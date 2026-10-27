import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['text/*','application/octet-stream'], limit: '2mb' }));

const port = Number(process.env.SIM_PORT || 3091);
const login = process.env.SIM_USER || 'admin';
const password = process.env.SIM_PASSWORD || 'admin';
const serial = process.env.SIM_SERIAL || 'SIM671000001';
const logDir = path.resolve(process.env.SIM_LOG_DIR || './data/simulator');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'requests.ndjson');

type LogItem = {
  at: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, unknown>;
};

const recent: LogItem[] = [];
function writeLog(req: express.Request) {
  const item: LogItem = {
    at: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body,
    headers: {
      host: req.headers.host,
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent']
    }
  };
  recent.unshift(item);
  if (recent.length > 200) recent.pop();
  fs.appendFileSync(logFile, JSON.stringify(item) + '\n');
}

app.use((req, _res, next) => {
  writeLog(req);
  next();
});

function validSession(req: express.Request) {
  return typeof req.query.session === 'string' && req.query.session.startsWith('SIM-');
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Simulador REP Control iD 671</title>
<style>
body{font-family:system-ui;margin:32px;max-width:900px}code{background:#eee;padding:2px 5px;border-radius:4px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}
</style>
<h1>Simulador REP Control iD 671</h1>
<p>Servidor ativo. Use no IPM apenas para teste de comunicação.</p>
<p>Porta: <code>${port}</code> · Usuário: <code>${login}</code></p>
<p>Logs: <a href="/simulator/logs">/simulator/logs</a></p>
<p>Estado: <a href="/simulator/state">/simulator/state</a></p>`);
});

app.get('/simulator/logs', (_req, res) => res.json({ count: recent.length, items: recent }));
app.get('/simulator/state', (_req, res) => res.json({
  simulator: 'Control iD REP iDClass 671',
  serial,
  isFacial: true,
  port,
  logFile
}));

app.post('/login.fcgi', (req, res) => {
  const body = req.body ?? {};
  if (body.login !== login || body.password !== password) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  res.json({ session: `SIM-${Date.now()}` });
});

app.post('/session_is_valid.fcgi', (req, res) => {
  res.json({ session_is_valid: validSession(req) });
});

app.post('/logout.fcgi', (_req, res) => res.status(200).end());

app.post('/get_about.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  res.json({
    mac: '02:00:00:00:67:01',
    nSerie: serial,
    versionFW: 260,
    versionMRP: 1,
    isFacial: true
  });
});

app.post('/get_system_information.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  res.json({
    uptime: 3600,
    user_count: 1,
    number_of_faces: '1',
    ticks: 3600,
    cuts: 4,
    coil_paper: 80,
    total_paper: 100,
    paper_ok: true,
    low_paper: false,
    memory: 10,
    used_mrp: 1,
    last_nsr: 4
  });
});

app.post('/get_info.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  res.json({
    num_serie: serial,
    user_count: 1,
    administrator_count: 1,
    template_count: 0,
    password_count: 1,
    bars_count: 0,
    rfid_count: 1,
    uptime: 3600,
    low_on_paper: false,
    cuts: 4,
    total_printed: 4
  });
});

app.post('/get_system_date_time.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  const d = new Date();
  res.json({
    day: d.getDate(),
    month: d.getMonth()+1,
    year: d.getFullYear(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    timezone: '-0300'
  });
});

app.post('/load_users.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  res.json({
    users: [{
      cpf: 12345678909,
      name: 'USUARIO TESTE',
      registration: '1',
      rfid: 1001,
      code: 1,
      admin: false,
      face: true,
      image_timestamp: 0
    }]
  });
});

app.post('/load_company.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  res.json({
    company: {
      name: 'CAMARA TESTE',
      address: 'AMBIENTE DE SIMULACAO',
      cpf: 12345678909,
      tipo_doc: 1,
      cpf_cnpj: '00000000000000',
      cei: 0
    }
  });
});

/**
 * Este retorno é apenas uma sonda de protocolo.
 * Não é um AFD fiscal válido e não deve ser usado em produção.
 */
app.post('/get_afd.fcgi', (req, res) => {
  if (!validSession(req)) return res.status(401).json({ error: 'invalid_session' });
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');
  const sample = [
    '# SIMULACAO CONTROL ID 671 - NAO E AFD FISCAL',
    `# DATA=${yyyy}-${mm}-${dd}`,
    '# CPF_TESTE=12345678909',
    '# NSR=1',
    ''
  ].join('\r\n');
  res.type('text/plain; charset=iso-8859-1').send(sample);
});

app.use((req, res) => {
  res.status(501).json({
    error: 'endpoint_not_implemented',
    endpoint: req.path,
    message: 'A chamada foi registrada em /simulator/logs para implementarmos a resposta correta.'
  });
});

const certPath = process.env.SIM_TLS_CERT;
const keyPath = process.env.SIM_TLS_KEY;

if (certPath && keyPath) {
  https.createServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  }, app).listen(port, '0.0.0.0', () => {
    console.log(`Simulador HTTPS Control iD 671 na porta ${port}`);
  });
} else {
  http.createServer(app).listen(port, '0.0.0.0', () => {
    console.log(`Simulador HTTP Control iD 671 na porta ${port}`);
    console.log('Para HTTPS, defina SIM_TLS_CERT e SIM_TLS_KEY.');
  });
}
