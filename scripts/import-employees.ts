import 'dotenv/config';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  eventsFingerprint, maskId, parseRecords, runImport, validateSchema
} from '../src/services/importEmployees.js';

// Uso:
//   tsx scripts/import-employees.ts --file data/import/servidores_ponto.json            (simulação, não grava)
//   tsx scripts/import-employees.ts --file data/import/servidores_ponto.json --apply    (backup + grava)
// Banco: --db <caminho> ou DB_PATH do .env (padrão ./data/ponto.db).
// Só escreve em employees / employee_device_bindings / audit_log. Não cria sync_jobs, não altera device_events.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg('--file');
const apply = process.argv.includes('--apply');
const dbPath = path.resolve(arg('--db') || process.env.DB_PATH || './data/ponto.db');
if (!file) { console.error('Informe --file <servidores.json>'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error(`Banco não encontrado: ${dbPath}`); process.exit(2); }

async function main() {
  const { records, errors } = parseRecords(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  if (errors.length) { console.error('Arquivo inválido:\n- ' + errors.join('\n- ')); process.exit(2); }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  console.log(`Banco: ${dbPath}`);
  console.log(`Modo:  ${apply ? 'APLICAR (com backup)' : 'SIMULAÇÃO (nada é gravado)'}`);
  console.log(`Arquivo: ${path.resolve(file)} — ${records.length} registros`);

  const problems = validateSchema(db);
  if (problems.length) { console.error('Estrutura do banco incompatível:\n- ' + problems.join('\n- ')); process.exit(3); }
  console.log('Estrutura das tabelas: OK');

  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup-${stamp}`;
    await db.backup(backupPath); // API de backup do SQLite: cópia consistente mesmo com WAL/servidor em uso
    const sha = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
    fs.writeFileSync(`${backupPath}.sha256`, `${sha}  ${path.basename(backupPath)}\n# criado em ${new Date().toISOString()}\n`);
    console.log(`Backup: ${backupPath}`);
    console.log(`Backup SHA-256: ${sha}`);
    console.log(`Backup criado em: ${new Date().toISOString()}`);
  }

  const before = eventsFingerprint(db);
  const r = runImport(db, records, { apply });
  const syncJobs = (db.prepare('SELECT COUNT(*) AS n FROM sync_jobs').get() as { n: number }).n;

  console.log('\n=== RESULTADO ===');
  console.log(`Servidores no arquivo:     ${r.total}`);
  console.log(`Criados:                   ${r.created}`);
  console.log(`Já existentes:             ${r.existing}  (atualizados: ${r.updated}, sem mudança: ${r.unchanged})`);
  console.log(`Vínculos criados:          ${r.bindingsCreated}  (atualizados: ${r.bindingsUpdated})`);
  console.log(`Erros:                     ${r.errors.length}`);
  console.log(`Identificadores duplicados: ${r.duplicates.length ? r.duplicates.join('; ') : 'nenhum'}`);
  r.errors.forEach((e) => console.log(`  ERRO   #${e.index} ${e.name} (${e.id}): ${e.message}`));
  r.warnings.forEach((e) => console.log(`  AVISO  #${e.index} ${e.name} (${e.id}): ${e.message}`));
  console.log(`Gravado no banco:          ${r.applied ? 'SIM' : 'NÃO'}`);
  console.log(`device_events inalterado:  ${r.eventsUntouched && before === eventsFingerprint(db) ? 'SIM' : 'NÃO — INVESTIGAR'}`);
  console.log(`sync_jobs existentes:      ${syncJobs} (a importação não cria nenhum)`);
  console.log(`Batidas do REP com servidor identificado: antes ${r.attendance.before} → ${r.attendance.after} de ${r.attendance.total}${r.applied ? '' : ' (previsto)'}`);

  if (r.applied) {
    const device = records[0].deviceIds[0];
    const q = db.prepare(`
      SELECT emp.name, COUNT(e.id) AS batidas
      FROM employee_device_bindings b
      JOIN employees emp ON emp.id=b.employee_id
      LEFT JOIN device_events e ON e.device_id=b.device_id AND e.employee_no=b.device_employee_no AND e.kind='ATTENDANCE'
      WHERE b.device_id=? AND b.device_employee_no=? GROUP BY b.id
    `);
    console.log('\nBatidas históricas por servidor do arquivo:');
    for (const rec of records) {
      const x = q.get(device, rec.deviceEmployeeNo) as { name: string; batidas: number } | undefined;
      console.log(`  ${(x?.name ?? rec.name).padEnd(34)} ${maskId(rec.deviceEmployeeNo)}  ${x?.batidas ?? 0}`);
    }
  }
  db.close();
  process.exit(r.errors.length || r.duplicates.length ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
