import { db } from '../storage/db.js';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:3061';
const MAX_ATTEMPTS = 5;

export function normalizeWhatsappNumber(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;

  // Brasil: aceita DDD+número (10/11 dígitos) ou número já com DDI 55 (12/13 dígitos).
  if (/^\d{10,11}$/.test(digits)) return '55' + digits;
  if (/^55\d{10,11}$/.test(digits)) return digits;

  throw new Error('whatsapp_number_invalid');
}

export function isWhatsappGatewayConfigured(): boolean {
  return !!process.env.WHATSAPP_GATEWAY_API_KEY?.trim();
}

export async function sendWhatsappMessage(destination: string, message: string): Promise<void> {
  const apiKey = process.env.WHATSAPP_GATEWAY_API_KEY?.trim();
  if (!apiKey) throw new Error('WHATSAPP_GATEWAY_API_KEY não configurada.');

  const baseUrl = (process.env.WHATSAPP_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(baseUrl + '/api/mensagem', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        destino: destination,
        mensagem: message
      }),
      signal: controller.signal
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Gateway WhatsApp HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function nextRetryModifier(attemptsAfterIncrement: number): string {
  const seconds = Math.min(300, 15 * Math.pow(2, Math.max(0, attemptsAfterIncrement - 1)));
  return `+${Math.round(seconds)} seconds`;
}

let processing = false;

export async function processWhatsappQueue(): Promise<void> {
  if (processing || !isWhatsappGatewayConfigured()) return;
  processing = true;

  try {
    // Recupera itens que ficaram presos se o processo caiu durante um envio.
    db.prepare(`
      UPDATE attendance_notifications
      SET status='ERROR',
          last_error=COALESCE(last_error,'Envio interrompido antes da confirmação.'),
          next_attempt_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      WHERE status='SENDING'
        AND updated_at < datetime('now','-5 minutes')
    `).run();

    const jobs = db.prepare(`
      SELECT id, destination, message, attempts
      FROM attendance_notifications
      WHERE status IN ('PENDING','ERROR')
        AND attempts < ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
      ORDER BY id
      LIMIT 10
    `).all(MAX_ATTEMPTS) as Array<{
      id: number;
      destination: string;
      message: string;
      attempts: number;
    }>;

    for (const job of jobs) {
      const claimed = db.prepare(`
        UPDATE attendance_notifications
        SET status='SENDING',
            attempts=attempts+1,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status IN ('PENDING','ERROR')
      `).run(job.id);

      if (claimed.changes !== 1) continue;

      const attemptNumber = job.attempts + 1;

      try {
        await sendWhatsappMessage(job.destination, job.message);
        db.prepare(`
          UPDATE attendance_notifications
          SET status='DONE',
              sent_at=CURRENT_TIMESTAMP,
              last_error=NULL,
              next_attempt_at=NULL,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(job.id);
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        db.prepare(`
          UPDATE attendance_notifications
          SET status='ERROR',
              last_error=?,
              next_attempt_at=datetime('now', ?),
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(detail, nextRetryModifier(attemptNumber), job.id);
      }
    }
  } finally {
    processing = false;
  }
}

export function startWhatsappWorker(): void {
  if (!isWhatsappGatewayConfigured()) {
    console.log('WhatsApp de batidas: desabilitado (WHATSAPP_GATEWAY_API_KEY ausente).');
    return;
  }

  const intervalSeconds = Math.max(
    5,
    Number(process.env.WHATSAPP_WORKER_INTERVAL_SECONDS || 10)
  );

  console.log(
    `WhatsApp de batidas: habilitado via ${process.env.WHATSAPP_GATEWAY_URL || DEFAULT_GATEWAY_URL}.`
  );

  void processWhatsappQueue();

  const timer = setInterval(() => {
    void processWhatsappQueue();
  }, intervalSeconds * 1000);

  timer.unref();
}
