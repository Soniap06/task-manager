# Инструкция по загрузке

## В репозиторий GitHub
Загрузите файлы из архива с сохранением структуры:
- `package.json`, `server.js`, `.gitignore`, `README.md`, `DEPLOYMENT.md`
- папку `public` целиком, включая `index.html`, `css/style.css`, `js/app.js`

При необходимости замените старые файлы первой версии. Новая структура использует `public/`, а не корневые `style.css` и `script.js`.

## Запуск
1. Установите Node.js 20+ с https://nodejs.org/
2. Скачайте/распакуйте папку проекта.
3. Откройте терминал в папке, где лежит `package.json`.
4. Выполните `npm install`.
5. Выполните `npm start`.
6. Откройте `http://localhost:3000`.

## GitHub Pages
GitHub Pages не запускает сервер Node.js, REST API и SQLite. Поэтому для проверки всех функций запускайте локально или разверните Node.js-приложение на подходящем хостинге. Для постоянной базы на облачном хостинге используйте persistent disk либо PostgreSQL.
