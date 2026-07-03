# Интерактивное расписание (Фаза 0) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить захардкоженное расписание на лендинге интерактивной сеткой из `content.schedule_data` с расширенной моделью ячейки (поля допуска) и админ-редактором.

**Architecture:** Один JSON-ключ `content.schedule_data` — источник данных. Лендинг читает через `GET /api/content`, строит сетку в JS (десктоп-грид + мобильный список, сгруппированный по дням). Админка редактирует и публикует через существующий `POST /api/content`. Новых эндпоинтов и таблиц БД нет.

**Tech Stack:** Express + better-sqlite3 (сервер), ванильный HTML/CSS/JS (лендинг `public/index.html`, админка `public/admin.html`), ES-модули. Тест-фреймворка в проекте нет — проверка ручная (curl / браузер / DevTools).

## Global Constraints

- Единый источник данных — ключ `content.schedule_data`, значение = JSON-строка. Дублирования нет.
- `POST /api/content` уже принимает произвольные пары ключ→значение (`upsertContent`) — серверный код для сохранения НЕ трогаем, только `CONTENT_DEFAULTS`.
- Модель ячейки: `{id, title, meta, cat, level_min, level_max, audience, gender, coach_id, capacity}` либо `null`.
- `cat` ∈ `women | men | kids | mixed | extreme` — только цвет. `audience` ∈ `adult | kids`. `gender` ∈ `m | f | mixed`. `coach_id` ∈ `'' | coach1 | coach2 | coach3`.
- Дефолты новой заполненной ячейки: `cat:'mixed'`, `level_min:1`, `level_max:7`, `audience:'adult'`, `gender:'mixed'`, `coach_id:''`, `capacity:8`.
- Поля допуска на витрине НЕ рендерятся (только `title`+`meta`+цвет по `cat`).
- `days` — конфигурируемый массив, сид = 5 будних (`['ПН','ВТ','СР','ЧТ','ПТ']`); у каждой строки `cells.length === days.length`.
- Стабильный `id` ячейки генерится в браузере (админка) при первом заполнении, при правках не меняется.
- CSS-переменные лендинга: `--bg2`, `--surface`, `--border`, `--text`, `--muted`, `--accent`. Тёплый акцент вводится локально: `--sch-warm: #FFB347`.
- Деплой: rsync статики + `server.js` на `root@45.139.29.201:/root/savvateam-site/`, `pm2 restart savvateam` (нужен из-за `server.js`). Секрет админки — `?secret=`.

---

## Структура файлов

- `server.js` — добавить ключ `schedule_data` в `CONTENT_DEFAULTS` (одно место). Ответственность: сид дефолтного расписания.
- `public/index.html`:
  - CSS-блок расписания (строки 777–827) — заменить на `.sch-*` стили (+ мобильные правила).
  - Старые мобильные правила расписания (строка 1507 и блок 1616–1625) — удалить.
  - HTML-секция сетки (строки 1915–1965) — заменить на контейнеры `#schedule-grid`, `#schedule-mobile`, `#schedule-legend`.
  - JS — добавить `renderSchedule(c)` (после IIFE на строке 2541) и вызвать её внутри IIFE (перед `loadVideos(c)` на строке 2539).
- `public/admin.html`:
  - Сайдбар (после строки 226) — пункт меню.
  - `navigate()` map (строка 448) — регистрация `schedule:renderSchedule`.
  - `SEED` (строка 272) — дефолт `schedule`; `loadStore` (строка ~348) — нормализация; `fetchLeadsAndStats` (строки 385–399) — мерж из `/api/content`.
  - Блок функций расписания — перед `/* ===== TESTIMONIALS ===== */` (строка 817).

---

## Task 1: Сервер — дефолт `schedule_data`

**Files:**
- Modify: `server.js` (объект `CONTENT_DEFAULTS`, после `coach3_video: '',` — строка 145)

**Interfaces:**
- Produces: ключ `schedule_data` (JSON-строка формы `{days:[5], rows:[{time, cells:[5 × (cell|null)]}]}`) в ответе `GET /api/content`.

- [x] **Шаг 1: Добавить ключ `schedule_data` в `CONTENT_DEFAULTS`**

В `server.js` сразу после строки `  coach3_video:      '',` (строка 145) вставить:

```js
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
```

- [x] **Шаг 2: Проверить, что сервер стартует и отдаёт корректный ключ**

Run (локально, порт 3000):
```bash
cd /root/savvateam && (node server.js & SRV=$!; sleep 1; \
curl -s localhost:3000/api/content | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const s=JSON.parse(j.schedule_data);const flat=s.rows.flatMap(r=>r.cells).filter(Boolean);console.log('days:',s.days.length,'rows:',s.rows.length,'row0 cells:',s.rows[0].cells.length,'cells with id:',flat.length,'all have coach/level:',flat.every(c=>'coach_id' in c && 'level_min' in c))})"; \
kill $SRV)
```
Expected: `days: 5 rows: 7 row0 cells: 5 cells with id: 25 all have coach/level: true`

- [x] **Шаг 3: Commit**
```bash
cd /root/savvateam && git add server.js && git commit -m "feat(schedule): seed schedule_data default with extended cell model"
```

---

## Task 2: Лендинг — CSS расписания

**Files:**
- Modify: `public/index.html` — CSS-блок строки 777–827 (`#schedule { … }` … `.slot-level { … }`); удалить старые мобильные правила на строке 1507 и в блоке 1616–1625.

**Interfaces:**
- Produces: классы `.sch-wrap`, `.sch-grid`, `.sch-head`, `.sch-time`, `.sch-cell`, `.sch-empty`, `.sch-card` (+ `.women/.men/.kids/.mixed/.extreme`), `.sch-card .t`, `.sch-card .m`, `.sch-legend`, `.sch-legend-item`, `.sch-dot` (+ `.warm`), `.sch-mobile`, `.sch-mday`.

- [x] **Шаг 1: Заменить блок стилей расписания**

Удалить строки 777–827 (от `    #schedule { background: var(--bg2); }` до строки `    .slot-level {` и её тела, заканчивая `      margin-top: 2px;\n    }`) и вставить:

```css
    #schedule { background: var(--bg2); }
    .sch-wrap {
      margin-top: 56px;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 28px;
      background: var(--surface);
      overflow-x: auto;
      --sch-warm: #FFB347;
    }
    .sch-grid {
      /* grid-template-columns задаётся из JS по числу дней */
      display: grid;
      gap: 14px;
    }
    .sch-head {
      padding: 18px 16px;
      border-radius: 18px;
      background: var(--bg2);
      font-weight: 800;
      font-size: 14px;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      text-align: center;
      border-bottom: 2px solid var(--accent);
    }
    .sch-time {
      min-height: 92px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      background: rgba(255,255,255,0.025);
      border-radius: 18px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.6px;
      white-space: nowrap;
      text-align: center;
    }
    .sch-cell { min-height: 92px; display: flex; align-items: stretch; }
    .sch-empty { opacity: 0; pointer-events: none; }
    .sch-card {
      width: 100%;
      padding: 18px 18px 16px;
      border-radius: 18px;
      background: linear-gradient(145deg, rgba(22,22,22,0.98), rgba(10,10,10,0.96));
      border: 1px solid var(--accent-dim);
      display: flex;
      flex-direction: column;
      justify-content: center;
      position: relative;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
    }
    .sch-card::before {
      content: "";
      position: absolute;
      left: 0; top: 16px; bottom: 16px;
      width: 3px; border-radius: 10px;
      background: var(--accent);
    }
    .sch-card:hover {
      transform: translateY(-4px);
      border-color: var(--accent);
      box-shadow: 0 18px 36px rgba(86,211,123,0.12);
    }
    .sch-card .t {
      font-size: 18px;
      line-height: 1.15;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: -0.2px;
      color: var(--text);
    }
    .sch-card .m {
      margin-top: 9px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1.4px;
      font-weight: 700;
    }
    .sch-card.men::before { background: var(--sch-warm); }
    .sch-card.kids::before { background: linear-gradient(180deg, var(--accent), var(--sch-warm)); }
    .sch-card.extreme {
      border-color: rgba(86,211,123,0.45);
      box-shadow: inset 0 0 22px rgba(86,211,123,0.08), 0 0 24px rgba(86,211,123,0.08);
    }
    .sch-card.extreme::after {
      content: "";
      position: absolute;
      right: -38px; top: -38px;
      width: 92px; height: 92px;
      border-radius: 50%;
      background: rgba(86,211,123,0.18);
      filter: blur(12px);
    }
    .sch-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin-top: 28px;
      color: var(--muted);
      font-size: 13px;
      letter-spacing: 1px;
      text-transform: uppercase;
      font-weight: 800;
    }
    .sch-legend-item { display: flex; align-items: center; gap: 9px; }
    .sch-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 14px rgba(86,211,123,0.6); }
    .sch-dot.warm { background: var(--sch-warm); box-shadow: 0 0 14px rgba(255,179,71,0.55); }
    /* мобильный список расписания (сгруппирован по дням) — скрыт на десктопе */
    .sch-mobile { display: none; }
    .sch-mday {
      margin: 26px 0 12px;
      color: var(--accent);
      font-weight: 900;
      letter-spacing: 2px;
      text-transform: uppercase;
      font-size: 13px;
    }
    .sch-mobile .sch-card { margin-bottom: 12px; }
    @media (max-width: 760px) {
      .sch-wrap { padding: 0; background: transparent; border: 0; overflow: visible; }
      .sch-grid { display: none; }
      .sch-mobile { display: block; }
      .sch-mobile .sch-mtime { color: var(--muted); font-size: 11px; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px; }
    }
```

- [x] **Шаг 2: Удалить старое мобильное правило на строке 1507**

Найти и удалить строку:
```css
      .schedule-grid { grid-template-columns: repeat(7, minmax(110px, 1fr)); overflow-x: auto; }
```

- [x] **Шаг 3: Удалить старый мобильный блок расписания (строки 1616–1625)**

Найти и удалить блок:
```css
      /* SCHEDULE — horizontal scroll */
      .schedule-grid {
        grid-template-columns: repeat(7, 130px);
        overflow-x: auto;
        margin-top: 40px;
        padding-bottom: 8px;
        -webkit-overflow-scrolling: touch;
      }
      .schedule-grid::-webkit-scrollbar { height: 4px; }
      .schedule-grid::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
```

- [x] **Шаг 4: Проверить, что старые классы расписания больше не встречаются в CSS**

Run:
```bash
cd /root/savvateam && grep -c "\.schedule-grid\|\.day-col\|\.day-slot\|\.slot-time\|\.slot-name\|\.slot-level\|\.day-header\|\.day-name" public/index.html
```
Expected: старые CSS-селекторы удалены. Ненулевой результат допустим ТОЛЬКО если это HTML-разметка (её убирает Task 3) — на этом шаге ожидаем совпадения только из ещё не тронутой разметки строк 1915–1965 (≈8 упоминаний в HTML). CSS-определений (`.day-col {`, `.slot-time {` и т.п.) быть не должно — проверить глазами в git diff, что удалён именно блок стилей.

- [x] **Шаг 5: Commit**
```bash
cd /root/savvateam && git add public/index.html && git commit -m "feat(schedule): new grid + mobile CSS on landing (reference-based)"
```

---

## Task 3: Лендинг — разметка секции

**Files:**
- Modify: `public/index.html` — блок `<div class="schedule-grid reveal reveal-delay-2">` … `</div>` (строки 1915–1965, семь `.day-col`).

**Interfaces:**
- Consumes: классы из Task 2.
- Produces: DOM-узлы `#schedule-grid`, `#schedule-mobile`, `#schedule-legend` для наполнения из JS (Task 4).

- [x] **Шаг 1: Заменить разметку сетки**

Заменить весь блок строк 1915–1965 (от `    <div class="schedule-grid reveal reveal-delay-2">` до соответствующего закрывающего `    </div>` на строке 1965 включительно — семь `.day-col`) на:

```html
    <div class="sch-wrap reveal reveal-delay-2">
      <div class="sch-grid" id="schedule-grid"></div>
      <div class="sch-mobile" id="schedule-mobile"></div>
      <div class="sch-legend" id="schedule-legend"></div>
    </div>
```

Строки `<div class="section-label" … data-content="schedule_label">` (1913) и `<h2 … data-content="schedule_title">` (1914) НЕ трогать.

- [x] **Шаг 2: Проверить, что старая разметка удалена**

Run:
```bash
cd /root/savvateam && grep -c 'class="schedule-grid"\|class="day-col"\|class="day-slot\|class="day-header"\|class="slot-time"' public/index.html
```
Expected: `0`

- [x] **Шаг 3: Проверить наличие новых контейнеров**

Run:
```bash
cd /root/savvateam && grep -c 'id="schedule-grid"\|id="schedule-mobile"\|id="schedule-legend"' public/index.html
```
Expected: `3`

- [x] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add public/index.html && git commit -m "feat(schedule): replace hardcoded grid markup with containers"
```

---

## Task 4: Лендинг — рендер расписания + клик→запись

**Files:**
- Modify: `public/index.html` — IIFE (строки 2480–2541): добавить вызов `renderSchedule(c)` перед `loadVideos(c)` (строка 2539); добавить функцию `renderSchedule` после `})();` (строка 2541).

**Interfaces:**
- Consumes: `c.schedule_data` (JSON-строка) из `/api/content`; контейнеры `#schedule-grid`, `#schedule-mobile`, `#schedule-legend`; `#contact`, `#contactComment`.
- Produces: глобальная функция `renderSchedule(c)`.

- [x] **Шаг 1: Добавить вызов рендера в IIFE**

В IIFE, на строке 2539 сразу перед `    loadVideos(c);`, вставить строку:
```js
    renderSchedule(c);
```

- [x] **Шаг 2: Добавить функцию `renderSchedule`**

Сразу после `})();` (строка 2541, закрытие IIFE), в том же `<script>`, добавить:

```js
function renderSchedule(c) {
  const grid = document.getElementById('schedule-grid');
  const mobile = document.getElementById('schedule-mobile');
  const legend = document.getElementById('schedule-legend');
  if (!grid) return;
  let data;
  try { data = JSON.parse(c.schedule_data); } catch (e) { return; }
  if (!data || !Array.isArray(data.days) || !Array.isArray(data.rows)) return;

  const days = data.days;
  const CAT_LABEL = { women:'Женские / Mixed', men:'Мужские / Power', kids:'Детские группы', mixed:'Смешанные', extreme:'Advanced glow' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  const usedCats = new Set();

  const cardHtml = (cell, dayName, time) => {
    const cat = cell.cat || 'mixed';
    usedCats.add(cat);
    const book = `Запись: ${cell.title} · ${dayName} ${time}`;
    return `<div class="sch-card ${esc(cat)}" role="button" tabindex="0" data-book="${esc(book)}">`
      + `<div class="t">${esc(cell.title)}</div>`
      + (cell.meta ? `<div class="m">${esc(cell.meta)}</div>` : '')
      + `</div>`;
  };

  // Десктоп-грид: колонка времени + N дней
  grid.style.gridTemplateColumns = `110px repeat(${days.length}, minmax(180px, 1fr))`;
  let html = '<div class="sch-head" style="background:transparent;border:0">Время</div>';
  days.forEach(d => { html += `<div class="sch-head">${esc(d)}</div>`; });
  data.rows.forEach(row => {
    html += `<div class="sch-time">${esc(row.time)}</div>`;
    for (let i = 0; i < days.length; i++) {
      const cell = (row.cells || [])[i];
      if (!cell || !cell.title) { html += '<div class="sch-cell sch-empty"></div>'; continue; }
      html += `<div class="sch-cell">${cardHtml(cell, days[i], row.time)}</div>`;
    }
  });
  grid.innerHTML = html;

  // Мобильный список: сгруппирован по дням
  if (mobile) {
    let mhtml = '';
    for (let i = 0; i < days.length; i++) {
      const dayCards = data.rows
        .map(row => ({ cell: (row.cells || [])[i], time: row.time }))
        .filter(x => x.cell && x.cell.title);
      if (!dayCards.length) continue;
      mhtml += `<div class="sch-mday">${esc(days[i])}</div>`;
      dayCards.forEach(x => {
        mhtml += `<div class="sch-mtime">${esc(x.time)}</div>` + cardHtml(x.cell, days[i], x.time);
      });
    }
    mobile.innerHTML = mhtml;
  }

  // Легенда — авто из встречающихся cat
  if (legend) {
    const order = ['women','mixed','men','kids','extreme'];
    legend.innerHTML = order.filter(k => usedCats.has(k)).map(k => {
      const dotCls = k === 'men' ? 'warm' : '';
      return `<div class="sch-legend-item"><span class="sch-dot ${dotCls}"></span>${CAT_LABEL[k]}</div>`;
    }).join('');
  }

  // Клик по карточке → форма записи с предзаполнением
  const goBook = (text) => {
    const field = document.getElementById('contactComment');
    if (field) field.value = text;
    const contact = document.getElementById('contact');
    if (contact) contact.scrollIntoView({ behavior: 'smooth' });
    if (field) setTimeout(() => field.focus({ preventScroll: true }), 600);
  };
  document.querySelectorAll('.sch-card').forEach(card => {
    card.addEventListener('click', () => goBook(card.dataset.book));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goBook(card.dataset.book); } });
  });
}
```

- [x] **Шаг 3: Запустить локально и проверить в браузере (десктоп)**

Run: `cd /root/savvateam && node server.js`, открыть `http://localhost:3000/#schedule`.
Expected: сетка «Время + 5 дней (ПН–ПТ)» отрисована; карточки с цветными полосками (женские зелёные, мужские тёплые, extreme со свечением); легенда снизу. Клик по карточке → скролл к форме, в поле «комментарий» текст вида `Запись: Девушки 1,5–2 · ПН 9:30–11:00`. Полей допуска (уровень/пол/тренер/вместимость) на карточке НЕТ.

- [x] **Шаг 4: Проверить мобильную раскладку**

В DevTools включить мобильный вьюпорт (≤760px), обновить `#schedule`.
Expected: сетка-грид скрыта, показан вертикальный список с заголовками дней (`ПН`, `ВТ`, …) и карточками под каждым днём; пустых ячеек нет.

- [x] **Шаг 5: Проверить fallback при битом JSON**

В DevTools Console: `renderSchedule({schedule_data:'{bad'})` — без исключений (функция тихо выходит).
Expected: ошибок в консоли нет. Остановить сервер (`Ctrl+C`).

- [x] **Шаг 6: Commit**
```bash
cd /root/savvateam && git add public/index.html && git commit -m "feat(schedule): render grid + mobile list from schedule_data + click-to-book"
```

---

## Task 5: Админка — меню, роутинг, стейт, мерж контента

**Files:**
- Modify: `public/admin.html` — сайдбар (после строки 226), `navigate()` map (строка 448), `SEED` (строка 272), `loadStore` (строка ~348), `fetchLeadsAndStats` (строки 385–399).

**Interfaces:**
- Consumes: `state`, `/api/content`.
- Produces: `state.schedule` (объект `{days:[…], rows:[…]}`); зарегистрированная страница `schedule` в роутере (обработчик `renderSchedule` реализуется в Task 6).

- [x] **Шаг 1: Пункт меню в сайдбаре**

После строки 226 (`    <button class="nav-item" data-page="programs"><span class="icon">◈</span>Программы</button>`) вставить:
```html
    <button class="nav-item" data-page="schedule"><span class="icon">▤</span>Расписание</button>
```

- [x] **Шаг 2: Дефолт `schedule` в `SEED`**

В объекте `SEED` (начинается на строке 272), сразу после закрывающей `],` массива `coaches` (перед `  texts:{`) вставить:
```js
  schedule:{days:['ПН','ВТ','СР','ЧТ','ПТ'],rows:[]},
```

- [x] **Шаг 3: Нормализация `schedule` в `loadStore`**

В функции `loadStore` найти строку:
```js
  ['texts','media'].forEach(k=>{if(!s[k]||typeof s[k]!=='object')s[k]=JSON.parse(JSON.stringify(SEED[k]||{}))});
```
и заменить массив на `['texts','media','schedule']`:
```js
  ['texts','media','schedule'].forEach(k=>{if(!s[k]||typeof s[k]!=='object')s[k]=JSON.parse(JSON.stringify(SEED[k]||{}))});
```

- [x] **Шаг 4: Мерж `schedule_data` с сервера в `fetchLeadsAndStats`**

В `fetchLeadsAndStats`, внутри `if(contentRes.ok){ … }`, сразу перед `    saveStore();` (строка 399) вставить:
```js
    if(c.schedule_data){ try{ const s=JSON.parse(c.schedule_data); if(s&&Array.isArray(s.days)&&Array.isArray(s.rows)) state.schedule=s; }catch(e){} }
```

- [x] **Шаг 5: Зарегистрировать страницу в `navigate()`**

На строке 448 в объекте-роутере `({dashboard:renderDashboard, … ,coaches:renderCoaches}[page]||renderDashboard)(c);` добавить `schedule:renderSchedule,` (например, сразу после `prices:renderPrices,`):
```js
  ({dashboard:renderDashboard,inbox:renderInbox,students:renderStudents,texts:renderTexts,media:renderMedia,programs:renderPrograms,prices:renderPrices,schedule:renderSchedule,testimonials:renderTestimonials,coaches:renderCoaches}[page]||renderDashboard)(c);
```

- [x] **Шаг 6: Проверить синтаксис JS админки**

> Примечание: `renderSchedule` пока не определён (появится в Task 6) — при клике на пункт меню будет ReferenceError. Это ожидаемо до Task 6; на этом шаге проверяем только парсинг файла и отсутствие битых скобок в самом `<script>`. Извлекаем и синтаксически валидируем инлайновый скрипт:

Run:
```bash
cd /root/savvateam && node -e "const h=require('fs').readFileSync('public/admin.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');try{new Function(m);console.log('admin script parses OK')}catch(e){console.log('PARSE ERROR:',e.message)}"
```
Expected: `admin script parses OK` (одиночное упоминание `renderSchedule` как идентификатора не мешает парсингу).

- [x] **Шаг 7: Commit**
```bash
cd /root/savvateam && git add public/admin.html && git commit -m "feat(schedule): admin menu, route, state default and content merge"
```

---

## Task 6: Админка — редактор расписания

**Files:**
- Modify: `public/admin.html` — блок функций перед `/* ============= TESTIMONIALS ============= */` (строка 817).

**Interfaces:**
- Consumes: `state.schedule` (Task 5), `state.coaches` (имена тренеров), `adminSecret`, `toast()`, `escapeHtml()`, `escapeAttr()`, `saveStore()`, `/api/content`.
- Produces: `renderSchedule(c)`, `collectSchedule()`, `addSchRow()`, `delSchRow(i)`, `addSchDay()`, `delSchDay()`, `toggleSchCell(ri,ci)`, `genSchId()`, `saveSchedule()`.

- [x] **Шаг 1: Добавить функции редактора**

Непосредственно перед строкой 817 (`/* ============= TESTIMONIALS ============= */`) вставить:

```js
/* ============= SCHEDULE ============= */
const SCH_CATS=[['','— пусто —'],['women','Женские'],['men','Мужские'],['kids','Детские'],['mixed','Смешанные'],['extreme','Экстрим']];
const SCH_AUD=[['adult','Взрослые'],['kids','Дети']];
const SCH_GEN=[['mixed','Смешанная'],['m','Мужская'],['f','Женская']];
let schOpenCell=null; // "ri:ci" ячейки с раскрытым блоком допуска
function genSchId(){return 'g_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
function schCoachOptions(sel){
  const opts=[['','—']].concat((state.coaches||[]).map(co=>['coach'+co.id, co.name]));
  return opts.map(o=>`<option value="${escapeAttr(o[0])}" ${o[0]===(sel||'')?'selected':''}>${escapeHtml(o[1])}</option>`).join('');
}
function renderSchedule(c){
  const sch=state.schedule||(state.schedule={days:['ПН','ВТ','СР','ЧТ','ПТ'],rows:[]});
  if(!Array.isArray(sch.days)) sch.days=['ПН','ВТ','СР','ЧТ','ПТ'];
  if(!Array.isArray(sch.rows)) sch.rows=[];
  const days=sch.days;
  c.innerHTML=`<div class="page-head"><div><div class="page-title">РАСПИСАНИЕ</div><div class="page-sub">${sch.rows.length} строк · ${days.length} дней · клик по карточке на сайте ведёт к форме записи</div></div>
    <div class="page-actions"><button class="btn" onclick="addSchDay()">+ День</button><button class="btn" onclick="delSchDay()">− День</button><button class="btn" onclick="addSchRow()">+ Строка</button><button class="btn btn-primary" onclick="saveSchedule()">Сохранить и опубликовать</button></div></div>
    <div style="overflow-x:auto"><table style="border-collapse:separate;border-spacing:8px;min-width:${140+days.length*180}px">
    <thead><tr><th style="width:90px">Время</th>${days.map((d,di)=>`<th><input data-schday="${di}" value="${escapeAttr(d)}" style="width:150px;text-align:center"/></th>`).join('')}<th></th></tr></thead>
    <tbody>${sch.rows.map((row,ri)=>`<tr>
      <td style="vertical-align:top"><input data-sch="${ri}" data-f="time" value="${escapeAttr(row.time||'')}" style="width:84px"/></td>
      ${days.map((_,ci)=>{const cell=(row.cells&&row.cells[ci])||{};const open=schOpenCell===ri+':'+ci;return `<td style="vertical-align:top">
        <input data-sch="${ri}" data-c="${ci}" data-f="title" placeholder="Название" value="${escapeAttr(cell.title||'')}" style="width:170px;margin-bottom:4px"/>
        <input data-sch="${ri}" data-c="${ci}" data-f="meta" placeholder="Meta" value="${escapeAttr(cell.meta||'')}" style="width:170px;margin-bottom:4px"/>
        <div style="display:flex;gap:4px;margin-bottom:4px">
          <select data-sch="${ri}" data-c="${ci}" data-f="cat" style="width:120px">${SCH_CATS.map(o=>`<option value="${o[0]}" ${((cell.cat||'')===o[0])?'selected':''}>${o[1]}</option>`).join('')}</select>
          <button class="btn" style="padding:4px 8px" onclick="toggleSchCell(${ri},${ci})">Допуск ${open?'▲':'▾'}</button>
        </div>
        <div style="${open?'':'display:none'};background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;width:170px">
          <div style="display:flex;gap:4px;margin-bottom:4px"><input data-sch="${ri}" data-c="${ci}" data-f="level_min" type="number" step="0.5" min="1" max="7" placeholder="ур. от" value="${cell.level_min!=null?cell.level_min:''}" style="width:78px"/><input data-sch="${ri}" data-c="${ci}" data-f="level_max" type="number" step="0.5" min="1" max="7" placeholder="ур. до" value="${cell.level_max!=null?cell.level_max:''}" style="width:78px"/></div>
          <select data-sch="${ri}" data-c="${ci}" data-f="audience" style="width:100%;margin-bottom:4px">${SCH_AUD.map(o=>`<option value="${o[0]}" ${((cell.audience||'adult')===o[0])?'selected':''}>${o[1]}</option>`).join('')}</select>
          <select data-sch="${ri}" data-c="${ci}" data-f="gender" style="width:100%;margin-bottom:4px">${SCH_GEN.map(o=>`<option value="${o[0]}" ${((cell.gender||'mixed')===o[0])?'selected':''}>${o[1]}</option>`).join('')}</select>
          <select data-sch="${ri}" data-c="${ci}" data-f="coach_id" style="width:100%;margin-bottom:4px">${schCoachOptions(cell.coach_id)}</select>
          <input data-sch="${ri}" data-c="${ci}" data-f="capacity" type="number" min="1" placeholder="мест" value="${cell.capacity!=null?cell.capacity:''}" style="width:100%"/>
        </div>
      </td>`;}).join('')}
      <td style="vertical-align:top"><button class="btn btn-danger" onclick="delSchRow(${ri})">✕</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}
function collectSchedule(){
  const sch=state.schedule;
  const g=(ri,ci,f)=>{const el=document.querySelector(`[data-sch="${ri}"][data-c="${ci}"][data-f="${f}"]`);return el?el.value.trim():''};
  // дни
  sch.days=sch.days.map((d,di)=>{const el=document.querySelector(`[data-schday="${di}"]`);return el?el.value.trim()||d:d});
  sch.rows.forEach((row,ri)=>{
    const t=document.querySelector(`[data-sch="${ri}"][data-f="time"]`); if(t)row.time=t.value.trim();
    row.cells=sch.days.map((_,ci)=>{
      const title=g(ri,ci,'title'); if(!title)return null;
      const prev=(row.cells&&row.cells[ci])||{};
      const lmin=parseFloat(g(ri,ci,'level_min')); const lmax=parseFloat(g(ri,ci,'level_max')); const cap=parseInt(g(ri,ci,'capacity'),10);
      return {
        id: prev.id||genSchId(),
        title, meta:g(ri,ci,'meta'),
        cat:g(ri,ci,'cat')||'mixed',
        level_min: isNaN(lmin)?1:lmin,
        level_max: isNaN(lmax)?7:lmax,
        audience:g(ri,ci,'audience')||'adult',
        gender:g(ri,ci,'gender')||'mixed',
        coach_id:g(ri,ci,'coach_id')||'',
        capacity: isNaN(cap)?8:cap,
      };
    });
  });
}
function toggleSchCell(ri,ci){collectSchedule();const key=ri+':'+ci;schOpenCell=(schOpenCell===key)?null:key;renderSchedule(document.getElementById('pageContent'))}
function addSchRow(){collectSchedule();state.schedule.rows.push({time:'00:00–00:00',cells:state.schedule.days.map(()=>null)});renderSchedule(document.getElementById('pageContent'))}
function delSchRow(i){collectSchedule();if(!confirm('Удалить строку?'))return;state.schedule.rows.splice(i,1);renderSchedule(document.getElementById('pageContent'))}
function addSchDay(){collectSchedule();state.schedule.days.push('ДЕНЬ');state.schedule.rows.forEach(r=>{(r.cells=r.cells||[]).push(null)});renderSchedule(document.getElementById('pageContent'))}
function delSchDay(){collectSchedule();if(state.schedule.days.length<=1)return;if(!confirm('Удалить последний день?'))return;state.schedule.days.pop();state.schedule.rows.forEach(r=>{if(r.cells)r.cells.pop()});renderSchedule(document.getElementById('pageContent'))}
async function saveSchedule(){
  collectSchedule();
  const res=await fetch('/api/content?secret='+encodeURIComponent(adminSecret),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schedule_data:JSON.stringify(state.schedule)})});
  if(res.ok){saveStore();toast('Расписание опубликовано')}else{toast('Ошибка сохранения')}
}
```

- [x] **Шаг 2: Проверить, что скрипт админки парсится и `renderSchedule` определён**

Run:
```bash
cd /root/savvateam && node -e "const h=require('fs').readFileSync('public/admin.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n;\n');try{new Function(m+'\n;if(typeof renderSchedule!==\"function\")throw new Error(\"renderSchedule missing\");if(typeof saveSchedule!==\"function\")throw new Error(\"saveSchedule missing\")');console.log('admin editor OK')}catch(e){console.log('ERROR:',e.message)}"
```
Expected: `admin editor OK`

- [x] **Шаг 3: Проверить сохранение end-to-end (локально)**

Run: `cd /root/savvateam && node server.js`. Открыть `http://localhost:3000/admin`, войти (значение `ADMIN_SECRET`, по умолчанию см. `server.js`/`.env`), меню «Расписание» → раскрыть «Допуск ▾» у ячейки → изменить название/уровень/тренера → «Сохранить и опубликовать» (toast «Расписание опубликовано»). Затем:
```bash
cd /root/savvateam && curl -s localhost:3000/api/content | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const s=JSON.parse(j.schedule_data);const flat=s.rows.flatMap(r=>r.cells).filter(Boolean);console.log('rows:',s.rows.length,'cells:',flat.length,'all keep id:',flat.every(x=>/^g_/.test(x.id)))})"
```
Expected: изменения сохранены; `all keep id: true` (стабильные id не потеряны). Открыть `http://localhost:3000/#schedule` → изменения видны на витрине. Остановить сервер.

- [x] **Шаг 4: Commit**
```bash
cd /root/savvateam && git add public/admin.html && git commit -m "feat(schedule): admin editor with collapsible admission block and publish"
```

---

## Task 7: Деплой и финальная проверка

**Files:** нет изменений кода — только выкладка.

- [x] **Шаг 1: Выложить статику и сервер на прод**
```bash
cd /root/savvateam && SSHPASS='oDR%r1C%rZjm' sshpass -p "$SSHPASS" rsync -az -e "ssh -o StrictHostKeyChecking=no" server.js public/index.html public/admin.html root@45.139.29.201:/root/savvateam-site/
```

- [x] **Шаг 2: Перезапустить сервер и убедиться, что ключ засеян**
```bash
SSHPASS='oDR%r1C%rZjm' sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no root@45.139.29.201 "cd /root/savvateam-site && pm2 restart savvateam && sleep 1 && curl -s localhost:3002/api/content | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('schedule_data rows:',JSON.parse(j.schedule_data).rows.length)})\""
```
Expected: `schedule_data rows: 7` (либо число строк после ваших правок, если контент уже редактировался в БД прода).

- [x] **Шаг 3: Проверить прод в браузере**

Открыть `https://savva.n2node.store/#schedule` — сетка на 5 дней, клик по карточке ведёт к форме с предзаполнением; мобильный вид — список по дням. Открыть `https://savva.n2node.store/admin` → «Расписание» → правка сохраняется и видна на витрине.

- [x] **Шаг 4: Push в репозиторий**
```bash
cd /root/savvateam && git push origin main
```

---

## Self-review (проверка плана против спеки)

- **Покрытие спеки:** модель данных `schedule_data` → Task 1; витрина CSS (референс + мобилка) → Task 2; разметка-контейнеры → Task 3; рендер (десктоп-грид + мобильный список по дням + легенда + клик→запись, скрытые поля допуска) → Task 4; админ-меню/роут/стейт/мерж → Task 5; редактор с компактной ячейкой + сворачиваемый блок допуска + стабильный `id` (`genSchId`, сохранение `prev.id`) + конфигурируемые дни (`addSchDay/delSchDay`) → Task 6; деплой → Task 7. `coach_id` = слот `coach{id}` через `schCoachOptions` (Task 6). Все пункты спеки покрыты.
- **Плейсхолдеров нет** — весь код приведён целиком.
- **Согласованность имён:** ключ `schedule_data`; контейнеры `#schedule-grid`/`#schedule-mobile`/`#schedule-legend` (index) ↔ создаются в Task 3, потребляются в Task 4; `state.schedule` + `renderSchedule/collectSchedule/addSchRow/delSchRow/addSchDay/delSchDay/toggleSchCell/genSchId/saveSchedule` — согласованы между Task 5 и Task 6. `renderSchedule` существует и в index.html, и в admin.html — разные файлы, конфликта нет. Атрибуты `data-sch`/`data-c`/`data-f`/`data-schday` совпадают между `renderSchedule` (рендер) и `collectSchedule` (сбор) в админке.
- **Модель ячейки** одинакова в сиде (Task 1) и в сборщике админки (Task 6): `id,title,meta,cat,level_min,level_max,audience,gender,coach_id,capacity`.
