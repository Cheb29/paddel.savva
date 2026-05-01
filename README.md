# Savva Team — Академия падел тенниса

Лендинг и бэкенд для академии падел тенниса [Savva Team](https://savva.n2node.store).

## Стек

- **Frontend:** HTML / CSS / Vanilla JS — анимации, параллакс, кастомный курсор, мобильная адаптация
- **Backend:** Node.js + Express (ES modules)
- **База данных:** SQLite (better-sqlite3) — хранение заявок
- **Уведомления:** Telegram Bot API — оповещения о новых заявках
- **Прокси:** Caddy — HTTPS, reverse proxy
- **Процесс:** PM2

## Структура

```
├── server.js              # Express-сервер
├── package.json
├── .env.example           # Шаблон переменных окружения
├── public/
│   ├── index.html         # Лендинг
│   ├── tweaks-panel.jsx   # Панель настроек (дизайн)
│   └── uploads/           # Фото и видео тренеров
└── db/
    └── leads.db           # SQLite база заявок (создаётся автоматически)
```

## Запуск

```bash
cp .env.example .env
# Заполни .env (см. ниже)

npm install
npm start
# → http://localhost:3000
```

## Переменные окружения

```env
PORT=3000

# Telegram уведомления о новых заявках (необязательно)
TELEGRAM_BOT_TOKEN=   # токен от @BotFather
TELEGRAM_CHAT_ID=     # chat_id от @userinfobot

# Защита эндпоинта /api/leads (необязательно)
ADMIN_SECRET=
```

## API

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/contact` | Принять заявку `{ name, phone, comment }` |
| `GET` | `/api/leads?secret=...` | Список заявок |

## Деплой

```bash
# Синхронизировать файлы на сервер
rsync -az public/index.html user@server:/path/to/savvateam-site/public/

# Перезапустить (если менялся server.js)
ssh user@server "pm2 restart savvateam"
```

## Контакты

- Сайт: [savva.n2node.store](https://savva.n2node.store)
- Телефон: +7 (999) 218-36-39
- Адрес: Санкт-Петербург, ул. Полевая Сабировская, 52
- Дизайн: [@cheb29](https://t.me/cheb29)
