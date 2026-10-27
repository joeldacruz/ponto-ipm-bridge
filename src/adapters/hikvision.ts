import { XMLParser } from 'fast-xml-parser';
import { classifyEvent } from '../core/classifyEvent.js';
import type { DeviceEvent } from '../core/types.js';

const parser = new XMLParser({ ignoreAttributes: false });

function basicAuth(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export class HikvisionAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly deviceId = 'hikvision-1'
  ) {}

  /**
   * Consulta eventos via ISAPI. O equipamento pode exigir Digest Auth em produção.
   * Esta implementação inicial deixa o ponto de integração isolado para homologação.
   */
  async fetchEvents(startTime: string, endTime: string): Promise<DeviceEvent[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<AcsEventCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">\n  <searchID>${Date.now()}</searchID>\n  <searchResultPosition>0</searchResultPosition>\n  <maxResults>100</maxResults>\n  <major>0</major>\n  <minor>0</minor>\n  <startTime>${startTime}</startTime>\n  <endTime>${endTime}</endTime>\n</AcsEventCond>`;

    const response = await fetch(`${this.baseUrl}/ISAPI/AccessControl/AcsEvent?format=json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Authorization: basicAuth(this.username, this.password)
      },
      body
    });

    if (!response.ok) {
      throw new Error(`Hikvision respondeu HTTP ${response.status}`);
    }

    const text = await response.text();
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = parser.parse(text);
    }

    const root = payload?.AcsEvent ?? payload?.AcsEventSearchResult ?? payload;
    const infos = root?.InfoList ?? root?.MatchList ?? root?.Info ?? [];
    const list = Array.isArray(infos) ? infos : Array.isArray(infos?.Info) ? infos.Info : [infos?.Info ?? infos].filter(Boolean);

    return list.map((item: any, index: number) => {
      const occurredAt = item.time ?? item.dateTime ?? item.eventTime ?? new Date().toISOString();
      const employeeNo = item.employeeNoString ?? item.employeeNo ?? undefined;
      const cardNo = item.cardNo ?? undefined;
      const attendanceStatus = item.attendanceStatus ?? undefined;
      const sourceId = String(item.serialNo ?? item.eventId ?? `${occurredAt}-${employeeNo ?? cardNo ?? index}`);

      return {
        sourceId,
        deviceId: this.deviceId,
        employeeNo,
        cardNo,
        occurredAt,
        kind: classifyEvent(attendanceStatus),
        attendanceStatus,
        rawType: String(item.minor ?? item.eventType ?? ''),
        rawPayload: JSON.stringify(item)
      } satisfies DeviceEvent;
    });
  }
}
