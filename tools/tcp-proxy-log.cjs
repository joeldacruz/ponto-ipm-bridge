'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const listenHost = process.env.PROXY_HOST || '0.0.0.0';
const listenPort = Number(process.env.PROXY_PORT || 3092);
const targetHost = process.env.TARGET_HOST || '127.0.0.1';
const targetPort = Number(process.env.TARGET_PORT || 3091);
const logDir = process.env.SIM_LOG_DIR || path.join(process.cwd(), 'data', 'simulator');
const logPath = path.join(logDir, 'proxy.ndjson');

fs.mkdirSync(logDir, { recursive: true });

function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

const server = net.createServer((client) => {
  const started = Date.now();
  const remoteAddress = client.remoteAddress;
  const remotePort = client.remotePort;
  let rx = 0;
  let tx = 0;
  let first = true;

  log({ type: 'proxy_connection', remoteAddress, remotePort, targetHost, targetPort });

  const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
    log({ type: 'proxy_upstream_connected', remoteAddress, remotePort });
  });

  client.on('data', (chunk) => {
    rx += chunk.length;
    if (first) {
      first = false;
      log({
        type: 'proxy_first_packet',
        remoteAddress,
        remotePort,
        bytes: chunk.length,
        hex: chunk.subarray(0, 256).toString('hex'),
        ascii: chunk.subarray(0, 256).toString('latin1').replace(/[\x00-\x1F\x7F-\xFF]/g, '.')
      });
    }
  });

  upstream.on('data', (chunk) => {
    tx += chunk.length;
  });

  client.on('error', (err) => log({ type: 'proxy_client_error', remoteAddress, remotePort, code: err.code, message: err.message }));
  upstream.on('error', (err) => log({ type: 'proxy_upstream_error', remoteAddress, remotePort, code: err.code, message: err.message }));

  client.on('close', (hadError) => {
    log({ type: 'proxy_closed', remoteAddress, remotePort, durationMs: Date.now() - started, rxBytes: rx, txBytes: tx, hadError });
    if (!upstream.destroyed) upstream.end();
  });

  upstream.on('close', () => {
    if (!client.destroyed) client.end();
  });

  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (err) => {
  log({ type: 'proxy_server_error', code: err.code, message: err.message });
  console.error(err);
});

server.listen(listenPort, listenHost, () => {
  console.log(`Proxy TCP de diagnóstico em ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
  console.log(`Log: ${logPath}`);
});
