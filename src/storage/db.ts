import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/ponto.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cpf TEXT,
  registration TEXT,
  device_employee_no TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  employee_no TEXT,
  card_no TEXT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ACCESS','ATTENDANCE')),
  attendance_status TEXT,
  raw_type TEXT,
  raw_payload TEXT NOT NULL,
  exported_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_events_occurred_at ON device_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_device_events_kind ON device_events(kind);
CREATE INDEX IF NOT EXISTS idx_device_events_employee_no ON device_events(employee_no);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  format TEXT NOT NULL,
  file_name TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
