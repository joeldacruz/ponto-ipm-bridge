import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { router } from './http/routes.js';
import './storage/db.js';
import { startWhatsappWorker } from './services/whatsapp.js';
import { requirePageSession } from './security/auth.js';

const app = express();
app.use(express.json());
app.use(router);

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    return requirePageSession(req, res, next);
  }
  next();
});

app.use(express.static(path.resolve(process.cwd(), 'public')));

const port = Number(process.env.PORT || 3090);
app.listen(port, '0.0.0.0', () => {
  console.log(`Ponto IPM Bridge em http://0.0.0.0:${port}`);
  startWhatsappWorker();
});
