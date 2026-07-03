import express from 'express';
import compression from 'compression';
import Database from 'better-sqlite3';
import multer from 'multer';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MANAGER_USERNAME = process.env.MANAGER_USERNAME || '';
const DEV_ALLOW_UNSIGNED = process.env.DEV_ALLOW_UNSIGNED === '1';

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

db.exec(`
  CREATE TABLE IF NOT EXISTS tg_sessions (
    telegram_user_id INTEGER PRIMARY KEY,
    phone            TEXT NOT NULL,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);
const upsertTgSession = db.prepare(
  `INSERT INTO tg_sessions (telegram_user_id, phone, updated_at)
   VALUES (?, ?, datetime('now','localtime'))
   ON CONFLICT(telegram_user_id) DO UPDATE SET phone = excluded.phone, updated_at = excluded.updated_at`
);
const getTgSession = db.prepare('SELECT phone FROM tg_sessions WHERE telegram_user_id = ?');
const isCoachChat = db.prepare('SELECT slot FROM coaches WHERE telegram_chat_id = ?');
const listAllConfirmed = db.prepare(
  'SELECT id, name, level, audience, gender, phone FROM students WHERE confirmed = 1'
);
// Нормализация телефона для сравнения: только цифры, RU 8XXXXXXXXXX → 7XXXXXXXXXX
function normPhone(p) {
  return String(p || '').replace(/\D/g, '').replace(/^8(\d{10})$/, '7$1');
}
// Подтверждённые ученики с телефоном, эквивалентным заданному (без учёта форматирования)
function confirmedByPhone(phone) {
  const target = normPhone(phone);
  if (!target) return [];
  return listAllConfirmed.all()
    .filter(s => normPhone(s.phone) === target)
    .map(({ phone, ...rest }) => rest);
}
function coachNameBySlot(slot) {
  const m = /^coach(\d)$/.exec(slot); if (!m) return '';
  const row = db.prepare('SELECT value FROM content WHERE key = ?').get('coach' + m[1] + '_name');
  return row ? row.value : '';
}

// ── Bookings (Фаза 2B) ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'group',
    group_id TEXT,
    date TEXT,
    coach_id TEXT,
    datetime TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_active
    ON bookings(student_id, group_id, date)
    WHERE status = 'confirmed' AND type = 'group'
`);
const countConfirmedStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM bookings WHERE group_id = ? AND date = ? AND status = 'confirmed' AND type = 'group'"
);
const activeBookingExists = db.prepare(
  "SELECT id FROM bookings WHERE student_id = ? AND group_id = ? AND date = ? AND status = 'confirmed' AND type = 'group' LIMIT 1"
);
try { db.exec("ALTER TABLE bookings ADD COLUMN title TEXT"); } catch { /* колонка есть */ }
try { db.exec("ALTER TABLE bookings ADD COLUMN time TEXT"); } catch { /* колонка есть */ }
const insertGroupBooking = db.prepare(
  "INSERT INTO bookings (student_id, type, group_id, date, coach_id, title, time) VALUES (?, 'group', ?, ?, ?, ?, ?)"
);
const getActiveBooking = db.prepare(
  "SELECT * FROM bookings WHERE student_id = ? AND group_id = ? AND date = ? AND status = 'confirmed' AND type = 'group' LIMIT 1"
);
const cancelBookingById = db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?");
const getBookingById = db.prepare("SELECT * FROM bookings WHERE id = ?");
const studentActiveBookings = db.prepare(
  "SELECT group_id, date FROM bookings WHERE student_id = ? AND status = 'confirmed' AND type = 'group'"
);

const MAX_GROUP_CAPACITY = 4; // жёсткий потолок мест на группу (бизнес-правило)
const WEEKDAY = { 'ВС':0, 'ПН':1, 'ВТ':2, 'СР':3, 'ЧТ':4, 'ПТ':5, 'СБ':6 };
function scheduleData() {
  const row = db.prepare('SELECT value FROM content WHERE key = ?').get('schedule_data');
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
function isoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseStartMinutes(time) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function occStart(dateIso, time) {
  const [y, mo, da] = dateIso.split('-').map(Number);
  const d = new Date(y, mo - 1, da, 0, 0, 0, 0);
  const mins = parseStartMinutes(time);
  if (mins != null) d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}
function groupOccurrences(days = 14) {
  const data = scheduleData();
  if (!data || !Array.isArray(data.days) || !Array.isArray(data.rows)) return [];
  const now = new Date();
  const out = [];
  for (let off = 0; off < days; off++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    const wd = d.getDay();
    const dateIso = isoDate(d);
    data.days.forEach((label, ci) => {
      if (WEEKDAY[label] !== wd) return;
      data.rows.forEach(row => {
        const cell = row.cells && row.cells[ci];
        if (!cell || !cell.title || !cell.id) return;
        if (occStart(dateIso, row.time) <= now) return;
        out.push({
          group_id: cell.id, date: dateIso, time: row.time,
          title: cell.title, meta: cell.meta, cat: cell.cat,
          level_min: cell.level_min, level_max: cell.level_max,
          audience: cell.audience, gender: cell.gender,
          coach_id: cell.coach_id,
          capacity: Math.min(Number(cell.capacity) || MAX_GROUP_CAPACITY, MAX_GROUP_CAPACITY),
        });
      });
    });
  }
  return out;
}
function eligible(student, cell) {
  if (student.audience == null || student.level == null || student.gender == null) return false;
  if (cell.audience !== student.audience) return false;
  if (!(cell.level_min <= student.level && student.level <= cell.level_max)) return false;
  if (!(cell.gender === 'mixed' || cell.gender === student.gender)) return false;
  return true;
}

// ── Booking notifications (Фаза 2C) ───────────────────────────────────────────
function cellById(group_id) {
  const data = scheduleData();
  if (!data || !Array.isArray(data.rows)) return null;
  for (const row of data.rows) {
    for (const cell of (row.cells || [])) {
      if (cell && cell.id === group_id) return { title: cell.title, time: row.time, coach_id: cell.coach_id };
    }
  }
  return null;
}
const coachBySlot = db.prepare('SELECT telegram_chat_id FROM coaches WHERE slot = ?');
const allTgSessions = db.prepare('SELECT telegram_user_id, phone FROM tg_sessions');
function coachChatIdForGroup(coachId) {
  if (!coachId) return null;
  const row = coachBySlot.get(coachId);
  return row && row.telegram_chat_id ? row.telegram_chat_id : null;
}
function clientChatIdsForStudent(student) {
  const target = normPhone(student && student.phone);
  if (!target) return [];
  return allTgSessions.all().filter(s => normPhone(s.phone) === target).map(s => s.telegram_user_id);
}
async function notifyBookingCreated(name, occ) {
  const chat = coachChatIdForGroup(occ.coach_id);
  if (!chat) return;
  await tgApi('sendMessage', { chat_id: chat, text: `🆕 Новая запись\n👤 ${name}\n🏷 ${occ.title}\n📅 ${occ.date} ${occ.time}` });
}
async function notifyTrainerCancelled(name, booking) {
  const chat = coachChatIdForGroup(booking.coach_id);
  if (!chat) return;
  await tgApi('sendMessage', { chat_id: chat, text: `❌ Отмена записи (клиентом)\n👤 ${name}\n🏷 ${booking.title || ''}\n📅 ${booking.date} ${booking.time || ''}` });
}
async function notifyClientCancelled(student, booking) {
  const chats = clientChatIdsForStudent(student);
  for (const chat of chats) {
    await tgApi('sendMessage', { chat_id: chat, text: `❌ Ваша запись отменена\n🏷 ${booking.title || ''}\n📅 ${booking.date} ${booking.time || ''}\nПо вопросам — к тренеру.` });
  }
}
const listCoaches = db.prepare('SELECT slot, telegram_chat_id FROM coaches ORDER BY slot');
const getCoach = db.prepare('SELECT slot FROM coaches WHERE slot = ?');

db.exec(`
  CREATE TABLE IF NOT EXISTS coach_availability (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    slot      TEXT NOT NULL,
    day       INTEGER NOT NULL,
    from_time TEXT NOT NULL,
    to_time   TEXT NOT NULL
  )
`);
const listAvailability = db.prepare('SELECT id, day, from_time, to_time FROM coach_availability WHERE slot = ? ORDER BY day, from_time');
const deleteAvailability = db.prepare('DELETE FROM coach_availability WHERE slot = ?');
const insertAvailability = db.prepare('INSERT INTO coach_availability (slot, day, from_time, to_time) VALUES (?, ?, ?, ?)');
function isHHMM(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')); }
function validateWindows(windows) {
  if (!Array.isArray(windows)) return { error: 'windows должен быть массивом' };
  const out = [];
  for (const w of windows) {
    const day = Number(w && w.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return { error: 'day должен быть 0–6' };
    if (!isHHMM(w.from_time) || !isHHMM(w.to_time)) return { error: 'время в формате HH:MM' };
    if (String(w.from_time) >= String(w.to_time)) return { error: 'from_time должен быть меньше to_time' };
    out.push({ day, from_time: w.from_time, to_time: w.to_time });
  }
  return { windows: out };
}
const updateCoachChat = db.prepare('UPDATE coaches SET telegram_chat_id = ? WHERE slot = ?');

// ── Telegram helper ───────────────────────────────────────────────────────────
async function tgApi(method, params) {
  if (!TG_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return await r.json();
  } catch { return null; }
}
async function sendTelegram(text) {
  if (!TG_CHAT) return;
  await tgApi('sendMessage', { chat_id: TG_CHAT, text, parse_mode: 'HTML' });
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

// ── Coaches (Фаза 1) — тонкая таблица над слотами content ─────────────────────
app.get('/api/coaches', requireSecret, (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM content WHERE key LIKE 'coach%name'").all();
  const names = {};
  rows.forEach(r => { const m = r.key.match(/^coach(\d)_name$/); if (m) names['coach' + m[1]] = r.value; });
  const list = listCoaches.all().map(c => ({ slot: c.slot, name: names[c.slot] ?? '', telegram_chat_id: c.telegram_chat_id }));
  res.json(list);
});

app.patch('/api/coaches/:slot', requireSecret, (req, res) => {
  const slot = req.params.slot;
  if (!getCoach.get(slot)) return res.status(404).json({ error: 'Тренер не найден' });
  const raw = req.body?.telegram_chat_id;
  const chat = (raw === null || raw === undefined || String(raw).trim() === '') ? null : String(raw).trim();
  updateCoachChat.run(chat, slot);
  res.json({ ok: true });
});

// ── Mini App identify (Фаза 2A) ───────────────────────────────────────────────
function validateInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(TG_TOKEN).digest();
  const calc = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calc !== hash) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;
  try { return { user: JSON.parse(params.get('user') || 'null') }; } catch { return null; }
}

app.post('/api/app/identify', (req, res) => {
  let user;
  if (DEV_ALLOW_UNSIGNED && req.body && req.body.dev_user_id) {
    user = { id: Number(req.body.dev_user_id) };
    if (req.body.dev_phone) upsertTgSession.run(user.id, String(req.body.dev_phone));
  } else {
    const v = validateInitData(String((req.body && req.body.initData) || ''));
    if (!v || !v.user) return res.status(401).json({ error: 'Невалидный initData' });
    user = v.user;
  }
  const sess = getTgSession.get(user.id);
  if (!sess) return res.json({ status: 'need_phone' });
  const students = confirmedByPhone(sess.phone);
  if (!students.length) return res.json({ status: 'unmatched', manager: MANAGER_USERNAME });
  res.json({ status: 'ok', students });
});

// ── Group booking (Фаза 2B) ───────────────────────────────────────────────────
function resolveAppUser(body) {
  if (DEV_ALLOW_UNSIGNED && body && body.dev_user_id) {
    if (body.dev_phone) upsertTgSession.run(Number(body.dev_user_id), String(body.dev_phone));
    return { userId: Number(body.dev_user_id) };
  }
  const v = validateInitData(String((body && body.initData) || ''));
  if (!v || !v.user) return { error: 'Невалидный initData', code: 401 };
  return { userId: v.user.id };
}
function resolveAppStudent(body) {
  const u = resolveAppUser(body);
  if (u.error) return u;
  const sess = getTgSession.get(u.userId);
  if (!sess) return { status: 'need_phone' };
  const student = confirmedByPhone(sess.phone).find(s => s.id === Number(body && body.student_id));
  if (!student) return { status: 'forbidden' };
  return { student };
}

app.post('/api/app/lessons', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const student = r.student;
  const booked = new Set(studentActiveBookings.all(student.id).map(b => b.group_id + '|' + b.date));
  const lessons = groupOccurrences(14)
    .filter(o => eligible(student, o))
    .map(o => {
      const count = countConfirmedStmt.get(o.group_id, o.date).n;
      const status = count > o.capacity ? 'overbooked' : (count >= o.capacity ? 'full' : 'open');
      return {
        group_id: o.group_id, date: o.date, time: o.time, title: o.title, meta: o.meta, cat: o.cat,
        coach_name: coachNameBySlot(o.coach_id || ''), capacity: o.capacity,
        free: Math.max(0, o.capacity - count), status,
        booked: booked.has(o.group_id + '|' + o.date),
      };
    })
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : parseStartMinutes(a.time) - parseStartMinutes(b.time));
  res.json({ status: 'ok', lessons });
});

app.post('/api/app/book', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const student = r.student;
  const group_id = String((req.body && req.body.group_id) || '');
  const date = String((req.body && req.body.date) || '');
  const occ = groupOccurrences(14).find(o => o.group_id === group_id && o.date === date);
  if (!occ) return res.json({ error: 'expired' });
  if (!eligible(student, occ)) return res.json({ error: 'ineligible' });
  try {
    const freeLeft = db.transaction(() => {
      const count = countConfirmedStmt.get(group_id, date).n;
      if (count >= occ.capacity) throw new Error('full');
      if (activeBookingExists.get(student.id, group_id, date)) throw new Error('duplicate');
      insertGroupBooking.run(student.id, group_id, date, occ.coach_id || null, occ.title || null, occ.time || null);
      return occ.capacity - (count + 1);
    })();
    notifyBookingCreated(student.name, occ).catch(() => {});
    res.json({ ok: true, free: Math.max(0, freeLeft) });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'full' || msg === 'duplicate') return res.json({ error: msg });
    if (msg.includes('UNIQUE')) return res.json({ error: 'duplicate' });
    return res.status(500).json({ error: 'server' });
  }
});

app.post('/api/app/cancel', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const student = r.student;
  const group_id = String((req.body && req.body.group_id) || '');
  const date = String((req.body && req.body.date) || '');
  const b = getActiveBooking.get(student.id, group_id, date);
  if (!b) return res.json({ error: 'not_found' });
  const time = b.time || ((cellById(group_id) || {}).time);
  if (occStart(b.date, time).getTime() - Date.now() < 8 * 3600 * 1000) {
    return res.json({ error: 'too_late' });
  }
  cancelBookingById.run(b.id);
  notifyTrainerCancelled(student.name, b).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/bookings', requireSecret, (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'future';
  const rows = db.prepare(
    "SELECT b.*, s.name AS student_name FROM bookings b LEFT JOIN students s ON s.id = b.student_id WHERE b.type = 'group' ORDER BY b.date, b.time"
  ).all();
  const now = Date.now();
  const out = rows.map(b => {
    const cell = cellById(b.group_id) || {};
    const title = b.title || cell.title || '(группа изменена)';
    const time = b.time || cell.time || '';
    return {
      id: b.id, student_id: b.student_id, student_name: b.student_name || '—',
      group_id: b.group_id, date: b.date, title, time,
      coach_name: coachNameBySlot(b.coach_id || cell.coach_id || ''),
      status: b.status, created_at: b.created_at,
    };
  }).filter(b => scope === 'all' ? true : (b.status === 'confirmed' && occStart(b.date, b.time).getTime() > now));
  res.json(out);
});

app.patch('/api/bookings/:id/cancel', requireSecret, (req, res) => {
  const b = getBookingById.get(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'not_found' });
  if (b.status !== 'cancelled') {
    cancelBookingById.run(b.id);
    const cell = cellById(b.group_id) || {};
    b.title = b.title || cell.title; b.time = b.time || cell.time;
    const student = getStudent.get(b.student_id);
    if (student) notifyClientCancelled(student, b).catch(() => {});
  }
  res.json({ ok: true });
});

// ── Telegram webhook (Фаза 2A) ────────────────────────────────────────────────
app.post('/api/tg/webhook/:secret', (req, res) => {
  if (!WEBHOOK_SECRET ||
      req.params.secret !== WEBHOOK_SECRET ||
      req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  handleTgUpdate(req.body).catch(() => {});
  res.sendStatus(200);
});

// ── GET /admin ─────────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function handleTgUpdate(update) {
  const msg = update && update.message;
  if (!msg) return;
  const chatId = msg.chat && msg.chat.id;
  const userId = msg.from && msg.from.id;
  if (!chatId || !userId) return;

  // Пользователь поделился телефоном (доверяем только собственному контакту)
  if (msg.contact && msg.contact.user_id === userId) {
    upsertTgSession.run(userId, msg.contact.phone_number);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Телефон получен ✅',
      reply_markup: { remove_keyboard: true },
    });
    if (PUBLIC_URL) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '📅 Открывайте запись на тренировку:',
        reply_markup: { inline_keyboard: [[{ text: '📅 Открыть запись', web_app: { url: PUBLIC_URL + '/app' } }]] },
      });
    }
    return;
  }

  // Тренер: user_id совпал с coaches.telegram_chat_id
  const coach = isCoachChat.get(userId);
  if (coach) {
    const name = coachNameBySlot(coach.slot);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `Вы тренер ${name || ''} команды Savva 🎾\nУведомления о записях учеников будут приходить сюда.`,
    });
    return;
  }

  // Клиент: приветствие + запрос телефона
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: 'Добро пожаловать в Savva Team! 🎾\nЧтобы записаться на тренировку, поделитесь номером телефона.',
    reply_markup: {
      keyboard: [[{ text: '📱 Поделиться телефоном', request_contact: true }]],
      resize_keyboard: true, one_time_keyboard: true,
    },
  });
}

async function initWebhook() {
  if (!TG_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) {
    console.log('Telegram webhook: отключён (нет PUBLIC_URL/WEBHOOK_SECRET/токена)');
    return;
  }
  const url = `${PUBLIC_URL}/api/tg/webhook/${WEBHOOK_SECRET}`;
  const r = await tgApi('setWebhook', { url, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'] });
  console.log('Telegram webhook:', r && r.ok ? 'установлен → ' + url : 'ошибка ' + JSON.stringify(r));
}

app.listen(PORT, () => {
  console.log(`Savva Team backend запущен: http://localhost:${PORT}`);
  if (TG_TOKEN) console.log('Telegram уведомления: включены');
  initWebhook();
});
