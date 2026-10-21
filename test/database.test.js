const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDatabase } = require("../lib/database");

const PROJECT = "16d271c8-55b2-4d1d-8cfa-539b463fa102";
const TASK = "a1f004ed-5614-4b05-9af2-3b9877a80a27";
const EMPLOYEE = "0204fe2f-2d42-4a2d-8b0f-df764750b4b7";
const USER = "16a96948-53db-4555-8c81-339b3c71b343";

function fixture(t) {
    const database = openDatabase(":memory:");
    t.after(() => database.close());
    database.prepare("INSERT INTO projects (id, github_repository_id, installation_id, owner, name, base_branch) VALUES (?, 10, 20, 'karina', 'habits', 'main')").run(PROJECT);
    return database;
}

test("SQLite: инициализация повторяема, данные сохраняются, FK включены на каждом соединении", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-manager-db-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "nested", "test.sqlite");
    let database = openDatabase(filename);
    try {
        database.prepare("INSERT INTO users (id, display_name) VALUES (?, 'Карина')").run(USER);
        assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    } finally { database.close(); }
    database = openDatabase(filename);
    try {
        assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
        assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
        assert.equal(database.prepare("SELECT display_name FROM users WHERE id = ?").get(USER).display_name, "Карина");
        const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
        assert.deepEqual(tables, ["employees", "events", "projects", "tasks", "users", "webhook_deliveries"]);
        assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { database.close(); }
});

test("SQLite: сотрудник назначается задаче; удаление пользователя/сотрудника сохраняет задачу", (t) => {
    const database = fixture(t);
    database.prepare("INSERT INTO users (id, display_name) VALUES (?, 'Карина')").run(USER);
    database.prepare("INSERT INTO employees (id, user_id, name, role, executor_type, stack, capacity) VALUES (?, ?, 'Карина', 'Frontend Middle', 'human', '[\"JavaScript\"]', 16)").run(EMPLOYEE, USER);
    database.prepare("INSERT INTO tasks (id, project_id, title, description, assignee_id) VALUES (?, ?, 'Добавить привычку', 'Форма и валидация', ?)").run(TASK, PROJECT, EMPLOYEE);
    assert.equal(database.prepare("SELECT status FROM tasks WHERE id = ?").get(TASK).status, "todo");
    database.prepare("DELETE FROM users WHERE id = ?").run(USER);
    assert.equal(database.prepare("SELECT user_id FROM employees WHERE id = ?").get(EMPLOYEE).user_id, null);
    database.prepare("DELETE FROM employees WHERE id = ?").run(EMPLOYEE);
    assert.equal(database.prepare("SELECT assignee_id FROM tasks WHERE id = ?").get(TASK).assignee_id, null);
    assert.throws(() => database.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT), /FOREIGN KEY/);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("SQLite: несуществующий проект и исполнитель отвергаются", (t) => {
    const database = fixture(t);
    const insert = database.prepare("INSERT INTO tasks (id, project_id, title, assignee_id) VALUES (?, ?, 'Привычка', ?)");
    assert.throws(() => insert.run(TASK, "missing", null), /FOREIGN KEY/);
    assert.throws(() => insert.run(TASK, PROJECT, "missing"), /FOREIGN KEY/);
    assert.throws(() => database.prepare("INSERT INTO employees (id, user_id, name, role, executor_type) VALUES (?, 'missing', 'Агент', 'AI Agent', 'ai_agent')").run(EMPLOYEE), /FOREIGN KEY/);
    assert.throws(() => database.prepare("INSERT INTO events (id, project_id, event_type, payload_summary) VALUES ('event', 'missing', 'push', 'commit')").run(), /FOREIGN KEY/);
});

test("SQLite: типы исполнителя, навыки и capacity ограничены схемой", (t) => {
    const database = fixture(t);
    const insert = database.prepare("INSERT INTO employees (id, name, role, executor_type, stack, capacity) VALUES (?, 'Агент', 'AI Agent', ?, ?, ?)");
    for (const [executor, stack, capacity] of [
        ["robot", "[]", 0], ["human", "broken-json", 1], ["human", "{}", 1],
        ["human", "null", 1], ["ai_agent", "[]", -1], ["human", "[]", 1.5]
    ]) {
        assert.throws(() => insert.run(EMPLOYEE, executor, stack, capacity));
    }
    insert.run(EMPLOYEE, "ai_agent", '["Node.js","Python"]', 0);
    assert.equal(database.prepare("SELECT executor_type FROM employees WHERE id = ?").get(EMPLOYEE).executor_type, "ai_agent");
});

test("SQLite: статусы, обязательные значения и уникальность репозитория", (t) => {
    const database = fixture(t);
    const insert = database.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)");
    assert.throws(() => insert.run(TASK, PROJECT, "Задача", "done"), /CHECK/);
    assert.throws(() => insert.run(TASK, PROJECT, "   ", "todo"), /CHECK/);
    assert.throws(() => insert.run(null, PROJECT, "Задача", "todo"), /NOT NULL/);
    for (const status of ["todo", "progress", "review"]) insert.run(`${TASK}-${status}`, PROJECT, "Задача", status);
    assert.throws(() => database.prepare("INSERT INTO projects (id, github_repository_id, installation_id, owner, name, base_branch) VALUES ('other', 11, 20, 'KARINA', 'HABITS', 'main')").run(), /UNIQUE/);
    assert.throws(() => database.prepare("INSERT INTO projects (id, github_repository_id, installation_id, owner, name, base_branch) VALUES ('other', 10, 20, 'other', 'other', 'main')").run(), /UNIQUE/);
});

test("SQLite: события привязаны к проекту и получают дату UTC", (t) => {
    const database = fixture(t);
    database.prepare("INSERT INTO events (id, project_id, event_type, payload_summary) VALUES ('event', ?, 'pull_request_review', 'PR #1: approved')").run(PROJECT);
    const event = database.prepare("SELECT * FROM events WHERE id = 'event'").get();
    assert.equal(event.payload_summary, "PR #1: approved");
    assert.match(event.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.throws(() => database.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT), /FOREIGN KEY/);
});

test("SQLite: новая версия БД не понижается и не повреждается", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-manager-db-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "future.sqlite");
    let database = new DatabaseSync(filename);
    database.exec("PRAGMA user_version = 99; CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('сохранено');");
    database.close();
    assert.throws(() => openDatabase(filename), /Версия БД новее/);
    database = new DatabaseSync(filename);
    try {
        assert.equal(database.prepare("PRAGMA user_version").get().user_version, 99);
        assert.equal(database.prepare("SELECT value FROM marker").get().value, "сохранено");
    } finally { database.close(); }
});

test("SQLite: миграция версии 1 добавляет доставки webhook и сохраняет существующие записи", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-manager-upgrade-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "previous.sqlite");
    let database = new DatabaseSync(filename);
    database.exec(fs.readFileSync(path.join(__dirname, "../db/migrations/001-initial.sql"), "utf8"));
    database.exec("PRAGMA user_version = 1");
    database.prepare("INSERT INTO users (id, display_name) VALUES (?, 'Сохранить пользователя')").run(USER);
    database.close();
    database = openDatabase(filename);
    try {
        assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
        assert.equal(database.prepare("SELECT display_name FROM users WHERE id=?").get(USER).display_name, "Сохранить пользователя");
        database.prepare("INSERT INTO webhook_deliveries (delivery_id) VALUES ('delivery')").run();
        assert.throws(() => database.prepare("INSERT INTO webhook_deliveries (delivery_id) VALUES ('delivery')").run(), /UNIQUE/);
    } finally { database.close(); }
});

test("SQLite: ошибка миграции откатывает всю схему", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-manager-db-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "conflict.sqlite");
    let database = new DatabaseSync(filename);
    database.exec("CREATE TABLE employees (marker TEXT); INSERT INTO employees VALUES ('исходные данные');");
    database.close();
    assert.throws(() => openDatabase(filename), /already exists/);
    database = new DatabaseSync(filename);
    try {
        assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
        assert.equal(database.prepare("SELECT marker FROM employees").get().marker, "исходные данные");
        assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name), ["employees"]);
    } finally { database.close(); }
});
