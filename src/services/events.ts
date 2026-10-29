import { db } from '../storage/db.js';
import type { DeviceEvent } from '../core/types.js';
import { employeeNoMatchSql } from '../core/employeeMatch.js';

const insertEvent = db.prepare(`
INSERT OR IGNORE INTO device_events
(source_id, device_id, employee_no, card_no, occurred_at, kind, nsr, attendance_status, raw_type, raw_payload)
VALUES (@sourceId, @deviceId, @employeeNo, @cardNo, @occurredAt, @kind, @nsr, @attendanceStatus, @rawType, @rawPayload)
`);

const attendanceNotificationTarget = db.prepare(`
  SELECT
    emp.id AS employee_id,
    emp.name AS employee_name,
    emp.whatsapp_number,
    d.name AS device_name
  FROM device_events e
  JOIN employee_device_bindings b
    ON b.device_id=e.device_id
   AND b.enabled=1
   AND ${employeeNoMatchSql('b', 'e')}
  JOIN employees emp
    ON emp.id=b.employee_id
   AND emp.active=1
   AND emp.whatsapp_attendance_enabled=1
   AND emp.whatsapp_number IS NOT NULL
  JOIN devices d ON d.id=e.device_id
  WHERE e.id=?
  ORDER BY b.id
  LIMIT 1
`);

const insertAttendanceNotification = db.prepare(`
  INSERT OR IGNORE INTO attendance_notifications(
    event_id, employee_id, destination, message
  )
  VALUES(?,?,?,?)
`);

function formatOccurrence(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]} às ${match[4]}:${match[5]}`;
}

function attendanceMessage(
  employeeName: string,
  occurredAt: string,
  deviceName: string,
  nsr?: number
): string {
  const firstName = employeeName.trim().split(/\s+/)[0] || employeeName;
  const nsrLine = nsr == null ? '' : `\nNSR: ${nsr}`;

  return [
    '✅ Ponto registrado',
    '',
    `${firstName}, sua marcação foi registrada em ${formatOccurrence(occurredAt)}.`,
    `Equipamento: ${deviceName}${nsrLine}`,
    '',
    'Câmara Municipal de Três Barras'
  ].join('\n');
}

export function saveEvents(events: DeviceEvent[]): number {
  const tx = db.transaction((items: DeviceEvent[]) => {
    let inserted = 0;
    for (const event of items) {
      const result = insertEvent.run({
        ...event,
        employeeNo: event.employeeNo ?? null,
        cardNo: event.cardNo ?? null,
        nsr: event.nsr ?? null,
        attendanceStatus: event.attendanceStatus ?? null,
        rawType: event.rawType ?? null
      });

      inserted += result.changes;

      if (result.changes === 1 && event.kind === 'ATTENDANCE') {
        const eventId = Number(result.lastInsertRowid);
        const target = attendanceNotificationTarget.get(eventId) as
          | {
              employee_id: number;
              employee_name: string;
              whatsapp_number: string;
              device_name: string;
            }
          | undefined;

        if (target) {
          insertAttendanceNotification.run(
            eventId,
            target.employee_id,
            target.whatsapp_number,
            attendanceMessage(
              target.employee_name,
              event.occurredAt,
              target.device_name,
              event.nsr
            )
          );
        }
      }
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
      ON b.device_id = e.device_id AND ${employeeNoMatchSql('b', 'e')}
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
