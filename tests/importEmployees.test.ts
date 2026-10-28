import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

// Banco temporário com o schema real do projeto (src/storage/db.ts cria as tabelas).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-employees-'));
process.env.DB_PATH = path.join(tmp, 'ponto.db');
delete process.env.TOPDATA_HOST;

let db: typeof import('../src/storage/db.js')['db'];
let runImport: typeof import('../src/services/importEmployees.js')['runImport'];
let parseRecords: typeof import('../src/services/importEmployees.js')['parseRecords'];
let eventsFingerprint: typeof import('../src/services/importEmployees.js')['eventsFingerprint'];
let validateSchema: typeof import('../src/services/importEmployees.js')['validateSchema'];
let router: typeof import('../src/http/routes.js')['router'];
let express: any;

const DEV = 'rep-topdata-02';
test.before(async () => {
  ({ db } = await import('../src/storage/db.js'));
  ({ runImport, parseRecords, eventsFingerprint, validateSchema } = await import('../src/services/importEmployees.js'));
  ({ router } = await import('../src/http/routes.js'));
  express = (await import('express')).default;
  db.prepare(`INSERT INTO devices(id,name,vendor,model,role,transport,host,port,agent_id) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(DEV, 'REP 02 - Topdata contingência', 'TOPDATA', 'Inner REP Bio', 'SECONDARY', 'WINDOWS_AGENT', '10.0.0.2', 51000, 'agent');
});

// Dados SINTÉTICOS (nenhum PIS/CPF real).
const rec = (name: string, registration: string | null, no: string, identifierType = 'PIS/PASEP') =>
  ({ name, registration, deviceEmployeeNo: no, deviceIds: [DEV], identifierType });
const A = rec('ANA TESTE', '1001-00', '00012345678');
const B = rec('BRUNO TESTE', '1002-00', '10987654321');
const C = rec('CARLA CPF', '1003-00', '52998224725', 'CPF');

function wipe() {
  db.exec('DELETE FROM sync_jobs; DELETE FROM employee_device_bindings; DELETE FROM employees; DELETE FROM device_events; DELETE FROM audit_log;');
}
function addEvent(no: string, nsr: number) {
  db.prepare(`INSERT INTO device_events(source_id,device_id,employee_no,occurred_at,kind,nsr,raw_payload) VALUES(?,?,?,?,?,?,?)`)
    .run(`${DEV}:${nsr}`, DEV, no, '2026-10-28T07:01:00', 'ATTENDANCE', nsr, `raw-${nsr}`);
}
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

test('estrutura do banco é validada', () => {
  assert.deepEqual(validateSchema(db), []);
});

test('cria servidores e vínculos locais, sem sync_jobs e sem tocar em device_events', () => {
  wipe(); addEvent(A.deviceEmployeeNo, 1); addEvent('99999999999', 2);
  const before = eventsFingerprint(db);
  const r = runImport(db, [A, B, C], { apply: true });
  assert.equal(r.applied, true);
  assert.equal(r.created, 3); assert.equal(r.existing, 0); assert.equal(r.bindingsCreated, 3);
  assert.equal(r.errors.length, 0);
  assert.equal(count('employees'), 3);
  assert.equal(count('sync_jobs'), 0);
  assert.equal(eventsFingerprint(db), before);
  assert.equal(r.eventsUntouched, true);
  const b = db.prepare('SELECT * FROM employee_device_bindings WHERE device_id=? AND device_employee_no=?').get(DEV, A.deviceEmployeeNo) as any;
  assert.equal(b.device_employee_no, '00012345678'); // zeros à esquerda preservados
  assert.equal(b.sync_status, 'IMPORTED');
  assert.equal((db.prepare('SELECT cpf FROM employees WHERE registration=?').get('1003-00') as any).cpf, '52998224725'); // só o do tipo CPF
  assert.equal((db.prepare('SELECT cpf FROM employees WHERE registration=?').get('1001-00') as any).cpf, null); // PIS não vai para o campo cpf
  assert.equal(count('audit_log'), 1);
});

test('idempotente: segunda execução não cria nem altera nada', () => {
  const r = runImport(db, [A, B, C], { apply: true });
  assert.equal(r.created, 0); assert.equal(r.existing, 3); assert.equal(r.updated, 0); assert.equal(r.unchanged, 3);
  assert.equal(r.bindingsCreated, 0); assert.equal(count('employees'), 3); assert.equal(count('employee_device_bindings'), 3);
});

test('simulação (dry-run) não grava nada', () => {
  wipe();
  const r = runImport(db, [A, B], { apply: false });
  assert.equal(r.applied, false); assert.equal(r.created, 2);
  assert.equal(count('employees'), 0); assert.equal(count('employee_device_bindings'), 0); assert.equal(count('audit_log'), 0);
});

test('servidor já cadastrado por matrícula não é duplicado, mantém o nome e ganha o vínculo', () => {
  wipe();
  db.prepare('INSERT INTO employees(name,registration,device_employee_no) VALUES(?,?,?)').run('Ana (cadastro antigo)', '1001-00', '1001-00');
  const r = runImport(db, [A], { apply: true });
  assert.equal(r.created, 0); assert.equal(r.existing, 1); assert.equal(r.updated, 1); assert.equal(r.bindingsCreated, 1);
  assert.equal(count('employees'), 1);
  assert.equal(r.warnings.length, 1); // nome diferente é só avisado
  assert.equal((db.prepare('SELECT name FROM employees').get() as any).name, 'Ana (cadastro antigo)');
});

test('vínculo existente com outro device_employee_no é corrigido só se necessário', () => {
  wipe();
  const id = Number(db.prepare('INSERT INTO employees(name,registration,device_employee_no) VALUES(?,?,?)').run('ANA TESTE', '1001-00', '1001-00').lastInsertRowid);
  db.prepare('INSERT INTO employee_device_bindings(employee_id,device_id,device_employee_no) VALUES(?,?,?)').run(id, DEV, '1001-00');
  const r = runImport(db, [A], { apply: true });
  assert.equal(r.bindingsUpdated, 1); assert.equal(r.bindingsCreated, 0); assert.equal(count('employee_device_bindings'), 1);
  assert.equal((db.prepare('SELECT device_employee_no AS n FROM employee_device_bindings').get() as any).n, '00012345678');
});

test('conflito entre servidores gera erro e desfaz TUDO (tudo-ou-nada)', () => {
  wipe();
  db.prepare('INSERT INTO employees(name,registration,device_employee_no) VALUES(?,?,?)').run('OUTRO', '1001-00', 'x1');
  db.prepare('INSERT INTO employees(name,registration,device_employee_no) VALUES(?,?,?)').run('OUTRO 2', '7777', A.deviceEmployeeNo);
  const r = runImport(db, [B, A], { apply: true });
  assert.equal(r.errors.length, 1); assert.equal(r.applied, false);
  assert.equal(count('employees'), 2); assert.equal(count('employee_device_bindings'), 0);
});

test('identificadores duplicados no arquivo abortam sem gravar', () => {
  wipe();
  const r = runImport(db, [A, { ...B, deviceEmployeeNo: A.deviceEmployeeNo }], { apply: true });
  assert.equal(r.duplicates.length, 1); assert.equal(r.applied, false); assert.equal(count('employees'), 0);
});

test('REP inexistente aborta e não cria equipamento', () => {
  assert.throws(() => runImport(db, [{ ...A, deviceIds: ['rep-nao-existe'] }], { apply: true }), /não existe em devices/);
  assert.equal(count('devices'), 1);
});

test('entrada com deviceEmployeeNo numérico é rejeitada (não converte para número)', () => {
  const { errors } = parseRecords([{ ...A, deviceEmployeeNo: 12345678 }]);
  assert.equal(errors.length, 1);
});

test('batidas históricas passam a exibir o nome em GET /api/events/attendance', async () => {
  wipe();
  for (let i = 1; i <= 3; i++) addEvent(A.deviceEmployeeNo, i);
  addEvent('55555555555', 4); // PIS sem cadastro continua sem nome
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events/attendance`;
    const antes = await (await fetch(url)).json() as any[];
    assert.equal(antes.filter((e) => e.name).length, 0);
    const r = runImport(db, [A, B], { apply: true });
    assert.deepEqual([r.attendance.before, r.attendance.after, r.attendance.total], [0, 3, 4]);
    const depois = await (await fetch(url)).json() as any[];
    assert.equal(depois.length, 4);
    assert.deepEqual(depois.filter((e) => e.employee_no === A.deviceEmployeeNo).map((e) => e.name), ['ANA TESTE', 'ANA TESTE', 'ANA TESTE']);
    assert.equal(depois.find((e) => e.employee_no === '55555555555').name, null);
  } finally { server.close(); }
});

async function withApi<T>(fn: (post: (url: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<T>): Promise<T> {
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (url: string, body: unknown = {}) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  try { return await fn(post); } finally { server.close(); }
}

test('proteção: sincronizar vínculo IMPORTED é recusado (409), sem sync_jobs e sem alterar ponto', async () => {
  wipe(); addEvent(A.deviceEmployeeNo, 1);
  runImport(db, [A], { apply: true });
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;
  const before = eventsFingerprint(db);
  await withApi(async (post) => {
    const geral = await post(`/api/employees/${id}/sync`);
    assert.equal(geral.status, 409); assert.equal(geral.json.error, 'sync_blocked_imported');
    const porRep = await post(`/api/employees/${id}/sync`, { deviceId: DEV });
    assert.equal(porRep.status, 409);
  });
  assert.equal(count('sync_jobs'), 0);
  assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s, 'IMPORTED');
  assert.equal(eventsFingerprint(db), before);
});

test('proteção: POST /bindings em vínculo IMPORTED mantém o status e não enfileira job', async () => {
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;
  await withApi(async (post) => {
    const r = await post(`/api/employees/${id}/bindings`, { deviceId: DEV, deviceEmployeeNo: A.deviceEmployeeNo });
    assert.equal(r.status, 200); assert.deepEqual(r.json.syncJobs, []);
  });
  assert.equal(count('sync_jobs'), 0);
  assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s, 'IMPORTED');
});

test('proteção: servidor com vínculo IMPORTED e outro normal sincroniza só o normal', async () => {
  db.prepare(`INSERT OR IGNORE INTO devices(id,name,vendor,role,transport) VALUES('rep-outro','REP Outro','ACME','PRIMARY','DIRECT')`).run();
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;
  db.prepare('INSERT INTO employee_device_bindings(employee_id,device_id,device_employee_no) VALUES(?,?,?)').run(id, 'rep-outro', 'X1');
  await withApi(async (post) => {
    const r = await post(`/api/employees/${id}/sync`);
    assert.equal(r.status, 200); assert.equal(r.json.jobs.length, 1);
  });
  const jobs = db.prepare('SELECT device_id FROM sync_jobs').all() as any[];
  assert.deepEqual(jobs.map((j) => j.device_id), ['rep-outro']); // nunca o rep-topdata-02
});

test('regressão: vínculo normal continua sincronizando e servidor inexistente dá 404', async () => {
  wipe();
  await withApi(async (post) => {
    const c = await post('/api/employees', { name: 'NOVO', registration: '5', deviceIds: [DEV] });
    assert.equal(c.status, 201); assert.equal(c.json.syncJobs.length, 1);
    const r = await post(`/api/employees/${c.json.id}/sync`);
    assert.equal(r.status, 200); assert.equal(r.json.jobs.length, 1);
    assert.equal((await post('/api/employees/99999/sync')).status, 404);
  });
});

test('CLI: simulação não grava; --apply faz backup com SHA-256 e não cria sync_jobs', () => {
  wipe(); addEvent(A.deviceEmployeeNo, 1);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const file = path.join(tmp, 'in.json');
  fs.writeFileSync(file, JSON.stringify([A, B, C]));
  const run = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-employees.ts', '--file', file, '--db', process.env.DB_PATH!, ...extra], { encoding: 'utf8' });

  const dry = run();
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /SIMULAÇÃO/); assert.match(dry.stdout, /Gravado no banco:\s+NÃO/);
  assert.equal(count('employees'), 0);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.includes('.backup-')).length, 0);

  const real = run('--apply');
  assert.equal(real.status, 0, real.stderr + real.stdout);
  assert.match(real.stdout, /Gravado no banco:\s+SIM/); assert.match(real.stdout, /device_events inalterado:\s+SIM/);
  assert.equal(count('employees'), 3); assert.equal(count('sync_jobs'), 0);
  const backup = fs.readdirSync(tmp).find((f) => /\.backup-[^.]*$/.test(f) && !f.endsWith('.sha256'))!;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, backup))).digest('hex');
  assert.ok(real.stdout.includes(sha));
  assert.ok(fs.readFileSync(path.join(tmp, backup + '.sha256'), 'utf8').startsWith(sha));
  assert.ok(!real.stdout.includes(A.deviceEmployeeNo)); // identificadores saem mascarados no relatório
});

test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
