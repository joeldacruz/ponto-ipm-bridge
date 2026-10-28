import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptPin, encryptPin, isValidPin } from '../src/security/pin.js';

test('PIN deve ter exatamente quatro digitos', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('0000'), true);
  assert.equal(isValidPin('123'), false);
  assert.equal(isValidPin('12345'), false);
  assert.equal(isValidPin('12a4'), false);
});

test('PIN é cifrado com AES-GCM e recuperado somente com a chave correta', () => {
  const old = process.env.PIN_ENCRYPTION_KEY;
  process.env.PIN_ENCRYPTION_KEY = '11'.repeat(32);

  try {
    const encrypted = encryptPin('0427');
    assert.notEqual(encrypted.ciphertext, '0427');
    assert.equal(decryptPin(encrypted.ciphertext, encrypted.iv, encrypted.tag), '0427');

    process.env.PIN_ENCRYPTION_KEY = '22'.repeat(32);
    assert.throws(() => decryptPin(encrypted.ciphertext, encrypted.iv, encrypted.tag));
  } finally {
    if (old == null) delete process.env.PIN_ENCRYPTION_KEY;
    else process.env.PIN_ENCRYPTION_KEY = old;
  }
});
