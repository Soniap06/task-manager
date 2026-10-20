const path = require("node:path");
const { openDatabase, DEFAULT_DATABASE_PATH } = require("../lib/database");

try {
    const filename = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DATABASE_PATH;
    const database = openDatabase(filename);
    try {
        const version = database.prepare("PRAGMA user_version").get().user_version;
        console.log(`БД инициализирована: ${filename}; версия схемы: ${version}.`);
    } finally {
        database.close();
    }
} catch (error) {
    console.error(`Не удалось инициализировать БД: ${error.message}`);
    process.exitCode = 1;
}
