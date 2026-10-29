import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/ponto.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cpf TEXT,
  registration TEXT,
  device_employee_no TEXT NOT NULL UNIQUE,
  pin_ciphertext TEXT,
  pin_iv TEXT,
  pin_tag TEXT,
  pin_updated_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT,
  role TEXT NOT NULL CHECK(role IN ('PRIMARY','SECONDARY')),
  transport TEXT NOT NULL CHECK(transport IN ('DIRECT','WINDOWS_AGENT')),
  host TEXT,
  port INTEGER,
  agent_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(status IN ('UNKNOWN','ONLINE','OFFLINE')),
  last_seen_at TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_device_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  device_employee_no TEXT NOT NULL,
  card_no TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(employee_id) REFERENCES employees(id),
  FOREIGN KEY(device_id) REFERENCES devices(id),
  UNIQUE(employee_id, device_id),
  UNIQUE(device_id, device_employee_no)
);

CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  employee_no TEXT,
  card_no TEXT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ACCESS','ATTENDANCE')),
  nsr INTEGER,
  attendance_status TEXT,
  raw_type TEXT,
  raw_payload TEXT NOT NULL,
  exported_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  employee_id INTEGER,
  operation TEXT NOT NULL CHECK(operation IN ('UPSERT_EMPLOYEE','DELETE_EMPLOYEE')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','LEASED','DONE','ERROR')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  leased_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES devices(id),
  FOREIGN KEY(employee_id) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_events_occurred_at ON device_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_device_events_kind ON device_events(kind);
CREATE INDEX IF NOT EXISTS idx_device_events_employee_no ON device_events(employee_no);
CREATE INDEX IF NOT EXISTS idx_device_events_device_nsr ON device_events(device_id, nsr);
CREATE INDEX IF NOT EXISTS idx_bindings_employee ON employee_device_bindings(employee_id);
CREATE INDEX IF NOT EXISTS idx_bindings_device ON employee_device_bindings(device_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_device_status ON sync_jobs(device_id, status);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  format TEXT NOT NULL,
  file_name TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL,
  destination TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','SENDING','DONE','ERROR')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(event_id) REFERENCES device_events(id),
  FOREIGN KEY(employee_id) REFERENCES employees(id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_notifications_status
  ON attendance_notifications(status, next_attempt_at);


CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  whatsapp_number TEXT,
  role TEXT NOT NULL DEFAULT 'OPERATOR'
    CHECK(role IN ('ADMIN','OPERATOR')),
  active INTEGER NOT NULL DEFAULT 1,
  password_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_expiry
  ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user
  ON password_reset_codes(user_id, expires_at);
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Migra bases criadas pelas primeiras versões do MVP.
ensureColumn('device_events', 'nsr', 'INTEGER');
ensureColumn('employees', 'pin_ciphertext', 'TEXT');
ensureColumn('employees', 'pin_iv', 'TEXT');
ensureColumn('employees', 'pin_tag', 'TEXT');
ensureColumn('employees', 'pin_updated_at', 'TEXT');
ensureColumn('employees', 'whatsapp_number', 'TEXT');
ensureColumn('employees', 'whatsapp_attendance_enabled', 'INTEGER NOT NULL DEFAULT 0');


db.prepare(`
  INSERT OR IGNORE INTO app_users(name,email,role)
  VALUES(?,?,?)
`).run('Joel da Cruz', 'joeldacruz@gmail.com', 'ADMIN');

db.prepare(`
  INSERT OR IGNORE INTO app_users(name,email,role)
  VALUES(?,?,?)
`).run('Josiele Tischler', 'josy_con_tabil@hotmail.com', 'OPERATOR');

db.prepare(`
  UPDATE app_users
  SET whatsapp_number=(
    SELECT e.whatsapp_number
    FROM employees e
    WHERE lower(e.name)=lower(app_users.name)
      AND e.whatsapp_number IS NOT NULL
      AND trim(e.whatsapp_number)<>''
    LIMIT 1
  )
  WHERE whatsapp_number IS NULL
    AND EXISTS(
      SELECT 1
      FROM employees e
      WHERE lower(e.name)=lower(app_users.name)
        AND e.whatsapp_number IS NOT NULL
        AND trim(e.whatsapp_number)<>''
    )
`).run();


const topdataHost = process.env.TOPDATA_HOST;
if (topdataHost) {
  db.prepare(`
    INSERT OR IGNORE INTO devices
      (id,name,vendor,model,role,transport,host,port,agent_id)
    VALUES
      ('rep-topdata-02','REP 02 - Topdata','TOPDATA','Inner REP Bio','SECONDARY','WINDOWS_AGENT',?,?,?)
  `).run(
    topdataHost,
    Number(process.env.TOPDATA_PORT || 51000),
    process.env.TOPDATA_AGENT_ID || 'topdata-windows-01'
  );
}
