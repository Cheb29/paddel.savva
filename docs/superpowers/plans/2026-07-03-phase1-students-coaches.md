# Фаза 1 — students + coaches — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Завести серверные таблицы `students` и `coaches` с REST CRUD, авто-создавать заготовку ученика из каждого лида, переписать админ-раздел «Ученики» с localStorage-мока на сервер и добавить тренерам поле `telegram_chat_id`.

**Architecture:** Расширяем `server.js` (better-sqlite3): 2 таблицы + prepared statements + REST-эндпоинты под `requireSecret`, плюс хук авто-создания ученика внутри публичного `POST /api/contact`. Переписываем раздел «Ученики» и дополняем редактор тренеров в `public/admin.html`. Лендинг не трогаем.

**Tech Stack:** Express + better-sqlite3, ES-модули. Тест-фреймворка нет — проверка ручная (curl / браузер / DevTools). Локально `ADMIN_SECRET` не задан → API доступно без `?secret=`.

## Global Constraints

- Таблица `students`: `id, name, phone` (НЕ уникальный), `level REAL NULL`, `audience TEXT NULL (adult|kids)`, `gender TEXT NULL (m|f)`, `confirmed INTEGER DEFAULT 0`, `source TEXT DEFAULT 'manual' (lead|manual)`, `created_at`.
- Таблица `coaches`: `slot TEXT PK (coach1|coach2|coach3)`, `telegram_chat_id TEXT NULL`, `created_at`. Засев 3 слотов `INSERT OR IGNORE`.
- Валидация студента: `level` ∈ [1,7] или null; `audience` ∈ {adult,kids} или null; `gender` ∈ {m,f} или null; `confirmed` ∈ {0,1}. Нарушение → 400.
- Все API students/coaches под `requireSecret`. Хук авто-создания — внутри публичного `/api/contact`, обёрнут в try/catch (не ломает ответ формы).
- Лид → ученик: дедуп по телефону среди неподтверждённых (`WHERE phone=? AND confirmed=0`).
- Паттерн сервера: prepared statements, именованные параметры better-sqlite3 (`@name`).
- Деплой: `server.js` → `/root/savvateam-site/` (корень), `public/admin.html` → `/root/savvateam-site/public/` (rsync СПЛЮЩИВАЕТ путь — статику слать явно в `public/`). Пароль через `export SSHPASS=...` + `sshpass -e`. `pm2 restart savvateam` (из-за server.js).

---

## Структура файлов

- `server.js`:
  - После `seedContent();` (≈строка 199) — DDL таблиц `students`/`coaches` + prepared statements + засев `coaches`.
  - Внутри `POST /api/contact` (после `insertLead.run(...)`, ≈строка 286) — хук авто-создания ученика.
  - После `POST /api/upload` (≈строка 388), перед `GET /admin` — новые роуты: students CRUD, coaches GET/PATCH + хелпер `validateStudentPatch`.
- `public/admin.html`:
  - `SEED.students` (строки 274–282) — заменить на пустой массив.
  - Блок функций студентов (`renderStudents`…`newStudent`, строки 697–772) — переписать на сервер.
  - `renderCoaches` (строка 1095) — добавить поле `telegram_chat_id` + `loadCoachChats`/`saveCoachChat`.

---

## Task 1: Сервер — таблицы `students`/`coaches` + statements

**Files:**
- Modify: `server.js` (после `seedContent();`, ≈строка 199)

**Interfaces:**
- Produces: таблицы `students`, `coaches`; prepared statements `insertStudent`, `findUnconfirmedByPhone`, `listStudents`, `getStudent`, `deleteStudentStmt`, `listCoaches`, `getCoach`, `updateCoachChat`.

- [ ] **Шаг 1: Добавить DDL и statements**

В `server.js` сразу после строки `seedContent();` вставить:

```js

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
```

- [ ] **Шаг 2: Проверить, что таблицы создаются и coaches засеян**

Run:
```bash
cd /root/savvateam && (node server.js & SRV=$!; sleep 1.2; kill $SRV 2>/dev/null); \
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('students cols:',db.prepare('PRAGMA table_info(students)').all().map(c=>c.name).join(','));console.log('coaches slots:',db.prepare('SELECT slot FROM coaches ORDER BY slot').all().map(c=>c.slot).join(','))"
```
Expected:
```
students cols: id,name,phone,level,audience,gender,confirmed,source,created_at
coaches slots: coach1,coach2,coach3
```

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(phase1): students + coaches tables and prepared statements"
```

---

## Task 2: Сервер — students CRUD API + валидация

**Files:**
- Modify: `server.js` (после `POST /api/upload`, ≈строка 388, перед `GET /admin`)

**Interfaces:**
- Consumes: `insertStudent`, `listStudents`, `getStudent`, `deleteStudentStmt`, `requireSecret`, `db`.
- Produces: `validateStudentPatch(body, {partial})`; роуты `GET/POST /api/students`, `PATCH/DELETE /api/students/:id`.

- [ ] **Шаг 1: Добавить хелпер валидации и роуты**

В `server.js` перед строкой `// ── GET /admin ──` вставить:

```js
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
```

- [ ] **Шаг 2: Проверить полный CRUD-цикл (локально, без секрета)**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo "-- create --"; ID=$(curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Тест Ученик","phone":"+7 900 000-00-00","level":2.5,"audience":"adult","gender":"m"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))"); echo "id=$ID"
echo "-- list --"; curl -s localhost:3000/api/students | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log('count',a.length,'last',JSON.stringify(a[0]))})"
echo "-- patch confirmed --"; curl -s -X PATCH localhost:3000/api/students/$ID -H 'Content-Type: application/json' -d '{"confirmed":1,"level":3}' -w ' http %{http_code}\n' -o /dev/null
echo "-- bad level 400 --"; curl -s -X PATCH localhost:3000/api/students/$ID -H 'Content-Type: application/json' -d '{"level":9}' -w 'http %{http_code}\n' -o /dev/null
echo "-- delete --"; curl -s -X DELETE localhost:3000/api/students/$ID -w 'http %{http_code}\n' -o /dev/null
kill $SRV 2>/dev/null
```
Expected: `id=<число>`; list count ≥1 с полями; patch → `http 200`; bad level → `http 400`; delete → `http 200`.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(phase1): students CRUD API with validation"
```

---

## Task 3: Сервер — авто-создание ученика из лида

**Files:**
- Modify: `server.js` (`POST /api/contact`, после `const row = insertLead.run(...)`, ≈строка 286)

**Interfaces:**
- Consumes: `findUnconfirmedByPhone`, `insertStudent`.

- [ ] **Шаг 1: Добавить хук после вставки лида**

В `server.js` внутри `POST /api/contact`, сразу после строки `const row = insertLead.run(name.trim(), phone.trim(), comment?.trim() ?? '', ip);` вставить:

```js

  // Фаза 1: авто-заготовка ученика из лида (дедуп по телефону среди неподтверждённых)
  try {
    if (!findUnconfirmedByPhone.get(phone.trim())) {
      insertStudent.run({
        name: name.trim(), phone: phone.trim(),
        level: null, audience: null, gender: null, confirmed: 0, source: 'lead',
      });
    }
  } catch (e) { /* не блокируем ответ формы */ }
```

- [ ] **Шаг 2: Проверить авто-создание и дедуп**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
BEFORE=$(curl -s localhost:3000/api/students | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))")
curl -s -X POST localhost:3000/api/contact -H 'Content-Type: application/json' -d '{"name":"Лид Тест","phone":"+7 900 111-22-33","comment":"хочу пробное"}' -o /dev/null
curl -s -X POST localhost:3000/api/contact -H 'Content-Type: application/json' -d '{"name":"Лид Тест","phone":"+7 900 111-22-33","comment":"ещё раз"}' -o /dev/null
AFTER=$(curl -s localhost:3000/api/students | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);const leadOnes=a.filter(s=>s.source==='lead');console.log(a.length+'|'+leadOnes.length+'|'+JSON.stringify(leadOnes[0]||{}))})")
echo "before=$BEFORE after(count|leadCount|firstLead)=$AFTER"
kill $SRV 2>/dev/null
```
Expected: после двух `/api/contact` с одним телефоном добавился **ровно один** ученик с `source:'lead'`, `confirmed:0`, `level:null` (дедуп сработал). `after` count = before+1.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(phase1): auto-create student stub from each contact lead (dedupe by phone)"
```

---

## Task 4: Сервер — coaches API (GET + PATCH)

**Files:**
- Modify: `server.js` (рядом со students-роутами, перед `GET /admin`)

**Interfaces:**
- Consumes: `listCoaches`, `getCoach`, `updateCoachChat`, `db`, `requireSecret`.
- Produces: роуты `GET /api/coaches`, `PATCH /api/coaches/:slot`.

- [ ] **Шаг 1: Добавить роуты coaches**

В `server.js` сразу после `DELETE /api/students/:id` роута (Task 2) вставить:

```js

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
```

- [ ] **Шаг 2: Проверить coaches API**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo "-- list --"; curl -s localhost:3000/api/coaches | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log('slots+names:',a.map(c=>c.slot+'='+(c.name||'?')).join(' | '))})"
echo "-- set chat --"; curl -s -X PATCH localhost:3000/api/coaches/coach2 -H 'Content-Type: application/json' -d '{"telegram_chat_id":"123456"}' -w 'http %{http_code}\n' -o /dev/null
echo "-- verify + clear --"; curl -s localhost:3000/api/coaches | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c2=JSON.parse(d).find(x=>x.slot==='coach2');console.log('coach2 chat:',c2.telegram_chat_id)})"
curl -s -X PATCH localhost:3000/api/coaches/coach2 -H 'Content-Type: application/json' -d '{"telegram_chat_id":""}' -o /dev/null
echo "-- 404 unknown slot --"; curl -s -X PATCH localhost:3000/api/coaches/coach9 -H 'Content-Type: application/json' -d '{"telegram_chat_id":"x"}' -w 'http %{http_code}\n' -o /dev/null
kill $SRV 2>/dev/null
```
Expected: список 3 слотов с именами из content (`coach1=Савва Шехватов` и т.д.); set → `http 200`; coach2 chat = `123456`; unknown slot → `http 404`.

- [ ] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(phase1): coaches API (list with content names, set/clear telegram_chat_id)"
```

---

## Task 5: Админка — раздел «Ученики» на сервер

**Files:**
- Modify: `public/admin.html` — `SEED.students` (строки 274–282); блок функций студентов (строки 697–772).

**Interfaces:**
- Consumes: `/api/students` API (Task 2), `adminSecret`, `openDrawer`, `closeDrawer`, `toast`, `escapeHtml`, `escapeAttr`, `exportCSV`, `state`.
- Produces: серверные `renderStudents`, `loadStudents`, `openStudent`, `saveStudent`, `toggleStudentConfirmed`, `deleteStudent`, `newStudent`.

- [ ] **Шаг 1: Обнулить демо-мок студентов в `SEED`**

Заменить строки 274–282 (массив `students:[ ...5 демо-объектов... ],`) на:
```js
  students:[],
```

- [ ] **Шаг 2: Переписать блок функций студентов**

Заменить весь блок от `function renderStudents(c){` (строка 697) до закрывающей `}` функции `newStudent` (строка 772) на:

```js
function renderStudents(c){
  const filter={search:'',confirmed:'all'};
  const AUD={adult:'Взрослый',kids:'Ребёнок'}, GEN={m:'М',f:'Ж'};
  c.innerHTML=`<div class="page-head">
      <div><div class="page-title">УЧЕНИКИ</div><div class="page-sub" id="stSub">Загрузка…</div></div>
      <div class="page-actions">
        <button class="btn" onclick="exportCSV(state.students,'students.csv')">↓ CSV</button>
        <button class="btn btn-primary" onclick="newStudent()">+ Ученик</button>
      </div>
    </div>
    <div class="toolbar">
      <input id="stSearch" type="text" placeholder="Поиск по имени, телефону…" />
      <select id="stConfirmed"><option value="all">Все</option><option value="1">Подтверждённые</option><option value="0">Не подтверждённые</option></select>
    </div>
    <div id="stList"><div class="empty"><div class="glyph">◉</div>Загрузка…</div></div>`;
  const refresh=()=>{
    const list=state.students.filter(s=>{
      if(filter.confirmed!=='all'&&String(s.confirmed)!==filter.confirmed)return false;
      if(filter.search){const q=filter.search.toLowerCase();return [s.name,s.phone].join(' ').toLowerCase().includes(q)}
      return true;
    });
    const sub=document.getElementById('stSub'); if(sub)sub.textContent=`${state.students.length} в базе · ${state.students.filter(s=>s.confirmed).length} подтверждённых`;
    const el=document.getElementById('stList'); if(!el)return;
    if(!list.length){el.innerHTML=`<div class="empty"><div class="glyph">◉</div>Нет учеников</div>`;return}
    el.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Ученик</th><th>Уровень</th><th>Аудитория</th><th>Пол</th><th>Источник</th><th>Статус</th><th></th></tr></thead><tbody>${list.map(s=>`
      <tr onclick="openStudent(${s.id})" style="cursor:pointer">
        <td><div style="display:flex;align-items:center;gap:12px"><div class="avatar" style="background:var(--surface2);color:var(--text)">${escapeHtml((s.name||'?')[0])}</div><div><strong>${escapeHtml(s.name)}</strong><div style="color:var(--muted);font-size:11px">${escapeHtml(s.phone)}</div></div></div></td>
        <td>${s.level!=null?`<span class="tag tag-elite">${s.level}</span>`:'<span style="color:var(--muted)">—</span>'}</td>
        <td>${s.audience?AUD[s.audience]:'—'}</td>
        <td>${s.gender?GEN[s.gender]:'—'}</td>
        <td>${s.source==='lead'?'<span class="tag" style="background:var(--accent-dim);color:var(--accent)">из лида</span>':'вручную'}</td>
        <td><span class="tag tag-${s.confirmed?'active':'paused'}">${s.confirmed?'Подтверждён':'Не подтв.'}</span></td>
        <td><div class="row-actions" onclick="event.stopPropagation()"><button class="tiny-btn" onclick="toggleStudentConfirmed(${s.id})" title="Подтвердить/снять">✓</button><button class="tiny-btn danger" onclick="deleteStudent(${s.id})" title="Удалить">✕</button></div></td>
      </tr>`).join('')}</tbody></table></div>`;
  };
  document.getElementById('stSearch').addEventListener('input',e=>{filter.search=e.target.value;refresh()});
  document.getElementById('stConfirmed').addEventListener('change',e=>{filter.confirmed=e.target.value;refresh()});
  loadStudents().then(refresh);
}
async function loadStudents(){
  try{const r=await fetch('/api/students?secret='+encodeURIComponent(adminSecret));if(r.ok)state.students=await r.json();}catch(e){}
}
function openStudent(id){
  const s=state.students.find(x=>x.id===id);if(!s)return;
  openDrawer(s.name,
    `<div class="field"><label>Имя</label><input id="edStName" value="${escapeAttr(s.name)}"/></div>
     <div class="field"><label>Телефон</label><input id="edStPhone" value="${escapeAttr(s.phone)}"/></div>
     <div class="field"><label>Уровень (1.0–7.0)</label><input id="edStLevel" type="number" step="0.5" min="1" max="7" value="${s.level!=null?s.level:''}"/></div>
     <div class="field"><label>Аудитория</label><select id="edStAud"><option value="" ${s.audience==null?'selected':''}>—</option><option value="adult" ${s.audience==='adult'?'selected':''}>Взрослый</option><option value="kids" ${s.audience==='kids'?'selected':''}>Ребёнок</option></select></div>
     <div class="field"><label>Пол</label><select id="edStGen"><option value="" ${s.gender==null?'selected':''}>—</option><option value="m" ${s.gender==='m'?'selected':''}>М</option><option value="f" ${s.gender==='f'?'selected':''}>Ж</option></select></div>
     <div class="field"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="edStConfirmed" ${s.confirmed?'checked':''}/> Подтверждён (доступ к записи)</label></div>`,
    `<button class="btn btn-primary" onclick="saveStudent(${id})">Сохранить</button><button class="btn" onclick="closeDrawer()">Отмена</button>`);
}
async function saveStudent(id){
  const lvl=document.getElementById('edStLevel').value;
  const body={
    name:document.getElementById('edStName').value.trim(),
    phone:document.getElementById('edStPhone').value.trim(),
    level:lvl===''?null:Number(lvl),
    audience:document.getElementById('edStAud').value||null,
    gender:document.getElementById('edStGen').value||null,
    confirmed:document.getElementById('edStConfirmed').checked?1:0,
  };
  const r=await fetch('/api/students/'+id+'?secret='+encodeURIComponent(adminSecret),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){const e=await r.json().catch(()=>({}));toast(e.error||'Ошибка сохранения');return}
  closeDrawer();renderStudents(document.getElementById('pageContent'));toast('Сохранено');
}
async function toggleStudentConfirmed(id){
  const s=state.students.find(x=>x.id===id);if(!s)return;
  const r=await fetch('/api/students/'+id+'?secret='+encodeURIComponent(adminSecret),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:s.confirmed?0:1})});
  if(r.ok)renderStudents(document.getElementById('pageContent'));
}
async function deleteStudent(id){
  if(!confirm('Удалить ученика?'))return;
  const r=await fetch('/api/students/'+id+'?secret='+encodeURIComponent(adminSecret),{method:'DELETE'});
  if(r.ok){renderStudents(document.getElementById('pageContent'));toast('Удалено');}
}
async function newStudent(){
  const r=await fetch('/api/students?secret='+encodeURIComponent(adminSecret),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Новый ученик',phone:'+7'})});
  if(!r.ok){toast('Ошибка создания');return}
  const {id}=await r.json();
  await loadStudents();renderStudents(document.getElementById('pageContent'));openStudent(id);
}
```

- [ ] **Шаг 3: Проверить, что скрипт админки парсится**

Run:
```bash
cd /root/savvateam && node -e "const h=require('fs').readFileSync('public/admin.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');try{new Function(m+'\n;if(typeof renderStudents!==\"function\"||typeof loadStudents!==\"function\")throw new Error(\"missing student fns\")');console.log('admin students OK')}catch(e){console.log('ERROR:',e.message)}"
```
Expected: `admin students OK`

- [ ] **Шаг 4: Проверить в браузере (end-to-end)**

Run: `cd /root/savvateam && node server.js`, открыть `http://localhost:3000/admin`, войти (локально `ADMIN_SECRET` не задан → любой пароль пройдёт), раздел «Ученики».
Expected: список грузится с сервера (после Task 3 там есть заготовки из лидов с бейджем «из лида»); «+ Ученик» создаёт и открывает дровер; правка уровня/аудитории/пола/тумблера сохраняется (toast «Сохранено»); тумблер ✓ в строке переключает `Подтверждён`; удаление работает. Остановить сервер.

- [ ] **Шаг 5: Commit**
```bash
cd /root/savvateam && git add public/admin.html && git commit -m "feat(phase1): rewire admin Students section to server API (drop localStorage mock)"
```

---

## Task 6: Админка — поле `telegram_chat_id` тренера

**Files:**
- Modify: `public/admin.html` — `renderCoaches` (строка 1095) + новые `loadCoachChats`/`saveCoachChat`.

**Interfaces:**
- Consumes: `/api/coaches` API (Task 4), `state.coaches`, `adminSecret`, `toast`, `escapeAttr`.
- Produces: `loadCoachChats()`, `saveCoachChat(id)`; поле chat_id в карточке тренера.

- [ ] **Шаг 1: Ленивая загрузка chat_id при входе в раздел**

В функции `renderCoaches(c)` (строка 1095), сразу после строки `if(!state.coaches)state.coaches=[];` вставить:
```js
  if(!state._coachChatsLoaded){ loadCoachChats().then(()=>{ state._coachChatsLoaded=true; renderCoaches(c); }); }
```

- [ ] **Шаг 2: Добавить поле chat_id в карточку тренера**

В `renderCoaches`, внутри `.editor-card` тренера, найти строку `<div class="editor-actions"><button class="btn btn-primary" onclick="saveCoach(${co.id})">Сохранить</button><button class="btn btn-danger" onclick="delCoach(${co.id})">Удалить</button></div>` и прямо перед ней вставить:
```js
       <div class="field" style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px"><label>Telegram chat_id (для уведомлений о записи · Фаза 2)</label>
         <div style="display:flex;gap:8px"><input id="coachChat${co.id}" value="${escapeAttr(co.telegram_chat_id||'')}" placeholder="не привязан" style="flex:1"/><button class="btn" onclick="saveCoachChat(${co.id})">Сохранить</button></div>
       </div>
```

- [ ] **Шаг 3: Добавить `loadCoachChats` и `saveCoachChat`**

Сразу после функции `renderCoaches` (перед `async function saveCoach`) вставить:
```js
async function loadCoachChats(){
  try{
    const r=await fetch('/api/coaches?secret='+encodeURIComponent(adminSecret));
    if(r.ok){const list=await r.json();(state.coaches||[]).forEach(co=>{const m=list.find(x=>x.slot==='coach'+co.id);if(m)co.telegram_chat_id=m.telegram_chat_id||'';});}
  }catch(e){}
}
async function saveCoachChat(id){
  const el=document.getElementById('coachChat'+id); if(!el)return;
  const val=el.value.trim();
  const r=await fetch('/api/coaches/coach'+id+'?secret='+encodeURIComponent(adminSecret),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram_chat_id:val})});
  if(r.ok){const co=state.coaches.find(x=>x.id===id);if(co)co.telegram_chat_id=val;toast('chat_id сохранён');}else{toast('Ошибка');}
}
```

- [ ] **Шаг 4: Проверить парсинг и наличие функций**

Run:
```bash
cd /root/savvateam && node -e "const h=require('fs').readFileSync('public/admin.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');try{new Function(m+'\n;if(typeof loadCoachChats!==\"function\"||typeof saveCoachChat!==\"function\")throw new Error(\"missing coach chat fns\")');console.log('coach chat OK')}catch(e){console.log('ERROR:',e.message)}"
```
Expected: `coach chat OK`

- [ ] **Шаг 5: Проверить в браузере**

Run: `cd /root/savvateam && node server.js`, `http://localhost:3000/admin` → «Тренеры». У каждого тренера появилось поле «Telegram chat_id»; ввести значение → «Сохранить» → toast «chat_id сохранён». Проверить:
```bash
curl -s localhost:3000/api/coaches | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(c=>c.slot+':'+(c.telegram_chat_id||'—')).join(' ')))"
```
Expected: сохранённый chat_id виден у нужного слота. Остановить сервер.

- [ ] **Шаг 6: Commit**
```bash
cd /root/savvateam && git add public/admin.html && git commit -m "feat(phase1): coach telegram_chat_id field in admin coaches editor"
```

---

## Task 7: Деплой и финальная проверка

**Files:** нет изменений кода — только выкладка.

- [ ] **Шаг 1: Выложить сервер (в корень) и админку (в public/)**
```bash
cd /root/savvateam && export SSHPASS='oDR%r1C%rZjm'
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js root@45.139.29.201:/root/savvateam-site/
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" public/admin.html root@45.139.29.201:/root/savvateam-site/public/
echo "rsync done"
```

- [ ] **Шаг 2: Перезапустить сервер и убедиться, что таблицы созданы**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam >/dev/null 2>&1 && sleep 1.5 && node -e \"const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('students cols:',db.prepare('PRAGMA table_info(students)').all().length,'| coaches:',db.prepare('SELECT slot FROM coaches').all().map(c=>c.slot).join(','))\""
```
Expected: `students cols: 9 | coaches: coach1,coach2,coach3`

- [ ] **Шаг 3: Прод smoke-тест API (с секретом)**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "curl -s 'localhost:3002/api/students?secret=SavvaKatitaLena' -o /dev/null -w 'students GET %{http_code}\n'; curl -s 'localhost:3002/api/coaches?secret=SavvaKatitaLena' | head -c 300; echo; curl -s 'localhost:3002/api/students' -o /dev/null -w 'no-secret %{http_code} (expect 401)\n'"
```
Expected: `students GET 200`; список coaches с именами; `no-secret 401`.

- [ ] **Шаг 4: Прод проверка формы → авто-ученик**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "curl -s -X POST localhost:3002/api/contact -H 'Content-Type: application/json' -d '{\"name\":\"Проверка Прод\",\"phone\":\"+7 905 000-11-22\",\"comment\":\"тест фазы 1\"}' -o /dev/null -w 'contact %{http_code}\n'; curl -s 'localhost:3002/api/students?secret=SavvaKatitaLena' | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);const f=a.find(s=>s.phone.includes('905 000-11-22'));console.log('lead-student:',JSON.stringify(f||'НЕ НАЙДЕН'))})\""
```
Expected: `contact 200`; найден ученик с `source:'lead'`, `confirmed:0`.

- [ ] **Шаг 5: Проверить админку на проде**

Открыть `https://savva.n2node.store/admin`, войти паролем `SavvaKatitaLena`. Раздел «Ученики» — список с сервера (есть заготовка «Проверка Прод» из лида); создание/правка/удаление/тумблер работают. Раздел «Тренеры» — поле chat_id сохраняется.

- [ ] **Шаг 6: Push в репозиторий**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** таблица `students` + `coaches` → Task 1; students CRUD + валидация → Task 2; авто-создание из лида + дедуп → Task 3; coaches API (имена из content, set/clear chat_id) → Task 4; админка «Ученики» на сервер + удаление мока → Task 5; поле chat_id тренера → Task 6; деплой + прод-проверки → Task 7. Все пункты спеки покрыты.
- **Плейсхолдеров нет** — весь код приведён целиком.
- **Согласованность имён:** statements (`insertStudent`, `findUnconfirmedByPhone`, `listStudents`, `getStudent`, `deleteStudentStmt`, `listCoaches`, `getCoach`, `updateCoachChat`) определены в Task 1, используются в Task 2/3/4. `validateStudentPatch` — Task 2, используется в POST/PATCH. Поля ученика (`id,name,phone,level,audience,gender,confirmed,source,created_at`) одинаковы в DDL (Task 1), API (Task 2), админ-рендере (Task 5). Слоты `coach1/2/3` ↔ `co.id` 1/2/3 согласованы (Task 4 API ↔ Task 6 `saveCoachChat('coach'+id)`). Эндпоинты `/api/students`, `/api/students/:id`, `/api/coaches`, `/api/coaches/:slot` совпадают между сервером (Task 2/4) и админкой (Task 5/6).
- **Валидация:** `level` [1,7]/null, `audience` adult|kids/null, `gender` m|f/null, `confirmed` 0/1 — в `validateStudentPatch` (Task 2), соответствует Global Constraints и спеке.
- **Деплой:** server.js в корень, admin.html в `public/` (учтён rsync-сплющивание из памяти проекта); `pm2 restart` из-за server.js.
