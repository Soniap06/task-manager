# Task Manager

Учебный Task Manager: Node.js + Express + SQLite, Kanban, команда, события GitHub, демо-авторизация и генерация ТЗ через Qwen API.

## Локальный запуск

1. Установите Node.js 20+.
2. Установите зависимости: `npm install`.
3. Создайте локальный `.env` на основе `.env.example` и задайте `DEMO_USERNAME`, `DEMO_PASSWORD`, `SESSION_SECRET`, `GITHUB_WEBHOOK_SECRET`. Для генерации ТЗ укажите `QWEN_API_KEY`.
4. Запустите `npm start` и откройте `http://localhost:3000`.

Секреты храните только в `.env` и настройках хостинга. Не публикуйте `.env` и не отправляйте API-ключи в чат или GitHub.

## API

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status`
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`
- `GET /api/employees`, `GET /api/profile`, `GET /api/events`
- `POST /api/ai/generate-task` — генерация ТЗ через Qwen, требует `QWEN_API_KEY`
- `POST /api/webhooks/github` — GitHub webhook с проверкой `X-Hub-Signature-256`, требует `GITHUB_WEBHOOK_SECRET`
- `GET /api/health`

## Настройка GitHub Webhooks

В GitHub откройте Settings → Webhooks → Add webhook. Payload URL должен указывать на публичный HTTPS-адрес приложения с путём `/api/webhooks/github`; Content type — `application/json`; Secret — значение `GITHUB_WEBHOOK_SECRET`. Выберите события Pushes, Pull requests и Pull request reviews. Локальный `localhost` GitHub не видит — для реального теста нужен публичный HTTPS endpoint.

## Демонстрационная авторизация

Используется один пользователь, заданный через `DEMO_USERNAME` и `DEMO_PASSWORD`. Сессия подписывается `SESSION_SECRET` и хранится в HttpOnly cookie. Это учебная схема для одного демонстрационного аккаунта, а не замена полноценной системы управления пользователями.
