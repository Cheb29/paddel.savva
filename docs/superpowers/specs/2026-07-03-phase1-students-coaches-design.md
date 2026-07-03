# Фаза 1 — реальные `students` + `coaches` — дизайн

> Реализация Фазы 1 из `TELEGRAM_BOOKING_SPEC.md`: серверная таблица учеников с CRUD (конец localStorage-мока) + тонкая таблица тренеров с `telegram_chat_id`. Документ фиксирует **решения**; пошаговый план — отдельным файлом (writing-plans).

## Цель

Заменить демо-мок учеников (localStorage в `admin.html`) на реальную серверную таблицу `students` (SQLite) с полной CRUD-админкой. Завести тонкую таблицу `coaches` над слотами `coach1/2/3` для хранения `telegram_chat_id`. Каждый входящий лид с формы контактов автоматически создаёт заготовку ученика.

## Архитектура

- Расширяем `server.js`: две новые таблицы (`students`, `coaches`), prepared statements, REST-эндпоинты под `requireSecret`. Внутри существующего публичного `POST /api/contact` — хук авто-создания ученика.
- Переписываем раздел «Ученики» в `public/admin.html` с localStorage-мока на серверный API. В редактор тренеров добавляем поле `telegram_chat_id`.
- Лендинг (`public/index.html`) **не трогаем**.
- Стек: Express + better-sqlite3, ES-модули. Паттерн — prepared statements + `requireSecret` (как у `leads`/`content`). Тест-фреймворка нет — проверка ручная (curl / браузер / DevTools).

## Решения (из брейншторма)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Легаси CRM-поля (`plan`/`visits`/`status`, буквенный уровень) | **Выброшены.** Чистая спека-модель. Роль «активен» несёт `confirmed` |
| 2 | Форма API students | **Классический REST** (`GET/POST /api/students`, `PATCH/DELETE /api/students/:id`) |
| 3 | Схема `coaches` | **Тонкая таблица над слотами** `coach1/2/3`; имя из `content.coachN_name`, не дублируем |
| 4 | Стартовые данные / мок | **Пустой старт**, сервер — единственный источник, localStorage-мок учеников удаляется |
| 5 | Лид → ученик | **Каждый лид авто-создаёт заготовку ученика** (`confirmed:0`, `source:'lead'`); `level/audience/gender` nullable |
| 5b | Дубли лидов | **Дедуп по телефону среди неподтверждённых**: если есть неподтверждённый ученик с этим `phone`, нового не создаём (лид всё равно в инбоксе) |

## Модель данных

### Таблица `students`
```sql
CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,            -- НЕ уникальный (родитель → несколько детей)
  level      REAL,                     -- 1.0–7.0, NULL пока не заполнено
  audience   TEXT,                     -- 'adult' | 'kids' | NULL
  gender     TEXT,                     -- 'm' | 'f' | NULL
  confirmed  INTEGER NOT NULL DEFAULT 0,   -- 0/1, подтверждён тренером = доступ к записи
  source     TEXT NOT NULL DEFAULT 'manual', -- 'lead' | 'manual'
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```
`level/audience/gender` nullable, потому что заготовка из лида их не содержит — тренер дозаполняет при подтверждении.

### Таблица `coaches`
```sql
CREATE TABLE IF NOT EXISTS coaches (
  slot             TEXT PRIMARY KEY,   -- 'coach1' | 'coach2' | 'coach3'
  telegram_chat_id TEXT,               -- NULL = не привязан
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```
Засев при старте: `INSERT OR IGNORE` строк `coach1`, `coach2`, `coach3`. Имя/фото/био остаются в `content` (ключи `coachN_*`) — единственный источник. Слот совпадает с `schedule_data.cells[].coach_id` (Фаза 0) → Фаза 2 джойнит `cell.coach_id → coaches.slot → telegram_chat_id`.

## Авто-создание ученика из лида

В обработчике `POST /api/contact`, после успешной вставки лида:
1. Дедуп: `SELECT id FROM students WHERE phone = ? AND confirmed = 0 LIMIT 1`.
2. Если ничего не найдено → `INSERT INTO students (name, phone, confirmed, source) VALUES (?, ?, 0, 'lead')` (`level/audience/gender` = NULL по умолчанию).
3. Лид всегда пишется в `leads` независимо от результата дедупа. Ошибка вставки ученика не должна ломать ответ формы (обернуть в try/catch, как телеграм-отправка).

## API

Все под `requireSecret`, кроме хука внутри публичного `POST /api/contact`.

| Метод | Путь | Тело | Ответ |
|-------|------|------|-------|
| GET | `/api/students` | — | `[{id,name,phone,level,audience,gender,confirmed,source,created_at}]` (id DESC, LIMIT 2000) |
| POST | `/api/students` | `{name, phone, level?, audience?, gender?, confirmed?}` | `{id}` созданного (`source:'manual'`) |
| PATCH | `/api/students/:id` | любое подмножество полей | `{ok:true}` |
| DELETE | `/api/students/:id` | — | `{ok:true}` |
| GET | `/api/coaches` | — | `[{slot, name, telegram_chat_id}]` (name из content) |
| PATCH | `/api/coaches/:slot` | `{telegram_chat_id}` (строка или пусто/null) | `{ok:true}` |

### Валидация (сервер, 400 при нарушении)
- `name` непустой, `phone` непустой (для POST).
- `level`: число в `[1, 7]` если задано (иначе 400); допускается `null` для очистки.
- `audience` ∈ `{adult, kids}` или `null`.
- `gender` ∈ `{m, f}` или `null`.
- `confirmed` ∈ `{0, 1}` (принимаем также `true/false`).
- `PATCH /api/students/:id`: обновляем только переданные ключи (частичный апдейт), неизвестные ключи игнорируем.
- `PATCH /api/coaches/:slot`: `slot` должен быть одним из существующих (иначе 404); пустая строка `telegram_chat_id` → `NULL`.

## Админка (`public/admin.html`)

### Раздел «Ученики» (переписан на сервер)
- Загрузка: `GET /api/students` при входе в раздел (и обновление после мутаций). Данные держим в `state.students`, но источник — сервер (не localStorage; ключ ученика убираем из SEED/`loadStore`).
- Список: имя, телефон, уровень (или «—»), аудитория, пол, бейдж `confirmed` (Подтверждён/Не подтверждён), бейдж `source='lead'` («из лида»). Фильтры: поиск по имени/телефону, селект по `confirmed` (все/подтв./не подтв.).
- Создание: «+ Ученик» → `POST /api/students` (или создаём пустого и открываем дровер на редактирование).
- Редактирование (дровер): имя, телефон, уровень (число 1–7 или пусто), аудитория (adult/kids/—), пол (m/f/—), тумблер `confirmed` → `PATCH /api/students/:id`.
- Быстрый тумблер «Подтверждён» в строке списка → `PATCH {confirmed}`.
- Удаление → `DELETE /api/students/:id`.
- Пустое состояние: «Нет учеников».

### Тренеры (дополнение)
- В существующий редактор тренеров (раздел «Тренеры») к каждому тренеру (coach1/2/3) добавить поле **Telegram chat_id** с текущим значением (или плейсхолдер «не привязан»).
- Сохранение → `PATCH /api/coaches/:slot`. Данные грузятся `GET /api/coaches` при входе в раздел.
- Значения `name` для отображения берутся из уже загруженного контента (`state.texts.coachN_name`), API `/api/coaches` возвращает их для удобства.

## Границы (YAGNI)

Нет: бота и авто-ловли «Я тренер» (Фаза 2 — `telegram_chat_id` задаётся вручную), публичных/бот-эндпоинтов матча по телефону (Фаза 2), брони и групп-доступа (Фаза 2), изменений лендинга, жёсткого FK-связывания лид↔ученик (только авто-инсерт заготовки), онлайн-оплаты/баланса.

## Связь с последующими фазами

- `students.confirmed` = флаг «имеет доступ к записи» → вход в правило допуска Фазы 2.
- `students.phone` (не уникальный) → матч по телефону в Mini App (Фаза 2), выбор «кого записываем» при нескольких.
- `coaches.telegram_chat_id` → адресат уведомлений о брони (Фаза 2); авто-привязка через бота «Я тренер» (Фаза 2) заменит ручной ввод.
- `coaches.slot` ↔ `schedule_data.cells[].coach_id` (Фаза 0) — джойн тренера занятия.

## Тестирование (ручное, curl/браузер)

- `POST /api/contact` → лид создан + заготовка ученика (`source:'lead'`, `confirmed:0`); повторный тот же телефон → второго ученика нет, лид есть.
- `GET/POST/PATCH/DELETE /api/students` — полный цикл; валидация (level вне [1,7] → 400).
- `GET /api/coaches` возвращает 3 слота с именами из content; `PATCH /api/coaches/coach2` задаёт и очищает chat_id.
- Админка: раздел «Ученики» читает сервер, создание/правка/удаление/тумблер работают; поле chat_id тренера сохраняется.
