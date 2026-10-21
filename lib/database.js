const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DATABASE_PATH = path.join(__dirname, "..", ".data", "task-manager.sqlite");
const MIGRATIONS = [
    path.join(__dirname, "..", "db", "migrations", "001-initial.sql"),
    path.join(__dirname, "..", "db", "migrations", "002-webhook-deliveries.sql")
];

function initializeSchema(database) {
    // Чтение версии внутри блокировки исключает гонку двух инициализаторов.
    database.exec("BEGIN IMMEDIATE");
    try {
        const version = database.prepare("PRAGMA user_version").get().user_version;
        if (version > MIGRATIONS.length) {
            throw new Error("Версия БД новее приложения; требуется обновление приложения.");
        }
        for (let index = version; index < MIGRATIONS.length; index++) {
            database.exec(fs.readFileSync(MIGRATIONS[index], "utf8"));
            database.exec(`PRAGMA user_version = ${index + 1}`);
        }
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function openDatabase(filename = DEFAULT_DATABASE_PATH) {
    if (filename !== ":memory:") {
        fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    }
    const database = new DatabaseSync(filename);
    try {
        database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        if (database.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
            throw new Error("Не удалось включить внешние ключи SQLite.");
        }
        initializeSchema(database);
        return database;
    } catch (error) {
        database.close();
        throw error;
    }
}

module.exports = { openDatabase, DEFAULT_DATABASE_PATH };
