import { db } from '../storage/db.js';
import type { DeviceEvent } from '../core/types.js';

const insertEvent = db.prepare(`
INSERT OR IGNORE INTO device_events
(source_id, device_id, employee_no, card_no, occurred_at, kind, nsr, attendance_status, raw_type, raw_payload)
VALUES (@sourceId, @deviceId, @employeeNo, @cardNo, @occurredAt, @kind, @nsr, @attendanceStatus, @rawType, @rawPayload)
`);

export function saveEvents(events: DeviceEvent[]): number {
  const tx = db.transaction((items: DeviceEvent[]) => {
    let inserted = 0;
    for (const event of items) {
      inserted += insertEvent.run({
        ...event,
        employeeNo: event.employeeNo ?? null,
        cardNo: event.cardNo ?? null,
        nsr: event.nsr ?? null,
        attendanceStatus: event.attendanceStatus ?? null,
        rawType: event.rawType ?? null
      }).changes;
    }
    return inserted;
  });
  return tx(events);
}

export function listAttendance(period?: string) {
  const base = `
    SELECT e.*, emp.name, emp.cpf, emp.registration, d.name AS device_name, d.role AS device_role
    FROM device_events e
    LEFT JOIN employee_device_bindings b
      ON b.device_id = e.device_id AND b.device_employee_no = e.employee_no
    LEFT JOIN employees emp ON emp.id = b.employee_id
    LEFT JOIN devices d ON d.id = e.device_id
    WHERE e.kind='ATTENDANCE'
  `;

  if (period) {
    return db.prepare(base + `
      AND substr(e.occurred_at,1,7)=?
      ORDER BY e.occurred_at DESC
    `).all(period);
  }

  return db.prepare(base + `
    ORDER BY e.occurred_at DESC
    LIMIT 500
  `).all();
}
