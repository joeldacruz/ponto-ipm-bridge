import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

// Importação em lote de servidores direto no banco central.
// NÃO cria sync_jobs, NÃO fala com REP e NÃO toca em device_events.

export const IMPORTED_SYNC_STATUS = 'IMPORTED';

export interface ImportRecord {
  name: string;
  registration: string | null;
  deviceEmployeeNo: string;
  deviceIds: string[];
  identifierType: string;
}

export interface ImportIssue { index: number; name: string; id: string; message: string }

export interface ImportReport {
  applied: boolean;
  total: number;
  created: number;
  existing: number;
  updated: number;
  unchanged: number;
  bindingsCreated: number;
  bindingsUpdated: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  duplicates: string[];
  eventsUntouched: boolean;
  attendance: { before: number; after: number; total: number };
}

export function maskId(value: string): string {
  return value.length <= 4 ? '****' : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

export function parseRecords(raw: unknown): { records: ImportRecord[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { records: [], errors: ['O arquivo deve conter uma lista (array) de servidores.'] };
  const records: ImportRecord[] = [];
  raw.forEach((item: any, i) => {
    const where = `registro ${i + 1}`;
    if (!item || typeof item !== 'object') return errors.push(`${where}: não é um objeto.`);
    const { name, registration, deviceEmployeeNo, deviceIds, identifierType } = item;
    if (typeof name !== 'string' || !name.trim()) errors.push(`${where}: name obrigatório.`);
    // deviceEmployeeNo deve ser string (preserva zeros à esquerda) e é usado exatamente como veio.
    if (typeof deviceEmployeeNo !== 'string' || !deviceEmployeeNo || deviceEmployeeNo !== deviceEmployeeNo.trim()) {
      errors.push(`${where}: deviceEmployeeNo deve ser string não vazia, sem espaços nas pontas.`);
    }
    if (registration != null && typeof registration !== 'string') errors.push(`${where}: registration deve ser string.`);
    if (!Array.isArray(deviceIds) || !deviceIds.length || deviceIds.some((d: unknown) => typeof d !== 'string' || !d)) {
      errors.push(`${where}: deviceIds deve ser uma lista de ids.`);
    }
    if (typeof identifierType !== 'string') errors.push(`${where}: identifierType obrigatório.`);
    if (!errors.some((e) => e.startsWith(where))) {
      records.push({
        name: name.trim(),
        registration: registration ? registration : null,
        deviceEmployeeNo,
        deviceIds,
        identifierType
      });
    }
  });
  return { records, errors };
}

export function findFileDuplicates(records: ImportRecord[]): string[] {
  const out: string[] = [];
  const check = (label: string, values: Array<string | null>) => {
    const seen = new Map<string, number>();
    for (const v of values) if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
    for (const [v, n] of seen) if (n > 1) out.push(`${label} repetido(a) ${n}x: ${label === 'deviceEmployeeNo' ? maskId(v) : v}`);
  };
  check('deviceEmployeeNo', records.map((r) => r.deviceEmployeeNo));
  check('matrícula', records.map((r) => r.registration));
  return out;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  employees: ['id', 'name', 'cpf', 'registration', 'device_employee_no', 'active'],
  employee_device_bindings: ['id', 'employee_id', 'device_id', 'device_employee_no', 'enabled', 'sync_status'],
  devices: ['id', 'name'],
  device_events: ['id', 'source_id', 'device_id', 'employee_no', 'kind', 'nsr', 'raw_payload'],
  audit_log: ['action', 'entity_type', 'entity_id', 'detail_json']
};

export function validateSchema(db: Database): string[] {
  const problems: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.length) { problems.push(`tabela ausente: ${table}`); continue; }
    for (const c of cols) if (!info.some((i) => i.name === c)) problems.push(`coluna ausente: ${table}.${c}`);
  }
  return problems;
}

// Impressão digital de device_events para provar que a importação não alterou nenhum registro coletado.
export function eventsFingerprint(db: Database): string {
  const hash = crypto.createHash('sha256');
  const rows = db.prepare(`
    SELECT id, source_id, device_id, employee_no, card_no, occurred_at, kind, nsr, attendance_status, raw_type, raw_payload
    FROM device_events ORDER BY id
  `).iterate();
  let n = 0;
  for (const row of rows) { hash.update(JSON.stringify(row)); n++; }
  return `${n}:${hash.digest('hex')}`;
}

// Batidas ATTENDANCE do REP que hoje resolvem para um servidor (mesmo JOIN de listAttendance()).
function identifiedAttendance(db: Database, deviceId: string): { identified: number; total: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN emp.id IS NOT NULL THEN 1 ELSE 0 END),0) AS identified
    FROM device_events e
    LEFT JOIN employee_device_bindings b ON b.device_id=e.device_id AND b.device_employee_no=e.employee_no
    LEFT JOIN employees emp ON emp.id=b.employee_id
    WHERE e.kind='ATTENDANCE' AND e.device_id=?
  `).get(deviceId) as { total: number; identified: number };
  return { identified: row.identified, total: row.total };
}

class Rollback extends Error {}

export function runImport(db: Database, records: ImportRecord[], opts: { apply: boolean }): ImportReport {
  const deviceIds = [...new Set(records.flatMap((r) => r.deviceIds))];
  for (const id of deviceIds) {
    if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)) {
      throw new Error(`Equipamento "${id}" não existe em devices. O importador não cria equipamentos.`);
    }
  }
  const primaryDevice = deviceIds[0];
  const eventsBefore = eventsFingerprint(db);
  const attBefore = identifiedAttendance(db, primaryDevice);

  const report: ImportReport = {
    applied: false, total: records.length, created: 0, existing: 0, updated: 0, unchanged: 0,
    bindingsCreated: 0, bindingsUpdated: 0, errors: [], warnings: [], duplicates: findFileDuplicates(records),
    eventsUntouched: true, attendance: { before: attBefore.identified, after: attBefore.identified, total: attBefore.total }
  };
  if (report.duplicates.length) return report; // identificadores repetidos no arquivo: nada é gravado

  const byReg = db.prepare('SELECT id,name,registration,device_employee_no FROM employees WHERE registration=?');
  const byNo = db.prepare('SELECT id,name,registration,device_employee_no FROM employees WHERE device_employee_no=?');
  const byId = db.prepare('SELECT id,name,registration,device_employee_no FROM employees WHERE id=?');
  const bindByNo = db.prepare('SELECT id,employee_id,device_employee_no FROM employee_device_bindings WHERE device_id=? AND device_employee_no=?');
  const bindByEmp = db.prepare('SELECT id,employee_id,device_employee_no FROM employee_device_bindings WHERE device_id=? AND employee_id=?');
  const insEmp = db.prepare('INSERT INTO employees(name,cpf,registration,device_employee_no) VALUES(?,?,?,?)');
  const fillReg = db.prepare('UPDATE employees SET registration=? WHERE id=?');
  const fillCpf = db.prepare('UPDATE employees SET cpf=? WHERE id=?');
  const insBind = db.prepare(`INSERT INTO employee_device_bindings(employee_id,device_id,device_employee_no,sync_status) VALUES(?,?,?,'${IMPORTED_SYNC_STATUS}')`);
  const updBind = db.prepare('UPDATE employee_device_bindings SET device_employee_no=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');

  const tx = db.transaction(() => {
    records.forEach((rec, index) => {
      const issue = (message: string): ImportIssue => ({ index: index + 1, name: rec.name, id: maskId(rec.deviceEmployeeNo), message });
      const isCpf = rec.identifierType.toUpperCase() === 'CPF';

      // Candidatos: por matrícula, por device_employee_no central e por vínculo existente em qualquer REP do registro.
      const found = new Map<number, any>();
      if (rec.registration) for (const e of byReg.all(rec.registration) as any[]) found.set(e.id, e);
      for (const e of byNo.all(rec.deviceEmployeeNo) as any[]) found.set(e.id, e);
      for (const d of rec.deviceIds) {
        for (const b of bindByNo.all(d, rec.deviceEmployeeNo) as any[]) {
          const e = byId.get(b.employee_id) as any; if (e) found.set(e.id, e);
        }
      }
      if (found.size > 1) { report.errors.push(issue('conflito: matrícula, identificador e/ou vínculo apontam para servidores diferentes.')); return; }

      let emp: any = [...found.values()][0];
      let changed = false;
      if (!emp) {
        const id = Number(insEmp.run(rec.name, isCpf ? rec.deviceEmployeeNo : null, rec.registration, rec.deviceEmployeeNo).lastInsertRowid);
        emp = { id, name: rec.name };
        report.created++; changed = true;
      } else {
        report.existing++;
        if (emp.name.trim().toUpperCase() !== rec.name.toUpperCase()) report.warnings.push(issue(`nome já cadastrado difere do arquivo (mantido: "${emp.name}").`));
        if (!emp.registration && rec.registration) { fillReg.run(rec.registration, emp.id); changed = true; }
        if (isCpf && !(db.prepare('SELECT cpf FROM employees WHERE id=?').get(emp.id) as any).cpf) { fillCpf.run(rec.deviceEmployeeNo, emp.id); changed = true; }
      }

      for (const d of rec.deviceIds) {
        const b = bindByEmp.get(d, emp.id) as any;
        if (!b) {
          const clash = bindByNo.get(d, rec.deviceEmployeeNo) as any;
          if (clash) { report.errors.push(issue(`identificador já vinculado a outro servidor em ${d}.`)); return; }
          insBind.run(emp.id, d, rec.deviceEmployeeNo); report.bindingsCreated++; changed = true;
        } else if (b.device_employee_no !== rec.deviceEmployeeNo) {
          updBind.run(rec.deviceEmployeeNo, b.id); report.bindingsUpdated++; changed = true;
        }
      }
      if (found.size) { if (changed) report.updated++; else report.unchanged++; }
    });

    if (opts.apply && !report.errors.length) {
      db.prepare(`INSERT INTO audit_log(action,entity_type,entity_id,detail_json) VALUES('EMPLOYEES_IMPORT','employee',NULL,?)`).run(JSON.stringify({
        total: report.total, created: report.created, existing: report.existing, updated: report.updated,
        bindingsCreated: report.bindingsCreated, bindingsUpdated: report.bindingsUpdated, deviceIds, syncJobsCreated: 0
      }));
    }
    const after = identifiedAttendance(db, primaryDevice);
    report.attendance.after = after.identified;
    report.attendance.total = after.total;
    // Dry-run ou qualquer erro: desfaz tudo (importação é tudo-ou-nada).
    if (!opts.apply || report.errors.length) throw new Rollback();
  });

  try { tx(); report.applied = opts.apply && !report.errors.length; }
  catch (e) { if (!(e instanceof Rollback)) throw e; }

  report.eventsUntouched = eventsFingerprint(db) === eventsBefore;
  return report;
}
