import { createHmac, randomBytes } from 'node:crypto';
import { db } from '../storage/db.js';
import { decryptPin } from '../security/pin.js';

// Vínculos criados pelo importador (scripts/import-employees.ts) ficam com sync_status='IMPORTED':
// o cadastro já existe no REP e a importação é só no banco central. Nunca geram sync_jobs.
export const IMPORTED_STATUS = 'IMPORTED';

// Quantos vínculos ativos do servidor poderiam ser enviados ao REP e quantos estão bloqueados por IMPORTED.
export function countSyncTargets(employeeId: number, deviceId?: string, allowImported = false) {
  if (allowImported && !deviceId) throw new Error('allow_imported_requires_device');

  const rows = db.prepare(`
    SELECT b.sync_status
    FROM employee_device_bindings b
    JOIN devices d ON d.id=b.device_id
    WHERE b.employee_id=? AND (? IS NULL OR b.device_id=?) AND b.enabled=1 AND d.active=1
  `).all(employeeId, deviceId ?? null, deviceId ?? null) as Array<{ sync_status: string }>;

  const blocked = rows.filter((r) => r.sync_status === IMPORTED_STATUS).length;
  const eligible = rows.filter((r) => allowImported || r.sync_status !== IMPORTED_STATUS).length;
  return { eligible, blocked };
}

function normalizePis(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (/^0\d{11}$/.test(digits)) return digits.slice(1);
  return /^\d{11}$/.test(digits) ? digits : null;
}

function createPortalGrant(employeeId: number, deviceId: string, pis: string) {
  const secret = process.env.AGENT_TOKEN ?? '';
  if (!secret) throw new Error('agent_token_required_for_topdata_portal_write');

  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString('hex');
  const material = ['UPSERT_EMPLOYEE', employeeId, deviceId, pis, issuedAt, nonce].join('|');
  const signature = createHmac('sha256', secret).update(material, 'utf8').digest('hex');

  return {
    portalApproved: true,
    approvedPis: pis,
    approvedDeviceId: deviceId,
    issuedAt,
    nonce,
    signature
  };
}

export function queueEmployeeSync(
  employeeId: number,
  deviceId?: string,
  allowImported = false,
  portalApproved = false
) {
  const employee = db.prepare('SELECT * FROM employees WHERE id=?').get(employeeId) as any;
  if (!employee) throw new Error('employee_not_found');
  if (!employee.active) throw new Error('employee_inactive');

  if (allowImported && !deviceId) throw new Error('allow_imported_requires_device');
  if (portalApproved && !deviceId) throw new Error('portal_write_requires_device');

  const candidates = deviceId
    ? db.prepare(`
        SELECT b.*, d.vendor, d.model, d.agent_id
        FROM employee_device_bindings b
        JOIN devices d ON d.id=b.device_id
        WHERE b.employee_id=? AND b.device_id=? AND b.enabled=1 AND d.active=1
      `).all(employeeId, deviceId) as any[]
    : db.prepare(`
        SELECT b.*, d.vendor, d.model, d.agent_id
        FROM employee_device_bindings b
        JOIN devices d ON d.id=b.device_id
        WHERE b.employee_id=? AND b.enabled=1 AND d.active=1
      `).all(employeeId) as any[];

  const bindings = candidates.filter((binding) =>
    allowImported || binding.sync_status !== IMPORTED_STATUS
  );

  const insert = db.prepare(`
    INSERT INTO sync_jobs(device_id, employee_id, operation, payload_json)
    VALUES(?,?,?,?)
  `);

  const tx = db.transaction(() => {
    const ids: number[] = [];
    for (const binding of bindings) {
      const isTopdata = String(binding.vendor ?? '').toUpperCase() === 'TOPDATA';

      // Topdata só recebe escrita quando houve ação explícita no portal.
      // Sem autorização, o vínculo fica READY (ou preserva IMPORTED), nunca PENDING sem job.
      if (isTopdata && !portalApproved) {
        if (binding.sync_status !== IMPORTED_STATUS) {
          db.prepare(`
            UPDATE employee_device_bindings
            SET sync_status='READY', sync_error=NULL, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).run(binding.id);
        }
        continue;
      }

      const importedOverride = allowImported && binding.sync_status === IMPORTED_STATUS;
      const pis = normalizePis(binding.device_employee_no);
      if (isTopdata && !pis) throw new Error('topdata_invalid_pis');

      const syncMeta: Record<string, unknown> = {
        importedOverride
      };

      if (isTopdata && portalApproved) {
        Object.assign(syncMeta, createPortalGrant(employee.id, binding.device_id, pis!));
      }

      const payload = {
        employee: {
          id: employee.id,
          name: employee.name,
          cpf: employee.cpf,
          registration: employee.registration,
          active: !!employee.active
        },
        binding: {
          deviceId: binding.device_id,
          deviceEmployeeNo: binding.device_employee_no,
          cardNo: binding.card_no,
          enabled: !!binding.enabled
        },
        syncMeta
      };
      const result = insert.run(binding.device_id, employee.id, 'UPSERT_EMPLOYEE', JSON.stringify(payload));
      ids.push(Number(result.lastInsertRowid));
      db.prepare(`
        UPDATE employee_device_bindings
        SET sync_status='PENDING', sync_error=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(binding.id);
    }
    return ids;
  });

  return tx();
}

export function leaseJobs(agentId: string, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const tx = db.transaction(() => {
    const jobs = db.prepare(`
      SELECT j.*, d.name AS device_name, d.vendor, d.model, d.host, d.port
      FROM sync_jobs j
      JOIN devices d ON d.id=j.device_id
      WHERE d.agent_id=? AND d.active=1 AND j.status='PENDING'
        AND (
          j.employee_id IS NULL OR EXISTS (
            SELECT 1 FROM employees e
            WHERE e.id=j.employee_id AND e.active=1
          )
        )
      ORDER BY j.id
      LIMIT ?
    `).all(agentId, safeLimit) as any[];

    const lease = db.prepare(`
      UPDATE sync_jobs
      SET status='LEASED', lease_owner=?, leased_at=CURRENT_TIMESTAMP, attempts=attempts+1
      WHERE id=? AND status='PENDING'
    `);

    const leased: any[] = [];
    for (const job of jobs) {
      if (lease.run(agentId, job.id).changes === 1) {
        const payload = JSON.parse(job.payload_json);

        if (job.operation === 'UPSERT_EMPLOYEE' && job.employee_id) {
          const pin = db.prepare(`
            SELECT pin_ciphertext, pin_iv, pin_tag
            FROM employees
            WHERE id=?
          `).get(job.employee_id) as {
            pin_ciphertext: string | null;
            pin_iv: string | null;
            pin_tag: string | null;
          } | undefined;

          if (pin?.pin_ciphertext && pin.pin_iv && pin.pin_tag) {
            payload.employee = payload.employee ?? {};
            payload.employee.pin = decryptPin(pin.pin_ciphertext, pin.pin_iv, pin.pin_tag);
          }
        }

        leased.push({ ...job, status: 'LEASED', payload });
      }
    }
    return leased;
  });
  return tx();
}

export function completeJob(jobId: number, ok: boolean, errorMessage?: string) {
  const job = db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(jobId) as any;
  if (!job) throw new Error('job_not_found');

  const status = ok ? 'DONE' : 'ERROR';
  db.prepare(`
    UPDATE sync_jobs
    SET status=?, completed_at=CURRENT_TIMESTAMP, error_message=?
    WHERE id=?
  `).run(status, ok ? null : errorMessage ?? 'Falha não detalhada', jobId);

  if (job.employee_id) {
    let bindingStatus = status;
    if (!ok) {
      try {
        const payload = JSON.parse(job.payload_json);
        if (payload?.syncMeta?.importedOverride === true) {
          bindingStatus = IMPORTED_STATUS;
        }
      } catch {
        // Payload legado/inválido: mantém o comportamento anterior (ERROR).
      }
    }

    db.prepare(`
      UPDATE employee_device_bindings
      SET sync_status=?, sync_error=?, last_synced_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_synced_at END,
          updated_at=CURRENT_TIMESTAMP
      WHERE employee_id=? AND device_id=?
    `).run(bindingStatus, ok ? null : errorMessage ?? 'Falha não detalhada', ok ? 1 : 0, job.employee_id, job.device_id);
  }
}
