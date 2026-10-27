export type EventKind = 'ACCESS' | 'ATTENDANCE';
export type DeviceRole = 'PRIMARY' | 'SECONDARY';
export type DeviceStatus = 'UNKNOWN' | 'ONLINE' | 'OFFLINE';
export type SyncOperation = 'UPSERT_EMPLOYEE' | 'DELETE_EMPLOYEE';
export type SyncStatus = 'PENDING' | 'LEASED' | 'DONE' | 'ERROR';

export interface DeviceEvent {
  sourceId: string;
  deviceId: string;
  employeeNo?: string;
  cardNo?: string;
  occurredAt: string;
  kind: EventKind;
  nsr?: number;
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

export interface Device {
  id: string;
  name: string;
  vendor: string;
  model?: string;
  role: DeviceRole;
  transport: 'DIRECT' | 'WINDOWS_AGENT';
  host?: string;
  port?: number;
  agentId?: string;
  active: boolean;
  status: DeviceStatus;
}
