import crypto from 'node:crypto';

const AAD = Buffer.from('ponto-camara:employee-pin:v1', 'utf8');
const PIN_RE = /^\d{4}$/;

export interface EncryptedPin {
  ciphertext: string;
  iv: string;
  tag: string;
}

function getKey(): Buffer {
  const raw = process.env.PIN_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error('PIN_ENCRYPTION_KEY_not_configured');

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== 32) throw new Error('PIN_ENCRYPTION_KEY_invalid');
  return key;
}

export function isValidPin(value: unknown): value is string {
  return typeof value === 'string' && PIN_RE.test(value);
}

export function encryptPin(pin: string): EncryptedPin {
  if (!isValidPin(pin)) throw new Error('pin_invalid');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  cipher.setAAD(AAD);

  const ciphertext = Buffer.concat([
    cipher.update(pin, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

export function decryptPin(ciphertext: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(iv, 'base64')
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  const value = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');

  if (!isValidPin(value)) throw new Error('pin_decrypted_invalid');
  return value;
}
