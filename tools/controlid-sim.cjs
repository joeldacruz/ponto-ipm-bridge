const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const port = Number(process.env.SIM_PORT || 3091);
const login = process.env.SIM_USER || 'admin';
const password = process.env.SIM_PASSWORD || 'admin';
const serial = process.env.SIM_SERIAL || '0001400000000001';
const simMac = process.env.SIM_MAC || '02:00:00:00:67:01';
const simVersionFW = Number(process.env.SIM_VERSION_FW || 257);
const simVersionMRP = Number(process.env.SIM_VERSION_MRP || 1);
const simIsFacial = String(process.env.SIM_IS_FACIAL || 'false').toLowerCase() === 'true';
const tlsPfx = process.env.SIM_TLS_PFX || '';
const tlsPfxPassword = process.env.SIM_TLS_PFX_PASSWORD || '';
const logDir = path.resolve(process.env.SIM_LOG_DIR || './data/simulator');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'requests.ndjson');
const tcpLogFile = path.join(logDir, 'tcp.ndjson');
const tcpLogPath = tcpLogFile;
const recent = [];
const activeSessions = new Set();

function appendLog(filePath, item) {
  fs.appendFileSync(filePath, JSON.stringify(item) + '\n');
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function html(res, status, body) {
  res.writeHead(status, {'Content-Type':'text/html; charset=utf-8'});
  res.end(body);
}

function text(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type': type});
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if ((contentType || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  if ((contentType || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch { return raw; }
}

function validSession(url) {
  const s = url.searchParams.get('session');
  if (!s) return false;
  if (activeSessions.has(s)) return true;
  // URLSearchParams converte "+" em espaco quando o cliente nao faz encode.
  return activeSessions.has(s.replace(/ /g, '+'));
}

function createSessionToken() {
  // Token opaco e seguro para query string: evita +, / e =.
  return crypto.randomBytes(18).toString('base64url');
}

function logRequest(req, url, body) {
  const item = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    headers: {
      host: req.headers.host,
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'cf-connecting-ip': req.headers['cf-connecting-ip'],
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-forwarded-proto': req.headers['x-forwarded-proto'],
      'cf-ray': req.headers['cf-ray'],
      'expect': req.headers['expect']
    }
  };
  recent.unshift(item);
  if (recent.length > 200) recent.pop();
  fs.appendFileSync(logFile, JSON.stringify(item) + '\n');
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const raw = await readBody(req);
    const body = parseBody(raw, req.headers['content-type']);
    logRequest(req, url, body);

    if (req.method === 'GET' && url.pathname === '/') {
      return html(res, 200, `<!doctype html>
<meta charset="utf-8">
<title>Simulador REP Control iD 671</title>
<style>body{font-family:system-ui;margin:32px;max-width:900px}code{background:#eee;padding:2px 5px;border-radius:4px}</style>
<h1>Simulador REP Control iD 671</h1>
<p>Servidor ativo. Use apenas para teste de comunicação com o IPM.</p>
<p>Porta: <code>${port}</code> · Usuário: <code>${login}</code></p>
<p><a href="/simulator/logs">Ver logs</a> · <a href="/simulator/state">Ver estado</a></p>`);
    }

    if (req.method === 'GET' && url.pathname === '/simulator/logs') {
      return json(res, 200, {count: recent.length, items: recent});
    }

    if (req.method === 'GET' && url.pathname === '/simulator/state') {
      return json(res, 200, {
        simulator: 'Control iD REP iDClass 671',
        serial,
        port,
        user: login,
        logFile,
        tcpLogFile
      });
    }

    if (req.method === 'POST' && url.pathname === '/login.fcgi') {
      if (body?.login !== login || body?.password !== password) {
        return json(res, 401, {error:'invalid_credentials'});
      }
      const session = createSessionToken();
      activeSessions.add(session);
      return json(res, 200, {session});
    }

    if (req.method === 'POST' && url.pathname === '/session_is_valid.fcgi') {
      return json(res, 200, {session_is_valid: validSession(url)});
    }

    if (req.method === 'POST' && url.pathname === '/logout.fcgi') {
      const session = url.searchParams.get('session');
      if (session) activeSessions.delete(session);
      res.writeHead(200, {'Content-Length':'0'});
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/get_about.fcgi') {
      if (!validSession(url)) {
        appendLog(logFile, {
          at: new Date().toISOString(),
          type: 'response',
          path: '/get_about.fcgi',
          status: 401,
          body: { error: 'invalid_session' }
        });
        return json(res, 401, {error:'invalid_session'});
      }
      const about = {
        mac: simMac,
        nSerie: serial,
        versionFW: simVersionFW,
        versionMRP: simVersionMRP,
        isFacial: simIsFacial
      };
      appendLog(logFile, {
        at: new Date().toISOString(),
        type: 'response',
        path: '/get_about.fcgi',
        status: 200,
        body: about
      });
      return json(res, 200, about);
    }

    if (req.method === 'POST' && url.pathname === '/get_system_information.fcgi') {
      if (!validSession(url)) return json(res, 401, {error:'invalid_session'});
      return json(res, 200, {
        uptime:3600,
        user_count:1,
        number_of_faces:'1',
        ticks:3600,
        cuts:4,
        coil_paper:80,
        total_paper:100,
        paper_ok:true,
        low_paper:false,
        memory:10,
        used_mrp:1,
        last_nsr:4
      });
    }

    if (req.method === 'POST' && url.pathname === '/get_info.fcgi') {
      if (!validSession(url)) return json(res, 401, {error:'invalid_session'});
      return json(res, 200, {
        num_serie:serial,
        user_count:1,
        administrator_count:1,
        template_count:0,
        password_count:1,
        bars_count:0,
        rfid_count:1,
        uptime:3600,
        low_on_paper:false,
        cuts:4,
        total_printed:4
      });
    }

    if (req.method === 'POST' && url.pathname === '/get_system_date_time.fcgi') {
      if (!validSession(url)) return json(res, 401, {error:'invalid_session'});
      const d = new Date();
      return json(res, 200, {
        day:d.getDate(),
        month:d.getMonth()+1,
        year:d.getFullYear(),
        hour:d.getHours(),
        minute:d.getMinutes(),
        second:d.getSeconds(),
        timezone:'-0300'
      });
    }

    if (req.method === 'POST' && url.pathname === '/load_users.fcgi') {
      if (!validSession(url)) return json(res, 401, {error:'invalid_session'});
      return json(res, 200, {
        users:[{
          cpf:12345678909,
          name:'USUARIO TESTE',
          registration:'1',
          rfid:1001,
          code:1,
          admin:false,
          face:true,
          image_timestamp:0
        }]
      });
    }

    if (req.method === 'POST' && url.pathname === '/load_company.fcgi') {
      if (!validSession(url)) return json(res, 401, {error:'invalid_session'});
      return json(res, 200, {
        company:{
          name:'CAMARA TESTE',
          address:'AMBIENTE DE SIMULACAO',
          cpf:12345678909,
          tipo_doc:1,
          cpf_cnpj:'00000000000000',
          cei:0
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/get_afd.fcgi') {
      if (!validSession(url)) return json(res, 401, {error:'invalid_session'});
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      const sample = [
        '# SIMULACAO CONTROL ID 671 - NAO E AFD FISCAL',
        `# DATA=${yyyy}-${mm}-${dd}`,
        '# CPF_TESTE=12345678909',
        '# NSR=1',
        ''
      ].join('\r\n');
      return text(res, 200, sample);
    }

    return json(res, 501, {
      error:'endpoint_not_implemented',
      endpoint:url.pathname,
      message:'A chamada foi registrada em /simulator/logs.'
    });
  } catch (err) {
    json(res, 500, {error:'simulator_error', message:String(err?.message || err)});
  }
};

const server = tlsPfx
  ? https.createServer({ pfx: fs.readFileSync(tlsPfx), passphrase: tlsPfxPassword }, handler)
  : http.createServer(handler);

if (tlsPfx) {
  server.on('secureConnection', (socket) => {
    appendLog(tcpLogPath, {
      at: new Date().toISOString(),
      type: 'tls_secure_connection',
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      protocol: socket.getProtocol(),
      alpnProtocol: socket.alpnProtocol || null,
      cipher: socket.getCipher(),
      servername: socket.servername || null,
      authorized: socket.authorized,
      authorizationError: socket.authorizationError || null
    });

    let loggedAppData = false;
    socket.on('data', (chunk) => {
      if (loggedAppData) return;
      loggedAppData = true;
      appendLog(tcpLogPath, {
        at: new Date().toISOString(),
        type: 'tls_app_data',
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        bytes: chunk.length,
        hex: chunk.subarray(0, 512).toString('hex'),
        ascii: chunk.subarray(0, 512).toString('latin1').replace(/[\\x00-\\x1F\\x7F-\\xFF]/g, '.')
      });
    });
  });
  server.on('tlsClientError', (err, socket) => {
    appendLog(tcpLogPath, { at: new Date().toISOString(), type: 'tls_client_error', remoteAddress: socket?.remoteAddress, remotePort: socket?.remotePort, code: err.code, message: err.message });
  });
}


server.on('checkExpectation', (req, res) => {
  handler(req, res);
});

server.on('connection', (socket) => {
  const connectedAt = Date.now();
  const item = {
    at: new Date().toISOString(),
    type: 'tcp_connection',
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort
  };
  fs.appendFileSync(tcpLogFile, JSON.stringify(item) + '\n');

  socket.on('close', (hadError) => {
    appendLog(tcpLogPath, {
      at: new Date().toISOString(),
      type: 'socket_closed',
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      durationMs: Date.now() - connectedAt,
      bytesRead: socket.bytesRead,
      bytesWritten: socket.bytesWritten,
      hadError
    });
  });
});

server.on('clientError', (err, socket) => {
  const item = {
    at: new Date().toISOString(),
    type: 'client_error',
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    code: err.code,
    message: err.message,
    rawPacketHex: err.rawPacket ? err.rawPacket.subarray(0, 64).toString('hex') : null
  };
  fs.appendFileSync(tcpLogFile, JSON.stringify(item) + '\n');
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (err) => {
  console.error('ERRO DO SERVIDOR:', err);
});

server.on('close', () => {
  console.error('SERVIDOR FOI FECHADO.');
});

// Mantem explicitamente o processo ativo durante os testes de homologacao.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
process.on('SIGINT', () => {
  clearInterval(keepAlive);
  server.close(() => process.exit(0));
});

server.listen(port, '0.0.0.0', () => {
  const scheme = tlsPfx ? 'https' : 'http';
  console.log(`Simulador ${scheme.toUpperCase()} Control iD 671 na porta ${port}`);
  console.log(`Abra: ${scheme}://localhost:${port}`);
  console.log(`Logs: ${scheme}://localhost:${port}/simulator/logs`);
  console.log(`Usuario: ${login} | Senha: ${password}`);
});
