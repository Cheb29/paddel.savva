import express from 'express';
import compression from 'compression';
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
  // coaches
  coach1_eyebrow: '01 · Head Coach',
  coach1_name: 'Савва Шехватов',
  coach1_bio: 'Основатель академии. 12 лет профессионального опыта в теннисе и паделе. Сертифицированный тренер FIP. Обучает взрослых и игроков уровня advanced. Автор методики «Техника через логику».',
  coach1_stat1_num: '12', coach1_stat1_label: 'лет опыта',
  coach1_stat2_num: 'FIP', coach1_stat2_label: 'сертификат',
  coach1_stat3_num: 'A1', coach1_stat3_label: 'уровень',
  coach2_eyebrow: '02 · Junior Coach',
  coach2_name: 'Катита Леонова',
  coach2_bio: 'Смэш — это не просто удар. Это моя подпись. Моё «ало». Я люблю его не за грубую силу, а за ту самую секунду абсолютной власти над мячом — когда соперник кидает свечку в надежде отдышаться, и я слышу зов. В этот момент мир замирает.',
  coach2_stat1_num: '9',   coach2_stat1_label: 'лет опыта',
  coach2_stat2_num: 'P1',  coach2_stat2_label: 'рейтинг',
  coach2_stat3_num: 'B/A', coach2_stat3_label: 'уровень',
  coach3_eyebrow: '03 · Junior Coach',
  coach3_name: 'Елена Алешина',
  coach3_bio: 'Работает с детьми от 6 лет и начинающими взрослыми. Бывший игрок юниорской сборной. Главный принцип — игровой подход и развитие координации.',
  coach3_stat1_num: '7',   coach3_stat1_label: 'лет опыта',
  coach3_stat2_num: '6+',  coach3_stat2_label: 'возраст',
  coach3_stat3_num: 'C/B', coach3_stat3_label: 'уровень',
  // media
  hero_video_url:    'uploads/hero.mp4',
  showreel_url:      'uploads/hero.mp4',
  showreel_poster:   '',
  showreel_caption:  'Один день в академии',
  coach1_photo:      'uploads/саваа.jpeg',
  coach1_photo2:     'uploads/photo_2026-05-01 23.25.57.jpeg',
  coach1_video:      'uploads/hero.mp4',
  coach2_photo:      'uploads/Катита 1.PNG',
  coach2_photo2:     'uploads/Катита 2.PNG',
  coach2_video:      'uploads/coach-katita-opt.mp4',
  coach3_photo:      'uploads/Елена 1.PNG',
  coach3_photo2:     'uploads/Елена 2.PNG',
  coach3_video:      '',
  // schedule (JSON: {days:[5], rows:[{time, cells:[5 × (cell|null)]}]}); cell = {id,title,meta,cat,level_min,level_max,audience,gender,coach_id,capacity}
  schedule_data: JSON.stringify({
    days: ['ПН','ВТ','СР','ЧТ','ПТ'],
    rows: [
      { time: '9:30–11:00', cells: [
        {id:'g_0_0', title:'Девушки 1,5–2', meta:'Beginner / Light', cat:'women', level_min:1.5, level_max:2.0, audience:'adult', gender:'f', coach_id:'coach2', capacity:8},
        {id:'g_0_1', title:'Девушки 1–1,5', meta:'Start level', cat:'women', level_min:1.0, level_max:1.5, audience:'adult', gender:'f', coach_id:'coach2', capacity:8},
        {id:'g_0_2', title:'Девушки 1,5–2', meta:'Beginner / Light', cat:'women', level_min:1.5, level_max:2.0, audience:'adult', gender:'f', coach_id:'coach2', capacity:8},
        {id:'g_0_3', title:'Девушки 1–1,5', meta:'Start level', cat:'women', level_min:1.0, level_max:1.5, audience:'adult', gender:'f', coach_id:'coach2', capacity:8},
        {id:'g_0_4', title:'Девушки 1,5–2', meta:'Beginner / Light', cat:'women', level_min:1.5, level_max:2.0, audience:'adult', gender:'f', coach_id:'coach2', capacity:8} ] },
      { time: '13:00–15:00', cells: [
        {id:'g_1_0', title:'Мужчины 2,5–3,5', meta:'Power group', cat:'men', level_min:2.5, level_max:3.5, audience:'adult', gender:'m', coach_id:'coach1', capacity:8},
        {id:'g_1_1', title:'Экстремалы 3,5+', meta:'Advanced / Pro', cat:'extreme', level_min:3.5, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:4},
        {id:'g_1_2', title:'Мужчины 2,5–3,5', meta:'Power group', cat:'men', level_min:2.5, level_max:3.5, audience:'adult', gender:'m', coach_id:'coach1', capacity:8},
        {id:'g_1_3', title:'Экстремалы 3,5+', meta:'Advanced / Pro', cat:'extreme', level_min:3.5, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:4},
        {id:'g_1_4', title:'Мужчины 2,5–3,5', meta:'Power group', cat:'men', level_min:2.5, level_max:3.5, audience:'adult', gender:'m', coach_id:'coach1', capacity:8} ] },
      { time: '15:00–16:00', cells: [
        null,
        {id:'g_2_1', title:'Дети 5–7', meta:'Junior academy', cat:'kids', level_min:1.0, level_max:3.0, audience:'kids', gender:'mixed', coach_id:'coach3', capacity:6},
        null, null, null ] },
      { time: '16:00–17:30', cells: [
        null,
        {id:'g_3_1', title:'Дети 7–11', meta:'Junior academy', cat:'kids', level_min:1.0, level_max:3.0, audience:'kids', gender:'mixed', coach_id:'coach3', capacity:6},
        null, null, null ] },
      { time: '17:30–19:00', cells: [
        null,
        {id:'g_4_1', title:'Дети 11–16', meta:'Teen academy', cat:'kids', level_min:1.0, level_max:4.0, audience:'kids', gender:'mixed', coach_id:'coach3', capacity:6},
        null, null, null ] },
      { time: '19:00–20:30', cells: [
        {id:'g_5_0', title:'Смешанные 2+', meta:'Mixed group', cat:'mixed', level_min:2.0, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_5_1', title:'Смешанные 2+', meta:'Mixed group', cat:'mixed', level_min:2.0, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_5_2', title:'Смешанные 2,5+', meta:'Mixed group', cat:'mixed', level_min:2.5, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_5_3', title:'Смешанные 1,5–2', meta:'Mixed group', cat:'mixed', level_min:1.5, level_max:2.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_5_4', title:'Смешанные 1,5–2', meta:'Mixed group', cat:'mixed', level_min:1.5, level_max:2.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8} ] },
      { time: '20:30–22:00', cells: [
        {id:'g_6_0', title:'Смешанные 2,5+', meta:'Mixed group', cat:'mixed', level_min:2.5, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_6_1', title:'Смешанные 1,5–2', meta:'Mixed group', cat:'mixed', level_min:1.5, level_max:2.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_6_2', title:'Смешанные 1,5–2', meta:'Mixed group', cat:'mixed', level_min:1.5, level_max:2.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_6_3', title:'Смешанные 2+', meta:'Mixed group', cat:'mixed', level_min:2.0, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8},
        {id:'g_6_4', title:'Смешанные 2,5+', meta:'Mixed group', cat:'mixed', level_min:2.5, level_max:7.0, audience:'adult', gender:'mixed', coach_id:'coach1', capacity:8} ] },
    ],
  }),
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

// ── Students & Coaches (Фаза 1 booking) ───────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    level      REAL,
    audience   TEXT,
    gender     TEXT,
    confirmed  INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS coaches (
    slot             TEXT PRIMARY KEY,
    telegram_chat_id TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);

const insertStudent = db.prepare(
  `INSERT INTO students (name, phone, level, audience, gender, confirmed, source)
   VALUES (@name, @phone, @level, @audience, @gender, @confirmed, @source)`
);
const findUnconfirmedByPhone = db.prepare(
  'SELECT id FROM students WHERE phone = ? AND confirmed = 0 LIMIT 1'
);
const listStudents = db.prepare(
  `SELECT id, name, phone, level, audience, gender, confirmed, source, created_at
   FROM students ORDER BY id DESC LIMIT 2000`
);
const getStudent = db.prepare('SELECT * FROM students WHERE id = ?');
const deleteStudentStmt = db.prepare('DELETE FROM students WHERE id = ?');

const seedCoach = db.prepare('INSERT OR IGNORE INTO coaches (slot) VALUES (?)');
['coach1','coach2','coach3'].forEach(s => seedCoach.run(s));
const listCoaches = db.prepare('SELECT slot, telegram_chat_id FROM coaches ORDER BY slot');
const getCoach = db.prepare('SELECT slot FROM coaches WHERE slot = ?');
const updateCoachChat = db.prepare('UPDATE coaches SET telegram_chat_id = ? WHERE slot = ?');

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
app.use(compression());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public'), {
  acceptRanges: true,
  setHeaders(res, filePath) {
    if (/\.(mp4|webm|mov)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// ── Rate limiter: max 3 заявки в час с одного IP ─────────────────────────────
const rateLimitMap = new Map(); // ip → [timestamp, ...]
const RATE_LIMIT = 3;
const RATE_WINDOW = 60 * 60 * 1000; // 1 час

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return false;
}

// Очистка старых записей раз в час
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateLimitMap) {
    const fresh = hits.filter(t => now - t < RATE_WINDOW);
    if (fresh.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}, RATE_WINDOW);

// ── POST /api/contact ─────────────────────────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, phone, comment, website } = req.body ?? {};

  // Honeypot: боты заполняют скрытое поле website
  if (website) return res.json({ ok: true });

  if (!name?.trim() || !phone?.trim()) {
    return res.status(400).json({ ok: false, error: 'Укажите имя и телефон' });
  }
  if (name.length > 120 || phone.length > 40 || (comment?.length ?? 0) > 1000) {
    return res.status(400).json({ ok: false, error: 'Слишком длинные данные' });
  }

  // Валидация телефона: только цифры, 10–15 знаков
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    return res.status(400).json({ ok: false, error: 'Некорректный номер телефона' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '';

  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Слишком много заявок. Попробуйте позже.' });
  }

  const row = insertLead.run(name.trim(), phone.trim(), comment?.trim() ?? '', ip);

  // Фаза 1: авто-заготовка ученика из лида (дедуп по телефону среди неподтверждённых)
  try {
    if (!findUnconfirmedByPhone.get(phone.trim())) {
      insertStudent.run({
        name: name.trim(), phone: phone.trim(),
        level: null, audience: null, gender: null, confirmed: 0, source: 'lead',
      });
    }
  } catch (e) { /* не блокируем ответ формы */ }

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

// ── Students CRUD (Фаза 1) ────────────────────────────────────────────────────
// Валидация полей ученика. partial=true → проверяем только присутствующие ключи.
function validateStudentPatch(body, { partial }) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'Имя обязательно' };
    out.name = name;
  }
  if (!partial || has('phone')) {
    const phone = String(body.phone ?? '').trim();
    if (!phone) return { error: 'Телефон обязателен' };
    out.phone = phone;
  }
  if (has('level')) {
    if (body.level === null || body.level === '') out.level = null;
    else {
      const lv = Number(body.level);
      if (!Number.isFinite(lv) || lv < 1 || lv > 7) return { error: 'Уровень должен быть 1.0–7.0' };
      out.level = lv;
    }
  }
  if (has('audience')) {
    const a = body.audience;
    if (a === null || a === '') out.audience = null;
    else if (a === 'adult' || a === 'kids') out.audience = a;
    else return { error: 'audience: adult|kids' };
  }
  if (has('gender')) {
    const g = body.gender;
    if (g === null || g === '') out.gender = null;
    else if (g === 'm' || g === 'f') out.gender = g;
    else return { error: 'gender: m|f' };
  }
  if (has('confirmed')) {
    out.confirmed = (body.confirmed === true || body.confirmed === 1 || body.confirmed === '1') ? 1 : 0;
  }
  return { values: out };
}

app.get('/api/students', requireSecret, (_req, res) => {
  res.json(listStudents.all());
});

app.post('/api/students', requireSecret, (req, res) => {
  const { error, values } = validateStudentPatch(req.body ?? {}, { partial: false });
  if (error) return res.status(400).json({ error });
  const row = insertStudent.run({
    name: values.name, phone: values.phone,
    level: values.level ?? null, audience: values.audience ?? null,
    gender: values.gender ?? null, confirmed: values.confirmed ?? 0, source: 'manual',
  });
  res.json({ id: row.lastInsertRowid });
});

app.patch('/api/students/:id', requireSecret, (req, res) => {
  const id = Number(req.params.id);
  if (!getStudent.get(id)) return res.status(404).json({ error: 'Не найдено' });
  const { error, values } = validateStudentPatch(req.body ?? {}, { partial: true });
  if (error) return res.status(400).json({ error });
  const keys = Object.keys(values);
  if (!keys.length) return res.json({ ok: true });
  const setSql = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE students SET ${setSql} WHERE id = @id`).run({ ...values, id });
  res.json({ ok: true });
});

app.delete('/api/students/:id', requireSecret, (req, res) => {
  deleteStudentStmt.run(Number(req.params.id));
  res.json({ ok: true });
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
