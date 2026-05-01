import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// ── Database ─────────────────────────────────────────────────────────────────
const DB_DIR = path.join(__dirname, 'db');
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR);

const db = new Database(path.join(DB_DIR, 'leads.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    phone     TEXT NOT NULL,
    comment   TEXT,
    ip        TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

const insertLead = db.prepare(
  'INSERT INTO leads (name, phone, comment, ip) VALUES (?, ?, ?, ?)'
);

// ── Telegram helper ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch {
    // не блокируем запрос если Telegram недоступен
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Static files — index.html + assets (videos, images)
app.use(express.static(path.join(__dirname, 'public'), {
  // Range-запросы нужны браузеру для видео (seek)
  acceptRanges: true,
  setHeaders(res, filePath) {
    if (/\.(mp4|webm|mov)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// ── POST /api/contact ─────────────────────────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, phone, comment } = req.body ?? {};

  // Валидация
  if (!name?.trim() || !phone?.trim()) {
    return res.status(400).json({ ok: false, error: 'Укажите имя и телефон' });
  }
  if (name.length > 120 || phone.length > 40 || (comment?.length ?? 0) > 1000) {
    return res.status(400).json({ ok: false, error: 'Слишком длинные данные' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '';
  const row = insertLead.run(name.trim(), phone.trim(), comment?.trim() ?? '', ip);

  // Уведомление в Telegram (фоново, не ждём)
  sendTelegram(
    `📩 <b>Новая заявка #${row.lastInsertRowid}</b>\n` +
    `👤 Имя: ${name.trim()}\n` +
    `📞 Телефон: ${phone.trim()}\n` +
    (comment?.trim() ? `💬 Комментарий: ${comment.trim()}\n` : '') +
    `🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`
  );

  res.json({ ok: true, id: row.lastInsertRowid });
});

// ── GET /api/leads ─────────────────────────────────────────────────────────────
// Простой список заявок (защитить паролем в проде)
app.get('/api/leads', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const leads = db.prepare(
    'SELECT id, name, phone, comment, ip, created_at FROM leads ORDER BY id DESC LIMIT 200'
  ).all();
  res.json(leads);
});

// ── SPA fallback — всё остальное отдаём index.html ──────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Savva Team backend запущен: http://localhost:${PORT}`);
  if (TG_TOKEN) console.log('Telegram уведомления: включены');
});
