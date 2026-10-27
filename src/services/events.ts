import { db } from '../storage/db.js';
import type { DeviceEvent } from '../core/types.js';

const insertEvent = db.prepare(`
INSERT OR IGNORE INTO device_events
(source_id, device_id, employee_no, card_no, occurred_at, kind, attendance_status, raw_type, raw_payload)
VALUES (@sourceId, @deviceId, @employeeNo, @cardNo, @occurredAt, @kind, @attendanceStatus, @rawType, @rawPayload)
`);

export function saveEvents(events: DeviceEvent[]): number {
  const tx = db.transaction((items: DeviceEvent[]) => {
    let inserted = 0;
    for (const event of items) inserted += insertEvent.run(event).changes;
    return inserted;
  });
  return tx(events);
}

export function listAttendance(period?: string) {
  if (period) {
    return db.prepare(`
      SELECT e.*, emp.name, emp.cpf, emp.registration
      FROM device_events e
      LEFT JOIN employees emp ON emp.device_employee_no = e.employee_no
      WHERE e.kind='ATTENDANCE' AND substr(e.occurred_at,1,7)=?
      ORDER BY e.occurred_at DESC
    `).all(period);
  }
  return db.prepare(`
    SELECT e.*, emp.name, emp.cpf, emp.registration
    FROM device_events e
    LEFT JOIN employees emp ON emp.device_employee_no = e.employee_no
    WHERE e.kind='ATTENDANCE'
    ORDER BY e.occurred_at DESC
    LIMIT 500
  `).all();
}
