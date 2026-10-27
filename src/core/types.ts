export type EventKind = 'ACCESS' | 'ATTENDANCE';

export interface DeviceEvent {
  sourceId: string;
  deviceId: string;
  employeeNo?: string;
  cardNo?: string;
  occurredAt: string;
  kind: EventKind;
  attendanceStatus?: string;
  rawType?: string;
  rawPayload: string;
}

export interface Employee {
  id?: number;
  name: string;
  cpf?: string;
  registration?: string;
  deviceEmployeeNo: string;
  active: boolean;
}
