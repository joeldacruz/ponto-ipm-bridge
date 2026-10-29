import { Router, type NextFunction, type Request, type Response } from 'express';
import { db } from '../storage/db.js';
import { listAttendance, saveEvents } from '../services/events.js';
import { exportGenericCsv } from '../services/exporter.js';
import { completeJob, countSyncTargets, leaseJobs, queueEmployeeSync } from '../services/sync.js';
import type { DeviceEvent } from '../core/types.js';
import { encryptPin, isValidPin } from '../security/pin.js';

export const router = Router();

function audit(action: string, entityType: string, entityId: string | number | null, detail: unknown = {}) {
  db.prepare(`
    INSERT INTO audit_log(action,entity_type,entity_id,detail_json)
    VALUES(?,?,?,?)
  `).run(action, entityType, entityId == null ? null : String(entityId), JSON.stringify(detail));
}

function requireAgent(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.AGENT_TOKEN;
  if (!expected) return next();
  const supplied = req.header('x-agent-token');
  if (supplied !== expected) return res.status(401).json({ error: 'agent_unauthorized' });
  next();
}

router.get('/health', (_req, res) => {
  const devices = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='ONLINE' THEN 1 ELSE 0 END),0) AS online
    FROM devices WHERE active=1
  `).get();
  const employees = db.prepare('SELECT COUNT(*) AS total FROM employees WHERE active=1').get();
  const attendance = db.prepare("SELECT COUNT(*) AS total FROM device_events WHERE kind='ATTENDANCE'").get();
  res.json({ ok: true, devices, employees, attendance });
});

router.get('/api/devices', (_req, res) => {
  res.json(db.prepare(`
    SELECT d.*,
      (SELECT MAX(nsr) FROM device_events e WHERE e.device_id=d.id) AS last_nsr,
      (SELECT COUNT(*) FROM device_events e WHERE e.device_id=d.id AND e.kind='ATTENDANCE') AS attendance_count
    FROM devices d
    ORDER BY CASE d.role WHEN 'PRIMARY' THEN 0 ELSE 1 END, d.name
  `).all());
});

router.post('/api/devices', (req, res) => {
  const { id, name, vendor, model, role, transport, host, port, agentId, active = true } = req.body ?? {};
  if (!id || !name || !vendor) return res.status(400).json({ error: 'id, name e vendor são obrigatórios' });
  if (!['PRIMARY','SECONDARY'].includes(role)) return res.status(400).json({ error: 'role deve ser PRIMARY ou SECONDARY' });
  if (!['DIRECT','WINDOWS_AGENT'].includes(transport)) return res.status(400).json({ error: 'transport inválido' });

  db.prepare(`
    INSERT INTO devices(id,name,vendor,model,role,transport,host,port,agent_id,active)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(id, name, vendor, model ?? null, role, transport, host ?? null, port ?? null, agentId ?? null, active ? 1 : 0);
  audit('DEVICE_CREATE', 'device', id, req.body);
  res.status(201).json({ id });
});

router.get('/api/events/attendance', (req, res) => {
  res.json(listAttendance(typeof req.query.period === 'string' ? req.query.period : undefined));
});

router.get('/api/employees', (_req, res) => {
  const employees = db.prepare(`
    SELECT
      id, name, cpf, registration, device_employee_no, active, created_at,
      CASE
        WHEN pin_ciphertext IS NOT NULL AND pin_iv IS NOT NULL AND pin_tag IS NOT NULL THEN 1
        ELSE 0
      END AS pin_configured,
      pin_updated_at
    FROM employees
    ORDER BY name
  `).all() as any[];
  const bindings = db.prepare(`
    SELECT b.*, d.name AS device_name, d.role AS device_role, d.vendor
    FROM employee_device_bindings b
    JOIN devices d ON d.id=b.device_id
    ORDER BY d.role, d.name
  `).all() as any[];

  res.json(employees.map((employee) => ({
    ...employee,
    pinConfigured: !!employee.pin_configured,
    pin_configured: undefined,
    bindings: bindings.filter((binding) => binding.employee_id === employee.id)
  })));
});

router.post('/api/employees', (req, res) => {
  const { name, cpf, registration, deviceEmployeeNo, deviceIds = [], pin } = req.body ?? {};
  const centralNo = deviceEmployeeNo || registration || cpf;
  if (!name || !centralNo) {
    return res.status(400).json({ error: 'name e pelo menos matrícula, CPF ou deviceEmployeeNo são obrigatórios' });
  }

  // Identificadores numéricos precisam chegar como string (número já teria perdido os zeros à esquerda).
  for (const [field, value] of [['cpf', cpf], ['deviceEmployeeNo', deviceEmployeeNo], ['registration', registration]] as const) {
    if (value != null && typeof value !== 'string') return res.status(400).json({ error: `${field} deve ser enviado como texto` });
  }
  if (cpf && !/^\d{11}$/.test(cpf)) return res.status(400).json({ error: 'cpf deve ter 11 dígitos numéricos' });
  if (deviceEmployeeNo && !/^\d{11}$/.test(deviceEmployeeNo)) {
    return res.status(400).json({ error: 'deviceEmployeeNo (PIS/PASEP) deve ter 11 dígitos numéricos' });
  }
  if (pin != null && !isValidPin(pin)) {
    return res.status(400).json({ error: 'PIN do ponto deve ter exatamente 4 dígitos numéricos' });
  }

  // O REP Topdata identifica o servidor pelo PIS/PASEP: não se usa CPF nem matrícula no lugar dele.
  const ids: string[] = Array.isArray(deviceIds) ? deviceIds : [];
  let hasTopdata = false;
  if (ids.length) {
    hasTopdata = !!db.prepare(`SELECT 1 FROM devices WHERE id IN (${ids.map(() => '?').join(',')}) AND upper(vendor)='TOPDATA'`).get(...ids);
  }
  if (!deviceEmployeeNo && hasTopdata) {
    return res.status(400).json({ error: 'Informe o PIS/PASEP (deviceEmployeeNo) para cadastrar este servidor no REP Topdata.' });
  }
  let encryptedPin: ReturnType<typeof encryptPin> | null = null;
  try {
    if (pin) encryptedPin = encryptPin(pin);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'pin_encryption_error'
    });
  }

  const result = db.prepare(`
    INSERT INTO employees(
      name,cpf,registration,device_employee_no,
      pin_ciphertext,pin_iv,pin_tag,pin_updated_at
    )
    VALUES(?,?,?,?,?,?,?,CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
  `).run(
    name,
    cpf ?? null,
    registration ?? null,
    String(centralNo),
    encryptedPin?.ciphertext ?? null,
    encryptedPin?.iv ?? null,
    encryptedPin?.tag ?? null,
    encryptedPin?.ciphertext ?? null
  );

  const employeeId = Number(result.lastInsertRowid);
  for (const deviceId of Array.isArray(deviceIds) ? deviceIds : []) {
    db.prepare(`
      INSERT INTO employee_device_bindings(employee_id,device_id,device_employee_no)
      VALUES(?,?,?)
      ON CONFLICT(employee_id,device_id) DO UPDATE SET
        device_employee_no=excluded.device_employee_no,
        enabled=1,
        updated_at=CURRENT_TIMESTAMP
    `).run(employeeId, deviceId, String(centralNo));
  }

  const jobs = queueEmployeeSync(employeeId);
  audit('EMPLOYEE_CREATE', 'employee', employeeId, {
    name,
    cpf,
    registration,
    deviceIds,
    pinConfigured: !!encryptedPin
  });
  res.status(201).json({ id: employeeId, syncJobs: jobs });
});

router.put('/api/employees/:id/active', (req, res) => {
  const employeeId = Number(req.params.id);
  const active = req.body?.active;

  if (!employeeId) return res.status(400).json({ error: 'employeeId inválido' });
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active deve ser booleano' });
  }

  const employee = db.prepare('SELECT id, name, active FROM employees WHERE id=?').get(employeeId) as
    | { id: number; name: string; active: number }
    | undefined;

  if (!employee) return res.status(404).json({ error: 'employee_not_found' });

  const desired = active ? 1 : 0;
  if (employee.active === desired) {
    return res.json({ ok: true, active: !!employee.active, changed: false });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE employees SET active=? WHERE id=?').run(desired, employeeId);

    if (!active) {
      db.prepare(`
        UPDATE sync_jobs
        SET status='ERROR',
            completed_at=CURRENT_TIMESTAMP,
            error_message='EMPLOYEE_DEACTIVATED'
        WHERE employee_id=? AND status='PENDING'
      `).run(employeeId);
    }

    audit(active ? 'EMPLOYEE_ACTIVATE' : 'EMPLOYEE_DEACTIVATE', 'employee', employeeId, {
      active,
      repWrite: false
    });
  });

  tx();

  res.json({
    ok: true,
    active,
    changed: true,
    message: active
      ? 'Servidor reativado no sistema central.'
      : 'Servidor desativado no sistema central. Nenhuma exclusão foi enviada ao REP.'
  });
});

router.put('/api/employees/:id/pin', (req, res) => {
  const employeeId = Number(req.params.id);
  const pin = req.body?.pin;

  if (!employeeId) return res.status(400).json({ error: 'employeeId inválido' });
  if (!isValidPin(pin)) {
    return res.status(400).json({ error: 'PIN do ponto deve ter exatamente 4 dígitos numéricos' });
  }

  let encrypted: ReturnType<typeof encryptPin>;
  try {
    encrypted = encryptPin(pin);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'pin_encryption_error'
    });
  }

  const result = db.prepare(`
    UPDATE employees
    SET pin_ciphertext=?, pin_iv=?, pin_tag=?, pin_updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(encrypted.ciphertext, encrypted.iv, encrypted.tag, employeeId);

  if (result.changes !== 1) return res.status(404).json({ error: 'employee_not_found' });

  audit('EMPLOYEE_PIN_SET', 'employee', employeeId, { pinConfigured: true });
  res.json({ ok: true, pinConfigured: true });
});

router.post('/api/employees/:id/bindings', (req, res) => {
  const employeeId = Number(req.params.id);
  const { deviceId, deviceEmployeeNo, cardNo, enabled = true } = req.body ?? {};
  if (!employeeId || !deviceId || !deviceEmployeeNo) {
    return res.status(400).json({ error: 'employeeId, deviceId e deviceEmployeeNo são obrigatórios' });
  }

  db.prepare(`
    INSERT INTO employee_device_bindings(employee_id,device_id,device_employee_no,card_no,enabled)
    VALUES(?,?,?,?,?)
    ON CONFLICT(employee_id,device_id) DO UPDATE SET
      device_employee_no=excluded.device_employee_no,
      card_no=excluded.card_no,
      enabled=excluded.enabled,
      sync_status=CASE WHEN sync_status='IMPORTED' THEN 'IMPORTED' ELSE 'PENDING' END,
      sync_error=NULL,
      updated_at=CURRENT_TIMESTAMP
  `).run(employeeId, deviceId, String(deviceEmployeeNo), cardNo ?? null, enabled ? 1 : 0);

  const employee = db.prepare('SELECT active FROM employees WHERE id=?').get(employeeId) as { active: number } | undefined;
  const jobs = enabled && employee?.active ? queueEmployeeSync(employeeId, deviceId) : [];
  audit('EMPLOYEE_BIND_DEVICE', 'employee', employeeId, { deviceId, deviceEmployeeNo, cardNo, enabled });
  res.json({ ok: true, syncJobs: jobs });
});

router.post('/api/employees/:id/sync', (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const employee = db.prepare('SELECT active FROM employees WHERE id=?').get(employeeId) as { active: number } | undefined;
    if (!employee) return res.status(404).json({ error: 'employee_not_found' });
    if (!employee.active) {
      return res.status(409).json({
        error: 'employee_inactive',
        message: 'Servidor desativado: reative o cadastro antes de sincronizar com um REP.'
      });
    }

    const targets = countSyncTargets(employeeId, req.body?.deviceId);
    if (targets.eligible === 0 && targets.blocked > 0) {
      return res.status(409).json({
        error: 'sync_blocked_imported',
        message: 'Cadastro importado: a sincronização com o REP está bloqueada para este vínculo.'
      });
    }
    const jobs = queueEmployeeSync(employeeId, req.body?.deviceId);
    res.json({ ok: true, jobs });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'sync_error' });
  }
});

router.get('/api/sync/jobs', (_req, res) => {
  res.json(db.prepare(`
    SELECT j.*, d.name AS device_name, e.name AS employee_name
    FROM sync_jobs j
    JOIN devices d ON d.id=j.device_id
    LEFT JOIN employees e ON e.id=j.employee_id
    ORDER BY j.id DESC LIMIT 200
  `).all());
});

router.post('/api/agent/heartbeat', requireAgent, (req, res) => {
  const { agentId, devices = [] } = req.body ?? {};
  if (!agentId) return res.status(400).json({ error: 'agentId obrigatório' });

  for (const item of Array.isArray(devices) ? devices : []) {
    db.prepare(`
      UPDATE devices SET
        status=?,
        last_seen_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND agent_id=?
    `).run(item.online ? 'ONLINE' : 'OFFLINE', item.deviceId, agentId);
  }
  res.json({ ok: true });
});

router.get('/api/agent/:agentId/jobs', requireAgent, (req, res) => {
  const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
  res.json(leaseJobs(agentId, Number(req.query.limit || 20)));
});

router.post('/api/agent/jobs/:id/result', requireAgent, (req, res) => {
  try {
    completeJob(Number(req.params.id), !!req.body?.ok, req.body?.error);
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'job_error' });
  }
});

router.post('/api/agent/events', requireAgent, (req, res) => {
  const { deviceId, events } = req.body ?? {};
  if (!deviceId || !Array.isArray(events)) return res.status(400).json({ error: 'deviceId e events são obrigatórios' });

  const normalized: DeviceEvent[] = events.map((event: any) => ({
    sourceId: String(event.sourceId ?? `${deviceId}:${event.nsr ?? ''}:${event.occurredAt}`),
    deviceId,
    employeeNo: event.employeeNo == null ? undefined : String(event.employeeNo),
    cardNo: event.cardNo == null ? undefined : String(event.cardNo),
    occurredAt: String(event.occurredAt),
    kind: event.kind === 'ACCESS' ? 'ACCESS' : 'ATTENDANCE',
    nsr: event.nsr == null ? undefined : Number(event.nsr),
    attendanceStatus: event.attendanceStatus,
    rawType: event.rawType,
    rawPayload: typeof event.rawPayload === 'string' ? event.rawPayload : JSON.stringify(event.rawPayload ?? event)
  }));

  const inserted = saveEvents(normalized);
  db.prepare(`
    UPDATE devices SET status='ONLINE', last_seen_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(deviceId);
  audit('EVENTS_INGEST', 'device', deviceId, { received: events.length, inserted });
  res.status(201).json({ received: events.length, inserted });
});

router.post('/api/exports/:period', (req, res) => {
  if (!/^\d{4}-\d{2}$/.test(req.params.period)) return res.status(400).json({ error: 'Período deve ser AAAA-MM' });
  const out = exportGenericCsv(req.params.period);
  res.json({ ...out, warning: 'CSV provisório; layout IPM ainda depende de arquivo/documentação oficial.' });
});
