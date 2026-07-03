# Фаза 2C — Уведомления, отмена, «Записи» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Замкнуть цикл групповой брони: тренер получает уведомления о записи/отмене, клиент отменяет сам за ≥8ч (позже — через тренера), тренер видит все записи в админке и отменяет любую; отменённое место сразу свободно.

**Architecture:** Расширяем `server.js`: миграция `bookings` (снапшот `title/time/coach_id`), хелперы уведомлений через `tgApi` (never-throw), хук на `/api/app/book`, `POST /api/app/cancel`, admin `GET /api/bookings` + `PATCH /api/bookings/:id/cancel`. `public/app.html` — кнопка «Отменить» у брони ≥8ч. `public/admin.html` — раздел «Записи».

**Tech Stack:** Express + better-sqlite3, Node 22. Тест-фреймворка нет — curl / браузер; локально `DEV_ALLOW_UNSIGNED=1`. Часовой пояс — серверный localtime.

## Global Constraints

- Снапшот в `bookings`: `title`, `time`, `coach_id` заполняются при брони из occurrence; «Записи»/уведомления самоописательны при изменении расписания. Отсутствует снапшот → резолв из текущего `schedule_data` (`cellById`), иначе `(группа изменена)`.
- Уведомления: запись → тренеру (`coaches.telegram_chat_id` по `coach_id`); самоотмена клиента → тренеру; отмена тренером → клиенту (реверс `tg_sessions` по `normPhone(student.phone)`). Все `tgApi`-вызовы обёрнуты, не блокируют HTTP-ответ (`.catch(()=>{})`).
- Окно самоотмены: `occStart(date,time) − Date.now() ≥ 8ч` (8*3600*1000 мс); позже → `too_late`. Тренер в админке — без окна.
- Отмена = `status='cancelled'`; доступность (2B) считает только `confirmed`.
- Admin-эндпоинты под `requireSecret`. 13a (правка расписания) — вне scope.
- Деплой: `server.js`+`public/*.html` → прод (server.js в корень, html в `public/`); `pm2 restart savvateam`; `sshpass -e`.

---

## Структура файлов

- `server.js`:
  - После statements `bookings` (≈строка 309) — миграция ALTER + расширить `insertGroupBooking` + statements отмены/списка + `cellById` + хелперы уведомлений (Task 1).
  - `/api/app/book` (≈строка 741) — снапшот в insert + хук уведомления (Task 1).
  - После `/api/app/book` — `POST /api/app/cancel` (Task 2), `GET /api/bookings` + `PATCH /api/bookings/:id/cancel` (Task 3).
- `public/app.html` — кнопка отмены в `renderLessons` + `cancelBooking` (Task 4).
- `public/admin.html` — пункт меню + `navigate` + `renderBookings`/`cancelBookingAdmin` (Task 5).

---

## Task 1: Сервер — миграция снапшота + хелперы уведомлений + хук на book

**Files:**
- Modify: `server.js` (после statements bookings ≈309; `insertGroupBooking` 304-306; `/api/app/book` 741-766)

**Interfaces:**
- Consumes: `db`, `tgApi`, `normPhone`, `scheduleData`, `coachNameBySlot`, `occStart`, `groupOccurrences`, `eligible`, `countConfirmedStmt`, `activeBookingExists`.
- Produces: колонки `bookings.title/time/coach_id`(снапшот); `cellById(group_id)`; `coachChatIdForGroup(coachId)`; `clientChatIdsForStudent(student)`; `notifyBookingCreated(name, occ)`; `notifyTrainerCancelled(name, booking)`; `notifyClientCancelled(student, booking)`; statements `getActiveBooking`, `cancelBookingById`, `getBookingById`.

- [x] **Шаг 1: Миграция колонок снапшота + новые statements**

В `server.js` заменить блок `insertGroupBooking` (строки 304-306) на:
```js
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
```
(колонка `coach_id` уже есть в таблице с 2B.)

- [x] **Шаг 2: Добавить `cellById` и хелперы уведомлений**

В `server.js` сразу после функции `eligible` (после её `}`) вставить:
```js

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
```

- [x] **Шаг 3: Снапшот при брони + хук уведомления в `/api/app/book`**

В `server.js` в роуте `/api/app/book` заменить строку
```js
      insertGroupBooking.run(student.id, group_id, date);
```
на
```js
      insertGroupBooking.run(student.id, group_id, date, occ.coach_id || null, occ.title || null, occ.time || null);
```
и строку
```js
    res.json({ ok: true, free: Math.max(0, freeLeft) });
```
на
```js
    notifyBookingCreated(student.name, occ).catch(() => {});
    res.json({ ok: true, free: Math.max(0, freeLeft) });
```

- [x] **Шаг 4: Проверить миграцию, снапшот и путь уведомления (dev)**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('bookings cols:',db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name).join(','))"
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Снап Тест","phone":"+7 900 321-00-11","level":3,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
read GID DATE < <(curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":960,\"dev_phone\":\"79003210011\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).lessons.find(x=>x.status==='open');console.log(l.group_id,l.date)})")
curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":960,\"dev_phone\":\"79003210011\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" -o /dev/null
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const b=db.prepare(\"SELECT group_id,title,time,coach_id FROM bookings WHERE group_id='$GID' AND date='$DATE' ORDER BY id DESC LIMIT 1\").get();console.log('snapshot:',JSON.stringify(b))"
kill $SRV 2>/dev/null
```
Expected: `bookings cols` содержит `title` и `time`; snapshot брони с непустыми `title/time/coach_id` (уведомление тренеру не падает — токен фейковый, `tgApi` глотает ошибку).

- [x] **Шаг 5: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2c): booking snapshot (title/time/coach_id) + notification helpers + notify trainer on booking"
```

---

## Task 2: Сервер — `POST /api/app/cancel` (самоотмена, окно 8ч)

**Files:**
- Modify: `server.js` (после `/api/app/book`)

**Interfaces:**
- Consumes: `resolveAppStudent`, `getActiveBooking`, `cellById`, `occStart`, `cancelBookingById`, `notifyTrainerCancelled`.
- Produces: роут `POST /api/app/cancel`.

- [x] **Шаг 1: Добавить роут**

В `server.js` сразу после роута `POST /api/app/book` (после его `});`) вставить:
```js

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
```

- [x] **Шаг 2: Проверить самоотмену: ok (место освобождается) / too_late / not_found**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Отмена Тест","phone":"+7 900 654-00-22","level":3,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
# берём занятие, до начала которого >8ч (сортировка по дате — последнее в списке заведомо дальше)
read GID DATE < <(curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const ls=JSON.parse(d).lessons.filter(x=>x.status==='open');const l=ls[ls.length-1];console.log(l.group_id,l.date)})")
FREE0=$(curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).lessons.find(x=>x.group_id==='$GID'&&x.date==='$DATE');console.log(l.free)})")
curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" -o /dev/null
echo -n "cancel ok -> "; curl -s -X POST localhost:3000/api/app/cancel -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
FREE1=$(curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).lessons.find(x=>x.group_id==='$GID'&&x.date==='$DATE');console.log(l.free)})")
echo "free before=$FREE0 after cancel=$FREE1 (should be equal)"
echo -n "cancel again not_found -> "; curl -s -X POST localhost:3000/api/app/cancel -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))"
# too_late: занятие сегодня в ближайшие часы — вставим бронь напрямую на группу сегодня и попробуем отменить
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const data=JSON.parse(db.prepare(\"SELECT value FROM content WHERE key='schedule_data'\").get().value);let cell=null,time=null;outer:for(const r of data.rows){for(const c of r.cells){if(c&&c.id){cell=c;time=r.time;break outer;}}}const today=new Date();const iso=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');db.prepare(\"INSERT INTO bookings (student_id,type,group_id,date,coach_id,title,time,status) VALUES (?, 'group', ?, ?, ?, ?, ?, 'confirmed')\").run($SID, cell.id, iso, cell.coach_id, cell.title, time);require('fs').writeFileSync('/tmp/tl.json',JSON.stringify({gid:cell.id,date:iso}));console.log('inserted today booking',cell.id,iso,time);"
TL=$(cat /tmp/tl.json)
GID2=$(echo $TL | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gid))")
DATE2=$(echo $TL | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).date))")
echo -n "cancel too_late (or ok if >8ч) -> "; curl -s -X POST localhost:3000/api/app/cancel -H 'Content-Type: application/json' -d "{\"dev_user_id\":961,\"dev_phone\":\"79006540022\",\"student_id\":$SID,\"group_id\":\"$GID2\",\"date\":\"$DATE2\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
kill $SRV 2>/dev/null
```
Expected: `cancel ok -> {"ok":true}`; `free before == after cancel` (место освободилось); повтор → `not_found`; для сегодняшнего занятия — `too_late`, если до его начала <8ч (если сегодняшнее занятие уже >8ч впереди — вернёт `ok`; тогда проверка окна валидна на будущих датах и это не ошибка).

- [x] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2c): POST /api/app/cancel — self-cancel with 8h window, frees slot, notifies trainer"
```

---

## Task 3: Сервер — admin `GET /api/bookings` + `PATCH /api/bookings/:id/cancel`

**Files:**
- Modify: `server.js` (после `/api/app/cancel`)

**Interfaces:**
- Consumes: `requireSecret`, `db`, `cellById`, `coachNameBySlot`, `occStart`, `getBookingById`, `cancelBookingById`, `getStudent`, `notifyClientCancelled`.
- Produces: роуты `GET /api/bookings`, `PATCH /api/bookings/:id/cancel`.

- [x] **Шаг 1: Добавить роуты**

В `server.js` сразу после роута `POST /api/app/cancel` вставить:
```js

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
```

- [x] **Шаг 2: Проверить admin bookings API**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
SID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Админ Бук","phone":"+7 900 246-00-33","level":3,"audience":"adult","gender":"m","confirmed":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
read GID DATE < <(curl -s -X POST localhost:3000/api/app/lessons -H 'Content-Type: application/json' -d "{\"dev_user_id\":962,\"dev_phone\":\"79002460033\",\"student_id\":$SID}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const l=JSON.parse(d).lessons.find(x=>x.status==='open');console.log(l.group_id,l.date)})")
curl -s -X POST localhost:3000/api/app/book -H 'Content-Type: application/json' -d "{\"dev_user_id\":962,\"dev_phone\":\"79002460033\",\"student_id\":$SID,\"group_id\":\"$GID\",\"date\":\"$DATE\"}" -o /dev/null
echo "future bookings:"; curl -s "localhost:3000/api/bookings?scope=future" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);const m=a.find(x=>x.student_name==='Админ Бук');console.log('found:',JSON.stringify(m||'НЕТ'))})"
BID=$(curl -s "localhost:3000/api/bookings?scope=future" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).find(x=>x.student_name==='Админ Бук');console.log(m?m.id:'')})")
echo -n "admin cancel -> "; curl -s -X PATCH "localhost:3000/api/bookings/$BID/cancel" -w '%{http_code} ' -o /dev/null; curl -s -X PATCH "localhost:3000/api/bookings/$BID/cancel" -o /dev/null; echo "(idempotent)"
echo -n "after cancel in future scope (expect gone) -> "; curl -s "localhost:3000/api/bookings?scope=future" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).some(x=>x.id===$BID)?'STILL THERE':'gone'))"
echo -n "in all scope (expect cancelled) -> "; curl -s "localhost:3000/api/bookings?scope=all" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).find(x=>x.id===$BID);console.log(m?m.status:'НЕТ')})"
kill $SRV 2>/dev/null
```
Expected: future содержит запись «Админ Бук» с `title/time/coach_name`; admin cancel `200`, идемпотентно; после отмены — нет в `future`, в `all` статус `cancelled`.

- [x] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2c): admin GET /api/bookings + PATCH /api/bookings/:id/cancel (notify client)"
```

---

## Task 4: Mini App — кнопка «Отменить» у брони

**Files:**
- Modify: `public/app.html` (`renderLessons` + новая `cancelBooking`)

**Interfaces:**
- Consumes: `POST /api/app/cancel`, `api()`, `student`, `loadLessons`.

- [x] **Шаг 1: Показать кнопку отмены у забронированных занятий ≥8ч**

В `public/app.html` в функции `renderLessons` заменить строку формирования `badge` и блок карточки. Найти:
```js
        const badge = l.booked ? '<span class="bk booked">вы записаны</span>'
          : l.status === 'open' ? '<span class="bk free">свободно '+l.free+'/'+l.capacity+'</span>'
          : l.status === 'overbooked' ? '<span class="bk none">перебор</span>'
          : '<span class="bk none">мест нет</span>';
        const clickable = (!l.booked && l.status === 'open');
        html += '<div class="lesson'+(clickable?' clickable':'')+'"'+(clickable?' data-g="'+esc(l.group_id)+'" data-d="'+l.date+'"':'')+'>'
          + '<div><strong>'+esc(l.title)+'</strong><div class="muted">'+esc(l.time)+(l.coach_name?' · '+esc(l.coach_name):'')+'</div></div>'
          + badge + '</div>';
```
и заменить на:
```js
        const startMs = lessonStartMs(l.date, l.time);
        const cancelable = l.booked && (startMs - Date.now() >= 8*3600*1000);
        const badge = l.booked
            ? (cancelable ? '<button class="cancel" data-cg="'+esc(l.group_id)+'" data-cd="'+l.date+'">Отменить</button>'
                          : '<span class="bk booked">вы записаны</span>')
          : l.status === 'open' ? '<span class="bk free">свободно '+l.free+'/'+l.capacity+'</span>'
          : l.status === 'overbooked' ? '<span class="bk none">перебор</span>'
          : '<span class="bk none">мест нет</span>';
        const clickable = (!l.booked && l.status === 'open');
        html += '<div class="lesson'+(clickable?' clickable':'')+'"'+(clickable?' data-g="'+esc(l.group_id)+'" data-d="'+l.date+'"':'')+'>'
          + '<div><strong>'+esc(l.title)+'</strong><div class="muted">'+esc(l.time)+(l.coach_name?' · '+esc(l.coach_name):'')+(l.booked&&!cancelable?' · отмена через тренера':'')+'</div></div>'
          + badge + '</div>';
```

- [x] **Шаг 2: Добавить `lessonStartMs`, привязку и `cancelBooking`**

В `public/app.html` в функции `renderLessons`, после строки `root.querySelectorAll('.lesson.clickable').forEach(el => el.onclick = () => book(el.dataset.g, el.dataset.d, el));` добавить:
```js
      root.querySelectorAll('.cancel').forEach(el => el.onclick = (e) => { e.stopPropagation(); cancelBooking(el.dataset.cg, el.dataset.cd, el); });
```
И перед функцией `renderLessons` (или после `fmtDate`) добавить:
```js
    function lessonStartMs(iso, time) {
      const [y,m,d] = iso.split('-').map(Number);
      const mm = /(\d{1,2}):(\d{2})/.exec(String(time||''));
      const dt = new Date(y, m-1, d, mm?+mm[1]:0, mm?+mm[2]:0, 0, 0);
      return dt.getTime();
    }
    async function cancelBooking(group_id, date, el) {
      if (el) el.style.opacity = '0.5';
      const data = await api('/api/app/cancel', { student_id: student.id, group_id, date });
      if (data.ok) { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success'); loadLessons(); return; }
      const msg = data.error === 'too_late' ? 'Отменить можно не позднее 8 часов до начала'
        : data.error === 'not_found' ? '' : 'Ошибка отмены';
      if (msg) { errEl.textContent = msg; setTimeout(() => errEl.textContent = '', 2500); }
      loadLessons();
    }
```

- [x] **Шаг 3: Добавить стиль кнопки отмены**

В `public/app.html` внутри `<style>` перед `</style>` добавить:
```css
    .cancel { padding:8px 14px; border:1px solid var(--border); border-radius:10px; background:transparent; color:#ff6b6b; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; }
    .cancel:active { transform:scale(0.96); }
```

- [x] **Шаг 4: Проверить страницу и парсинг**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo -n "/app -> "; curl -s localhost:3000/app -o /tmp/app.html -w '%{http_code}\n'
node -e "const h=require('fs').readFileSync('/tmp/app.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/)[1];try{new Function(m.replace(/await /g,''));console.log('script parses OK')}catch(e){console.log('PARSE ERROR:',e.message)}"
grep -c 'api/app/cancel\|lessonStartMs\|class="cancel"' /tmp/app.html
kill $SRV 2>/dev/null
```
Expected: `/app -> 200`; `script parses OK`; grep `>=2`.

- [x] **Шаг 5: Commit**
```bash
cd /root/savvateam && git add public/app.html && git commit -m "feat(2c): Mini App cancel button for bookings with 8h window"
```

---

## Task 5: Админка — раздел «Записи»

**Files:**
- Modify: `public/admin.html` (сайдбар после строки 227; `navigate` map строка 442; блок функций перед `/* ===== SCHEDULE ===== */` строка 818)

**Interfaces:**
- Consumes: `GET /api/bookings`, `PATCH /api/bookings/:id/cancel`, `adminSecret`, `escapeHtml`, `toast`.
- Produces: `renderBookings(c)`, `cancelBookingAdmin(id)`; страница `bookings`.

- [x] **Шаг 1: Пункт меню**

После строки 227 (`<button class="nav-item" data-page="schedule">…Расписание</button>`) вставить:
```html
    <button class="nav-item" data-page="bookings"><span class="icon">✔</span>Записи</button>
```

- [x] **Шаг 2: Регистрация в `navigate()`**

В объекте-роутере (строка 442) добавить `bookings:renderBookings,` (например, после `schedule:renderSchedule,`):
```js
  ({dashboard:renderDashboard,inbox:renderInbox,students:renderStudents,texts:renderTexts,media:renderMedia,programs:renderPrograms,prices:renderPrices,schedule:renderSchedule,bookings:renderBookings,testimonials:renderTestimonials,coaches:renderCoaches}[page]||renderDashboard)(c);
```

- [x] **Шаг 3: Функции раздела**

Перед строкой 818 (`/* ============= SCHEDULE ============= */`) вставить:
```js
/* ============= BOOKINGS ============= */
let bookingsScope = 'future';
async function renderBookings(c){
  c.innerHTML = `<div class="page-head"><div><div class="page-title">ЗАПИСИ</div><div class="page-sub" id="bkSub">Загрузка…</div></div>
    <div class="page-actions"><button class="btn" id="bkToggle">${bookingsScope==='future'?'Показать все':'Только будущие'}</button></div></div>
    <div id="bkList"><div class="empty"><div class="glyph">✔</div>Загрузка…</div></div>`;
  document.getElementById('bkToggle').onclick=()=>{bookingsScope=bookingsScope==='future'?'all':'future';renderBookings(c);};
  let list=[];
  try{const r=await fetch('/api/bookings?scope='+bookingsScope+'&secret='+encodeURIComponent(adminSecret));if(r.ok)list=await r.json();}catch(e){}
  const sub=document.getElementById('bkSub'); if(sub)sub.textContent=`${list.length} ${bookingsScope==='future'?'активных будущих':'всего'}`;
  const el=document.getElementById('bkList'); if(!el)return;
  if(!list.length){el.innerHTML=`<div class="empty"><div class="glyph">✔</div>Нет записей</div>`;return;}
  el.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Ученик</th><th>Группа</th><th>Когда</th><th>Тренер</th><th>Статус</th><th></th></tr></thead><tbody>${list.map(b=>`
    <tr>
      <td><strong>${escapeHtml(b.student_name)}</strong></td>
      <td>${escapeHtml(b.title)}</td>
      <td>${escapeHtml(b.date)} <span style="color:var(--muted)">${escapeHtml(b.time||'')}</span></td>
      <td>${escapeHtml(b.coach_name||'—')}</td>
      <td><span class="tag tag-${b.status==='confirmed'?'active':'paused'}">${b.status==='confirmed'?'Активна':'Отменена'}</span></td>
      <td>${b.status==='confirmed'?`<button class="tiny-btn danger" onclick="cancelBookingAdmin(${b.id})" title="Отменить">✕</button>`:''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
async function cancelBookingAdmin(id){
  if(!confirm('Отменить запись? Клиент получит уведомление.'))return;
  const r=await fetch('/api/bookings/'+id+'/cancel?secret='+encodeURIComponent(adminSecret),{method:'PATCH'});
  if(r.ok){toast('Запись отменена');renderBookings(document.getElementById('pageContent'));}else{toast('Ошибка');}
}
```

- [x] **Шаг 4: Проверить парсинг админки**

Run:
```bash
cd /root/savvateam && node -e "const h=require('fs').readFileSync('public/admin.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');try{new Function(m+'\n;if(typeof renderBookings!==\"function\"||typeof cancelBookingAdmin!==\"function\")throw new Error(\"missing booking fns\")');console.log('admin bookings OK')}catch(e){console.log('ERROR:',e.message)}"
```
Expected: `admin bookings OK`

- [x] **Шаг 5: Commit**
```bash
cd /root/savvateam && git add public/admin.html && git commit -m "feat(2c): admin Bookings section (list + trainer cancel)"
```

---

## Task 6: Деплой + прод-проверка

**Files:** нет изменений кода — выкладка.

- [x] **Шаг 1: Выложить сервер и статику**
```bash
cd /root/savvateam && export SSHPASS='oDR%r1C%rZjm'
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js root@45.139.29.201:/root/savvateam-site/
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" public/app.html public/admin.html root@45.139.29.201:/root/savvateam-site/public/
echo "rsync done"
```

- [x] **Шаг 2: Перезапустить и проверить миграцию + эндпоинты**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam >/dev/null 2>&1 && sleep 1.5 && node -e \"const D=require('better-sqlite3');const db=new D('db/leads.db');const cols=db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);console.log('has title/time:', cols.includes('title')&&cols.includes('time'))\"
curl -s 'localhost:3002/api/bookings?secret=SavvaKatitaLena' -o /dev/null -w 'bookings(secret) %{http_code}\n'
curl -s 'localhost:3002/api/bookings' -o /dev/null -w 'bookings(no-secret) %{http_code} (expect 401)\n'
curl -s -X POST localhost:3002/api/app/cancel -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'cancel(no-initData) %{http_code} (expect 401)\n'"
echo -n "public /app -> "; curl -s https://savva.n2node.store/app -o /dev/null -w '%{http_code}\n'
```
Expected: `has title/time: true`; `bookings(secret) 200`; `bookings(no-secret) 401`; `cancel(no-initData) 401`; `/app 200`.

- [x] **Шаг 3: Живая проверка (ручная, пользователем)**

Предусловие: у тренера в админке заполнен `telegram_chat_id` (его Telegram user_id); у ученика — level/audience/gender/confirmed.
- В Mini App записаться на занятие → тренеру в Telegram приходит «🆕 Новая запись».
- У брони с началом >8ч в Mini App есть «Отменить» → тап → бронь снята, тренеру приходит «❌ Отмена (клиентом)».
- В админке раздел «Записи» → список; «Отменить» → клиенту (если он делился телефоном боту) приходит «❌ Ваша запись отменена».

- [x] **Шаг 4: Push**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** миграция снапшота + хелперы уведомлений + хук на book → Task 1; самоотмена ≥8ч → Task 2; admin `GET /api/bookings` + `PATCH cancel` → Task 3; Mini App кнопка отмены → Task 4; админ-раздел «Записи» → Task 5; деплой → Task 6. 13a явно вне scope. Все пункты покрыты.
- **Плейсхолдеров нет** — весь код целиком.
- **Согласованность имён:** statements (`insertGroupBooking` расширен, `getActiveBooking`, `cancelBookingById`, `getBookingById`) — Task 1, используются Task 2/3. Хелперы (`cellById`, `coachChatIdForGroup`, `clientChatIdsForStudent`, `notifyBookingCreated/notifyTrainerCancelled/notifyClientCancelled`) — Task 1, используются Task 1/2/3. Эндпоинты `/api/app/cancel`, `/api/bookings`, `/api/bookings/:id/cancel` совпадают между сервером (Task 2/3) и клиентами (Task 4/5). Поля брони в `/api/bookings` (`id,student_name,title,date,time,coach_name,status`) совпадают с рендером админки (Task 5).
- **Снапшот:** `insertGroupBooking` пишет `coach_id/title/time` (Task 1), читаются в отмене/списке/уведомлениях; фолбэк `cellById` при отсутствии.
- **Окно 8ч:** сервер (`/api/app/cancel`, Task 2) — источник истины; Mini App (`lessonStartMs`, Task 4) лишь прячет кнопку, дублирующая проверка на сервере.
- **Never-throw уведомления:** `tgApi` глотает ошибки, вызовы через `.catch(()=>{})` — ответ API не блокируется.