# Фаза 3B — Индивидуальная запись — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подтверждённый ученик выбирает тренера, видит его свободное время (нарезка окон минус занятые) и бронирует индивидуальную тренировку выбираемой длительности (≥60 мин, кратно 30); уведомление тренеру; отмена ≥8ч; individual в «Записях».

**Architecture:** Расширяем `server.js`: миграция `bookings.duration_min`; хелпер `individualSlots` (свободные интервалы); эндпоинты `coaches`/`slots`/`book-individual`/`my-bookings`; `cancel` по `booking_id`; `GET /api/bookings` на individual. Расширяем `public/app.html`: 3 вкладки. Переиспуем `resolveAppStudent`/`notify*`/`occStart`/`normPhone`/`coachNameBySlot`/`cellById`/`cancelBookingById`/`getBookingById`/`listAvailability`/`listCoaches`/`getCoach`.

**Tech Stack:** Express + better-sqlite3, Node 22. Тест-фреймворка нет — curl / браузер; локально `DEV_ALLOW_UNSIGNED=1`. Часовой пояс — серверный localtime.

## Global Constraints

- Individual-бронь: `type='individual'`, `coach_id`=slot, `datetime`=`'YYYY-MM-DD HH:MM'` (старт), `duration_min` (целое, ≥60, кратно 30). Групповые поля NULL.
- Слоты: старты шаг 30 мин в свободных интервалах (окно `coach_availability` минус активные individual-брони тренера), длительности `60,90,…` до конца свободного интервала, только будущие.
- Целостность пересечений — проверкой в транзакции (нет DB-индекса на интервалы).
- Допуск: любой подтверждённый ученик → любой тренер (без фильтра уровня/пола).
- Отмена ≥8ч (`occStart` старта); тренер в админке — без окна. Уведомления never-throw (`.catch(()=>{})`).
- Auth Mini App — `resolveAppStudent` (как 2B). Admin — `requireSecret`.
- Деплой: `server.js` → корень, `public/*.html` → `public/`; `pm2 restart savvateam`; `sshpass -e`.

---

## Структура файлов

- `server.js`:
  - После `getBookingById` (≈строка 313) — миграция `duration_min` + individual statements (Task 1).
  - После `individualSlots`-хелперов (рядом с `groupOccurrences`/`eligible`, ≈строка 397) — `individualSlots` + минутные хелперы + `notifyIndividualCreated` (Task 1).
  - После `/api/app/book` (≈строка 780) — `coaches`/`slots` (Task 2), `book-individual` (Task 3), `my-bookings` + расширение `cancel` (Task 4).
  - `GET /api/bookings` (≈строка 834) — на individual (Task 5).
- `public/app.html` — весь `<script>` + CSS вкладок/чипов (Task 6).

---

## Task 1: Сервер — миграция + individual statements + `individualSlots`

**Files:**
- Modify: `server.js` (после `getBookingById` ≈313; рядом с `eligible`/хелперами ≈397)

**Interfaces:**
- Consumes: `db`, `listAvailability`, `isoDate`, `parseStartMinutes`, `coachChatIdForGroup`, `tgApi`.
- Produces: колонка `bookings.duration_min`; statements `insertIndividualBooking`, `coachIndividualBookings`; хелперы `toMin`, `minToHHMM`, `subtractIntervals`, `individualSlots(slot,days)`, `notifyIndividualCreated`.

- [ ] **Шаг 1: Миграция + statements**

В `server.js` сразу после строки `const getBookingById = db.prepare("SELECT * FROM bookings WHERE id = ?");` вставить:
```js
try { db.exec("ALTER TABLE bookings ADD COLUMN duration_min INTEGER"); } catch { /* колонка есть */ }
const insertIndividualBooking = db.prepare(
  "INSERT INTO bookings (student_id, type, coach_id, datetime, duration_min) VALUES (?, 'individual', ?, ?, ?)"
);
const coachIndividualBookings = db.prepare(
  "SELECT datetime, duration_min FROM bookings WHERE coach_id = ? AND type = 'individual' AND status = 'confirmed'"
);
```

- [ ] **Шаг 2: Хелперы нарезки + уведомление**

В `server.js` сразу после функции `eligible` (после её `}`) вставить:
```js

function toMin(hhmm) { const m = /(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function minToHHMM(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function subtractIntervals(wf, wt, occupied) {
  let free = [[wf, wt]];
  for (const [os, oe] of occupied) {
    const next = [];
    for (const [fs, fe] of free) {
      if (oe <= fs || os >= fe) { next.push([fs, fe]); continue; }
      if (os > fs) next.push([fs, Math.min(os, fe)]);
      if (oe < fe) next.push([Math.max(oe, fs), fe]);
    }
    free = next;
  }
  return free.filter(([a, b]) => b > a);
}
function individualSlots(slot, days = 14) {
  const windows = listAvailability.all(slot);
  if (!windows.length) return [];
  const busy = {};
  coachIndividualBookings.all(slot).forEach(b => {
    if (!b.datetime || !b.duration_min) return;
    const date = b.datetime.slice(0, 10);
    const sm = toMin(b.datetime.slice(11));
    if (sm == null) return;
    (busy[date] = busy[date] || []).push([sm, sm + b.duration_min]);
  });
  const now = new Date();
  const out = [];
  for (let off = 0; off < days; off++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    const wd = d.getDay();
    const dateIso = isoDate(d);
    const dayWindows = windows.filter(w => Number(w.day) === wd);
    if (!dayWindows.length) continue;
    const occupied = (busy[dateIso] || []).slice().sort((a, b) => a[0] - b[0]);
    const starts = [];
    for (const w of dayWindows) {
      const wf = toMin(w.from_time), wt = toMin(w.to_time);
      if (wf == null || wt == null) continue;
      for (const [a, b] of subtractIntervals(wf, wt, occupied)) {
        if (b - a < 60) continue;
        for (let s = a; s + 60 <= b; s += 30) {
          const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(s / 60), s % 60, 0, 0);
          if (startDate <= now) continue;
          const durations = [];
          for (let dur = 60; s + dur <= b; dur += 30) durations.push(dur);
          if (durations.length) starts.push({ time: minToHHMM(s), datetime: dateIso + ' ' + minToHHMM(s), durations });
        }
      }
    }
    if (starts.length) { starts.sort((x, y) => toMin(x.time) - toMin(y.time)); out.push({ date: dateIso, starts }); }
  }
  return out;
}
async function notifyIndividualCreated(name, slot, datetime, duration) {
  const chat = coachChatIdForGroup(slot);
  if (!chat) return;
  await tgApi('sendMessage', { chat_id: chat, text: `🆕 Индивидуальная запись\n👤 ${name}\n📅 ${datetime}\n⏱ ${duration} мин` });
}
```

- [ ] **Шаг 3: Проверить миграцию и нарезку (dev)**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('has duration_min:', db.prepare('PRAGMA table_info(bookings)').all().some(c=>c.name==='duration_min'))"
# задать окно coach1 на завтрашний день недели 10:00-14:00 и проверить slots через API (Task 2) позже; здесь только миграция
kill $SRV 2>/dev/null
```
Expected: `has duration_min: true`.

- [ ] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3b): duration_min migration + individualSlots slicing + individual notify helper"
```

---

## Task 2: Сервер — `POST /api/app/coaches` + `/api/app/slots`

**Files:**
- Modify: `server.js` (после `/api/app/book`)

**Interfaces:**
- Consumes: `resolveAppStudent`, `listCoaches`, `coachNameBySlot`, `getCoach`, `individualSlots`.
- Produces: роуты `POST /api/app/coaches`, `POST /api/app/slots`.

- [ ] **Шаг 1: Добавить роуты**

В `server.js` сразу после роута `POST /api/app/book` (после его `});`) вставить:
```js

app.post('/api/app/coaches', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const coaches = listCoaches.all().map(c => ({ slot: c.slot, name: coachNameBySlot(c.slot) }));
  res.json({ status: 'ok', coaches });
});

app.post('/api/app/slots', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const slot = String((req.body && req.body.slot) || '');
  if (!getCoach.get(slot)) return res.json({ error: 'no_coach' });
  res.json({ status: 'ok', dates: individualSlots(slot, 14) });
});
```

- [ ] **Шаг 2: Проверить coaches и slots (dev)**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Инд Тест","phone":"+7 900 500-00-00","level":2,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
# окно coach1 на СЕГОДНЯ+1 (завтра) весь день 08:00-22:00, чтобы точно были будущие старты
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const t=new Date();t.setDate(t.getDate()+1);const wd=t.getDay();db.prepare('DELETE FROM coach_availability WHERE slot=?').run('coach1');db.prepare('INSERT INTO coach_availability (slot,day,from_time,to_time) VALUES (?,?,?,?)').run('coach1',wd,'08:00','22:00');console.log('window set day',wd)"
echo "coaches -> "; curl -s -X POST localhost:3000/api/app/coaches -H 'Content-Type: application/json' -d "{\"dev_user_id\":800,\"dev_phone\":\"79005000000\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).coaches.map(c=>c.slot+'='+c.name).join(', ')))"
echo "slots coach1 -> "; curl -s -X POST localhost:3000/api/app/slots -H 'Content-Type: application/json' -d "{\"dev_user_id\":800,\"dev_phone\":\"79005000000\",\"student_id\":$SID,\"slot\":\"coach1\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const day=j.dates[0];console.log('first date',day.date,'starts',day.starts.length,'first start',JSON.stringify(day.starts[0]))})"
kill $SRV 2>/dev/null
```
Expected: `coaches` — 3 слота с именами; `slots coach1` — первая дата (завтра) со стартами (08:00,08:30,…,21:00) и первым стартом с массивом `durations` (60,90,…).

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3b): /api/app/coaches + /api/app/slots (individual free time)"
```

---

## Task 3: Сервер — `POST /api/app/book-individual` (атомарно)

**Files:**
- Modify: `server.js` (после `/api/app/slots`)

**Interfaces:**
- Consumes: `resolveAppStudent`, `getCoach`, `individualSlots`, `toMin`, `coachIndividualBookings`, `insertIndividualBooking`, `notifyIndividualCreated`, `db`.
- Produces: роут `POST /api/app/book-individual`.

- [ ] **Шаг 1: Добавить роут**

В `server.js` сразу после роута `POST /api/app/slots` вставить:
```js

app.post('/api/app/book-individual', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const student = r.student;
  const slot = String((req.body && req.body.slot) || '');
  const datetime = String((req.body && req.body.datetime) || '');
  const duration = Number(req.body && req.body.duration_min);
  if (!getCoach.get(slot)) return res.json({ error: 'no_coach' });
  if (!Number.isInteger(duration) || duration < 60 || duration % 30 !== 0) return res.json({ error: 'invalid' });
  const dateIso = datetime.slice(0, 10);
  const dayEntry = individualSlots(slot, 14).find(x => x.date === dateIso);
  const startEntry = dayEntry && dayEntry.starts.find(s => s.datetime === datetime);
  if (!startEntry) return res.json({ error: 'expired' });
  if (!startEntry.durations.includes(duration)) return res.json({ error: 'invalid' });
  const startMin = toMin(datetime.slice(11));
  try {
    db.transaction(() => {
      const conflicts = coachIndividualBookings.all(slot).filter(b => b.datetime && b.datetime.slice(0, 10) === dateIso);
      for (const b of conflicts) {
        const bs = toMin(b.datetime.slice(11)), be = bs + (b.duration_min || 0);
        if (startMin < be && startMin + duration > bs) throw new Error('taken');
      }
      insertIndividualBooking.run(student.id, slot, datetime, duration);
    })();
    notifyIndividualCreated(student.name, slot, datetime, duration).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'taken') return res.json({ error: 'taken' });
    return res.status(500).json({ error: 'server' });
  }
});
```

- [ ] **Шаг 2: Проверить бронь: ok → пересечение taken → невалидная длительность**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Инд Букер","phone":"+7 900 600-00-00","level":2,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const t=new Date();t.setDate(t.getDate()+1);const wd=t.getDay();db.prepare('DELETE FROM coach_availability WHERE slot=?').run('coach2');db.prepare('INSERT INTO coach_availability (slot,day,from_time,to_time) VALUES (?,?,?,?)').run('coach2',wd,'08:00','22:00')"
read DT DUR < <(curl -s -X POST localhost:3000/api/app/slots -H 'Content-Type: application/json' -d "{\"dev_user_id\":810,\"dev_phone\":\"79006000000\",\"student_id\":$SID,\"slot\":\"coach2\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d).dates[0].starts[0];console.log(s.datetime, s.durations[1]||s.durations[0])})")
echo "target datetime=$DT duration=$DUR"
echo -n "book ok -> "; curl -s -X POST localhost:3000/api/app/book-individual -H 'Content-Type: application/json' -d "{\"dev_user_id\":810,\"dev_phone\":\"79006000000\",\"student_id\":$SID,\"slot\":\"coach2\",\"datetime\":\"$DT\",\"duration_min\":$DUR}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
echo -n "book overlap taken -> "; curl -s -X POST localhost:3000/api/app/book-individual -H 'Content-Type: application/json' -d "{\"dev_user_id\":810,\"dev_phone\":\"79006000000\",\"student_id\":$SID,\"slot\":\"coach2\",\"datetime\":\"$DT\",\"duration_min\":60}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error||JSON.parse(d)))"
echo -n "invalid duration 45 -> "; curl -s -X POST localhost:3000/api/app/book-individual -H 'Content-Type: application/json' -d "{\"dev_user_id\":810,\"dev_phone\":\"79006000000\",\"student_id\":$SID,\"slot\":\"coach2\",\"datetime\":\"$DT\",\"duration_min\":45}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))"
echo -n "slots after book (start gone) -> "; curl -s -X POST localhost:3000/api/app/slots -H 'Content-Type: application/json' -d "{\"dev_user_id\":810,\"dev_phone\":\"79006000000\",\"student_id\":$SID,\"slot\":\"coach2\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const dd=JSON.parse(d).dates.find(x=>'$DT'.startsWith(x.date));console.log('start still present:', dd?dd.starts.some(s=>s.datetime==='$DT'):false)})"
kill $SRV 2>/dev/null
```
Expected: `book ok -> {"ok":true}`; overlap → `taken`; duration 45 → `invalid`; после брони старт `$DT` больше не свободен (`start still present: false`).

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3b): POST /api/app/book-individual atomic (overlap check, notify trainer)"
```

---

## Task 4: Сервер — `my-bookings` + `cancel` по `booking_id`

**Files:**
- Modify: `server.js` (после `book-individual`; правка `POST /api/app/cancel`)

**Interfaces:**
- Consumes: `resolveAppStudent`, `db`, `occStart`, `cellById`, `coachNameBySlot`, `getBookingById`, `cancelBookingById`, `notifyTrainerCancelled`.
- Produces: роут `POST /api/app/my-bookings`; расширенный `POST /api/app/cancel`.

- [ ] **Шаг 1: Добавить `my-bookings`**

В `server.js` сразу после роута `POST /api/app/book-individual` вставить:
```js

app.post('/api/app/my-bookings', (req, res) => {
  const r = resolveAppStudent(req.body || {});
  if (r.code === 401) return res.status(401).json({ error: r.error });
  if (r.status) return res.json({ status: r.status });
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM bookings WHERE student_id = ? AND status = 'confirmed'").all(r.student.id);
  const items = rows.map(b => {
    if (b.type === 'individual') {
      const startMs = occStart(b.datetime.slice(0, 10), b.datetime.slice(11)).getTime();
      return { booking_id: b.id, kind: 'individual', title: 'Индивидуально (' + (b.duration_min || '?') + ' мин)', when: b.datetime, coach_name: coachNameBySlot(b.coach_id || ''), startMs };
    }
    const cell = cellById(b.group_id) || {};
    const time = b.time || cell.time || '';
    return { booking_id: b.id, kind: 'group', title: b.title || cell.title || '(группа)', when: (b.date || '') + ' ' + time, coach_name: coachNameBySlot(b.coach_id || cell.coach_id || ''), startMs: occStart(b.date, time).getTime() };
  }).filter(x => x.startMs > now)
    .sort((a, b) => a.startMs - b.startMs)
    .map(x => ({ booking_id: x.booking_id, kind: x.kind, title: x.title, when: x.when, coach_name: x.coach_name, cancelable: x.startMs - now >= 8 * 3600 * 1000 }));
  res.json({ status: 'ok', bookings: items });
});
```

- [ ] **Шаг 2: Расширить `POST /api/app/cancel` веткой `booking_id`**

В `server.js` в роуте `app.post('/api/app/cancel', ...)` сразу после строки `const student = r.student;` вставить:
```js
  if (req.body && req.body.booking_id != null) {
    const b = getBookingById.get(Number(req.body.booking_id));
    if (!b || b.status !== 'confirmed') return res.json({ error: 'not_found' });
    if (b.student_id !== student.id) return res.json({ error: 'forbidden' });
    const gcell = b.type === 'group' ? (cellById(b.group_id) || {}) : {};
    const startMs = b.type === 'individual'
      ? occStart(b.datetime.slice(0, 10), b.datetime.slice(11)).getTime()
      : occStart(b.date, b.time || gcell.time).getTime();
    if (startMs - Date.now() < 8 * 3600 * 1000) return res.json({ error: 'too_late' });
    cancelBookingById.run(b.id);
    const norm = b.type === 'individual'
      ? { coach_id: b.coach_id, title: 'Индивидуально (' + (b.duration_min || '') + ' мин)', date: b.datetime.slice(0, 10), time: b.datetime.slice(11) }
      : { coach_id: b.coach_id || gcell.coach_id, title: b.title || gcell.title, date: b.date, time: b.time || gcell.time };
    notifyTrainerCancelled(student.name, norm).catch(() => {});
    return res.json({ ok: true });
  }
```

- [ ] **Шаг 3: Проверить my-bookings + отмену по booking_id**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"МоиЗап","phone":"+7 900 700-00-00","level":2,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const t=new Date();t.setDate(t.getDate()+2);const wd=t.getDay();db.prepare('DELETE FROM coach_availability WHERE slot=?').run('coach3');db.prepare('INSERT INTO coach_availability (slot,day,from_time,to_time) VALUES (?,?,?,?)').run('coach3',wd,'08:00','22:00')"
read DT < <(curl -s -X POST localhost:3000/api/app/slots -H 'Content-Type: application/json' -d "{\"dev_user_id\":820,\"dev_phone\":\"79007000000\",\"student_id\":$SID,\"slot\":\"coach3\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).dates[0].starts[0].datetime))")
curl -s -X POST localhost:3000/api/app/book-individual -H 'Content-Type: application/json' -d "{\"dev_user_id\":820,\"dev_phone\":\"79007000000\",\"student_id\":$SID,\"slot\":\"coach3\",\"datetime\":\"$DT\",\"duration_min\":60}" -o /dev/null
echo "my-bookings:"; curl -s -X POST localhost:3000/api/app/my-bookings -H 'Content-Type: application/json' -d "{\"dev_user_id\":820,\"dev_phone\":\"79007000000\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d).bookings[0];console.log(JSON.stringify(b))})"
BID=$(curl -s -X POST localhost:3000/api/app/my-bookings -H 'Content-Type: application/json' -d "{\"dev_user_id\":820,\"dev_phone\":\"79007000000\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).bookings[0].booking_id))")
echo -n "cancel by id ok -> "; curl -s -X POST localhost:3000/api/app/cancel -H 'Content-Type: application/json' -d "{\"dev_user_id\":820,\"dev_phone\":\"79007000000\",\"student_id\":$SID,\"booking_id\":$BID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
echo -n "my-bookings after cancel -> "; curl -s -X POST localhost:3000/api/app/my-bookings -H 'Content-Type: application/json' -d "{\"dev_user_id\":820,\"dev_phone\":\"79007000000\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('count',JSON.parse(d).bookings.length))"
kill $SRV 2>/dev/null
```
Expected: my-bookings содержит individual с `title:'Индивидуально (60 мин)'`, `cancelable:true`; cancel by id → `{ok:true}`; после отмены `count 0`.

- [ ] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3b): /api/app/my-bookings + cancel by booking_id (unified group/individual)"
```

---

## Task 5: Сервер — `GET /api/bookings` показывает individual

**Files:**
- Modify: `server.js` (`GET /api/bookings`, ≈строка 834)

**Interfaces:**
- Consumes: `db`, `cellById`, `coachNameBySlot`, `occStart`.
- Produces: `GET /api/bookings` включает `type='individual'`.

- [ ] **Шаг 1: Заменить тело роута `GET /api/bookings`**

Заменить существующий роут `GET /api/bookings` целиком на:
```js
app.get('/api/bookings', requireSecret, (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'future';
  const rows = db.prepare(
    "SELECT b.*, s.name AS student_name FROM bookings b LEFT JOIN students s ON s.id = b.student_id WHERE b.type IN ('group','individual') ORDER BY b.date, b.datetime, b.time"
  ).all();
  const now = Date.now();
  const out = rows.map(b => {
    if (b.type === 'individual') {
      const date = (b.datetime || '').slice(0, 10), time = (b.datetime || '').slice(11);
      return {
        id: b.id, student_id: b.student_id, student_name: b.student_name || '—',
        group_id: null, date, time, title: 'Индивидуально (' + (b.duration_min || '?') + ' мин)',
        coach_name: coachNameBySlot(b.coach_id || ''), status: b.status, created_at: b.created_at,
      };
    }
    const cell = cellById(b.group_id) || {};
    const title = b.title || cell.title || '(группа изменена)';
    const time = b.time || cell.time || '';
    return {
      id: b.id, student_id: b.student_id, student_name: b.student_name || '—',
      group_id: b.group_id, date: b.date, time, title,
      coach_name: coachNameBySlot(b.coach_id || cell.coach_id || ''),
      status: b.status, created_at: b.created_at,
    };
  }).filter(b => scope === 'all' ? true : (b.status === 'confirmed' && occStart(b.date, b.time).getTime() > now));
  res.json(out);
});
```

- [ ] **Шаг 2: Проверить, что individual попадает в список**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"АдмИнд","phone":"+7 900 800-00-00","level":2,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const t=new Date();t.setDate(t.getDate()+3);const wd=t.getDay();db.prepare('DELETE FROM coach_availability WHERE slot=?').run('coach1');db.prepare('INSERT INTO coach_availability (slot,day,from_time,to_time) VALUES (?,?,?,?)').run('coach1',wd,'08:00','22:00')"
read DT < <(curl -s -X POST localhost:3000/api/app/slots -H 'Content-Type: application/json' -d "{\"dev_user_id\":830,\"dev_phone\":\"79008000000\",\"student_id\":$SID,\"slot\":\"coach1\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).dates[0].starts[0].datetime))")
curl -s -X POST localhost:3000/api/app/book-individual -H 'Content-Type: application/json' -d "{\"dev_user_id\":830,\"dev_phone\":\"79008000000\",\"student_id\":$SID,\"slot\":\"coach1\",\"datetime\":\"$DT\",\"duration_min\":90}" -o /dev/null
echo "future bookings individual:"; curl -s "localhost:3000/api/bookings?scope=future" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).find(x=>x.student_name==='АдмИнд');console.log(JSON.stringify(m||'НЕТ'))})"
kill $SRV 2>/dev/null
```
Expected: запись «АдмИнд» с `title:'Индивидуально (90 мин)'`, `date/time` из datetime, `coach_name` тренера.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3b): GET /api/bookings includes individual bookings"
```

---

## Task 6: Mini App — 3 вкладки (Групповые / Индивидуально / Мои записи)

**Files:**
- Modify: `public/app.html` (CSS + весь инлайновый `<script>`)

**Interfaces:**
- Consumes: `/api/app/identify`, `/api/app/lessons`, `/api/app/book`, `/api/app/coaches`, `/api/app/slots`, `/api/app/book-individual`, `/api/app/my-bookings`, `/api/app/cancel`.

- [ ] **Шаг 1: Добавить CSS вкладок/чипов**

В `public/app.html` внутри `<style>` перед `</style>` добавить:
```css
    .tabs { display:flex; gap:8px; margin:12px 0 18px; }
    .tab { flex:1; padding:10px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--muted); font-weight:700; font-size:13px; cursor:pointer; }
    .tab.active { background:var(--accent); border-color:var(--accent); color:#0a0a0a; }
    .cbtn { width:100%; padding:14px 16px; border:1px solid var(--border); border-radius:14px; background:var(--surface); color:var(--text); font-size:15px; font-weight:700; text-align:left; cursor:pointer; margin-bottom:10px; }
    .start { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid var(--border); border-radius:12px; margin-bottom:8px; cursor:pointer; }
    .start.open { border-color:var(--accent); }
    .chips { display:flex; flex-wrap:wrap; gap:8px; margin:4px 0 12px; }
    .chip { padding:8px 14px; border:1px solid var(--accent); border-radius:999px; background:transparent; color:var(--accent); font-weight:700; font-size:13px; cursor:pointer; }
    .chip:active { transform:scale(0.96); }
```

- [ ] **Шаг 2: Заменить весь инлайновый `<script>`**

Заменить весь блок `<script> … </script>` (тот, что начинается `const tg = window.Telegram`) на:
```html
  <script>
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { tg.ready(); tg.expand(); }
    const root = document.getElementById('root');
    const errEl = document.getElementById('err');
    const esc = s => String(s==null?'':s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
    const initData = tg ? tg.initData : '';
    let student = null, tab = 'group', curSlot = null;

    async function api(path, body){
      const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({initData},body))});
      if (r.status===401) return {_http:401};
      return await r.json();
    }
    const flash = m => { errEl.textContent=m; setTimeout(()=>errEl.textContent='',2600); };
    const body = () => document.getElementById('tabBody');

    async function identify(){
      const data = await api('/api/app/identify',{});
      if (data._http===401){ root.innerHTML='<div class="card">Не удалось подтвердить вход. Откройте приложение из бота.</div>'; return; }
      if (data.status==='need_phone') return renderNeedPhone();
      if (data.status==='unmatched') return renderUnmatched(data.manager);
      if (data.status==='ok') return renderStudents(data.students);
      root.innerHTML='<div class="card">Неизвестный ответ сервера.</div>';
    }
    function renderNeedPhone(){
      root.innerHTML='<div class="card"><div class="muted" style="margin-bottom:14px">Поделитесь номером телефона — по нему мы найдём вас в базе академии.</div><button id="share">📱 Поделиться телефоном</button></div>';
      document.getElementById('share').onclick=()=>{ if(tg&&tg.requestContact) tg.requestContact(()=>setTimeout(identify,800)); else flash('Откройте приложение из Telegram-бота.'); };
    }
    function renderUnmatched(manager){
      const u = manager?('https://t.me/'+manager):'#';
      root.innerHTML='<div class="card"><h1 style="font-size:18px">Вы ещё у нас не занимались</h1><div class="muted" style="margin:8px 0 16px">Напишите менеджеру — он подберёт группу и оформит вас.</div><a class="mgr" href="'+u+'">Написать менеджеру</a></div>';
    }
    function renderStudents(students){
      if(!students||!students.length){ root.innerHTML='<div class="card">Профиль не найден.</div>'; return; }
      if(students.length===1){ chooseStudent(students[0]); return; }
      root.innerHTML='<div class="card"><h1 style="font-size:18px">Кого записываем?</h1>'+students.map(s=>'<div class="stud" data-id="'+s.id+'" style="cursor:pointer"><div><strong>'+esc(s.name)+'</strong></div>'+(s.level!=null?'<div class="lv">'+s.level+'</div>':'')+'</div>').join('')+'</div>';
      root.querySelectorAll('.stud').forEach(el=>el.onclick=()=>chooseStudent(students.find(s=>s.id===Number(el.dataset.id))));
    }
    function chooseStudent(s){ student=s; tab='group'; renderShell(); }
    function renderShell(){
      root.innerHTML='<div class="muted" style="margin-bottom:2px">Ученик: <strong style="color:var(--text)">'+esc(student.name)+'</strong></div>'
        +'<div class="tabs"><button class="tab" data-t="group">Групповые</button><button class="tab" data-t="ind">Индивидуально</button><button class="tab" data-t="my">Мои записи</button></div>'
        +'<div id="tabBody"></div>';
      root.querySelectorAll('.tab').forEach(b=>b.onclick=()=>selectTab(b.dataset.t));
      selectTab(tab);
    }
    function selectTab(t){
      tab=t;
      root.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.t===t));
      body().innerHTML='<div class="card">Загрузка…</div>';
      if(t==='group') loadLessons();
      else if(t==='ind') loadCoaches();
      else loadMyBookings();
    }

    /* ---- групповые ---- */
    async function loadLessons(){
      const data = await api('/api/app/lessons',{student_id:student.id});
      if(data.status!=='ok'){ body().innerHTML='<div class="card">Не удалось загрузить занятия.</div>'; return; }
      renderLessons(data.lessons);
    }
    const DOW=['вс','пн','вт','ср','чт','пт','сб'];
    function fmtDate(iso){ const [y,m,d]=iso.split('-').map(Number); const dt=new Date(y,m-1,d); return d+'.'+String(m).padStart(2,'0')+' · '+DOW[dt.getDay()]; }
    function lessonStartMs(iso,time){ const [y,m,d]=iso.split('-').map(Number); const mm=/(\d{1,2}):(\d{2})/.exec(String(time||'')); return new Date(y,m-1,d,mm?+mm[1]:0,mm?+mm[2]:0,0,0).getTime(); }
    function renderLessons(lessons){
      if(!lessons.length){ body().innerHTML='<div class="card">Нет подходящих занятий. Уточните уровень/группу у тренера.</div>'; return; }
      let html='',cur=null;
      lessons.forEach(l=>{
        if(l.date!==cur){ cur=l.date; html+='<div class="mday">'+fmtDate(l.date)+'</div>'; }
        const badge = l.booked?'<span class="bk booked">вы записаны</span>'
          : l.status==='open'?'<span class="bk free">свободно '+l.free+'/'+l.capacity+'</span>'
          : l.status==='overbooked'?'<span class="bk none">перебор</span>':'<span class="bk none">мест нет</span>';
        const clickable=(!l.booked&&l.status==='open');
        html+='<div class="lesson'+(clickable?' clickable':'')+'"'+(clickable?' data-g="'+esc(l.group_id)+'" data-d="'+l.date+'"':'')+'>'
          +'<div><strong>'+esc(l.title)+'</strong><div class="muted">'+esc(l.time)+(l.coach_name?' · '+esc(l.coach_name):'')+'</div></div>'+badge+'</div>';
      });
      body().innerHTML=html;
      body().querySelectorAll('.lesson.clickable').forEach(el=>el.onclick=()=>bookGroup(el.dataset.g,el.dataset.d,el));
    }
    async function bookGroup(group_id,date,el){
      el.style.opacity='0.5';
      const data=await api('/api/app/book',{student_id:student.id,group_id,date});
      if(data.ok){ if(tg&&tg.HapticFeedback)tg.HapticFeedback.notificationOccurred('success'); loadLessons(); return; }
      flash(data.error==='full'?'Мест нет':data.error==='duplicate'?'Вы уже записаны':data.error==='ineligible'?'Группа вам не подходит':data.error==='expired'?'Занятие уже прошло':'Ошибка');
      loadLessons();
    }

    /* ---- индивидуально ---- */
    async function loadCoaches(){
      curSlot=null;
      const data=await api('/api/app/coaches',{student_id:student.id});
      if(data.status!=='ok'){ body().innerHTML='<div class="card">Не удалось загрузить тренеров.</div>'; return; }
      body().innerHTML='<div class="muted" style="margin-bottom:10px">Выберите тренера:</div>'+data.coaches.map(c=>'<button class="cbtn" data-s="'+esc(c.slot)+'">'+esc(c.name||c.slot)+'</button>').join('');
      body().querySelectorAll('.cbtn').forEach(b=>b.onclick=()=>loadSlots(b.dataset.s));
    }
    async function loadSlots(slot){
      curSlot=slot;
      body().innerHTML='<div class="card">Загрузка слотов…</div>';
      const data=await api('/api/app/slots',{student_id:student.id,slot});
      if(data.status!=='ok'){ body().innerHTML='<div class="card">Не удалось загрузить время.</div>'; return; }
      renderSlots(data.dates);
    }
    function renderSlots(dates){
      let html='<button class="cbtn" onclick="loadCoaches()" style="margin-bottom:14px">← Другой тренер</button>';
      if(!dates.length){ body().innerHTML=html+'<div class="card">У тренера нет свободного времени.</div>'; return; }
      dates.forEach(dt=>{
        html+='<div class="mday">'+fmtDate(dt.date)+'</div>';
        dt.starts.forEach(s=>{
          html+='<div class="start" data-dt="'+esc(s.datetime)+'"><strong>'+esc(s.time)+'</strong><span class="muted">выбрать →</span></div>'
            +'<div class="chips" data-for="'+esc(s.datetime)+'" style="display:none">'+s.durations.map(d=>'<button class="chip" data-dt="'+esc(s.datetime)+'" data-dur="'+d+'">'+(d/60)+' ч'+(d%60?' 30м':'')+'</button>').join('')+'</div>';
        });
      });
      body().innerHTML=html;
      body().querySelectorAll('.start').forEach(el=>el.onclick=()=>{
        const ch=body().querySelector('.chips[data-for="'+CSS.escape(el.dataset.dt)+'"]');
        const open=ch.style.display!=='none';
        body().querySelectorAll('.chips').forEach(c=>c.style.display='none');
        body().querySelectorAll('.start').forEach(s=>s.classList.remove('open'));
        if(!open){ ch.style.display='flex'; el.classList.add('open'); }
      });
      body().querySelectorAll('.chip').forEach(el=>el.onclick=()=>bookIndividual(el.dataset.dt,Number(el.dataset.dur),el));
    }
    async function bookIndividual(datetime,duration_min,el){
      el.style.opacity='0.5';
      const data=await api('/api/app/book-individual',{student_id:student.id,slot:curSlot,datetime,duration_min});
      if(data.ok){ if(tg&&tg.HapticFeedback)tg.HapticFeedback.notificationOccurred('success'); flash('Записаны!'); loadSlots(curSlot); return; }
      flash(data.error==='taken'?'Время уже занято':data.error==='invalid'?'Некорректный слот':data.error==='expired'?'Слот уже прошёл':'Ошибка');
      loadSlots(curSlot);
    }

    /* ---- мои записи ---- */
    async function loadMyBookings(){
      const data=await api('/api/app/my-bookings',{student_id:student.id});
      if(data.status!=='ok'){ body().innerHTML='<div class="card">Не удалось загрузить записи.</div>'; return; }
      if(!data.bookings.length){ body().innerHTML='<div class="card">У вас нет предстоящих записей.</div>'; return; }
      body().innerHTML=data.bookings.map(b=>'<div class="lesson"><div><strong>'+esc(b.title)+'</strong><div class="muted">'+esc(b.when)+(b.coach_name?' · '+esc(b.coach_name):'')+'</div></div>'
        +(b.cancelable?'<button class="cancel" data-b="'+b.booking_id+'">Отменить</button>':'<span class="bk none">отмена через тренера</span>')+'</div>').join('');
      body().querySelectorAll('.cancel').forEach(el=>el.onclick=()=>cancelMine(Number(el.dataset.b),el));
    }
    async function cancelMine(booking_id,el){
      el.style.opacity='0.5';
      const data=await api('/api/app/cancel',{student_id:student.id,booking_id});
      if(data.ok){ if(tg&&tg.HapticFeedback)tg.HapticFeedback.notificationOccurred('success'); loadMyBookings(); return; }
      flash(data.error==='too_late'?'Отменить можно не позднее 8 часов до начала':data.error==='forbidden'?'Нет доступа':'Ошибка');
      loadMyBookings();
    }

    identify().catch(()=>flash('Ошибка сети'));
  </script>
```

- [ ] **Шаг 3: Проверить страницу и парсинг**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo -n "/app -> "; curl -s localhost:3000/app -o /tmp/app.html -w '%{http_code}\n'
node -e "const h=require('fs').readFileSync('/tmp/app.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/)[1];try{new Function(m.replace(/await /g,''));console.log('script parses OK')}catch(e){console.log('PARSE ERROR:',e.message)}"
grep -c 'book-individual\|my-bookings\|loadCoaches\|class="tabs"' /tmp/app.html
kill $SRV 2>/dev/null
```
Expected: `/app -> 200`; `script parses OK`; grep `>=3`.

- [ ] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add public/app.html && git commit -m "feat(3b): Mini App tabs (group / individual coach->start->duration / my bookings)"
```

---

## Task 7: Деплой + прод-проверка

**Files:** нет изменений кода — выкладка.

- [ ] **Шаг 1: Выложить сервер и Mini App**
```bash
cd /root/savvateam && export SSHPASS='oDR%r1C%rZjm'
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js root@45.139.29.201:/root/savvateam-site/
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" public/app.html root@45.139.29.201:/root/savvateam-site/public/
echo "rsync done"
```

- [ ] **Шаг 2: Перезапустить и проверить миграцию + эндпоинты**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam >/dev/null 2>&1 && sleep 1.5 && node -e \"const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('has duration_min:', db.prepare('PRAGMA table_info(bookings)').all().some(c=>c.name==='duration_min'))\"
curl -s -X POST localhost:3002/api/app/coaches -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'coaches(no-initData) %{http_code} (expect 401)\n'
curl -s -X POST localhost:3002/api/app/book-individual -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'book-ind(no-initData) %{http_code} (expect 401)\n'"
echo -n "public /app -> "; curl -s https://savva.n2node.store/app -o /dev/null -w '%{http_code}\n'
```
Expected: `has duration_min: true`; оба `401`; `/app 200`.

- [ ] **Шаг 3: Живая проверка в Telegram (ручная, пользователем)**

Предусловие: в админке «Доступность» задать тренеру окна; у тренера chat_id; ученик подтверждён. В Mini App: вкладка «Индивидуально» → тренер → старт → длительность → «Записаны!»; тренеру приходит уведомление; вкладка «Мои записи» → «Отменить» (если ≥8ч); в админке «Записи» видна индивидуальная запись.

- [ ] **Шаг 4: Push**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** миграция `duration_min` + `individualSlots` (свободные интервалы, шаг 30, ≥60, будущее) → Task 1; `coaches`/`slots` → Task 2; `book-individual` атомарно (пересечения) + уведомление → Task 3; `my-bookings` + `cancel` по `booking_id` (унификация, окно 8ч) → Task 4; `GET /api/bookings` individual → Task 5; Mini App 3 вкладки (группа/индивидуально/мои записи) → Task 6; деплой → Task 7. 13a вне scope. Все пункты покрыты.
- **Плейсхолдеров нет** — весь код целиком.
- **Согласованность имён:** statements (`insertIndividualBooking`, `coachIndividualBookings`) — Task 1, используются Task 3. Хелперы (`toMin`, `minToHHMM`, `subtractIntervals`, `individualSlots`, `notifyIndividualCreated`) — Task 1, используются Task 2/3. Эндпоинты `/api/app/coaches|slots|book-individual|my-bookings|cancel` совпадают между сервером (Task 2-4) и Mini App (Task 6). Поля слота (`time,datetime,durations`) одинаковы в `individualSlots` (Task 1) и рендере (Task 6). `booking_id` — из `my-bookings` (Task 4), потребляется `cancel` (Task 4) и Mini App (Task 6).
- **Переиспользование:** `resolveAppStudent`/`occStart`/`normPhone`/`coachNameBySlot`/`cellById`/`cancelBookingById`/`getBookingById`/`listAvailability`/`listCoaches`/`getCoach`/`notifyTrainerCancelled`/`coachChatIdForGroup` — из 2A/2B/2C/3A, не дублируются.
- **Атомарность/пересечения:** транзакция с пере-проверкой интервалов (Task 3); нарезка вычитает занятые (Task 1) — согласовано.
- **Границы:** автовычета групп нет; 13a отложено.