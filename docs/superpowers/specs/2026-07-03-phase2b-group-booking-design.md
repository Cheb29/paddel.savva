# Фаза 2B — Групповая бронь — дизайн

> Второй под-этап Фазы 2 (`TELEGRAM_BOOKING_SPEC.md`). После 2A (бот, Mini App, вход/матч по телефону) 2B добавляет: генерацию датированных занятий из недельного шаблона, таблицу `bookings`, фильтр допуска, живую доступность и атомарную групповую бронь. **Уведомлений тренеру, отмены, раздела «Записи» — нет** (2C). Индивидуальной записи — нет (Фаза 3).

## Цель

Подтверждённый ученик в Mini App видит подходящие ему датированные групповые занятия на 2 недели вперёд со счётчиком «свободно N из M» и бронирует их одним тапом; место захватывается атомарно, без овербукинга и дублей.

## Архитектура

- Расширяем `server.js`: таблица `bookings` + prepared statements; хелпер генерации occurrences из `content.schedule_data` (модель А — занятия не материализуются, вычисляются); общий auth-хелпер `resolveAppStudent`; эндпоинты `POST /api/app/lessons`, `POST /api/app/book`.
- Расширяем `public/app.html`: после identify — список занятий по датам + бронь.
- Стек: Express + better-sqlite3, ES-модули. Тест-фреймворка нет — ручная проверка (curl / браузер). Часовой пояс — серверный localtime (как в `leads.created_at` и `schedule`).

## Решения (из брейншторма; спека предопределила большинство)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Идентичность занятия | **Модель А**: occurrence = `group_id` (=`cell.id`) + ISO-дата; не материализуется |
| 2 | Маппинг день-в-расписании → день недели | По метке: `{ВС:0,ПН:1,ВТ:2,СР:3,ЧТ:4,ПТ:5,СБ:6}` (устойчиво к порядку/добавлению колонок) |
| 3 | Правило допуска | `audience совпал AND level_min≤level≤level_max AND (gender==='mixed' OR gender===пол ученика)` |
| 4 | Доступность | `free = capacity − COUNT(confirmed по group_id+date)`; `≥capacity` → «мест нет»; `capacity<count` → «перебор», новые закрыты |
| 5 | Атомарность | `db.transaction`: пересчёт count, `INSERT` только если `count<capacity` и нет активного дубля; + уникальный частичный индекс |
| 6 | Мин. лид-тайм брони | **Нет** — любое будущее занятие в окне (спека ограничивает только отмену ≤8ч, это 2C) |
| 7 | Заполненные занятия | **Показываем** «мест нет» (видны, неактивны), не прячем |
| 8 | Ученик без level/audience/gender | Подходящих занятий нет; в UI подсказка «обратитесь к тренеру» |
| 9 | Владение бронью | `student_id` должен принадлежать подтверждённому ученику с телефоном сессии (нормализация телефона как в 2A) |

## Данные — `bookings`

```sql
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  type       TEXT NOT NULL DEFAULT 'group',   -- задел под 'individual' (Фаза 3)
  group_id   TEXT,                             -- = schedule cell.id (для group)
  date       TEXT,                             -- 'YYYY-MM-DD' (для group)
  coach_id   TEXT,                             -- для individual (Фаза 3), сейчас NULL
  datetime   TEXT,                             -- для individual (Фаза 3), сейчас NULL
  status     TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_active
  ON bookings(student_id, group_id, date)
  WHERE status = 'confirmed' AND type = 'group';
```
Колонки `coach_id/datetime` заведены сразу под финальную форму спеки, чтобы Фаза 3 не мигрировала; в 2B всегда `NULL`. Частичный уникальный индекс — DB-гарантия от дубля активной групповой брони (в дополнение к проверке в транзакции).

## Генерация занятий (occurrences)

Хелпер `groupOccurrences(fromDate, days = 14)` → массив occurrences:
- Парсит `content.schedule_data` (`{days:[метки], rows:[{time, cells:[cell|null]}]}`).
- `WEEKDAY = {ВС:0,ПН:1,ВТ:2,СР:3,ЧТ:4,ПТ:5,СБ:6}`.
- Для каждой даты `d` из `[fromDate … fromDate+days-1]`: `wd = weekday(d)`; для каждого индекса колонки `ci`, где `WEEKDAY[days[ci]] === wd`; для каждой строки `row`: `cell = row.cells[ci]`; если `cell && cell.title` → occurrence `{ group_id:cell.id, date:iso(d), time:row.time, title, meta, cat, level_min, level_max, audience, gender, coach_id, capacity }`.
- Фильтр «в будущем»: `startDateTime(date, row.time) > now` (парсинг начала из `time` вида `"9:30–11:00"` → `"9:30"`; разделитель — en-dash `–` или дефис).

Занятие с `cell.id` отсутствующим (старые данные без стабильного id) — пропускается (без id нельзя бронировать); в 2A/Фазе 0 сид и админ-редактор проставляют `id`.

## Правило допуска

`eligible(student, cell)`:
```
student.audience != null && student.level != null && student.gender != null
&& cell.audience === student.audience
&& cell.level_min <= student.level && student.level <= cell.level_max
&& (cell.gender === 'mixed' || cell.gender === student.gender)
```
Ученик с незаполненными полями → не подходит ни одно занятие (решение #8).

## Доступность и бронь

- `countConfirmed(group_id, date)` = `SELECT COUNT(*) FROM bookings WHERE group_id=? AND date=? AND status='confirmed' AND type='group'`.
- `free = capacity − count`; статус занятия: `count>=capacity` → `full`; `capacity<count` → `overbooked`; иначе `open` с `free`.
- Бронь (`db.transaction`):
  1. пересчитать `count`; если `count >= capacity` → `throw 'full'`;
  2. если активный дубль (`student_id+group_id+date, status='confirmed'`) → `throw 'duplicate'`;
  3. `INSERT` брони.
  Уникальный индекс ловит гонку как второй рубеж.

## Эндпоинты (Mini App, auth по initData)

Общий `resolveAppStudent(body)` → `{ student }` или `{ error, code }`:
- Валидирует `initData` (как 2A; `DEV_ALLOW_UNSIGNED` для локали).
- Телефон сессии по `user.id` (`tg_sessions`); нет → `{code:'need_phone'}`.
- `student = confirmed-ученик по нормализованному телефону с `id === student_id`; если не найден → `{code:'forbidden'}` (нельзя бронировать за чужого/неподтверждённого).

**`POST /api/app/lessons`** `{initData, student_id}`:
- `resolveAppStudent` → student.
- `occ = groupOccurrences(today, 14)` → фильтр `eligible(student, occ)` → к каждому добавить `count/free/status` и `booked` (есть ли активная бронь этого ученика на это occurrence).
- Ответ: `{ status:'ok', lessons:[ {group_id,date,time,title,meta,cat,coach_name,capacity,free,status,booked} ] }` (сорт по date, затем по времени). `coach_name` — из content по `coach_id`.

**`POST /api/app/book`** `{initData, student_id, group_id, date}`:
- `resolveAppStudent` → student.
- Найти occurrence в `groupOccurrences` по `group_id+date`; нет / не в будущем → `{error:'expired'}`; не `eligible` → `{error:'ineligible'}`.
- Транзакционная бронь → `{ok:true, free}` либо `{error:'full'|'duplicate'}`.

Ошибки резолва → HTTP 401 (невалидный initData) / 200 с `{status:'need_phone'|'forbidden'}` (для UI).

## Mini App UI (`public/app.html`)

- После `identify` `ok`: если >1 ученик — экран «Кого записываем?» с выбором (клик выбирает `student_id`); иначе сразу берём единственного.
- Для выбранного ученика — `POST /api/app/lessons`; рендер по датам (заголовок даты + карточки). Карточка: время, название, тренер, справа `свободно N/M` (зелёным) / `мест нет` (серым) / `перебор` / `вы записаны`.
- Тап по `open` → `POST /api/app/book`; успех → тост «Записаны!» + локально пометить `booked`/уменьшить `free`; ошибка → тост с причиной (`нет мест`/`уже записаны`).
- Пусто → «Нет подходящих занятий. Уточните уровень/группу у тренера.»

## Ошибки/безопасность

- initData невалиден → 401. `need_phone`/`forbidden` → соответствующий экран. Бронь за чужого student_id → `forbidden`. Гонка за последнее место → один выигрывает (транзакция + индекс), второй получает `full`. Повторная бронь → `duplicate`. Занятие ушло в прошлое между списком и тапом → `expired`.

## Тестирование (ручное, curl/браузер)

- Генерация: `groupOccurrences` даёт занятия только на нужные дни недели, только будущие, с `cell.id`.
- Допуск: ученик уровня 3 adult m видит группы с `2.5–3.5 adult men/mixed`, не видит `women`/`kids`/вне диапазона.
- Бронь: первая — `ok`, `free` уменьшается; повтор того же — `duplicate`; при `capacity` мест заполнено — `full`; уменьшение `capacity` ниже брони → занятие `overbooked`, новая бронь `full`.
- Владение: бронь с чужим `student_id` (телефон сессии другой) → `forbidden`.
- Прошедшее занятие → `expired`.

## Границы (2B, YAGNI)

Нет: уведомлений тренеру о брони, самоотмены/отмены тренером, раздела «Записи» в админке (всё 2C); индивидуальной записи и доступности тренеров (Фаза 3); оплаты/баланса; waitlist.

## Связь с 2C / Фазой 3

- `bookings` (group) → 2C: уведомление тренеру группы (`coaches.telegram_chat_id` по `cell.coach_id`), отмена (`status='cancelled'`, освобождение места), раздел «Записи» в админке.
- Колонки `type/coach_id/datetime` → Фаза 3 (индивидуальная бронь) без миграции.
