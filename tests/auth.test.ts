import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-auth-'));
process.env.DB_PATH = path.join(tmp, 'ponto.db');
delete process.env.TOPDATA_HOST;

let db: typeof import('../src/storage/db.js')['db'];
let hashPassword: typeof import('../src/security/auth.js')['hashPassword'];
let verifyPassword: typeof import('../src/security/auth.js')['verifyPassword'];
let authenticateUser: typeof import('../src/security/auth.js')['authenticateUser'];

test.before(async () => {
  ({ db } = await import('../src/storage/db.js'));
  ({ hashPassword, verifyPassword, authenticateUser } = await import('../src/security/auth.js'));
});

test('cria os dois usuários iniciais sem senha em texto', () => {
  const rows = db.prepare(`
    SELECT name,email,role,password_hash
    FROM app_users
    ORDER BY email
  `).all() as Array<{
    name: string;
    email: string;
    role: string;
    password_hash: string | null;
  }>;

  assert.equal(rows.length, 2);

  const joel = rows.find((x) => x.email === 'joeldacruz@gmail.com');
  const josiele = rows.find((x) => x.email === 'josy_con_tabil@hotmail.com');

  assert.equal(joel?.name, 'Joel da Cruz');
  assert.equal(joel?.role, 'ADMIN');
  assert.equal(joel?.password_hash, null);

  assert.equal(josiele?.name, 'Josiele Tischler');
  assert.equal(josiele?.role, 'OPERATOR');
  assert.equal(josiele?.password_hash, null);
});

test('senha usa scrypt com salt e valida somente a senha correta', () => {
  const encoded1 = hashPassword('SenhaSegura#2026');
  const encoded2 = hashPassword('SenhaSegura#2026');

  assert.match(encoded1, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.notEqual(encoded1, encoded2);
  assert.equal(verifyPassword('SenhaSegura#2026', encoded1), true);
  assert.equal(verifyPassword('OutraSenha#2026', encoded1), false);
});

test('política rejeita senha curta', () => {
  assert.throws(() => hashPassword('curta'), /PASSWORD_POLICY/);
});

test('usuário sem senha é direcionado para recuperação', () => {
  const result = authenticateUser('joeldacruz@gmail.com', 'qualquer');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'password_not_set');
});
