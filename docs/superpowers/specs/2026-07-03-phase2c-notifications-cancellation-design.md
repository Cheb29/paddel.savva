# Фаза 2C — Уведомления, отмена, раздел «Записи» — дизайн

> Третий под-этап Фазы 2 (`TELEGRAM_BOOKING_SPEC.md`). После 2B (групповая бронь) 2C добавляет: уведомление тренеру о записи/отмене, самоотмену клиента (≥8ч), отмену тренером в админке, раздел «Записи». **Автоуведомление при удалении/переносе занятия (spec 13a) — отложено** в отдельный этап. Индивидуальная запись — Фаза 3.

## Цель

Замкнуть цикл групповой брони: тренер узнаёт о новых записях и отменах в Telegram; клиент может сам отменить бронь не позднее чем за 8 часов (иначе — через тренера); тренер видит все записи в админке и отменяет любую; отменённое место сразу освобождается.

## Архитектура

- Расширяем `server.js`: хелперы уведомлений (тренеру и клиенту через `tgApi`), снапшот `title/time` в `bookings`, эндпоинт `POST /api/app/cancel`, admin API `GET /api/bookings` + `PATCH /api/bookings/:id/cancel`; вешаем уведомление тренеру на существующий `/api/app/book` (2B).
- Расширяем `public/app.html`: кнопка «Отменить» у забронированных занятий с окном ≥8ч.
- Расширяем `public/admin.html`: раздел «Записи».
- Стек: Express + better-sqlite3. Тест-фреймворка нет — ручная проверка (curl / браузер). Часовой пояс — серверный localtime.

## Решения (из брейншторма)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | 13a (автоуведомление при правке расписания) | **Отложено** — отдельный этап после 2C |
| 2 | Набор уведомлений | Запись → тренеру; самоотмена клиента → тренеру; отмена тренером → клиенту |
| 3 | Как слать клиенту | Реверс-лукап: `student.phone` → `normPhone` → `tg_sessions` с тем же норм. телефоном → `user_id`=`chat_id`; шлём всем совпавшим, нет привязки → тихо пропускаем |
| 4 | Окно самоотмены | `occStart(date,time) − сейчас ≥ 8ч`; позже → `too_late`. Тренер в админке — без окна |
| 5 | Освобождение места | `status='cancelled'`; доступность (2B) считает только `confirmed` → место свободно сразу |
| 6 | Снапшот занятия в брони | При брони сохраняем `title`/`time` в строку `bookings` (nullable-колонки, ALTER с try/catch); «Записи»/уведомления самоописательны при изменении расписания |
| 7 | Надёжность отправки | Все `tgApi`-вызовы обёрнуты, не ломают ответ API (как `sendTelegram`) |

## Данные — миграция `bookings`

Добавить nullable-колонки снапшота (существующая таблица из 2B):
```js
try { db.exec("ALTER TABLE bookings ADD COLUMN title TEXT"); } catch {}
try { db.exec("ALTER TABLE bookings ADD COLUMN time TEXT"); } catch {}
```
`insertGroupBooking` расширяется: `INSERT INTO bookings (student_id, type, group_id, date, title, time) VALUES (?, 'group', ?, ?, ?, ?)`. Значения `title/time` берутся из occurrence в `/api/app/book`.

## Уведомления

- **`coachChatIdForGroup(coach_id)`** → `coaches.telegram_chat_id` по slot=`coach_id`; нет → null.
- **`clientChatIdsForStudent(student)`** → `[user_id]` из `tg_sessions`, где `normPhone(phone)===normPhone(student.phone)`.
- **`notifyBookingCreated(student, occ)`** → тренеру: `🆕 Новая запись\n👤 {student.name}\n🏷 {occ.title}\n📅 {date} {time}`.
- **`notifyBookingCancelled(student, booking, by)`** →
  - `by==='client'` → тренеру: `❌ Отмена записи (клиентом)\n👤 {name}\n🏷 {title}\n📅 {date} {time}`.
  - `by==='trainer'` → клиенту(ам): `❌ Ваша запись отменена\n🏷 {title}\n📅 {date} {time}\nПо вопросам — к тренеру.`.
- Все через `tgApi('sendMessage', {chat_id, text})`, каждый в try/catch, отправка не блокирует HTTP-ответ.

## Эндпоинты

### `POST /api/app/cancel` (Mini App)
`{initData, student_id, group_id, date}`:
- `resolveAppStudent` (как 2B: initData/dev, владение) → student; ошибки `401`/`need_phone`/`forbidden`.
- Найти активную бронь: `SELECT * FROM bookings WHERE student_id=? AND group_id=? AND date=? AND status='confirmed' AND type='group'`; нет → `{error:'not_found'}`.
- Окно: если `occStart(date, booking.time || <из расписания>) − Date.now() < 8ч` → `{error:'too_late'}`.
- `UPDATE bookings SET status='cancelled' WHERE id=?`; `notifyBookingCancelled(student, booking, 'client')`; `{ok:true}`.

### `GET /api/bookings` (админ, `requireSecret`)
- Параметр `?scope=future|all` (по умолчанию `future` — активные будущие).
- Возвращает `[{id, student_id, student_name, group_id, date, title, time, coach_name, status, created_at}]`, сорт по date+time. `title/time` — из снапшота, иначе резолв по `group_id` из текущего `schedule_data`, иначе `title:'(группа изменена)'`. `student_name` — join `students`. `coach_name` — по `cell.coach_id` текущего расписания (или пусто).
- `future` = `status='confirmed'` И `occStart(date,time) > now`.

### `PATCH /api/bookings/:id/cancel` (админ, `requireSecret`)
- Найти бронь по id; нет / уже cancelled → `404`/`{ok:true}` идемпотентно.
- `UPDATE status='cancelled'`; собрать `student` (по `student_id`) → `notifyBookingCancelled(student, booking, 'trainer')`; `{ok:true}`.

### Хук на `/api/app/book` (2B)
После успешной вставки брони — `notifyBookingCreated(student, occ)` (в try/catch, вне транзакции).

## Mini App (`public/app.html`)

- `/api/app/lessons` уже возвращает `booked`. Добавить в ответ по каждому занятию `cancelable` = `booked && occStart − now ≥ 8ч` (сервер считает; проще — Mini App считает сам из `date/time`).
- В `renderLessons`: у `booked` занятия, если до начала ≥8ч → кнопка/иконка «Отменить» (`data-cancel`); тап → `POST /api/app/cancel` → тост «Запись отменена» + `loadLessons()`. Если <8ч → подпись «отмена через тренера».
- Ошибки: `too_late` → «Отменить можно не позднее 8 часов до начала»; `not_found` → тихо перезагрузить.

## Админка (`public/admin.html`) — раздел «Записи»

- Новый пункт меню «Записи» (после «Ученики» или рядом с «Расписание»).
- Загрузка `GET /api/bookings?secret=&scope=future` (переключатель future/all).
- Таблица: ученик, группа (`title`), дата+время, тренер, статус; у `confirmed` — кнопка «Отменить» → `PATCH /api/bookings/:id/cancel` → перезагрузка списка + toast.
- Пусто → «Нет записей».

## Ошибки/безопасность

- Отмена чужой брони (student_id не принадлежит телефону сессии) → `forbidden` (через `resolveAppStudent`). Отмена позже 8ч → `too_late`. Повторная отмена — идемпотентна. Admin-эндпоинты под `requireSecret`. Отправка уведомлений never-throw. Клиент без привязанного `tg_sessions` (не открывал бота) — уведомление тихо пропускается.

## Тестирование (ручное, curl/браузер)

- Бронь (2B) → у тренера с заданным `coaches.telegram_chat_id` приходит уведомление (проверяем факт вызова `sendMessage`; при фейковом токене — что путь исполнился без throw).
- Самоотмена ≥8ч → `ok`, `status='cancelled'`, место снова `free`; повтор → `not_found`.
- Самоотмена <8ч (занятие сегодня скоро) → `too_late`.
- Отмена чужого student_id → `forbidden`.
- `GET /api/bookings?scope=future` → активные будущие с именами/группами; после отмены строка `cancelled` (в `scope=all`).
- `PATCH /api/bookings/:id/cancel` → `status='cancelled'`, попытка уведомления клиента.
- Снапшот: после брони `title/time` записаны; «Записи» показывают их даже если ячейку в расписании переименовали.

## Границы (2C, YAGNI)

Нет: автоуведомления при удалении/переносе занятия (spec 13a — отдельный этап); индивидуальной записи и доступности тренеров (Фаза 3); оплаты; напоминаний о занятии; истории/аналитики броней сверх списка.

## Связь с дальнейшим

- Отложенный **13a**: хук в `POST /api/content` (сохранение `schedule_data`) — diff старых/новых ячеек, отмена броней исчезнувших/перенесённых групп + `notifyBookingCancelled(...,'trainer'→клиенту, причина=перенос)`. Переиспользует хелперы уведомлений 2C.
- **Фаза 3**: индивидуальная бронь ложится в те же `bookings` (`type='individual'`, `coach_id/datetime`), «Записи» и отмена — те же механизмы.
