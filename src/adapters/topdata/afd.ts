export interface TopdataLegacyMark {
  nsr: number;
  recordType: '3';
  occurredAt: string;
  employeeIdentifier: string;
  raw: string;
}

export function parseTopdataLegacyMark(line: string): TopdataLegacyMark {
  const raw = line.trim();

  if (!/^\d{34}$/.test(raw)) {
    throw new Error(`topdata_legacy_invalid_length_or_chars:${raw.length}`);
  }

  const nsrText = raw.slice(0, 9);
  const recordType = raw.slice(9, 10);
  const date = raw.slice(10, 18);
  const time = raw.slice(18, 22);
  const employeeIdentifier = raw.slice(22, 34);

  if (recordType !== '3') {
    throw new Error(`topdata_legacy_not_attendance_type:${recordType}`);
  }

  const day = Number(date.slice(0, 2));
  const month = Number(date.slice(2, 4));
  const year = Number(date.slice(4, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));

  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    year < 2000 || year > 2100 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error('topdata_legacy_invalid_datetime');
  }

  return {
    nsr: Number(nsrText),
    recordType: '3',
    occurredAt:
      `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T` +
      `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
    employeeIdentifier,
    raw
  };
}
