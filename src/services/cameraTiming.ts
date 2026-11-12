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

export function eventEpochFromWallClock(
  occurredAt: string,
  nowEpochMs: number,
  currentWallClockEpochMs: number
): number | null {
  const occurredWallClockMs = wallClockMs(occurredAt);
  if (occurredWallClockMs == null) return null;

  const ageMs = currentWallClockEpochMs - occurredWallClockMs;
  return nowEpochMs - ageMs;
}
