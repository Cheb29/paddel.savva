# Фаза 2A — Бот + Mini App + вход/личность — дизайн

> Первый из трёх под-этапов Фазы 2 (`TELEGRAM_BOOKING_SPEC.md`). 2A даёт вход: бот на webhook открывает Telegram Mini App, Mini App получает телефон и авторизуется, сервер матчит по подтверждённым `students.phone`, клиент видит «кого записываем» или ссылку на менеджера. **Брони, уведомлений, отмены — нет** (2B/2C). Документ фиксирует решения; план — отдельным файлом.

## Цель

Рабочий вход в систему записи: клиент открывает `@SavvaPadel_bot` → делится телефоном → открывает Mini App → сервер по подтверждённому телефону узнаёт ученика(ов) и показывает готовность к записи, либо ведёт незнакомца к менеджеру. Тренеры распознаются по `user_id` и видят свой блок; ученики его не видят.

## Архитектура

- Расширяем `server.js`: webhook-роут бота, `setWebhook` на старте, эндпоинт `POST /api/app/identify`, таблица `tg_sessions`, хелпер `tgApi`. Раздаём Mini App как статическую страницу `public/app.html` на `/app`.
- Бот — **тот же** `@SavvaPadel_bot` (id `8649720856`), приём входящих через **webhook** (не polling), обработка **сырым Bot API через `fetch`** (без фреймворка). Отправка заявок с формы (`sendTelegram`) продолжает работать.
- Стек: Express + better-sqlite3, ES-модули. HTTPS уже есть (Caddy → :3002, `savva.n2node.store`).

## Решения (из брейншторма)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Бот | **Тот же `@SavvaPadel_bot`** |
| 2 | Приём входящих | **Webhook в Express** (`POST /api/tg/webhook/:secret` + заголовок-секрет), `setWebhook` на старте; **сырой Bot API** через fetch |
| 3 | Фолбэк незнакомца | **Ссылка на менеджера** (`t.me/<MANAGER_USERNAME>`), никакой формы в Mini App |
| 4 | Критерий матча | **Только подтверждённые** (`confirmed=1`); найдено, но все `confirmed=0` → трактуется как незнакомец → к менеджеру |
| 5 | «Я тренер» / захват chat_id | **Захвата в боте нет.** `user_id` тренера берётся вне бота (@userinfobot) и вписывается админом в `coaches.telegram_chat_id` (Фаза 1). Публичной кнопки «Я тренер» и команды `/id` нет |
| 5b | Распознавание тренера | По `/start`: если `user_id == coaches.telegram_chat_id` → тренерский блок; иначе клиентский экран. Ученики тренерское сообщение не видят |
| 5c | Соответствие id | В личке Telegram `chat_id == user_id` → одно поле `coaches.telegram_chat_id` служит и распознаванием, и адресом уведомлений (2C) |

## Данные

### Таблица `tg_sessions`
Короткоживущая связка «телеграм-пользователь → подтверждённый телефон» (телефон приходит боту сервер-сайд, когда пользователь им делится).
```sql
CREATE TABLE IF NOT EXISTS tg_sessions (
  telegram_user_id INTEGER PRIMARY KEY,
  phone            TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```
Пишется при получении `message.contact` в webhook. Читается в `/api/app/identify` по `user.id` из initData. Переживает рестарт (проще отладки, чем in-memory Map).

Новых полей в `students`/`coaches` не требуется. `coaches.telegram_chat_id` = числовой id тренера (уже есть с Фазы 1).

## Компоненты и потоки

### 1. Webhook бота
- **`POST /api/tg/webhook/:secret`** — приём апдейтов. Проверка: `req.params.secret === WEBHOOK_SECRET` **и** заголовок `X-Telegram-Bot-Api-Secret-Token === WEBHOOK_SECRET`; иначе 403.
- **Старт сервера:** если заданы `PUBLIC_URL` и `WEBHOOK_SECRET` и `TELEGRAM_BOT_TOKEN` → вызвать `setWebhook({url: PUBLIC_URL + '/api/tg/webhook/' + WEBHOOK_SECRET, secret_token: WEBHOOK_SECRET, allowed_updates:['message']})`. Иначе (локально) бот не поднимается — логируем «webhook отключён».
- **Хелпер `tgApi(method, params)`** — `POST https://api.telegram.org/bot<token>/<method>` через fetch, JSON-тело; `sendTelegram` переписать поверх него.
- **Обработка апдейтов:**
  - `message.contact` (пользователь поделился телефоном) → `upsert tg_sessions(user_id, contact.phone_number)`; ответить сообщением «Телефон получен, открываю запись…» + кнопкой Web App (на случай, если Mini App ещё не открыт).
  - `message.text === '/start'` (или любой первый контакт):
    - если `user.id` есть среди `coaches.telegram_chat_id` → **тренерский блок**: «Вы тренер <имя из content> команды Savva. Уведомления о записях будут приходить сюда.» (+ можно клиентскую кнопку, но не обязательно).
    - иначе → **клиентский экран**: приветствие + reply-клавиатура с кнопкой `request_contact` («📱 Поделиться телефоном для записи») и/или inline web_app-кнопка «📅 Открыть запись» (`web_app.url = PUBLIC_URL + '/app'`).
  - Прочие апдейты игнорируем.
- **Новые env:** `PUBLIC_URL`, `WEBHOOK_SECRET`, `MANAGER_USERNAME` (без `@`).

### 2. Mini App (`public/app.html` → `/app`)
- Подключает `https://telegram.org/js/telegram-web-app.js`.
- `Telegram.WebApp.ready(); expand();`. Тема/цвета — тёмные, в стиле лендинга.
- Если телефон ещё не подтверждён (identify вернул `need_phone`) → кнопка «Поделиться телефоном» → `Telegram.WebApp.requestContact()` (нативный диалог; при успехе телефон уходит боту, webhook пишет `tg_sessions`).
- Шлёт `Telegram.WebApp.initData` (сырую строку) на `POST /api/app/identify`.
- Экраны по ответу: `need_phone` → запрос телефона; `unmatched` → «Вы ещё у нас не занимались» + кнопка-ссылка `t.me/<MANAGER_USERNAME>`; `ok` с 1 учеником → «Привет, <имя>!» + плейсхолдер «Скоро: выбор занятий» (до 2B); `ok` с >1 → «Кого записываем?» + список выбора (выбор пока просто подсвечивает — брони нет).

### 3. `POST /api/app/identify`
- Тело: `{ initData }`.
- **Валидация initData** (канон Telegram): распарсить query-string; извлечь `hash`; собрать `data_check_string` из остальных пар, отсортированных по ключу, склеенных `\n`; `secret_key = HMAC_SHA256("WebAppData", bot_token)`; сверить `HMAC_SHA256(secret_key, data_check_string) === hash`. Проверить свежесть `auth_date` (≤ 24 ч). Невалидно/протухло → `401`.
- Извлечь `user.id` из initData.
- Телефон: `tg_sessions.phone` по `user.id`. Нет записи → `{ status:'need_phone' }`.
- Матч: подтверждённые ученики `SELECT ... FROM students WHERE phone = ? AND confirmed = 1`.
  - 0 → `{ status:'unmatched', manager: MANAGER_USERNAME }`.
  - ≥1 → `{ status:'ok', students:[{id,name,level,audience,gender}] }`.
- Dev-обход: при `DEV_ALLOW_UNSIGNED=1` (только локально) пропускать проверку подписи, брать `user.id`/телефон из тела — чтобы тестировать Mini App без реального Telegram.

## Ошибки и безопасность
- Webhook без верного secret (путь или заголовок) → 403.
- initData невалиден/протух → 401.
- `requestContact` отклонён пользователем → экран «Телефон нужен для записи, поделитесь, пожалуйста».
- Бот не поднимается без `PUBLIC_URL`/`WEBHOOK_SECRET`/`TELEGRAM_BOT_TOKEN` — локальная разработка не падает.
- Секрет webhook и токен — только в прод `.env`, не в репозитории.

## Тестирование (ручное)
- **Локально:** `identify` с `DEV_ALLOW_UNSIGNED=1` и мок-телефоном подтверждённого ученика → `ok`; с чужим телефоном → `unmatched`; без сессии телефона → `need_phone`; с битым initData (без dev-флага) → 401. Webhook с неверным secret → 403.
- **Прод:** `setWebhook` установлен (`getWebhookInfo` показывает url); `/start` от обычного аккаунта → клиентский экран; от аккаунта, чей id вписан в `coaches.telegram_chat_id` → тренерский блок; в Mini App поделиться телефоном известного подтверждённого ученика → приветствие; неизвестного → ссылка на менеджера.

## Границы (2A, YAGNI)
Нет: списка занятий, генерации датированных занятий, таблицы `bookings`, самой брони, capacity (всё 2B); уведомлений тренеру, отмены, раздела «Записи» в админке (2C); индивидуальной записи (Фаза 3); авто-заведения/подтверждения ученика из Mini App (остаётся у тренера через админку Фазы 1); оплаты.

## Связь с 2B/2C
- `tg_sessions` + `identify` дают серверу «кто это и какие у него ученики» → 2B строит для выбранного ученика список подходящих датированных занятий и бронирует.
- `coaches.telegram_chat_id` (распознавание тренера здесь) → 2C шлёт туда уведомления о брони.
- Экран «Кого записываем?» (выбор ученика) → вход в поток брони 2B.
