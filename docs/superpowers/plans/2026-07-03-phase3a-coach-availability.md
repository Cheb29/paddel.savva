# Фаза 3A — Доступность тренеров — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Тренер задаёт в админке недельный шаблон свободных окон (`день × from–to`) на каждого тренера; окна хранятся в `coach_availability` и отдаются через API — задел под нарезку слотов и индивидуальную бронь (3B).

**Architecture:** Расширяем `server.js`: таблица `coach_availability` + statements + валидатор + admin API `GET /api/availability`, `POST /api/availability` (замена окон в транзакции). Расширяем `public/admin.html`: раздел «Доступность» (выбор тренера + недельная сетка окон, загрузка с сервера без персиста в state).

**Tech Stack:** Express + better-sqlite3, Node 22. Тест-фреймворка нет — curl / браузер. Локально `ADMIN_SECRET` не задан → API без `?secret=`.

## Global Constraints

- `coach_availability(id, slot, day, from_time, to_time)`: `slot`=coach1/2/3, `day`=0–6 (0=Вс…6=Сб, JS getDay), `from_time`/`to_time`=`HH:MM`. Несколько строк на `(slot,day)` = несколько окон.
- Валидация окна: `day` целое 0–6; `from_time`/`to_time` формата `HH:MM` (`^([01]\d|2[0-3]):[0-5]\d$`); `from_time < to_time` (лексикографически, т.к. zero-padded). Нарушение → 400, ничего не сохраняется.
- `POST /api/availability` — атомарная замена всех окон тренера (delete+insert в транзакции). Пустой `windows` → очистка.
- Все эндпоинты под `requireSecret`. Неизвестный `slot` → 400 (GET) / 404 (POST).
- Админка грузит окна с сервера при выборе тренера; кэш в модульных переменных, НЕ в `state` (не персистить — урок из фикса chat_id 2C).
- Параметр для 3B (не здесь): шаг слота 30 мин, тренировка ≥60 мин.
- Деплой: `server.js` → корень, `public/admin.html` → `public/`; `pm2 restart savvateam`; `sshpass -e`.

---

## Структура файлов

- `server.js`:
  - После statements coaches (`getCoach`, ≈строка 416) — таблица `coach_availability` + statements + валидатор `validateWindows`/`isHHMM` (Task 1).
  - После роута `PATCH /api/bookings/:id/cancel` (≈строка 865) — `GET /api/availability`, `POST /api/availability` (Task 2).
- `public/admin.html`:
  - Сайдбар (после `data-page="bookings"`, строка 228) — пункт меню.
  - `navigate` map (строка 443) — `availability:renderAvailability`.
  - Блок функций перед `/* ===== BOOKINGS ===== */` (строка 819) — раздел «Доступность» (Task 3).

---

## Task 1: Сервер — таблица `coach_availability` + statements + валидатор

**Files:**
- Modify: `server.js` (после `getCoach`, ≈строка 416)

**Interfaces:**
- Produces: таблица `coach_availability`; statements `listAvailability`, `deleteAvailability`, `insertAvailability`; `isHHMM(s)`, `validateWindows(windows)`.

- [ ] **Шаг 1: Добавить DDL, statements и валидатор**

В `server.js` сразу после строки `const getCoach = db.prepare('SELECT slot FROM coaches WHERE slot = ?');` вставить:
```js

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
```

- [ ] **Шаг 2: Проверить создание таблицы**

Run:
```bash
cd /root/savvateam && (node server.js & SRV=$!; sleep 1.2; kill $SRV 2>/dev/null); \
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('coach_availability cols:',db.prepare('PRAGMA table_info(coach_availability)').all().map(c=>c.name).join(','))"
```
Expected: `coach_availability cols: id,slot,day,from_time,to_time`

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3a): coach_availability table, statements and window validator"
```

---

## Task 2: Сервер — `GET`/`POST /api/availability`

**Files:**
- Modify: `server.js` (после `PATCH /api/bookings/:id/cancel`)

**Interfaces:**
- Consumes: `requireSecret`, `getCoach`, `listAvailability`, `deleteAvailability`, `insertAvailability`, `validateWindows`, `db`.
- Produces: роуты `GET /api/availability`, `POST /api/availability`.

- [ ] **Шаг 1: Добавить роуты**

В `server.js` сразу после роута `PATCH /api/bookings/:id/cancel` (после его `});`) вставить:
```js

app.get('/api/availability', requireSecret, (req, res) => {
  const slot = String(req.query.slot || '');
  if (!getCoach.get(slot)) return res.status(400).json({ error: 'Неизвестный тренер' });
  res.json(listAvailability.all(slot));
});

app.post('/api/availability', requireSecret, (req, res) => {
  const slot = String((req.body && req.body.slot) || '');
  if (!getCoach.get(slot)) return res.status(404).json({ error: 'Тренер не найден' });
  const v = validateWindows((req.body && req.body.windows) || []);
  if (v.error) return res.status(400).json({ error: v.error });
  const save = db.transaction(() => {
    deleteAvailability.run(slot);
    for (const w of v.windows) insertAvailability.run(slot, w.day, w.from_time, w.to_time);
  });
  save();
  res.json({ ok: true, count: v.windows.length });
});
```

- [ ] **Шаг 2: Проверить CRUD-цикл и валидацию**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo -n "post 2 windows -> "; curl -s -X POST localhost:3000/api/availability -H 'Content-Type: application/json' -d '{"slot":"coach1","windows":[{"day":1,"from_time":"10:00","to_time":"13:00"},{"day":1,"from_time":"18:00","to_time":"21:00"}]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
echo "get -> "; curl -s "localhost:3000/api/availability?slot=coach1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d))))"
echo -n "replace with 1 window -> "; curl -s -X POST localhost:3000/api/availability -H 'Content-Type: application/json' -d '{"slot":"coach1","windows":[{"day":3,"from_time":"09:00","to_time":"12:00"}]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('count',JSON.parse(d).count))"
echo -n "after replace get count -> "; curl -s "localhost:3000/api/availability?slot=coach1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))"
echo -n "from>=to 400 -> "; curl -s -X POST localhost:3000/api/availability -H 'Content-Type: application/json' -d '{"slot":"coach1","windows":[{"day":1,"from_time":"13:00","to_time":"10:00"}]}' -w '%{http_code}\n' -o /dev/null
echo -n "bad day 400 -> "; curl -s -X POST localhost:3000/api/availability -H 'Content-Type: application/json' -d '{"slot":"coach1","windows":[{"day":9,"from_time":"10:00","to_time":"11:00"}]}' -w '%{http_code}\n' -o /dev/null
echo -n "bad time 400 -> "; curl -s -X POST localhost:3000/api/availability -H 'Content-Type: application/json' -d '{"slot":"coach1","windows":[{"day":1,"from_time":"25:00","to_time":"26:00"}]}' -w '%{http_code}\n' -o /dev/null
echo -n "unknown slot GET 400 -> "; curl -s "localhost:3000/api/availability?slot=coach9" -w '%{http_code}\n' -o /dev/null
echo -n "empty windows clears -> "; curl -s -X POST localhost:3000/api/availability -H 'Content-Type: application/json' -d '{"slot":"coach1","windows":[]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('count',JSON.parse(d).count))"
kill $SRV 2>/dev/null
```
Expected: post → `{"ok":true,"count":2}`; get → 2 окна сортированы; replace → `count 1`, after get `1` (заменено, не накоплено); `from>=to` / `bad day` / `bad time` → `400`; unknown slot → `400`; empty → `count 0`.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(3a): GET/POST /api/availability (replace-all with validation)"
```

---

## Task 3: Админка — раздел «Доступность»

**Files:**
- Modify: `public/admin.html` (сайдбар строка 228; `navigate` map строка 443; блок функций перед строкой 819)

**Interfaces:**
- Consumes: `GET/POST /api/availability`, `adminSecret`, `state.coaches`, `escapeHtml`, `escapeAttr`, `toast`.
- Produces: `renderAvailability(c)`, `selectAvailCoach(slot)`, `loadAvailability()`, `renderAvailGrid()`, `collectAvailability()`, `addAvailWindow(day)`, `delAvailWindow(day,i)`, `saveAvailability()`.

- [ ] **Шаг 1: Пункт меню**

После строки 228 (`<button class="nav-item" data-page="bookings">…Записи</button>`) вставить:
```html
    <button class="nav-item" data-page="availability"><span class="icon">◔</span>Доступность</button>
```

- [ ] **Шаг 2: Регистрация в `navigate()`**

В объекте-роутере (строка 443) добавить `availability:renderAvailability,` (например, после `bookings:renderBookings,`):
```js
  ({dashboard:renderDashboard,inbox:renderInbox,students:renderStudents,texts:renderTexts,media:renderMedia,programs:renderPrograms,prices:renderPrices,schedule:renderSchedule,bookings:renderBookings,availability:renderAvailability,testimonials:renderTestimonials,coaches:renderCoaches}[page]||renderDashboard)(c);
```

- [ ] **Шаг 3: Функции раздела**

Перед строкой 819 (`/* ============= BOOKINGS ============= */`) вставить:
```js
/* ============= AVAILABILITY ============= */
const AV_DAY_LABELS = {1:'Понедельник',2:'Вторник',3:'Среда',4:'Четверг',5:'Пятница',6:'Суббота',0:'Воскресенье'};
const AV_DAY_ORDER = [1,2,3,4,5,6,0];
let availSlot = 'coach1';
let availWindows = [];
async function renderAvailability(c){
  const coaches = state.coaches || [];
  c.innerHTML = `<div class="page-head">
      <div><div class="page-title">ДОСТУПНОСТЬ</div><div class="page-sub">Недельные окна свободного времени тренера (индивидуальная запись)</div></div>
      <div class="page-actions"><button class="btn btn-primary" onclick="saveAvailability()">Сохранить</button></div></div>
    <div class="toolbar">${coaches.map(co=>`<button class="btn${('coach'+co.id)===availSlot?' btn-primary':''}" onclick="selectAvailCoach('coach${co.id}')">${escapeHtml(co.name||('Тренер '+co.id))}</button>`).join('')}</div>
    <div id="availGrid"><div class="empty"><div class="glyph">◔</div>Загрузка…</div></div>`;
  await loadAvailability();
  renderAvailGrid();
}
async function loadAvailability(){
  availWindows = [];
  try{const r=await fetch('/api/availability?slot='+availSlot+'&secret='+encodeURIComponent(adminSecret));if(r.ok)availWindows=await r.json();}catch(e){}
}
function selectAvailCoach(slot){ availSlot=slot; renderAvailability(document.getElementById('pageContent')); }
function renderAvailGrid(){
  const grid=document.getElementById('availGrid'); if(!grid)return;
  grid.innerHTML = AV_DAY_ORDER.map(day=>{
    const wins = availWindows.filter(w=>Number(w.day)===day);
    return `<div class="editor-card" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>${AV_DAY_LABELS[day]}</strong><button class="btn" onclick="addAvailWindow(${day})">+ окно</button></div>
      ${wins.length?wins.map((w,i)=>`<div data-day="${day}" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <input type="time" class="av-from" value="${escapeAttr(w.from_time)}" style="width:130px"/>
        <span style="color:var(--muted)">—</span>
        <input type="time" class="av-to" value="${escapeAttr(w.to_time)}" style="width:130px"/>
        <button class="tiny-btn danger" onclick="delAvailWindow(${day},${i})">✕</button>
      </div>`).join(''):'<div class="muted" style="font-size:13px">нет окон</div>'}
    </div>`;
  }).join('');
}
function collectAvailability(){
  const out=[];
  document.querySelectorAll('#availGrid [data-day]').forEach(r=>{
    out.push({day:Number(r.dataset.day), from_time:r.querySelector('.av-from').value, to_time:r.querySelector('.av-to').value});
  });
  availWindows=out;
}
function addAvailWindow(day){ collectAvailability(); availWindows.push({day, from_time:'10:00', to_time:'11:00'}); renderAvailGrid(); }
function delAvailWindow(day,i){ collectAvailability(); let seen=-1; availWindows=availWindows.filter(w=>{ if(Number(w.day)===day){seen++;return seen!==i;} return true; }); renderAvailGrid(); }
async function saveAvailability(){
  collectAvailability();
  for(const w of availWindows){ if(!w.from_time||!w.to_time||String(w.from_time)>=String(w.to_time)){toast('Окно: начало должно быть раньше конца');return;} }
  const r=await fetch('/api/availability?secret='+encodeURIComponent(adminSecret),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:availSlot,windows:availWindows})});
  if(r.ok){toast('Доступность сохранена');}else{const e=await r.json().catch(()=>({}));toast(e.error||'Ошибка');}
}
```

- [ ] **Шаг 4: Проверить парсинг админки**

Run:
```bash
cd /root/savvateam && node -e "const h=require('fs').readFileSync('public/admin.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');try{new Function(m+'\n;if(typeof renderAvailability!==\"function\"||typeof saveAvailability!==\"function\"||typeof collectAvailability!==\"function\")throw new Error(\"missing avail fns\")');console.log('admin availability OK')}catch(e){console.log('ERROR:',e.message)}"
```
Expected: `admin availability OK`

- [ ] **Шаг 5: Проверить в браузере (end-to-end)**

Run: `cd /root/savvateam && node server.js`, `http://localhost:3000/admin` → «Доступность». Выбрать тренера → добавить окно (день ПН, 10:00–13:00) → «Сохранить» (toast «Доступность сохранена»). Затем:
```bash
curl -s "localhost:3000/api/availability?slot=coach1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('windows:',JSON.parse(d).length))"
```
Expected: окна сохранены; после перезагрузки страницы и выбора тренера окна снова видны (грузятся с сервера).

- [ ] **Шаг 6: Commit**
```bash
cd /root/savvateam && git add public/admin.html && git commit -m "feat(3a): admin Availability section (per-trainer weekly windows editor)"
```

---

## Task 4: Деплой + прод-проверка

**Files:** нет изменений кода — выкладка.

- [ ] **Шаг 1: Выложить сервер и админку**
```bash
cd /root/savvateam && export SSHPASS='oDR%r1C%rZjm'
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js root@45.139.29.201:/root/savvateam-site/
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" public/admin.html root@45.139.29.201:/root/savvateam-site/public/
echo "rsync done"
```

- [ ] **Шаг 2: Перезапустить и проверить таблицу + API**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam >/dev/null 2>&1 && sleep 1.5 && node -e \"const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('coach_availability cols:',db.prepare('PRAGMA table_info(coach_availability)').all().length)\"
curl -s 'localhost:3002/api/availability?slot=coach1&secret=SavvaKatitaLena' -o /dev/null -w 'availability(secret) %{http_code}\n'
curl -s 'localhost:3002/api/availability?slot=coach1' -o /dev/null -w 'availability(no-secret) %{http_code} (expect 401)\n'"
```
Expected: `coach_availability cols: 5`; `availability(secret) 200`; `availability(no-secret) 401`.

- [ ] **Шаг 3: Проверить админку на проде**

Открыть `https://savva.n2node.store/admin` (Ctrl+F5) → «Доступность» → выбрать тренера → добавить окна → «Сохранить» → перезагрузить: окна на месте.

- [ ] **Шаг 4: Push**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** таблица `coach_availability` → Task 1; валидатор (day 0–6, HH:MM, from<to) → Task 1; `GET`/`POST /api/availability` (замена в транзакции, ошибки) → Task 2; админ-раздел «Доступность» (выбор тренера, 7 дней, окна +/−, сохранение, загрузка с сервера) → Task 3; деплой → Task 4. Все пункты спеки покрыты.
- **Плейсхолдеров нет** — весь код целиком.
- **Согласованность имён:** statements (`listAvailability`, `deleteAvailability`, `insertAvailability`) и `validateWindows`/`isHHMM` — Task 1, используются Task 2. Эндпоинты `/api/availability` совпадают между сервером (Task 2) и админкой (Task 3). Поля окна (`day, from_time, to_time`) одинаковы в DDL (Task 1), API (Task 2), редакторе (Task 3).
- **Не персистить в state:** кэш `availSlot`/`availWindows` — модульные переменные, грузятся с сервера при выборе тренера (урок из 2C chat_id).
- **Границы:** нарезки слотов/брони нет (3B); параметр 30мин/≥60мин только зафиксирован для 3B.