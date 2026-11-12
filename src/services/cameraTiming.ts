export type MinutePrecisionAgeWindow = {
  minAgeMs: number;
  maxAgeMs: number;
};

export function wallClockMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return null;

  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  );
}

export function minutePrecisionAgeWindow(
  occurredAt: string,
  currentWallClockEpochMs: number,
  bufferMs: number,
  minimumCandidateAgeMs: number
): MinutePrecisionAgeWindow | null {
  const minuteStart = wallClockMs(occurredAt);
  if (minuteStart == null) return null;

  const minuteEnd = minuteStart + 59_999;
  const maxAgeMs = currentWallClockEpochMs - minuteStart;
  if (maxAgeMs < 0) return null;

  const minAgeMs = Math.max(
    minimumCandidateAgeMs,
    currentWallClockEpochMs - minuteEnd,
    0
  );

  const boundedMaxAgeMs = Math.min(
    maxAgeMs,
    Math.max(0, bufferMs - 1000)
  );

  if (minAgeMs > boundedMaxAgeMs) return null;

  return {
    minAgeMs,
    maxAgeMs: boundedMaxAgeMs
  };
}

export function minutePrecisionEventIsRecent(
  occurredAt: string,
  currentWallClockEpochMs: number,
  maxAgeMs: number
): boolean {
  const minuteStart = wallClockMs(occurredAt);
  if (minuteStart == null) return false;

  const minuteEnd = minuteStart + 59_999;
  const earliestPossibleAgeMs = currentWallClockEpochMs - minuteEnd;
  const latestPossibleAgeMs = currentWallClockEpochMs - minuteStart;

  // O AFD informa apenas o minuto. Consideramos recente quando a faixa de
  // instantes possiveis daquele minuto intersecta a janela permitida.
  return latestPossibleAgeMs >= -30_000
    && earliestPossibleAgeMs <= maxAgeMs;
}
