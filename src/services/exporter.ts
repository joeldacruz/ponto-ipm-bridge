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
