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
process.env.AGENT_TOKEN = 'test-agent-token-portal-write';
process.env.PIN_ENCRYPTION_KEY = '11'.repeat(32);
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

async function withApi<T>(
  fn: (
    post: (
      url: string,
      body?: unknown,
      method?: 'POST' | 'PUT'
    ) => Promise<{ status: number; json: any }>
  ) => Promise<T>
): Promise<T> {
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (url: string, body: unknown = {}, method: 'POST' | 'PUT' = 'POST') => {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    return {
      status: r.status,
      json: text ? JSON.parse(text) : {}
    };
  };
  try { return await fn(post); } finally { server.close(); }
}

async function setTestPin(
  request: (
    url: string,
    body?: unknown,
    method?: 'POST' | 'PUT'
  ) => Promise<{ status: number; json: any }>,
  employeeId: number
) {
  const r = await request(`/api/employees/${employeeId}/pin`, { pin: '0427' }, 'PUT');
  assert.equal(r.status, 200);
}

test('proteção: portal exige REP explícito, PIN e mantém IMPORTED bloqueado sem override', async () => {
  wipe(); addEvent(A.deviceEmployeeNo, 1);
  runImport(db, [A], { apply: true });
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;
  const before = eventsFingerprint(db);
  await withApi(async (post) => {
    const geral = await post(`/api/employees/${id}/sync`);
    assert.equal(geral.status, 400);
    assert.equal(geral.json.error, 'portal_write_requires_device');

    const semPin = await post(`/api/employees/${id}/sync`, { deviceId: DEV });
    assert.equal(semPin.status, 409);
    assert.equal(semPin.json.error, 'pin_required');

    await setTestPin(post, id);
    const porRep = await post(`/api/employees/${id}/sync`, { deviceId: DEV });
    assert.equal(porRep.status, 409);
    assert.equal(porRep.json.error, 'sync_blocked_imported');
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

test('portal: envio direcionado para vínculo normal não-Topdata continua funcionando', async () => {
  db.prepare(`INSERT OR IGNORE INTO devices(id,name,vendor,role,transport) VALUES('rep-outro','REP Outro','ACME','PRIMARY','DIRECT')`).run();
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;
  db.prepare('INSERT INTO employee_device_bindings(employee_id,device_id,device_employee_no) VALUES(?,?,?)').run(id, 'rep-outro', 'X1');
  await withApi(async (post) => {
    const r = await post(`/api/employees/${id}/sync`, { deviceId: 'rep-outro' });
    assert.equal(r.status, 200); assert.equal(r.json.jobs.length, 1);
  });
  const jobs = db.prepare('SELECT device_id FROM sync_jobs').all() as any[];
  assert.deepEqual(jobs.map((j) => j.device_id), ['rep-outro']); // nunca o rep-topdata-02
});

test('proteção: override de IMPORTED exige um REP explícito', async () => {
  wipe(); addEvent(A.deviceEmployeeNo, 20);
  runImport(db, [A], { apply: true });
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;
  const before = eventsFingerprint(db);

  await withApi(async (post) => {
    const r = await post(`/api/employees/${id}/sync`, { allowImported: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'portal_write_requires_device');
  });

  assert.equal(count('sync_jobs'), 0);
  assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s, 'IMPORTED');
  assert.equal(eventsFingerprint(db), before);
});

test('override explícito libera somente o servidor importado e o REP informado, com auditoria', async () => {
  wipe(); addEvent(A.deviceEmployeeNo, 21);
  runImport(db, [A, B], { apply: true });
  const id = (db.prepare('SELECT id FROM employees WHERE registration=?').get(A.registration) as any).id;
  const before = eventsFingerprint(db);

  await withApi(async (post) => {
    await setTestPin(post, id);
    const r = await post(`/api/employees/${id}/sync`, { deviceId: DEV, allowImported: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.jobs.length, 1);

    const duplicate = await post(`/api/employees/${id}/sync`, { deviceId: DEV, allowImported: true });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error, 'sync_already_pending');
  });

  const job = db.prepare('SELECT device_id,employee_id,operation,status,payload_json FROM sync_jobs').get() as any;
  assert.equal(job.device_id, DEV);
  assert.equal(job.employee_id, id);
  assert.equal(job.operation, 'UPSERT_EMPLOYEE');
  assert.equal(job.status, 'PENDING');
  const payload = JSON.parse(job.payload_json);
  assert.equal(payload.syncMeta.portalApproved, true);
  assert.equal(payload.syncMeta.approvedPis, A.deviceEmployeeNo);
  assert.equal(payload.syncMeta.approvedDeviceId, DEV);
  assert.match(payload.syncMeta.signature, /^[0-9a-f]{64}$/);
  assert.equal(payload.employee.pin, undefined);
  assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings WHERE employee_id=?').get(id) as any).s, 'PENDING');

  const auditRow = db.prepare(`
    SELECT action,detail_json FROM audit_log
    WHERE action='EMPLOYEE_SYNC_IMPORTED_OVERRIDE' AND entity_id=?
    ORDER BY id DESC LIMIT 1
  `).get(String(id)) as any;
  assert.equal(auditRow.action, 'EMPLOYEE_SYNC_IMPORTED_OVERRIDE');
  assert.equal(JSON.parse(auditRow.detail_json).deviceId, DEV);
  assert.equal(eventsFingerprint(db), before);

  const other = db.prepare('SELECT sync_status AS s FROM employee_device_bindings b JOIN employees e ON e.id=b.employee_id WHERE e.registration=?').get(B.registration) as any;
  assert.equal(other.s, 'IMPORTED');
});

test('falha no primeiro envio explícito restaura a proteção IMPORTED', async () => {
  wipe();
  runImport(db, [A], { apply: true });
  const id = (db.prepare('SELECT id FROM employees').get() as any).id;

  let jobId = 0;
  await withApi(async (post) => {
    await setTestPin(post, id);
    const r = await post(`/api/employees/${id}/sync`, { deviceId: DEV, allowImported: true });
    assert.equal(r.status, 200);
    jobId = Number(r.json.jobs[0]);
  });

  assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s, 'PENDING');

  const { completeJob } = await import('../src/services/sync.js');
  completeJob(jobId, false, 'SDK_TOPDATA_NOT_CONNECTED');

  const binding = db.prepare('SELECT sync_status AS s,sync_error AS e FROM employee_device_bindings').get() as any;
  assert.equal(binding.s, 'IMPORTED');
  assert.equal(binding.e, 'SDK_TOPDATA_NOT_CONNECTED');
  assert.equal((db.prepare('SELECT status FROM sync_jobs WHERE id=?').get(jobId) as any).status, 'ERROR');
});

test('portal: cadastro Topdata fica READY e só cria job após envio explícito', async () => {
  wipe();
  await withApi(async (post) => {
    const c = await post('/api/employees', {
      name: 'NOVO',
      registration: '5',
      deviceEmployeeNo: '12345678901',
      pin: '0427',
      deviceIds: [DEV]
    });
    assert.equal(c.status, 201);
    assert.deepEqual(c.json.syncJobs, []);
    assert.equal(count('sync_jobs'), 0);
    assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s, 'READY');

    const r = await post(`/api/employees/${c.json.id}/sync`, { deviceId: DEV });
    assert.equal(r.status, 200);
    assert.equal(r.json.jobs.length, 1);

    assert.equal((await post('/api/employees/99999/sync', { deviceId: DEV })).status, 404);
  });
});

// ---- Associação de PIS de 11 dígitos com o identificador de 12 posições do Topdata ('0' + PIS) ----
function addRawEvent(no: string, nsr: number, raw = `raw-${nsr}`) {
  db.prepare(`INSERT INTO device_events(source_id,device_id,employee_no,occurred_at,kind,nsr,raw_payload) VALUES(?,?,?,?,?,?,?)`)
    .run(`${DEV}:${nsr}`, DEV, no, '2026-10-28T07:01:00', 'ATTENDANCE', nsr, raw);
}
const snapshot = () => db.prepare('SELECT id,source_id,device_id,employee_no,nsr,raw_payload FROM device_events ORDER BY id').all();

test('PIS de 12 posições (0 + PIS de 11) encontra o vínculo; 11 dígitos continua funcionando; outros não associam', async () => {
  wipe();
  const pis = '12864722692';
  addRawEvent('0' + pis, 10);        // Topdata: 12 posições
  addRawEvent(pis, 11);              // já com 11 dígitos
  addRawEvent('0' + '99999999999', 12); // 12 posições, outro PIS
  addRawEvent('1' + pis, 13);        // 12 dígitos mas não começa com 0
  addRawEvent('00' + pis.slice(0, 10), 14); // 12 dígitos começando com 0, últimos 11 diferentes
  addRawEvent('0' + pis.slice(0, 10) + 'X', 15); // 12 posições com letra
  addRawEvent('0' + pis + '0', 16);  // 13 posições
  const antes = snapshot(); const fp = eventsFingerprint(db);

  const r = runImport(db, [rec('SERVIDOR PIS', '2001-00', pis)], { apply: true });
  assert.deepEqual([r.attendance.before, r.attendance.after, r.attendance.total], [0, 2, 7]);

  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0);
  try {
    const rows = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events/attendance`)).json() as any[];
    const nomes = new Map(rows.map((e) => [e.nsr, e.name]));
    assert.equal(nomes.get(10), 'SERVIDOR PIS');
    assert.equal(nomes.get(11), 'SERVIDOR PIS');
    for (const nsr of [12, 13, 14, 15, 16]) assert.equal(nomes.get(nsr), null, `NSR ${nsr} não pode associar`);
    assert.equal(rows.length, 7); // nenhuma duplicação de linhas pelo JOIN
    assert.equal(rows.find((e) => e.nsr === 10).employee_no, '0' + pis); // valor original preservado na resposta
  } finally { server.close(); }

  // device_events intacto: nem employee_no, nem NSR, nem raw_payload, nem source_id.
  assert.deepEqual(snapshot(), antes);
  assert.equal(eventsFingerprint(db), fp);
  assert.equal(r.eventsUntouched, true);
  assert.equal((db.prepare('SELECT employee_no FROM device_events WHERE nsr=10').get() as any).employee_no, '0' + pis);
  // formato do vínculo: continua o PIS de 11 dígitos do arquivo
  assert.equal((db.prepare('SELECT device_employee_no AS n FROM employee_device_bindings').get() as any).n, pis);
  assert.equal(count('sync_jobs'), 0);
});

test('exportação (CSV): evento 0+PIS identifica o servidor; 11 dígitos continua; inválido não associa; evento intacto', async () => {
  wipe();
  const { exportGenericCsv } = await import('../src/services/exporter.js');
  const pis = '12864722692';
  addRawEvent('0' + pis, 20);            // Topdata: 12 posições
  addRawEvent(pis, 21);                  // 11 dígitos exatos
  addRawEvent('0' + '99999999999', 22);  // outro PIS
  addRawEvent('1' + pis, 23);            // 12 dígitos sem 0 inicial
  addRawEvent('0' + pis.slice(0, 10) + 'X', 24); // 12 posições com letra
  runImport(db, [rec('SERVIDOR EXPORTA', '4001-00', pis)], { apply: true });
  const antes = snapshot(); const fp = eventsFingerprint(db);

  const cwd = process.cwd(); process.chdir(tmp);
  let out: { filePath: string; count: number };
  try { out = exportGenericCsv('2026-10'); } finally { process.chdir(cwd); }

  assert.equal(out.count, 5); // nenhuma linha duplicada pelo JOIN
  const linhas = fs.readFileSync(out.filePath, 'utf8').split('\n').slice(1).map((l) => l.split(';').map((c) => c.replace(/^"|"$/g, '')));
  const porNo = new Map(linhas.map((c) => [c[4], c])); // coluna 4 = device_employee_no do evento
  assert.equal(porNo.get('0' + pis)![3], 'SERVIDOR EXPORTA');   // 0 + PIS associado
  assert.equal(porNo.get('0' + pis)![2], '4001-00');            // matrícula do servidor
  assert.equal(porNo.get(pis)![3], 'SERVIDOR EXPORTA');         // 11 dígitos exatos continua
  for (const no of ['0' + '99999999999', '1' + pis, '0' + pis.slice(0, 10) + 'X']) assert.equal(porNo.get(no)![3], '', `${no} não pode associar`);
  assert.equal(porNo.get('0' + pis)![4], '0' + pis); // o identificador original sai como foi coletado

  assert.deepEqual(snapshot(), antes); assert.equal(eventsFingerprint(db), fp); // device_events intacto
  assert.equal(count('sync_jobs'), 0);
});

test('caso real simulado: 24 servidores + 2 batidas Topdata de 12 posições → dry-run prevê 2 identificadas; IMPORTED segue protegido', async () => {
  wipe();
  const lista = Array.from({ length: 24 }, (_, i) => rec(`SERVIDOR ${i + 1}`, `${3000 + i}-00`, String(10000000000 + i * 7919)));
  addRawEvent('0' + lista[0].deviceEmployeeNo, 100);
  addRawEvent('0' + lista[5].deviceEmployeeNo, 101);
  const fp = eventsFingerprint(db);

  const dry = runImport(db, lista, { apply: false });
  assert.equal(dry.applied, false); assert.equal(dry.created, 24); assert.equal(dry.errors.length, 0);
  assert.deepEqual([dry.attendance.before, dry.attendance.after, dry.attendance.total], [0, 2, 2]);
  assert.equal(count('employees'), 0); assert.equal(count('sync_jobs'), 0);

  const real = runImport(db, lista, { apply: true });
  assert.deepEqual([real.attendance.before, real.attendance.after], [0, 2]);
  assert.equal(count('employees'), 24); assert.equal(count('sync_jobs'), 0);
  assert.equal(eventsFingerprint(db), fp);

  await withApi(async (post) => {
    const first = (db.prepare('SELECT id FROM employees ORDER BY id LIMIT 1').get() as any).id;
    await setTestPin(post, first);
    const blocked = await post(`/api/employees/${first}/sync`, { deviceId: DEV });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, 'sync_blocked_imported');
  });
  assert.equal(count('sync_jobs'), 0);
});

test('cadastro: cpf, PIS (deviceEmployeeNo) e matrícula ficam independentes; zeros à esquerda preservados', async () => {
  wipe();
  await withApi(async (post) => {
    const r = await post('/api/employees', { name: 'COM PIS', registration: '1234-00', cpf: '01234567890', deviceEmployeeNo: '00123456789', deviceIds: [DEV] });
    assert.equal(r.status, 201);
  });
  const emp = db.prepare('SELECT * FROM employees').get() as any;
  assert.equal(emp.cpf, '01234567890');                 // CPF na coluna de CPF, com zero à esquerda
  assert.equal(emp.registration, '1234-00');            // matrícula independente
  assert.equal(emp.device_employee_no, '00123456789');  // PIS como identificador central
  const bind = db.prepare('SELECT * FROM employee_device_bindings').get() as any;
  assert.equal(bind.device_employee_no, '00123456789'); // vínculo recebe o PIS, não o CPF
  assert.notEqual(bind.device_employee_no, emp.cpf);
  assert.equal(count('sync_jobs'), 0);
  assert.equal(bind.sync_status, 'READY');
});

test('cadastro: REP Topdata exige PIS/PASEP (não usa CPF nem matrícula no lugar) e nada é gravado', async () => {
  wipe();
  await withApi(async (post) => {
    const r = await post('/api/employees', { name: 'SEM PIS', registration: '9', cpf: '12345678901', deviceIds: [DEV] });
    assert.equal(r.status, 400); assert.match(r.json.error, /PIS\/PASEP/);
  });
  assert.equal(count('employees'), 0); assert.equal(count('employee_device_bindings'), 0); assert.equal(count('sync_jobs'), 0);
});

test('cadastro: REP não-Topdata continua aceitando matrícula/CPF sem PIS', async () => {
  wipe();
  db.prepare(`INSERT OR IGNORE INTO devices(id,name,vendor,role,transport) VALUES('rep-outro','REP Outro','ACME','PRIMARY','DIRECT')`).run();
  await withApi(async (post) => {
    const r = await post('/api/employees', { name: 'OUTRO REP', registration: '77', deviceIds: ['rep-outro'] });
    assert.equal(r.status, 201);
  });
  assert.equal((db.prepare('SELECT device_employee_no AS n FROM employee_device_bindings').get() as any).n, '77');
});

test('cadastro: valores numéricos (perdem zeros) e tamanhos inválidos são recusados', async () => {
  wipe();
  await withApi(async (post) => {
    assert.equal((await post('/api/employees', { name: 'X', deviceEmployeeNo: 12345678901, deviceIds: [DEV] })).status, 400);
    assert.equal((await post('/api/employees', { name: 'X', cpf: 12345678901, deviceEmployeeNo: '12345678901' })).status, 400);
    assert.equal((await post('/api/employees', { name: 'X', cpf: '123', deviceEmployeeNo: '12345678901' })).status, 400);
    assert.equal((await post('/api/employees', { name: 'X', deviceEmployeeNo: '123' })).status, 400);
  });
  assert.equal(count('employees'), 0);
});

test('cadastro não altera device_events existentes', async () => {
  wipe(); addRawEvent('012345678901', 500, 'LINHA-AFD');
  const antes = snapshot(); const fp = eventsFingerprint(db);
  await withApi(async (post) => {
    assert.equal((await post('/api/employees', { name: 'NOVO', deviceEmployeeNo: '12345678901', deviceIds: [DEV] })).status, 201);
  });
  assert.deepEqual(snapshot(), antes); assert.equal(eventsFingerprint(db), fp);
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

test('desativar/reativar preserva histórico e não envia exclusão ao REP', async () => {
  wipe();
  addRawEvent('012345678901', 700, 'LINHA-AFD-DESATIVACAO');
  const before = snapshot();
  const fp = eventsFingerprint(db);

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const create = await fetch(base + '/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVIDOR DESATIVAVEL',
        registration: '7000-00',
        deviceEmployeeNo: '12345678901',
        deviceIds: [DEV]
      })
    });
    assert.equal(create.status, 201);
    const created = await create.json() as any;
    assert.equal(count('sync_jobs'), 0);
    assert.equal((db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s, 'READY');

    const deactivate = await fetch(base + `/api/employees/${created.id}/active`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    });
    assert.equal(deactivate.status, 200);
    const deactivated = await deactivate.json() as any;
    assert.equal(deactivated.active, false);
    assert.match(deactivated.message, /Nenhuma exclusão foi enviada ao REP/);

    assert.equal((db.prepare('SELECT active FROM employees WHERE id=?').get(created.id) as any).active, 0);
    assert.equal(count('sync_jobs'), 0);
    assert.equal(
      (db.prepare('SELECT sync_status AS s FROM employee_device_bindings').get() as any).s,
      'READY'
    );
    assert.equal(count('employee_device_bindings'), 1);

    const syncInactive = await fetch(base + `/api/employees/${created.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(syncInactive.status, 409);
    assert.equal((await syncInactive.json() as any).error, 'employee_inactive');
    assert.equal(count('sync_jobs'), 0);

    const reactivate = await fetch(base + `/api/employees/${created.id}/active`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true })
    });
    assert.equal(reactivate.status, 200);
    assert.equal((db.prepare('SELECT active FROM employees WHERE id=?').get(created.id) as any).active, 1);
    assert.equal(count('sync_jobs'), 0); // reativar não sincroniza automaticamente

    assert.deepEqual(snapshot(), before);
    assert.equal(eventsFingerprint(db), fp);
    const actions = db.prepare(`
      SELECT action FROM audit_log
      WHERE entity_type='employee' AND entity_id=?
      ORDER BY id
    `).all(String(created.id)) as any[];
    assert.deepEqual(actions.map((row) => row.action), [
      'EMPLOYEE_CREATE',
      'EMPLOYEE_DEACTIVATE',
      'EMPLOYEE_ACTIVATE'
    ]);
  } finally {
    server.close();
  }
});

test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
