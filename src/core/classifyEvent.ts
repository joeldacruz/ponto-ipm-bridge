import type { EventKind } from './types.js';

/**
 * Regra inicial para Hikvision:
 * - evento com attendanceStatus significativo => frequência/ponto;
 * - demais autenticações => acesso.
 *
 * A lista final será homologada com eventos reais do DS-K1T342MX-E1.
 */
export function classifyEvent(attendanceStatus?: string | null): EventKind {
  const value = (attendanceStatus ?? '').trim().toLowerCase();
  if (!value || value === 'undefined' || value === 'none' || value === '0') {
    return 'ACCESS';
  }
  return 'ATTENDANCE';
}
