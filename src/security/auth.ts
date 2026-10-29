import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../storage/db.js';
import { isGmailConfigured, sendPasswordRecoveryEmail } from '../services/email.js';
import { sendWhatsappMessage } from '../services/whatsapp.js';

const SESSION_COOKIE = 'ponto_session';
const SESSION_HOURS = Math.max(1, Number(process.env.AUTH_SESSION_HOURS || 12));
const RESET_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;

export type AppUser = {
  id: number;
  name: string;
  email: string;
  role: string;
  whatsapp_number: string | null;
};

function sqlTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resetPepper(): string {
  const value = process.env.AUTH_RESET_PEPPER?.trim();
  if (!value) throw new Error('AUTH_RESET_PEPPER_NOT_CONFIGURED');
  return value;
}

function resetCodeHash(userId: number, code: string): string {
  return sha256(`${userId}:${code}:${resetPepper()}`);
}

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new Error('PASSWORD_POLICY');
  }

  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, encoded: string | null): boolean {
  if (!encoded || typeof password !== 'string') return false;

  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function sessionTokenHash(token: string): string {
  return sha256(token);
}

function secureCookie(req: Request): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim();
  if (configured === '1' || configured?.toLowerCase() === 'true') return true;
  if (configured === '0' || configured?.toLowerCase() === 'false') return false;
  return req.secure || req.header('x-forwarded-proto') === 'https';
}

export function getSessionUser(req: Request): AppUser | null {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  return (db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.whatsapp_number
    FROM app_sessions s
    JOIN app_users u ON u.id=s.user_id
    WHERE s.token_hash=?
      AND s.expires_at > CURRENT_TIMESTAMP
      AND u.active=1
    LIMIT 1
  `).get(sessionTokenHash(token)) as AppUser | undefined) || null;
}

export function createUserSession(req: Request, res: Response, userId: number): void {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);

  db.prepare('DELETE FROM app_sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
  db.prepare(`
    INSERT INTO app_sessions(user_id, token_hash, expires_at)
    VALUES(?,?,?)
  `).run(userId, sessionTokenHash(token), sqlTimestamp(expires));

  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_HOURS * 60 * 60}`
  ];
  if (secureCookie(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function destroyUserSession(req: Request, res: Response): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    db.prepare('DELETE FROM app_sessions WHERE token_hash=?').run(sessionTokenHash(token));
  }

  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (secureCookie(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function requireApiSession(req: Request, res: Response, next: NextFunction) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  next();
}

export function requirePageSession(req: Request, res: Response, next: NextFunction) {
  const user = getSessionUser(req);
  if (!user) {
    const nextPath = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(302, `/login.html?next=${nextPath}`);
  }
  next();
}

export function authenticateUser(
  email: string,
  password: string
): { ok: true; user: AppUser } | { ok: false; error: string } {
  const normalized = String(email || '').trim().toLowerCase();
  const row = db.prepare(`
    SELECT id, name, email, role, whatsapp_number, password_hash, active
    FROM app_users
    WHERE lower(email)=?
    LIMIT 1
  `).get(normalized) as (AppUser & {
    password_hash: string | null;
    active: number;
  }) | undefined;

  if (!row || !row.active) return { ok: false, error: 'invalid_credentials' };
  if (!row.password_hash) return { ok: false, error: 'password_not_set' };
  if (!verifyPassword(password, row.password_hash)) {
    return { ok: false, error: 'invalid_credentials' };
  }

  return {
    ok: true,
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      whatsapp_number: row.whatsapp_number
    }
  };
}

export async function requestPasswordRecovery(
  email: string,
  channel: 'EMAIL' | 'WHATSAPP'
): Promise<{ accepted: boolean; message: string }> {
  const normalized = String(email || '').trim().toLowerCase();
  const user = db.prepare(`
    SELECT id, name, email, role, whatsapp_number
    FROM app_users
    WHERE lower(email)=? AND active=1
    LIMIT 1
  `).get(normalized) as AppUser | undefined;

  if (!user) {
    return {
      accepted: true,
      message: 'Se o usuário estiver cadastrado, o código será enviado pelo canal escolhido.'
    };
  }

  const recent = db.prepare(`
    SELECT 1
    FROM password_reset_codes
    WHERE user_id=?
      AND created_at > datetime('now','-60 seconds')
    LIMIT 1
  `).get(user.id);
  if (recent) throw new Error('RECOVERY_RATE_LIMIT');

  if (channel === 'EMAIL' && !isGmailConfigured()) {
    throw new Error('GMAIL_RECOVERY_NOT_CONFIGURED');
  }
  if (channel === 'WHATSAPP' && !user.whatsapp_number) {
    throw new Error('WHATSAPP_RECOVERY_NOT_CONFIGURED');
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expires = new Date(Date.now() + RESET_MINUTES * 60 * 1000);
  const codeHash = resetCodeHash(user.id, code);

  db.prepare(`
    UPDATE password_reset_codes
    SET consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP)
    WHERE user_id=? AND consumed_at IS NULL
  `).run(user.id);

  const result = db.prepare(`
    INSERT INTO password_reset_codes(user_id, channel, code_hash, expires_at)
    VALUES(?,?,?,?)
  `).run(user.id, channel, codeHash, sqlTimestamp(expires));

  try {
    if (channel === 'EMAIL') {
      await sendPasswordRecoveryEmail(user.email, user.name, code);
    } else {
      await sendWhatsappMessage(
        String(user.whatsapp_number),
        [
          '🔐 Recuperação de senha',
          '',
          `${user.name}, seu código do Ponto Eletrônico é: ${code}`,
          '',
          'Validade: 15 minutos.',
          'Câmara Municipal de Três Barras'
        ].join('\n')
      );
    }
  } catch (error) {
    db.prepare('DELETE FROM password_reset_codes WHERE id=?').run(Number(result.lastInsertRowid));
    throw error;
  }

  return {
    accepted: true,
    message: channel === 'EMAIL'
      ? 'Código enviado por e-mail.'
      : 'Código enviado por WhatsApp.'
  };
}

export function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string
): void {
  const normalized = String(email || '').trim().toLowerCase();
  const user = db.prepare(`
    SELECT id
    FROM app_users
    WHERE lower(email)=? AND active=1
    LIMIT 1
  `).get(normalized) as { id: number } | undefined;

  if (!user) throw new Error('RECOVERY_INVALID');

  const row = db.prepare(`
    SELECT id, code_hash, attempts
    FROM password_reset_codes
    WHERE user_id=?
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY id DESC
    LIMIT 1
  `).get(user.id) as {
    id: number;
    code_hash: string;
    attempts: number;
  } | undefined;

  if (!row || row.attempts >= RESET_MAX_ATTEMPTS) {
    throw new Error('RECOVERY_INVALID');
  }

  db.prepare(`
    UPDATE password_reset_codes
    SET attempts=attempts+1
    WHERE id=?
  `).run(row.id);

  const suppliedHash = resetCodeHash(user.id, String(code || '').trim());
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(suppliedHash, 'hex');

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('RECOVERY_INVALID');
  }

  const passwordHash = hashPassword(newPassword);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE app_users
      SET password_hash=?, password_updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(passwordHash, user.id);

    db.prepare(`
      UPDATE password_reset_codes
      SET consumed_at=CURRENT_TIMESTAMP
      WHERE user_id=? AND consumed_at IS NULL
    `).run(user.id);

    db.prepare('DELETE FROM app_sessions WHERE user_id=?').run(user.id);
  });

  tx();
}
