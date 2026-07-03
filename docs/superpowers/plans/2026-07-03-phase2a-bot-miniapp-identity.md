# Фаза 2A — Бот + Mini App + вход/личность — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Клиент открывает `@SavvaPadel_bot` → делится телефоном → открывает Mini App → сервер по подтверждённому телефону узнаёт ученика(ов) (`ok`/`unmatched`/`need_phone`); тренеры распознаются по `user_id` и видят свой блок.

**Architecture:** Расширяем `server.js` (better-sqlite3): webhook-роут бота + `setWebhook` на старте + сырой Bot API (`tgApi`), таблица `tg_sessions`, обработчик апдейтов `handleTgUpdate`, эндпоинт `POST /api/app/identify` с валидацией initData (HMAC). Mini App — статическая `public/app.html` на `/app`. Брони нет (2B).

**Tech Stack:** Express + better-sqlite3, ES-модули, Node 22 (глобальные `fetch`/`crypto`, старт `node --env-file=.env`). Тест-фреймворка нет — проверка ручная (curl / браузер). Локально бот не поднимается (нет `PUBLIC_URL`), Mini App тестируется через `DEV_ALLOW_UNSIGNED=1`.

## Global Constraints

- Бот — тот же `@SavvaPadel_bot` (`TELEGRAM_BOT_TOKEN`). Приём — webhook `POST /api/tg/webhook/:secret`, проверка пути И заголовка `X-Telegram-Bot-Api-Secret-Token` против `WEBHOOK_SECRET`; иначе 403.
- Матч — только подтверждённые: `SELECT ... FROM students WHERE phone=? AND confirmed=1`. Пусто → `unmatched`.
- Тренер: `user_id` совпал с `coaches.telegram_chat_id` → тренерский блок; иначе клиентский. Захвата id в боте нет.
- initData: канон Telegram. `secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)`; `hash = HMAC_SHA256(key=secret_key, msg=data_check_string)`; `data_check_string` — пары `k=v` (кроме `hash`), отсортированы по ключу, склеены `\n`. Свежесть `auth_date ≤ 24ч`. Невалидно → 401.
- Новые env: `PUBLIC_URL`, `WEBHOOK_SECRET`, `MANAGER_USERNAME` (без `@`), `DEV_ALLOW_UNSIGNED`.
- Деплой: `server.js` → `/root/savvateam-site/` (корень), `public/app.html` → `/root/savvateam-site/public/`; прод-`.env` дополнить; `pm2 restart savvateam`; `sshpass -e`.
- Webhook-роут возвращает `200` всегда и быстро; обработку не блокируем (`handleTgUpdate(...).catch(()=>{})`).

---

## Структура файлов

- `server.js`:
  - Config (строки 11–14) — новые env-переменные.
  - `sendTelegram` (строки 243–253) — переписать поверх нового `tgApi`.
  - Рядом со `students`/`coaches` DDL (после `seedCoach…`, ≈строка 240) — таблица `tg_sessions` + statements + хелперы.
  - Импорт `crypto` (верх файла).
  - Новые роуты (рядом со students/coaches, перед `GET /admin`): `POST /api/app/identify`, `POST /api/tg/webhook/:secret`, `GET /app`.
  - `handleTgUpdate`, `validateInitData`, `initWebhook` — функции; `initWebhook()` вызвать в колбэке `app.listen`.
- `public/app.html` — новая страница Mini App.

---

## Task 1: Сервер — config, `tgApi`, `tg_sessions`, statements

**Files:**
- Modify: `server.js` (config ≈11–14; `sendTelegram` 243–253; DDL-блок ≈240; импорты)

**Interfaces:**
- Produces: `PUBLIC_URL`, `WEBHOOK_SECRET`, `MANAGER_USERNAME`, `DEV_ALLOW_UNSIGNED`; `tgApi(method, params)`; таблица `tg_sessions`; statements `upsertTgSession`, `getTgSession`, `isCoachChat`, `listConfirmedByPhone`; хелпер `coachNameBySlot(slot)`.

- [x] **Шаг 1: Добавить импорт crypto**

В `server.js` в блок импортов (после строки 7 `import { fileURLToPath } from 'url';`) добавить:
```js
import { createHmac } from 'crypto';
```

- [x] **Шаг 2: Добавить env-переменные в Config**

После строки `const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';` (строка 14) вставить:
```js
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MANAGER_USERNAME = process.env.MANAGER_USERNAME || '';
const DEV_ALLOW_UNSIGNED = process.env.DEV_ALLOW_UNSIGNED === '1';
```

- [x] **Шаг 3: Переписать `sendTelegram` поверх `tgApi`**

Заменить функцию `sendTelegram` (строки 243–253) на:
```js
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
```

- [x] **Шаг 4: Таблица `tg_sessions` + statements + хелпер**

В `server.js` сразу после строки `['coach1','coach2','coach3'].forEach(s => seedCoach.run(s));` (засев coaches из Фазы 1) вставить:
```js

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
const listConfirmedByPhone = db.prepare(
  'SELECT id, name, level, audience, gender FROM students WHERE phone = ? AND confirmed = 1'
);
function coachNameBySlot(slot) {
  const m = /^coach(\d)$/.exec(slot); if (!m) return '';
  const row = db.prepare('SELECT value FROM content WHERE key = ?').get('coach' + m[1] + '_name');
  return row ? row.value : '';
}
```

- [x] **Шаг 5: Проверить, что сервер стартует и таблица создаётся**

Run:
```bash
cd /root/savvateam && (node server.js & SRV=$!; sleep 1.2; kill $SRV 2>/dev/null); \
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');console.log('tg_sessions cols:',db.prepare('PRAGMA table_info(tg_sessions)').all().map(c=>c.name).join(','))"
```
Expected: `tg_sessions cols: telegram_user_id,phone,updated_at`

- [x] **Шаг 6: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2a): config vars, tgApi helper, tg_sessions table and statements"
```

---

## Task 2: Сервер — webhook-роут + `setWebhook` на старте

**Files:**
- Modify: `server.js` (новый роут перед `GET /admin`; `initWebhook` + вызов в `app.listen`)

**Interfaces:**
- Consumes: `WEBHOOK_SECRET`, `PUBLIC_URL`, `TG_TOKEN`, `tgApi`, `handleTgUpdate` (Task 3).
- Produces: роут `POST /api/tg/webhook/:secret`; `initWebhook()`.

- [x] **Шаг 1: Добавить webhook-роут**

В `server.js` перед `// ── GET /admin ──` вставить:
```js
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
```

- [x] **Шаг 2: Добавить `initWebhook` и вызвать на старте**

Найти блок `app.listen(PORT, () => {` (≈конец файла) и внутри его колбэка, после существующих `console.log`, добавить вызов и саму функцию рядом. Сначала перед `app.listen(...)` вставить функцию:
```js
async function initWebhook() {
  if (!TG_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) {
    console.log('Telegram webhook: отключён (нет PUBLIC_URL/WEBHOOK_SECRET/токена)');
    return;
  }
  const url = `${PUBLIC_URL}/api/tg/webhook/${WEBHOOK_SECRET}`;
  const r = await tgApi('setWebhook', { url, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'] });
  console.log('Telegram webhook:', r && r.ok ? 'установлен → ' + url : 'ошибка ' + JSON.stringify(r));
}
```
Затем внутри колбэка `app.listen` добавить строку:
```js
  initWebhook();
```

- [x] **Шаг 3: Проверить gating секрета (403 без секрета)**

> `handleTgUpdate` появится в Task 3 — но на этом шаге проверяем только 403-ветку (до `handleTgUpdate` управление не доходит при неверном секрете). Пустой `WEBHOOK_SECRET` → все запросы 403.

Run:
```bash
cd /root/savvateam && WEBHOOK_SECRET=testsecret node server.js & SRV=$!; sleep 1.2
echo -n "bad path secret -> "; curl -s -X POST localhost:3000/api/tg/webhook/wrong -H 'Content-Type: application/json' -d '{}' -w '%{http_code}\n' -o /dev/null
echo -n "good path, bad header -> "; curl -s -X POST localhost:3000/api/tg/webhook/testsecret -H 'Content-Type: application/json' -d '{}' -w '%{http_code}\n' -o /dev/null
kill $SRV 2>/dev/null
```
Expected: оба `403` (у второго верный путь, но нет заголовка-секрета).

- [x] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2a): telegram webhook route + setWebhook on boot"
```

---

## Task 3: Сервер — обработка апдейтов (`handleTgUpdate`)

**Files:**
- Modify: `server.js` (функция `handleTgUpdate` рядом с `initWebhook`)

**Interfaces:**
- Consumes: `upsertTgSession`, `getTgSession`, `isCoachChat`, `coachNameBySlot`, `tgApi`, `PUBLIC_URL`.
- Produces: `handleTgUpdate(update)`.

- [x] **Шаг 1: Добавить `handleTgUpdate`**

Перед `initWebhook` (или сразу после) вставить:
```js
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
```

- [x] **Шаг 2: Проверить, что контакт пишется в `tg_sessions` (локально)**

`tgApi` с фейковым токеном не достучится до Telegram, но запись в БД — до отправки, поэтому наблюдаема.
Run:
```bash
cd /root/savvateam && WEBHOOK_SECRET=testsecret TELEGRAM_BOT_TOKEN=x node server.js & SRV=$!; sleep 1.2
curl -s -X POST localhost:3000/api/tg/webhook/testsecret -H 'Content-Type: application/json' -H 'X-Telegram-Bot-Api-Secret-Token: testsecret' \
  -d '{"message":{"chat":{"id":555},"from":{"id":555},"contact":{"user_id":555,"phone_number":"+7 900 111-22-33"}}}' -w 'webhook %{http_code}\n' -o /dev/null
sleep 0.3
node -e "const D=require('better-sqlite3');const db=new D('db/leads.db');const s=db.prepare('SELECT * FROM tg_sessions WHERE telegram_user_id=555').get();console.log('session:',JSON.stringify(s||'НЕТ'))"
kill $SRV 2>/dev/null
```
Expected: `webhook 200`; `session: {"telegram_user_id":555,"phone":"+7 900 111-22-33","updated_at":"…"}`

- [x] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2a): handleTgUpdate — contact->session, trainer vs client greeting"
```

---

## Task 4: Сервер — `POST /api/app/identify` + валидация initData

**Files:**
- Modify: `server.js` (`validateInitData` + роут, рядом с webhook-роутом)

**Interfaces:**
- Consumes: `createHmac`, `TG_TOKEN`, `DEV_ALLOW_UNSIGNED`, `getTgSession`, `upsertTgSession`, `listConfirmedByPhone`, `MANAGER_USERNAME`.
- Produces: `validateInitData(initData)`; роут `POST /api/app/identify`.

- [x] **Шаг 1: Добавить валидатор и роут**

В `server.js` рядом с webhook-роутом (перед `GET /admin`) вставить:
```js
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
  const students = listConfirmedByPhone.all(sess.phone);
  if (!students.length) return res.json({ status: 'unmatched', manager: MANAGER_USERNAME });
  res.json({ status: 'ok', students });
});
```

- [x] **Шаг 2: Проверить три ветки через dev-обход + валидный/битый initData**

Run:
```bash
cd /root/savvateam && DEV_ALLOW_UNSIGNED=1 TELEGRAM_BOT_TOKEN=testtoken MANAGER_USERNAME=savva_manager node server.js & SRV=$!; sleep 1.2
# подтверждённый ученик с телефоном +7 900 555-00-00
curl -s -X POST localhost:3000/api/students -H 'Content-Type: application/json' -d '{"name":"Иван Кон","phone":"+7 900 555-00-00","level":3,"audience":"adult","gender":"m","confirmed":1}' -o /dev/null
echo -n "need_phone -> "; curl -s -X POST localhost:3000/api/app/identify -H 'Content-Type: application/json' -d '{"dev_user_id":777}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))"
echo -n "ok -> ";         curl -s -X POST localhost:3000/api/app/identify -H 'Content-Type: application/json' -d '{"dev_user_id":777,"dev_phone":"+7 900 555-00-00"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.status, j.students&&j.students[0]&&j.students[0].name)})"
echo -n "unmatched -> ";  curl -s -X POST localhost:3000/api/app/identify -H 'Content-Type: application/json' -d '{"dev_user_id":888,"dev_phone":"+7 000 000-00-00"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.status, j.manager)})"
# валидный initData, подписанный тем же testtoken
node -e "
const {createHmac}=require('crypto');const TOKEN='testtoken';
const params=new URLSearchParams();params.set('auth_date',Math.floor(Date.now()/1000));params.set('user',JSON.stringify({id:777}));
const dcs=[...params.entries()].map(([k,v])=>k+'='+v).sort().join('\n');
const sk=createHmac('sha256','WebAppData').update(TOKEN).digest();
params.set('hash',createHmac('sha256',sk).update(dcs).digest('hex'));
require('fs').writeFileSync('/tmp/initdata.txt',params.toString());
"
echo -n "signed ok -> "; curl -s -X POST localhost:3000/api/app/identify -H 'Content-Type: application/json' -d "{\"initData\":\"$(cat /tmp/initdata.txt)\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))"
echo -n "bad initData 401 -> "; curl -s -X POST localhost:3000/api/app/identify -H 'Content-Type: application/json' -d '{"initData":"user=%7B%22id%22%3A1%7D&hash=deadbeef&auth_date=1"}' -w '%{http_code}\n' -o /dev/null
kill $SRV 2>/dev/null
```
Expected: `need_phone -> need_phone`; `ok -> ok Иван Кон`; `unmatched -> unmatched savva_manager`; `signed ok -> ok` (валидная подпись прошла реальную проверку, dev-флаг не задействован для этой ветки, т.к. нет `dev_user_id`); `bad initData 401 -> 401`.

- [x] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(2a): /api/app/identify with initData HMAC validation and confirmed-phone match"
```

---

## Task 5: Mini App — страница `public/app.html` + роут `/app`

**Files:**
- Create: `public/app.html`
- Modify: `server.js` (роут `GET /app` перед SPA fallback)

**Interfaces:**
- Consumes: `POST /api/app/identify`.
- Produces: страница Mini App на `/app`.

- [x] **Шаг 1: Добавить роут `/app`**

В `server.js` перед `// ── SPA fallback ──` (`app.get('*', …)`) вставить:
```js
app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
```

- [x] **Шаг 2: Создать `public/app.html`**

Создать файл `public/app.html` с содержимым:
```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>Savva Team — запись</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root { --bg:#0C0C0C; --surface:#161616; --border:rgba(255,255,255,0.08); --text:#F0F0EE; --muted:rgba(240,240,238,0.5); --accent:#56d37b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,Inter,Arial,sans-serif; -webkit-font-smoothing:antialiased; padding:24px 18px; }
    h1 { font-size:24px; margin:0 0 6px; }
    .sub { color:var(--muted); font-size:14px; margin-bottom:24px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:20px; margin-bottom:12px; }
    button { width:100%; padding:15px; border:0; border-radius:14px; background:var(--accent); color:#0a0a0a; font-size:15px; font-weight:700; cursor:pointer; }
    button:active { transform:scale(0.97); }
    a.mgr { display:block; text-align:center; padding:15px; border-radius:14px; background:var(--accent); color:#0a0a0a; font-weight:700; text-decoration:none; }
    .stud { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border:1px solid var(--border); border-radius:14px; margin-bottom:10px; }
    .stud .lv { color:var(--accent); font-weight:700; }
    .muted { color:var(--muted); font-size:13px; }
    #err { color:#ff6b6b; font-size:13px; margin-top:10px; }
  </style>
</head>
<body>
  <h1>Savva Team 🎾</h1>
  <div class="sub">Запись на тренировку</div>
  <div id="root"><div class="card">Загрузка…</div></div>
  <div id="err"></div>

  <script>
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { tg.ready(); tg.expand(); }
    const root = document.getElementById('root');
    const errEl = document.getElementById('err');
    const esc = s => String(s==null?'':s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

    async function identify() {
      const initData = tg ? tg.initData : '';
      const r = await fetch('/api/app/identify', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ initData })
      });
      if (r.status === 401) { root.innerHTML = '<div class="card">Не удалось подтвердить вход. Откройте приложение из бота.</div>'; return; }
      const data = await r.json();
      render(data);
    }

    function render(data) {
      if (data.status === 'need_phone') {
        root.innerHTML = '<div class="card"><div class="muted" style="margin-bottom:14px">Поделитесь номером телефона — по нему мы найдём вас в базе академии.</div><button id="share">📱 Поделиться телефоном</button></div>';
        document.getElementById('share').onclick = () => {
          if (tg && tg.requestContact) {
            tg.requestContact(() => setTimeout(identify, 800));
          } else {
            errEl.textContent = 'Откройте приложение из Telegram-бота.';
          }
        };
      } else if (data.status === 'unmatched') {
        const u = data.manager ? ('https://t.me/' + data.manager) : '#';
        root.innerHTML = '<div class="card"><h1 style="font-size:18px">Вы ещё у нас не занимались</h1><div class="muted" style="margin:8px 0 16px">Напишите менеджеру — он подберёт группу и оформит вас.</div><a class="mgr" href="'+u+'">Написать менеджеру</a></div>';
      } else if (data.status === 'ok') {
        const list = (data.students||[]).map(s =>
          '<div class="stud"><div><strong>'+esc(s.name)+'</strong>'+(s.audience?'<div class="muted">'+(s.audience==='kids'?'ребёнок':'взрослый')+'</div>':'')+'</div>'+(s.level!=null?'<div class="lv">'+s.level+'</div>':'')+'</div>'
        ).join('');
        const title = data.students.length>1 ? 'Кого записываем?' : 'С возвращением!';
        root.innerHTML = '<div class="card"><h1 style="font-size:18px">'+title+'</h1>'+list+'<div class="muted" style="margin-top:12px">Скоро здесь появится выбор занятий и запись.</div></div>';
      } else {
        root.innerHTML = '<div class="card">Неизвестный ответ сервера.</div>';
      }
    }

    identify().catch(e => { errEl.textContent = 'Ошибка сети'; });
  </script>
</body>
</html>
```

- [x] **Шаг 3: Проверить, что страница отдаётся и HTML валиден**

Run:
```bash
cd /root/savvateam && node server.js & SRV=$!; sleep 1.2
echo -n "/app http -> "; curl -s localhost:3000/app -o /tmp/app.html -w '%{http_code}\n'
grep -c 'telegram-web-app.js\|/api/app/identify\|requestContact' /tmp/app.html
node -e "const h=require('fs').readFileSync('/tmp/app.html','utf8');const o=(h.match(/<script/g)||[]).length,c=(h.match(/<\/script>/g)||[]).length;console.log('script tags balanced:', o===c)"
kill $SRV 2>/dev/null
```
Expected: `/app http -> 200`; grep `3` (все три маркера присутствуют); `script tags balanced: true`.

- [x] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add public/app.html server.js && git commit -m "feat(2a): Mini App page (public/app.html) served at /app"
```

---

## Task 6: Деплой + прод-env + `setWebhook`

**Files:** нет изменений кода — выкладка и конфигурация прода.

- [x] **Шаг 1: Спросить у пользователя username менеджера**

`MANAGER_USERNAME` — реальный Telegram-username менеджера (без `@`), куда ведёт фолбэк незнакомца. Уточнить у пользователя перед записью в `.env`.

- [x] **Шаг 2: Дополнить прод `.env` новыми переменными**

Сгенерировать секрет и дописать в `/root/savvateam-site/.env` (не затирая существующее):
```bash
export SSHPASS='oDR%r1C%rZjm'
SECRET=$(openssl rand -hex 24)
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && { grep -q '^PUBLIC_URL=' .env || echo 'PUBLIC_URL=https://savva.n2node.store' >> .env; grep -q '^WEBHOOK_SECRET=' .env || echo 'WEBHOOK_SECRET=$SECRET' >> .env; grep -q '^MANAGER_USERNAME=' .env || echo 'MANAGER_USERNAME=<USERNAME_МЕНЕДЖЕРА>' >> .env; } && echo '--- .env keys ---' && cut -d= -f1 .env"
```
(Заменить `<USERNAME_МЕНЕДЖЕРА>` на реальное значение из Шага 1.)

- [x] **Шаг 3: Выложить сервер и Mini App**
```bash
cd /root/savvateam && export SSHPASS='oDR%r1C%rZjm'
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js root@45.139.29.201:/root/savvateam-site/
sshpass -e rsync -az -e "ssh -o StrictHostKeyChecking=no" public/app.html root@45.139.29.201:/root/savvateam-site/public/
echo "rsync done"
```

- [x] **Шаг 4: Перезапустить и проверить, что webhook установился**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam >/dev/null 2>&1 && sleep 2 && pm2 logs savvateam --lines 20 --nostream | grep -i webhook; echo '--- getWebhookInfo ---'; TOKEN=\$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-); curl -s \"https://api.telegram.org/bot\$TOKEN/getWebhookInfo\" | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('url:',j.result.url,'| pending:',j.result.pending_update_count)})\""
```
Expected: лог «Telegram webhook: установлен → …»; `getWebhookInfo` url = `https://savva.n2node.store/api/tg/webhook/<secret>`.

- [x] **Шаг 5: Прод smoke-тест `/app` и identify**
```bash
export SSHPASS='oDR%r1C%rZjm'
sshpass -e ssh -o StrictHostKeyChecking=no root@45.139.29.201 "curl -s localhost:3002/app -o /dev/null -w '/app %{http_code}\n'; curl -s -X POST localhost:3002/api/app/identify -H 'Content-Type: application/json' -d '{}' -w ' identify(no-initData) %{http_code} (expect 401)\n' -o /dev/null"
echo "public /app:"; curl -s https://savva.n2node.store/app -o /dev/null -w '%{http_code}\n'
```
Expected: `/app 200`; `identify(no-initData) 401`; публичный `/app` 200.

- [x] **Шаг 6: Живая проверка в Telegram (ручная, пользователем)**

Открыть `@SavvaPadel_bot` → `/start` → «Поделиться телефоном». Известный подтверждённый ученик → Mini App приветствует; неизвестный → ссылка на менеджера. С аккаунта, чей id вписан в `coaches.telegram_chat_id` → `/start` даёт тренерский блок.

- [x] **Шаг 7: Push в репозиторий**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** config/`tgApi`/`tg_sessions` → Task 1; webhook-роут + `setWebhook` → Task 2; обработка `/start`(тренер vs клиент) + `message.contact` → Task 3; `identify` + валидация initData + матч confirmed + `ok/unmatched/need_phone` → Task 4; Mini App `public/app.html` на `/app` (SDK, requestContact, экраны, ссылка на менеджера) → Task 5; прод-env + `setWebhook` + деплой → Task 6. Все пункты спеки покрыты.
- **Плейсхолдеров нет** — весь код приведён целиком; единственный намеренный плейсхолдер `<USERNAME_МЕНЕДЖЕРА>` в Task 6 сопровождён явным шагом уточнения у пользователя.
- **Согласованность имён:** statements (`upsertTgSession`, `getTgSession`, `isCoachChat`, `listConfirmedByPhone`) и хелперы (`tgApi`, `coachNameBySlot`, `validateInitData`, `handleTgUpdate`, `initWebhook`) определены в Task 1–4 и используются согласованно. Роуты `/api/tg/webhook/:secret`, `/api/app/identify`, `/app` совпадают между сервером и Mini App. Env `PUBLIC_URL/WEBHOOK_SECRET/MANAGER_USERNAME/DEV_ALLOW_UNSIGNED` вводятся в Task 1, используются в Task 2/3/4 и настраиваются в Task 6.
- **initData:** формула HMAC (`secret_key=HMAC("WebAppData",token)`, `hash=HMAC(secret_key,data_check_string)`) идентична в Task 4 и в тесте Шага 2 (round-trip самоподписью) — согласованы, что подтверждает корректность.
- **Матч:** только `confirmed=1` (`listConfirmedByPhone`) — соответствует спеке (незнакомец и неподтверждённая заготовка → `unmatched`).
- **Границы:** брони/списка занятий нет (Mini App показывает плейсхолдер «Скоро: выбор занятий») — соответствует scope 2A.