import fs from 'node:fs';
import path from 'node:path';
import { db } from '../storage/db.js';
import { employeeNoMatchSql } from '../core/employeeMatch.js';

/**
 * Exportador provisório para homologação.
 * NÃO representa o layout oficial do IPM.
 * O layout final só será implementado após receber arquivo de exemplo/documentação do IPM.
 */
export function exportGenericCsv(period: string): { filePath: string; count: number } {
  const rows = db.prepare(`
    SELECT e.id, e.occurred_at, e.employee_no, e.attendance_status,
           emp.name, emp.cpf, emp.registration
    FROM device_events e
    LEFT JOIN employees emp ON ${employeeNoMatchSql('emp', 'e')}
    WHERE e.kind='ATTENDANCE' AND substr(e.occurred_at,1,7)=?
    ORDER BY e.occurred_at ASC
  `).all(period) as any[];

  const dir = path.resolve('exports');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `ponto-${period}.csv`;
  const filePath = path.join(dir, fileName);

  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = [
    ['id','cpf','matricula','nome','device_employee_no','data_hora','attendance_status'].map(esc).join(';'),
    ...rows.map(r => [r.id,r.cpf,r.registration,r.name,r.employee_no,r.occurred_at,r.attendance_status].map(esc).join(';'))
  ];
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  db.prepare(`INSERT INTO exports(period, format, file_name, event_count) VALUES(?,?,?,?)`)
    .run(period, 'generic-csv', fileName, rows.length);

  return { filePath, count: rows.length };
}


function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'rep';
}

function recordExport(period: string, format: string, fileName: string, count: number): void {
  db.prepare(`INSERT INTO exports(period, format, file_name, event_count) VALUES(?,?,?,?)`)
    .run(period, format, fileName, count);
}

export function buildAttendanceAfdDownload(
  period: string,
  deviceId: string
): { fileName: string; content: string; count: number; skipped: number } {
  const rows = db.prepare(`
    SELECT nsr, raw_payload
    FROM device_events
    WHERE device_id=?
      AND kind='ATTENDANCE'
      AND substr(occurred_at,1,7)=?
    ORDER BY nsr ASC, occurred_at ASC, id ASC
  `).all(deviceId, period) as Array<{ nsr: number | null; raw_payload: string }>;

  const lines: string[] = [];
  let skipped = 0;

  for (const row of rows) {
    const raw = String(row.raw_payload ?? '').trim();
    // Layout real validado no Topdata: NSR(9) + tipo 3 + ddMMyyyy + HHmm + identificador(12).
    if (!/^\d{9}3\d{24}$/.test(raw)) {
      skipped += 1;
      continue;
    }
    lines.push(raw);
  }

  const fileName = `AFD-${safeFilePart(deviceId)}-${period}.txt`;
  const content = lines.length ? lines.join('\r\n') + '\r\n' : '';

  recordExport(period, 'topdata-afd-attendance', fileName, lines.length);

  return { fileName, content, count: lines.length, skipped };
}

export function buildGenericCsvDownload(
  period: string,
  deviceId: string
): { fileName: string; content: string; count: number } {
  const rows = db.prepare(`
    SELECT
      e.id,
      e.occurred_at,
      e.employee_no,
      e.attendance_status,
      e.nsr,
      emp.name,
      emp.cpf,
      emp.registration,
      d.name AS device_name
    FROM device_events e
    LEFT JOIN employee_device_bindings b
      ON b.device_id=e.device_id
     AND ${employeeNoMatchSql('b', 'e')}
    LEFT JOIN employees emp ON emp.id=b.employee_id
    LEFT JOIN devices d ON d.id=e.device_id
    WHERE e.kind='ATTENDANCE'
      AND e.device_id=?
      AND substr(e.occurred_at,1,7)=?
    ORDER BY e.occurred_at ASC, e.nsr ASC, e.id ASC
  `).all(deviceId, period) as any[];

  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = [
    ['nsr','cpf','matricula','nome','device_employee_no','data_hora','equipamento','attendance_status']
      .map(esc).join(';'),
    ...rows.map((r) => [
      r.nsr,
      r.cpf,
      r.registration,
      r.name,
      r.employee_no,
      r.occurred_at,
      r.device_name,
      r.attendance_status
    ].map(esc).join(';'))
  ];

  const fileName = `ponto-${safeFilePart(deviceId)}-${period}.csv`;
  // BOM facilita abertura direta no Excel em pt-BR.
  const content = '\uFEFF' + lines.join('\r\n') + '\r\n';

  recordExport(period, 'generic-csv-download', fileName, rows.length);

  return { fileName, content, count: rows.length };
}
