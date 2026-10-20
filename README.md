# TaskFlow — менеджер задач

Учебный full-stack проект: HTML/CSS/JavaScript, Node.js + Express, SQLite.

## Локальный запуск
Нужен Node.js 20+:
```bash
npm install
npm start
```
Откройте http://localhost:3000. Таблицы и демонстрационные записи создаются автоматически при первом запуске.

## API
- GET /api/health
- GET /api/tasks — задачи и исполнитель (JOIN)
- POST /api/tasks — создать задачу
- PATCH /api/tasks/:id — изменить статус/исполнителя/поля
- GET /api/employees
- GET /api/employees/:id
- GET /api/profile
- GET /api/events
- POST /api/events — демонстрационное добавление события

## Страницы
`/` канбан, `/team` сотрудники, `/events` логи, `/profile` профиль, `/login` демонстрационный вход.

## Важно
GitHub Pages поддерживает только статические файлы, не запускает Node.js и SQLite. Для полноценной работы API проект нужно запустить локально или разместить на Node.js-хостинге. Login, генерация ТЗ через LLM и настоящие GitHub webhooks пока не подключены — это заглушки/демоданные.
