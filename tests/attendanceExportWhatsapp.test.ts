import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-export-whatsapp-'));
process.env.DB_PATH = path.join(tmp, 'ponto.db');
delete process.env.TOPDATA_HOST;
delete process.env.WHATSAPP_GATEWAY_API_KEY;

let db: typeof import('../src/storage/db.js')['db'];
let saveEvents: typeof import('../src/services/events.js')['saveEvents'];
let buildAttendanceAfdDownload: typeof import('../src/services/exporter.js')['buildAttendanceAfdDownload'];
let buildGenericCsvDownload: typeof import('../src/services/exporter.js')['buildGenericCsvDownload'];
let normalizeWhatsappNumber: typeof import('../src/services/whatsapp.js')['normalizeWhatsappNumber'];

const DEV = 'rep-topdata-test';
const PIS = '00123456789';
const REP_EMPLOYEE = '000123456789';
const RAW = '0000001233291020260828' + REP_EMPLOYEE;

test.before(async () => {
  ({ db } = await import('../src/storage/db.js'));
  ({ saveEvents } = await import('../src/services/events.js'));
  ({ buildAttendanceAfdDownload, buildGenericCsvDownload } = await import('../src/services/exporter.js'));
  ({ normalizeWhatsappNumber } = await import('../src/services/whatsapp.js'));

  db.prepare(`
    INSERT INTO devices(id,name,vendor,model,role,transport,active)
    VALUES(?,?,?,?,?,?,1)
  `).run(DEV, 'REP Topdata Teste', 'TOPDATA', 'Inner REP Bio', 'SECONDARY', 'WINDOWS_AGENT');
});

function wipe(): void {
  db.exec(`
    DELETE FROM attendance_notifications;
    DELETE FROM exports;
    DELETE FROM device_events;
    DELETE FROM employee_device_bindings;
    DELETE FROM employees;
  `);
}

function createEmployee(enabled = true): number {
  const result = db.prepare(`
    INSERT INTO employees(
      name, registration, device_employee_no,
      whatsapp_number, whatsapp_attendance_enabled
    )
    VALUES(?,?,?,?,?)
  `).run(
    'ANA TESTE',
    '1001-00',
    PIS,
    '5547999999999',
    enabled ? 1 : 0
  );

  const id = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO employee_device_bindings(
      employee_id, device_id, device_employee_no, sync_status
    )
    VALUES(?,?,?,'DONE')
  `).run(id, DEV, PIS);

  return id;
}

test('normaliza WhatsApp brasileiro sem perder o DDI já informado', () => {
  assert.equal(normalizeWhatsappNumber('(47) 99999-9999'), '5547999999999');
  assert.equal(normalizeWhatsappNumber('5547999999999'), '5547999999999');
  assert.equal(normalizeWhatsappNumber(''), null);
  assert.throws(() => normalizeWhatsappNumber('1234'), /whatsapp_number_invalid/);
});

test('nova batida salva primeiro e cria uma única notificação WhatsApp', () => {
  wipe();
  createEmployee(true);

  assert.equal(RAW.length, 34);

  const event = {
    sourceId: DEV + ':123',
    deviceId: DEV,
    employeeNo: REP_EMPLOYEE,
    occurredAt: '2026-10-29T08:28:00',
    kind: 'ATTENDANCE' as const,
    nsr: 123,
    rawType: '3',
    rawPayload: RAW
  };

  assert.equal(saveEvents([event]), 1);
  assert.equal(saveEvents([event]), 0);

  const notification = db.prepare(`
    SELECT destination, message, status, attempts
    FROM attendance_notifications
  `).get() as any;

  assert.equal(notification.destination, '5547999999999');
  assert.equal(notification.status, 'PENDING');
  assert.equal(notification.attempts, 0);
  assert.match(notification.message, /29\/10\/2026 às 08:28/);
  assert.match(notification.message, /NSR: 123/);

  const total = db.prepare('SELECT COUNT(*) AS n FROM attendance_notifications').get() as { n: number };
  assert.equal(total.n, 1);
});

test('servidor com confirmação desativada não entra na fila do WhatsApp', () => {
  wipe();
  createEmployee(false);

  saveEvents([{
    sourceId: DEV + ':124',
    deviceId: DEV,
    employeeNo: REP_EMPLOYEE,
    occurredAt: '2026-10-29T09:00:00',
    kind: 'ATTENDANCE',
    nsr: 124,
    rawType: '3',
    rawPayload: '0000001243291020260900' + REP_EMPLOYEE
  }]);

  const total = db.prepare('SELECT COUNT(*) AS n FROM attendance_notifications').get() as { n: number };
  assert.equal(total.n, 0);
});

test('AFD de download preserva exatamente a linha tipo 3 coletada', () => {
  wipe();
  createEmployee(false);

  saveEvents([{
    sourceId: DEV + ':123',
    deviceId: DEV,
    employeeNo: REP_EMPLOYEE,
    occurredAt: '2026-10-29T08:28:00',
    kind: 'ATTENDANCE',
    nsr: 123,
    rawType: '3',
    rawPayload: RAW
  }]);

  const out = buildAttendanceAfdDownload('2026-10', DEV);

  assert.equal(out.count, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.content, RAW + '\r\n');
  assert.equal(out.fileName, 'AFD-rep-topdata-test-2026-10.txt');
});

test('CSV de conferência associa o servidor pelo PIS de 11 dígitos', () => {
  wipe();
  createEmployee(false);

  saveEvents([{
    sourceId: DEV + ':125',
    deviceId: DEV,
    employeeNo: REP_EMPLOYEE,
    occurredAt: '2026-10-29T10:15:00',
    kind: 'ATTENDANCE',
    nsr: 125,
    rawType: '3',
    rawPayload: '0000001253291020261015' + REP_EMPLOYEE
  }]);

  const out = buildGenericCsvDownload('2026-10', DEV);

  assert.equal(out.count, 1);
  assert.match(out.content, /ANA TESTE/);
  assert.match(out.content, /1001-00/);
  assert.match(out.content, /000123456789/);
});
