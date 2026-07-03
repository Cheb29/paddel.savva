# Фаза 2B — Групповая бронь — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подтверждённый ученик в Mini App видит подходящие датированные групповые занятия на 2 недели со счётчиком «свободно N из M» и бронирует их атомарно, без овербукинга и дублей.

**Architecture:** Расширяем `server.js`: таблица `bookings` + statements; хелпер `groupOccurrences` (генерация занятий из `content.schedule_data`, модель А); `eligible`; общий auth `resolveAppStudent` (переиспользует `validateInitData`/`normPhone`/`confirmedByPhone` из 2A); эндпоинты `POST /api/app/lessons` и `POST /api/app/book` (атомарная транзакция). Расширяем `public/app.html` списком занятий по датам + бронь.

**Tech Stack:** Express + better-sqlite3, ES-модули, Node 22. Тест-фреймворка нет — проверка ручная (curl / браузер); локально `DEV_ALLOW_UNSIGNED=1`. Часовой пояс — серверный localtime.

## Global Constraints

- `bookings`: `id, student_id, type DEFAULT 'group', group_id, date, coach_id, datetime, status DEFAULT 'confirmed', created_at`. Частичный уникальный индекс `ux_booking_active(student_id, group_id, date) WHERE status='confirmed' AND type='group'`.
- Occurrence = `group_id` (=`schedule cell.id`) + ISO-дата; не материализуется. Окно 14 дней от сегодня, только занятия с началом в будущем, только ячейки с `cell.id` и `cell.title`.
- Маппинг метки дня: `{ВС:0,ПН:1,ВТ:2,СР:3,ЧТ:4,ПТ:5,СБ:6}`.
- Допуск: `audience совпал AND level_min≤level≤level_max AND (gender==='mixed' OR gender===пол)`; ученик с null level/audience/gender → не подходит ничего.
- Доступность: `count = confirmed по group_id+date`; `count>capacity`→`overbooked`; `count>=capacity`→`full`; иначе `open`, `free=capacity−count`.
- Бронь атомарна: `db.transaction` пересчитывает count, `INSERT` только если `count<capacity` и нет активного дубля; уникальный индекс — второй рубеж.
- Auth: `initData` (HMAC, как 2A) → `user.id` → телефон `tg_sessions` → `student_id` должен быть среди подтверждённых с этим (нормализованным) телефоном; иначе `forbidden`/`need_phone`/401.
- Телефон сравнивать только нормализованно (`normPhone`) — как исправлено в 2A.
- Деплой: `server.js` → корень, `public/app.html` → `public/`; `pm2 restart savvateam`; `sshpass -e`.

---

## Структура файлов

- `server.js`:
  - После блока `tg_sessions`/statements (≈строка 270, рядом с `confirmedByPhone`) — таблица `bookings` + индекс + statements (Task 1); хелперы occurrences/eligible (Task 2).
  - Рядом с `POST /api/app/identify` (≈строка 592) — `resolveAppStudent`, `POST /api/app/lessons` (Task 3), `POST /api/app/book` (Task 4).
- `public/app.html` — CSS + расширенный `<script>` (Task 5).

---

## Task 1: Сервер — таблица `bookings` + statements

**Files:**
- Modify: `server.js` (после `confirmedByPhone`, ≈строка 271)

**Interfaces:**
- Produces: таблица `bookings`, индекс `ux_booking_active`; statements `countConfirmedStmt`, `activeBookingExists`, `insertGroupBooking`, `studentActiveBookings`.

- [ ] **Шаг 1: Добавить DDL и statements**

В `server.js` сразу после функции `confirmedByPhone` (после её закрывающей `}`) вставить:
```js

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
const insertGroupBooking = db.prepare(
  "INSERT INTO bookings (student_id, type, group_id, date) VALUES (?, 'group', ?, ?)"
);
const studentActiveBookings = db.prepare(
  "SELECT group_id, date FROM bookings WHERE student_id = ? AND status = 'confirmed' AND type = 'group'"
);
```

- [ ] **Шаг 2: Проверить создание таблицы и индекса**

Run:
```bash
cd /root/savvateam && (node server.js & SRV=$!; sleep 1.2; kill $SRV 2>/dev/null); \
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('bookings cols:',db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name).join(','));console.log('index:',db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name='ux_booking_active'\").all().map(r=>r.name).join(','))"
```
Expected: `bookings cols: id,student_id,type,group_id,date,coach_id,datetime,status,created_at`; `index: ux_booking_active`.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2b): bookings table, unique active index and statements"
```

---

## Task 2: Сервер — `groupOccurrences` + `eligible` + парсинг

**Files:**
- Modify: `server.js` (после statements Task 1)

**Interfaces:**
- Consumes: `db` (для `content.schedule_data`).
- Produces: `WEEKDAY`, `scheduleData()`, `isoDate(d)`, `parseStartMinutes(time)`, `occStart(dateIso, time)`, `groupOccurrences(days)`, `eligible(student, cell)`.

- [ ] **Шаг 1: Добавить хелперы**

В `server.js` сразу после statements из Task 1 вставить:
```js

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
          coach_id: cell.coach_id, capacity: cell.capacity,
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
```

- [ ] **Шаг 2: Проверить генерацию и допуск на реальном сиде**

Run:
```bash
cd /root/savvateam && node -e "
const cp=require('child_process');
" 2>/dev/null; node --input-type=module -e "
import Database from 'better-sqlite3';
const db=new Database('db/leads.db');
const WEEKDAY={'ВС':0,'ПН':1,'ВТ':2,'СР':3,'ЧТ':4,'ПТ':5,'СБ':6};
const data=JSON.parse(db.prepare('SELECT value FROM content WHERE key=?').get('schedule_data').value);
function isoDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function pm(t){const m=/(\d{1,2}):(\d{2})/.exec(t||'');return m?+m[1]*60+ +m[2]:null;}
function occStart(iso,t){const [y,mo,da]=iso.split('-').map(Number);const d=new Date(y,mo-1,da);const mm=pm(t);if(mm!=null)d.setHours(mm/60|0,mm%60,0,0);return d;}
const now=new Date();const out=[];
for(let o=0;o<14;o++){const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()+o);const wd=d.getDay();const iso=isoDate(d);
  data.days.forEach((label,ci)=>{if(WEEKDAY[label]!==wd)return;data.rows.forEach(r=>{const c=r.cells&&r.cells[ci];if(!c||!c.title||!c.id)return;if(occStart(iso,r.time)<=now)return;out.push({id:c.id,date:iso,time:r.time,title:c.title,aud:c.audience,g:c.gender,lmin:c.level_min,lmax:c.level_max});});});}
console.log('occurrences (14d):',out.length,'| unique group_ids:',new Set(out.map(o=>o.id)).size);
const stu={audience:'adult',level:3,gender:'m'};
function elig(s,c){return s.audience===c.aud && c.lmin<=s.level && s.level<=c.lmax && (c.g==='mixed'||c.g===s.gender);}
const ok=out.filter(o=>elig(stu,o));
console.log('eligible for adult/3/m:',ok.length,'sample:',ok.slice(0,3).map(o=>o.title+' '+o.date+' '+o.time));
"
```
Expected: `occurrences (14d): N` (>0); каждая допустимая — только `adult` + уровень в диапазоне + `men/mixed` (для сида — «Мужчины 2,5–3,5» и «Смешанные», не «Девушки»/«Дети»/«Экстремалы 3,5+»).

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2b): groupOccurrences generator + eligibility rule"
```

---

## Task 3: Сервер — `resolveAppStudent` + `POST /api/app/lessons`

**Files:**
- Modify: `server.js` (перед `POST /api/tg/webhook` / после `POST /api/app/identify`)

**Interfaces:**
- Consumes: `DEV_ALLOW_UNSIGNED`, `validateInitData`, `upsertTgSession`, `getTgSession`, `confirmedByPhone`, `groupOccurrences`, `eligible`, `countConfirmedStmt`, `studentActiveBookings`, `coachNameBySlot`, `parseStartMinutes`.
- Produces: `resolveAppUser(body)`, `resolveAppStudent(body)`; роут `POST /api/app/lessons`.

- [ ] **Шаг 1: Добавить `resolveAppStudent` и `/api/app/lessons`**

В `server.js` сразу после роута `POST /api/app/identify` (после его закрывающей `});`) вставить:
```js

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
```

- [ ] **Шаг 2: Проверить lessons для подходящего ученика (dev)**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=testtoken node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Игрок М3","phone":"+7 900 777-00-11","level":3,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
echo "student id=$SID"
echo -n "forbidden (wrong session phone) -> "; curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":901,\"dev_phone\":\"+70000000000\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))"
echo "lessons (matching phone):"; curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":902,\"dev_phone\":\"79007770011\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(' status:',j.status,'count:',j.lessons.length,'first:',JSON.stringify(j.lessons[0]||{}))})"
kill $SRV 2>/dev/null
```
Expected: `forbidden` для чужого телефона; `status: ok`, `count > 0`, первая карточка с `group_id/date/free/capacity/status:'open'/booked:false` (телефон матчится нормализованно: `79007770011` ↔ `+7 900 777-00-11`).

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2b): resolveAppStudent + /api/app/lessons (eligible dated lessons with availability)"
```

---

## Task 4: Сервер — `POST /api/app/book` (атомарная бронь)

**Files:**
- Modify: `server.js` (после `/api/app/lessons`)

**Interfaces:**
- Consumes: `resolveAppStudent`, `groupOccurrences`, `eligible`, `db.transaction`, `countConfirmedStmt`, `activeBookingExists`, `insertGroupBooking`.
- Produces: роут `POST /api/app/book`.

- [ ] **Шаг 1: Добавить `/api/app/book`**

В `server.js` сразу после роута `POST /api/app/lessons` вставить:
```js

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
      insertGroupBooking.run(student.id, group_id, date);
      return occ.capacity - (count + 1);
    })();
    res.json({ ok: true, free: Math.max(0, freeLeft) });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'full' || msg === 'duplicate') return res.json({ error: msg });
    if (msg.includes('UNIQUE')) return res.json({ error: 'duplicate' });
    return res.status(500).json({ error: 'server' });
  }
});
```

- [ ] **Шаг 2: Проверить бронь: ok → duplicate → ineligible → full**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOOK=1 TELEGRAM_BOT_TOKEN=testtoken node server.js & SRV=$!; sleep 1.2
# ученик adult/3/m
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Букер М3","phone":"+7 900 888-00-22","level":3,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
# берём первое подходящее занятие
read GID DATE CAP < <(curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":903,\"dev_phone\":\"79008880022\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).lessons.find(x=>x.status==='open');console.log(l.group_id, l.date, l.capacity)})")
echo "target group=$GID date=$DATE capacity=$CAP"
echo -n "book ok -> "; curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":903,\"dev_phone\":\"79008880022\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
echo -n "book duplicate -> "; curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":903,\"dev_phone\":\"79008880022\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))"
# ineligible: женский ученик пытается бронировать мужскую группу
SIDF=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Жен1","phone":"+7 900 999-00-33","level":1,"audience":"adult","gender":"f","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
echo -n "book ineligible -> "; curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":904,\"dev_phone\":\"79009990033\",\"student_id\":$SIDF,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))"
# full: добить группу до capacity фиктивными бронями, затем реальная бронь новым учеником
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const ins=db.prepare(\"INSERT INTO bookings (student_id,type,group_id,date) VALUES (?, 'group', ?, ?)\");const cap=$CAP;const have=db.prepare(\"SELECT COUNT(*) n FROM bookings WHERE group_id=? AND date=? AND status='confirmed'\").get('$GID','$DATE').n;for(let i=have;i<cap;i++)ins.run(90000+i,'$GID','$DATE');console.log('filled to',cap);"
SID2=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Букер2","phone":"+7 900 111-77-88","level":3,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
echo -n "book full -> "; curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":905,\"dev_phone\":\"79001117788\",\"student_id\":$SID2,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))"
kill $SRV 2>/dev/null
```
Expected: `book ok -> {"ok":true,"free":<capacity-1>}`; `duplicate`; `ineligible`; `full`.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2b): /api/app/book atomic group booking (full/duplicate/ineligible/expired)"
```

---

## Task 5: Mini App — список занятий и бронь

**Files:**
- Modify: `public/app.html` (CSS-блок + весь `<script>`)

**Interfaces:**
- Consumes: `POST /api/app/identify`, `POST /api/app/lessons`, `POST /api/app/book`.

- [ ] **Шаг 1: Добавить CSS для списка занятий**

В `public/app.html` внутри `<style>`, перед закрывающей `</style>`, добавить:
```css
    .mday { color:var(--accent); font-weight:800; font-size:13px; letter-spacing:1px; text-transform:uppercase; margin:20px 0 10px; }
    .lesson { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:14px 16px; margin-bottom:10px; }
    .lesson.clickable { cursor:pointer; }
    .lesson.clickable:active { transform:scale(0.98); }
    .bk { font-size:12px; font-weight:700; white-space:nowrap; }
    .bk.free { color:var(--accent); }
    .bk.none { color:var(--muted); }
    .bk.booked { color:#FFB347; }
```

- [ ] **Шаг 2: Заменить весь `<script>` на расширенный**

Заменить весь блок `<script> … </script>` (тот, что содержит `const tg = window.Telegram`) на:
```html
  <script>
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { tg.ready(); tg.expand(); }
    const root = document.getElementById('root');
    const errEl = document.getElementById('err');
    const esc = s => String(s==null?'':s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
    const initData = tg ? tg.initData : '';
    let student = null;

    async function api(path, body) {
      const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(Object.assign({ initData }, body)) });
      if (r.status === 401) return { _http: 401 };
      return await r.json();
    }

    async function identify() {
      const data = await api('/api/app/identify', {});
      if (data._http === 401) { root.innerHTML = '<div class="card">Не удалось подтвердить вход. Откройте приложение из бота.</div>'; return; }
      if (data.status === 'need_phone') return renderNeedPhone();
      if (data.status === 'unmatched') return renderUnmatched(data.manager);
      if (data.status === 'ok') return renderStudents(data.students);
      root.innerHTML = '<div class="card">Неизвестный ответ сервера.</div>';
    }

    function renderNeedPhone() {
      root.innerHTML = '<div class="card"><div class="muted" style="margin-bottom:14px">Поделитесь номером телефона — по нему мы найдём вас в базе академии.</div><button id="share">📱 Поделиться телефоном</button></div>';
      document.getElementById('share').onclick = () => {
        if (tg && tg.requestContact) tg.requestContact(() => setTimeout(identify, 800));
        else errEl.textContent = 'Откройте приложение из Telegram-бота.';
      };
    }
    function renderUnmatched(manager) {
      const u = manager ? ('https://t.me/' + manager) : '#';
      root.innerHTML = '<div class="card"><h1 style="font-size:18px">Вы ещё у нас не занимались</h1><div class="muted" style="margin:8px 0 16px">Напишите менеджеру — он подберёт группу и оформит вас.</div><a class="mgr" href="'+u+'">Написать менеджеру</a></div>';
    }
    function renderStudents(students) {
      if (!students || !students.length) { root.innerHTML = '<div class="card">Профиль не найден.</div>'; return; }
      if (students.length === 1) { student = students[0]; return loadLessons(); }
      root.innerHTML = '<div class="card"><h1 style="font-size:18px">Кого записываем?</h1>' +
        students.map(s => '<div class="stud" data-id="'+s.id+'" style="cursor:pointer"><div><strong>'+esc(s.name)+'</strong></div>'+(s.level!=null?'<div class="lv">'+s.level+'</div>':'')+'</div>').join('') + '</div>';
      root.querySelectorAll('.stud').forEach(el => el.onclick = () => { student = students.find(s => s.id === Number(el.dataset.id)); loadLessons(); });
    }

    async function loadLessons() {
      root.innerHTML = '<div class="card">Загрузка занятий…</div>';
      const data = await api('/api/app/lessons', { student_id: student.id });
      if (data.status !== 'ok') { root.innerHTML = '<div class="card">Не удалось загрузить занятия.</div>'; return; }
      renderLessons(data.lessons);
    }

    const DOW = ['вс','пн','вт','ср','чт','пт','сб'];
    function fmtDate(iso) {
      const [y,m,d] = iso.split('-').map(Number);
      const dt = new Date(y, m-1, d);
      return d + '.' + String(m).padStart(2,'0') + ' · ' + DOW[dt.getDay()];
    }
    function renderLessons(lessons) {
      let html = '<div class="muted" style="margin-bottom:6px">Ученик: <strong style="color:var(--text)">'+esc(student.name)+'</strong></div>';
      if (!lessons.length) { root.innerHTML = html + '<div class="card">Нет подходящих занятий. Уточните уровень/группу у тренера.</div>'; return; }
      let curDate = null;
      lessons.forEach(l => {
        if (l.date !== curDate) { curDate = l.date; html += '<div class="mday">'+fmtDate(l.date)+'</div>'; }
        const badge = l.booked ? '<span class="bk booked">вы записаны</span>'
          : l.status === 'open' ? '<span class="bk free">свободно '+l.free+'/'+l.capacity+'</span>'
          : l.status === 'overbooked' ? '<span class="bk none">перебор</span>'
          : '<span class="bk none">мест нет</span>';
        const clickable = (!l.booked && l.status === 'open');
        html += '<div class="lesson'+(clickable?' clickable':'')+'"'+(clickable?' data-g="'+esc(l.group_id)+'" data-d="'+l.date+'"':'')+'>'
          + '<div><strong>'+esc(l.title)+'</strong><div class="muted">'+esc(l.time)+(l.coach_name?' · '+esc(l.coach_name):'')+'</div></div>'
          + badge + '</div>';
      });
      root.innerHTML = html;
      root.querySelectorAll('.lesson.clickable').forEach(el => el.onclick = () => book(el.dataset.g, el.dataset.d, el));
    }

    async function book(group_id, date, el) {
      el.style.opacity = '0.5';
      const data = await api('/api/app/book', { student_id: student.id, group_id, date });
      if (data.ok) { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success'); loadLessons(); return; }
      const msg = data.error === 'full' ? 'Мест нет' : data.error === 'duplicate' ? 'Вы уже записаны'
        : data.error === 'ineligible' ? 'Группа вам не подходит' : data.error === 'expired' ? 'Занятие уже прошло' : 'Ошибка';
      errEl.textContent = msg; el.style.opacity = '';
      setTimeout(() => errEl.textContent = '', 2500);
      if (data.error === 'full' || data.error === 'duplicate') loadLessons();
    }

    identify().catch(() => { errEl.textContent = 'Ошибка сети'; });
  </script>
```

- [ ] **Шаг 3: Проверить, что страница отдаётся и скрипт валиден**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo -n "/app -> "; curl -s localhost:3000/app -o /tmp/app.html -w '%{http_code}\n'
node -e "const h=require('fs').readFileSync('/tmp/app.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/)[1];try{new Function(m.replace(/await /g,''));console.log('script parses (sync-stripped) OK')}catch(e){console.log('PARSE ERROR:',e.message)}"
grep -c 'api/app/lessons\|api/app/book\|renderLessons' /tmp/app.html
kill $SRV 2>/dev/null
```
Expected: `/app -> 200`; `script parses (sync-stripped) OK`; grep `>=3` (эндпоинты и рендер присутствуют).

- [ ] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add public/app.html && git commit -m "feat(2b): Mini App lessons list + one-tap group booking"
```

---

## Task 6: Деплой + прод-проверка

**Files:** нет изменений кода — выкладка.

- [ ] **Шаг 1: Выложить сервер и Mini App**
```bash
cd /root/savvateam && export SSHPASS='oDR%r1C%rZjm'
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js root@45.139.29.201:/root/savvateam-site/
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" public/app.html root@45.139.29.201:/root/savvateam-site/public/
echo "rsync done"
```

- [ ] **Шаг 2: Перезапустить и проверить таблицу bookings**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam >/dev/null 2>&1 && sleep 1.5 && node -e \"const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('bookings cols:',db.prepare('PRAGMA table_info(bookings)').all().length,'| ux index:',db.prepare(\\\"SELECT name FROM sqlite_master WHERE name='ux_booking_active'\\\").all().length)\""
```
Expected: `bookings cols: 9 | ux index: 1`.

- [ ] **Шаг 3: Прод smoke — эндпоинты отвечают, auth работает**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "
curl -s -X POST localhost:3002/api/app/lessons -H 'Content-Type: application/json' -d '{}' -w 'lessons(no-initData) %{http_code} (expect 401)\n' -o /dev/null
curl -s -X POST localhost:3002/api/app/book -H 'Content-Type: application/json' -d '{}' -w 'book(no-initData) %{http_code} (expect 401)\n' -o /dev/null
"
echo -n "public /app -> "; curl -s https://savva.n2node.store/app -o /dev/null -w '%{http_code}\n'
```
Expected: оба `401`; публичный `/app` `200`.

- [ ] **Шаг 4: Живая проверка в Telegram (ручная, пользователем)**

Предусловие: в админке у своего ученика проставить `level`/`audience`/`gender` (иначе занятий не будет) и `confirmed`. Затем @SavvaPadel_bot → Mini App → должен появиться список подходящих занятий по датам со «свободно N/M»; тап → «Записаны!»; повторный тап того же → недоступен (уже записаны); счётчик уменьшается.

- [ ] **Шаг 5: Push**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** `bookings`+индекс → Task 1; occurrences+допуск (маппинг дней, будущее, cell.id) → Task 2; `resolveAppStudent`+`/api/app/lessons` (доступность, booked, владение, нормализация телефона) → Task 3; `/api/app/book` атомарная (full/duplicate/ineligible/expired) → Task 4; Mini App список по датам + бронь → Task 5; деплой+прод-проверки → Task 6. Все пункты спеки покрыты.
- **Плейсхолдеров нет** — весь код целиком.
- **Согласованность имён:** statements (`countConfirmedStmt`, `activeBookingExists`, `insertGroupBooking`, `studentActiveBookings`) — Task 1, используются Task 3/4. Хелперы (`groupOccurrences`, `eligible`, `occStart`, `parseStartMinutes`, `scheduleData`, `resolveAppStudent`) — Task 2/3, используются согласованно. Эндпоинты `/api/app/lessons`, `/api/app/book` совпадают между сервером (Task 3/4) и Mini App (Task 5). Поля занятия (`group_id,date,time,title,meta,cat,coach_name,capacity,free,status,booked`) одинаковы в `/lessons` (Task 3) и рендере (Task 5).
- **Переиспользование:** `validateInitData`, `normPhone`/`confirmedByPhone`, `getTgSession`/`upsertTgSession`, `coachNameBySlot` — из 2A/фикса, не дублируются.
- **Атомарность/овербукинг:** транзакция + уникальный индекс (Task 1/4); статус `overbooked` при `count>capacity` (Task 3) — соответствует спеке.
- **Границы:** уведомления/отмена/раздел «Записи» — не входят (2C); `type/coach_id/datetime` заведены под Фазу 3 без использования.
