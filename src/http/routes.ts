import { Router } from 'express';
import { db } from '../storage/db.js';
import { listAttendance } from '../services/events.js';
import { exportGenericCsv } from '../services/exporter.js';

export const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true }));

router.get('/api/events/attendance', (req, res) => {
  res.json(listAttendance(typeof req.query.period === 'string' ? req.query.period : undefined));
});

router.get('/api/employees', (_req, res) => {
  res.json(db.prepare('SELECT * FROM employees ORDER BY name').all());
});

router.post('/api/employees', (req, res) => {
  const { name, cpf, registration, deviceEmployeeNo } = req.body ?? {};
  if (!name || !deviceEmployeeNo) return res.status(400).json({ error: 'name e deviceEmployeeNo são obrigatórios' });
  const result = db.prepare(`INSERT INTO employees(name,cpf,registration,device_employee_no) VALUES(?,?,?,?)`)
    .run(name, cpf ?? null, registration ?? null, deviceEmployeeNo);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.post('/api/exports/:period', (req, res) => {
  if (!/^\d{4}-\d{2}$/.test(req.params.period)) return res.status(400).json({ error: 'Período deve ser AAAA-MM' });
  const out = exportGenericCsv(req.params.period);
  res.json({ ...out, warning: 'CSV provisório; layout IPM ainda depende de arquivo/documentação oficial.' });
});
