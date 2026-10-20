# Развёртывание

Приложению нужен хостинг Node.js, который поддерживает постоянный диск для SQLite. GitHub Pages не запускает Express-сервер и не подходит для этой версии.

1. Загрузите репозиторий на Node.js-хостинг с persistent disk.
2. Команда сборки/установки: `npm install`.
3. Команда запуска: `npm start`.
4. Добавьте переменные из `.env.example` в секреты хостинга. Установите `NODE_ENV=production`, длинный уникальный `SESSION_SECRET`, `DEMO_USERNAME`, `DEMO_PASSWORD` и `GITHUB_WEBHOOK_SECRET`. Для Qwen укажите `QWEN_API_KEY`.
5. Убедитесь, что папка `data/` находится на постоянном диске; иначе SQLite-база может потеряться при перезапуске или новом деплое.
6. Для GitHub Webhooks используйте публичный HTTPS URL вида `https://your-host.example/api/webhooks/github` и тот же секрет, что в `GITHUB_WEBHOOK_SECRET`.

Не коммитьте `.env`, API-ключи, пароли или файлы базы данных.
