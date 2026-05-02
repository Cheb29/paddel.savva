import express from 'express';
import Database from 'better-sqlite3';
import multer from 'multer';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// ── Uploads ───────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g, '_')
      .slice(0, 60);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 МБ
  fileFilter: (_req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения и видео'));
  },
});

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

// ── Content CMS ───────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS content (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const CONTENT_DEFAULTS = {
  hero_eyebrow: 'Академия падел тенниса',
  hero_title: 'БЬЁМ\nСИЛЬНО.\nРАСТЁМ.',
  hero_sub: 'Персональные тренировки по падел теннису — от первого удара до турнирного пьедестала',
  hero_cta: 'Записаться на пробное',
  hero_cta2: 'Смотреть видео',
  hero_badge: 'С 2024',
  hero_stat1_num: '200+', hero_stat1_label: 'Учеников',
  hero_stat2_num: '10',   hero_stat2_label: 'Крытых кортов',
  hero_stat3_num: '3',    hero_stat3_label: 'Тренера',
  hero_stat4_num: 'от 5 000 ₽', hero_stat4_label: 'занятие',
  about_label: 'О нас',
  about_title: 'МЫ СОЗДАЁМ\nЧЕМПИОНОВ',
  about_p1: 'Savva Team — ведущая академия падел тенниса, объединяющая профессиональных тренеров и современную инфраструктуру. Мы верим, что падел — это больше, чем спорт.',
  about_p2: 'Наша методика основана на международных стандартах тренировочного процесса, индивидуальном подходе к каждому игроку и постоянном анализе игры.',
  programs_label: 'Программы',
  programs_title: 'ДЛЯ\nКАЖДОГО',
  schedule_label: 'Расписание',
  schedule_title: 'КАЖДЫЙ\nДЕНЬ',
  prices_label: 'Тарифы',
  prices_title: 'ВЫБЕРИТЕ\nСВОЙ ПЛАН',
  coaches_label: 'Наша команда',
  coaches_title: 'ЛИЦА\nАКАДЕМИИ',
  coaches_sub: 'Три тренера — три характера. Общий опыт более 20 лет в ракеточных видах спорта.',
  coaches_detail_label: 'Персонально',
  coaches_detail_title: 'НАШИ\nТРЕНЕРЫ',
  testimonials_label: 'Отзывы',
  testimonials_title: 'ЧТО\nГОВОРЯТ',
  contact_label: 'Контакты',
  contact_title: 'ДАВАЙТЕ\nНАЧНЁМ',
  contact_phone: '+7 (999) 218-36-39',
  contact_address: 'Санкт-Петербург, ул. Полевая Сабировская, 52',
  contact_hours_week: 'Пн–Пт: 08:00 – 22:00',
  contact_hours_weekend: 'Сб–Вс: 09:00 – 20:00',
  footer_copy: '© 2026 Savva Team. Все права защищены.',
  // media
  hero_video_url:    'uploads/2026-05-01 07.51.23.mp4',
  showreel_url:      'uploads/showreel.mp4',
  showreel_poster:   '',
  showreel_caption:  'Один день в академии',
  coach1_photo:      'uploads/саваа.jpeg',
  coach1_video:      'uploads/2026-05-01 07.51.23.mp4',
  coach2_photo:      'uploads/Катита 1.PNG',
  coach2_video:      'uploads/coach-katita.mp4',
  coach3_photo:      'uploads/Елена 1.PNG',
  coach3_video:      '',
};

// Seed defaults (INSERT OR IGNORE — не затирает сохранённые значения)
const insertContent = db.prepare('INSERT OR IGNORE INTO content (key, value) VALUES (?, ?)');
const upsertContent = db.prepare('INSERT OR REPLACE INTO content (key, value) VALUES (?, ?)');
const seedContent = db.transaction(() => {
  for (const [k, v] of Object.entries(CONTENT_DEFAULTS)) {
    insertContent.run(k, v);
  }
});
seedContent();

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

// ── GET /api/content — публичный, читает лендинг ──────────────────────────────
app.get('/api/content', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM content').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

// ── POST /api/content — сохранение из админки ─────────────────────────────────
app.post('/api/content', requireSecret, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }
  const save = db.transaction(() => {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') upsertContent.run(k, v);
    }
  });
  save();
  res.json({ ok: true });
});

// ── POST /api/upload ──────────────────────────────────────────────────────────
app.post('/api/upload', requireSecret, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    res.json({ ok: true, url: `uploads/${req.file.filename}` });
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
