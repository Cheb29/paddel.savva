import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
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
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    comment    TEXT,
    ip         TEXT,
    status     TEXT NOT NULL DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// Миграция: добавить status если таблица уже существовала без него
try {
  db.exec(`ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`);
} catch {
  // колонка уже есть — ок
}

const insertLead = db.prepare(
  'INSERT INTO leads (name, phone, comment, ip) VALUES (?, ?, ?, ?)'
);
const updateStatus = db.prepare(
  "UPDATE leads SET status = ? WHERE id = ?"
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
  } catch { /* не блокируем */ }
}

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public'), {
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
  if (!name?.trim() || !phone?.trim()) {
    return res.status(400).json({ ok: false, error: 'Укажите имя и телефон' });
  }
  if (name.length > 120 || phone.length > 40 || (comment?.length ?? 0) > 1000) {
    return res.status(400).json({ ok: false, error: 'Слишком длинные данные' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '';
  const row = insertLead.run(name.trim(), phone.trim(), comment?.trim() ?? '', ip);

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
app.get('/api/leads', requireSecret, (req, res) => {
  const leads = db.prepare(
    'SELECT id, name, phone, comment, ip, status, created_at FROM leads ORDER BY id DESC LIMIT 1000'
  ).all();
  res.json(leads);
});

// ── PATCH /api/leads/:id — сменить статус ─────────────────────────────────────
app.patch('/api/leads/:id', requireSecret, (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const allowed = ['new', 'progress', 'done'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const info = updateStatus.run(status, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── GET /api/stats — аналитика для дашборда ───────────────────────────────────
app.get('/api/stats', requireSecret, (req, res) => {
  const total   = db.prepare('SELECT COUNT(*) as n FROM leads').get().n;
  const byStatus = db.prepare(
    "SELECT status, COUNT(*) as n FROM leads GROUP BY status"
  ).all();
  const today   = db.prepare(
    "SELECT COUNT(*) as n FROM leads WHERE date(created_at) = date('now','localtime')"
  ).get().n;

  // Последние 7 дней: кол-во заявок по дням
  const byDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as n
    FROM leads
    WHERE created_at >= date('now','localtime','-6 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  // Последняя заявка
  const last = db.prepare(
    'SELECT created_at FROM leads ORDER BY id DESC LIMIT 1'
  ).get();

  const statusMap = {};
  byStatus.forEach(r => { statusMap[r.status] = r.n; });

  res.json({
    total,
    new:      statusMap['new']      ?? 0,
    progress: statusMap['progress'] ?? 0,
    done:     statusMap['done']     ?? 0,
    today,
    by_day:   byDay,
    last_at:  last?.created_at ?? null,
  });
});

// ── GET /admin ─────────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Savva Team backend запущен: http://localhost:${PORT}`);
  if (TG_TOKEN) console.log('Telegram уведомления: включены');
});
