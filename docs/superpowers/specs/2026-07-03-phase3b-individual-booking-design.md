# Фаза 3B — Индивидуальная запись — дизайн

> Финальный под-этап Фазы 3 (`TELEGRAM_BOOKING_SPEC.md`). После 3A (окна доступности) 3B добавляет индивидуальную запись: нарезку окон на слоты, поток Mini App «тренер → свободное время → бронь», уведомления/отмену (переиспуем 2C), individual в разделе «Записи». Этим завершается вся система брони.

## Цель

Подтверждённый ученик выбирает тренера, видит его свободное время на 2 недели (нарезка окон доступности минус занятые индивидуальные брони) и бронирует индивидуальную тренировку выбираемой длительности (≥60 мин, кратно 30). Мгновенно, без овербукинга/пересечений; тренер получает уведомление; отмена — как у групповых.

## Архитектура

- Расширяем `server.js`: миграция `bookings.duration_min`; хелпер `individualSlots`; эндпоинты `POST /api/app/coaches`, `/api/app/slots`, `/api/app/book-individual`; расширяем `POST /api/app/cancel` (по `booking_id`) и `GET /api/bookings` (individual).
- Расширяем `public/app.html`: переключатель групповая/индивидуальная, выбор тренера → старт → длительность.
- Расширяем `public/admin.html`: раздел «Записи» показывает individual.
- Переиспуем: `resolveAppStudent`, `notifyBookingCreated`, `notifyTrainerCancelled`, `notifyClientCancelled`, `occStart`, `normPhone`, `coachNameBySlot`, `cancelBookingById`, `getBookingById`.
- Стек: Express + better-sqlite3. Тест-фреймворка нет — ручная проверка (curl / браузер). Часовой пояс — серверный localtime.

## Решения (из брейншторма)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Длительность | **Выбираемая ≥60 мин, кратно 30** (60/90/120…), старт с шагом 30 мин |
| 2 | Хранение длины | Колонка `bookings.duration_min` INTEGER (миграция ALTER) |
| 3 | Идентичность individual-брони | `coach_id`(slot) + `datetime` старта; пересечения — проверкой в транзакции (не DB-индексом) |
| 4 | Нарезка | Свободные интервалы = окно `coach_availability` минус занятые individual-брони; старты 30-мин шаг, длительности до конца свободного интервала |
| 5 | Допуск | Любой подтверждённый ученик → любой тренер (без фильтра уровня/пола) |
| 6 | Конфликты с группами | Нет автовычета (граница спеки) — тренер ведёт окна вручную |
| 7 | Эндпоинты | Отдельные `coaches`/`slots`/`book-individual`; отмена унифицирована по `booking_id` |
| 8 | UI | Два шага: старт → длительность (чипы); переключатель групповая/индивидуальная |

## Данные — миграция

```js
try { db.exec("ALTER TABLE bookings ADD COLUMN duration_min INTEGER"); } catch {}
```
Индивидуальная бронь: `type='individual'`, `coach_id`=slot, `datetime`=`'YYYY-MM-DD HH:MM'` (старт, localtime), `duration_min` (кратно 30, ≥60), `status` confirmed|cancelled. Групповые поля (`group_id/date/title/time`) — NULL. Уникального индекса нет (интервалы) — целостность через транзакционную проверку пересечений.

## Нарезка слотов

`individualSlots(slot, days = 14)` → `[{ date, starts: [{ time, datetime, durations:[min…] }] }]`:
- Окна тренера: `SELECT day, from_time, to_time FROM coach_availability WHERE slot=?`.
- Занятые: активные individual-брони тренера в будущем → интервалы `[startMin, startMin+duration_min)` по датам.
- Для каждой даты `d` (сегодня…+13): `wd = weekday(d)`; для каждого окна с `day===wd`:
  - переводим `from/to` в минуты; вычитаем из `[wf,wt]` занятые интервалы этой даты → **свободные под-интервалы** `[a,b]`;
  - для каждого `[a,b]` с `b−a ≥ 60`: старты `s = a, a+30, …` пока `s+60 ≤ b`; `durations = [60,90,… ≤ b−s]` (кратно 30);
  - только `datetime(d, s) > now`.
- `time`=`HH:MM(s)`, `datetime`=`'YYYY-MM-DD HH:MM'`.

Минутная арифметика: `HH:MM → H*60+M`; сравнение/вычитание в минутах; свободные интервалы = сортированное дополнение занятых внутри окна.

## Эндпоинты (Mini App, auth по initData; `resolveAppStudent`)

### `POST /api/app/coaches` `{initData, student_id}`
- Резолв ученика (любой подтверждённый). Ответ: `{status:'ok', coaches:[{slot, name}]}` (все coach1/2/3, `name` из content). `need_phone`/`forbidden`/401 — как в 2B.

### `POST /api/app/slots` `{initData, student_id, slot}`
- Резолв + `getCoach(slot)` валиден (иначе `{error:'no_coach'}`). Ответ: `{status:'ok', dates: individualSlots(slot,14)}`.

### `POST /api/app/book-individual` `{initData, student_id, slot, datetime, duration_min}`
- Резолв + `getCoach(slot)`. Валидация: `duration_min` целое, ≥60, кратно 30; `datetime` — валидный будущий старт, присутствующий в `individualSlots` с этой длительностью в `durations` (пере-деривация; иначе `{error:'invalid'}` / `{error:'expired'}`).
- **Атомарно** (`db.transaction`): пере-проверка отсутствия пересечения с активными individual-бронями тренера в этот интервал; если конфликт → `throw 'taken'`; `INSERT` брони.
- `notifyBookingCreated`-аналог тренеру (индивидуальный текст: тренер, дата, время, длительность). `{ok:true}`; ошибки `taken`/`invalid`/`expired`.

### `POST /api/app/my-bookings` `{initData, student_id}`
- Резолв ученика → его **будущие confirmed** брони (group + individual): `[{ booking_id, kind:'group'|'individual', title, when:'дата время', coach_name, cancelable }]`, сорт по старту. `cancelable` = старт − now ≥ 8ч. Для group `title` из снапшота/расписания; для individual `title='Индивидуально (D мин)'`. Используется вкладкой «Мои записи».

### `POST /api/app/cancel` — расширение (по `booking_id`)
- Если тело содержит `booking_id`: резолв ученика; `b = getBookingById(booking_id)`; проверка владения (`b.student_id` — подтверждённый ученик телефона сессии); окно ≥8ч (`occStart` из `b.datetime` для individual или `b.date/b.time` для group); `status='cancelled'`; уведомление тренеру. Ошибки `not_found`/`too_late`/`forbidden`.
- Совместимость: старый путь `{group_id, date}` (групповая инлайн-отмена) сохраняется.

## Отмена/уведомления

- Самоотмена ≥8ч и отмена тренером в админке — те же механизмы 2C, теперь и для individual (через `booking_id` / `PATCH /api/bookings/:id/cancel`). Освобождение слота = `status='cancelled'` (нарезка учитывает только confirmed).
- Уведомление тренеру при брони и при самоотмене; клиенту — при отмене тренером.

## Админка «Записи» + `GET /api/bookings`

- Выборка: `type IN ('group','individual')`.
- Маппинг individual: `title` = `Индивидуально (${duration_min} мин)`; «когда» = `datetime`; `coach_name` по `coach_id`; `date/time` для сортировки/`future`-фильтра берутся из `datetime` (`date=datetime[:10]`, `time=datetime[11:]`).
- `future` = `status='confirmed'` И старт > now (для group — `occStart(date,time)`; для individual — `occStart` из `datetime`).
- Отмена той же кнопкой `PATCH /api/bookings/:id/cancel` (уже уведомляет клиента).

## Mini App UI (`public/app.html`)

- После identify + выбора ученика (если >1) — **три вкладки: «Групповые» / «Индивидуально» / «Мои записи»**.
- **Групповые** — существующий поток (lessons/book, инлайн-отмена).
- **Индивидуально:**
  1. `POST /api/app/coaches` → список тренеров (кнопки).
  2. выбор тренера → `POST /api/app/slots` → свободные слоты по датам (заголовок даты + старты).
  3. тап по старту → раскрыть выбор длительности (чипы из `durations`) → тап по длительности → `POST /api/app/book-individual` → тост «Записаны!» + обновление слотов.
  - Пусто → «У тренера нет свободного времени».
- **Мои записи:** `POST /api/app/my-bookings` → будущие брони (group+individual) с кнопкой «Отменить» у `cancelable` (≥8ч) → `POST /api/app/cancel {booking_id}` → обновление. Так индивидуальная (и групповая) отмена унифицирована.

## Ошибки/безопасность

- initData невалиден → 401; `need_phone`/`forbidden`. Бронь за чужого student_id → `forbidden`. Гонка за слот → один выигрывает (транзакция + пере-проверка), второй `taken`. Прошедший старт → `expired`. Некорректная длительность/старт → `invalid`. Отмена <8ч → `too_late`.

## Тестирование (ручное, curl/браузер)

- Задать окно `coach1` day=D `10:00–14:00`; `slots` возвращает старты 10:00,10:30,…,13:00 с durations (60,90,120,… по остатку окна); прошлые старты отфильтрованы.
- `book-individual` 10:00 на 90 мин → `ok`; повторно пересекающийся старт (10:30 на 60) → `taken`; после брони `slots` не показывает пересекающиеся старты.
- Длительность 45/70 (не кратно 30 / <60) → `invalid`; старт не из окна → `invalid`.
- Отмена своей individual-брони по `booking_id` ≥8ч → `ok`, слот снова свободен; <8ч → `too_late`; чужая → `forbidden`.
- `GET /api/bookings` показывает individual с «Индивидуально (90 мин)» + тренер + datetime; отмена тренером уведомляет клиента.

## Границы (3B, YAGNI)

Нет: автовычета групповых занятий из окон; исключений на конкретную дату (только недельный шаблон); напоминаний; оплаты; повторяющихся индивидуальных записей.

## Завершение

3B закрывает Фазу 3 и всю систему брони (0/1/2/3). Остаётся отложенное **13a** (diff расписания → авто-уведомления при удалении/переносе групповых занятий) — отдельный этап при необходимости.
