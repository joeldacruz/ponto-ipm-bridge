import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './http/routes.js';
import './storage/db.js';

const app = express();
app.use(express.json());
app.use(router);

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, '../public')));

const port = Number(process.env.PORT || 3090);
app.listen(port, '0.0.0.0', () => {
  console.log(`Ponto IPM Bridge em http://0.0.0.0:${port}`);
});
