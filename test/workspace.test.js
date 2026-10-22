const test = require("node:test");
const assert = require("node:assert/strict");
const { openDatabase } = require("../lib/database");
const { Workspace } = require("../lib/workspace");

test("team profiles upgrade old defaults without changing capacity, identity or custom profiles", (t) => {
    const database = openDatabase(":memory:");
    t.after(() => database.close());
    database.prepare("INSERT INTO employees (id, name, role, executor_type, stack, capacity, avatar_url) VALUES (?, ?, ?, 'human', ?, 12, 'avatar.png')")
        .run("karina", "Халикова Карина", "Frontend Developer", JSON.stringify(["React", "UI/UX"]));
    database.prepare("INSERT INTO employees (id, name, role, executor_type, stack, capacity) VALUES ('sofia', 'София', 'Моя роль', 'human', '[\"Мой навык\"]', 20)").run();
    const workspace = new Workspace(database, {});
    const karina = workspace.employee("karina");
    assert.ok(karina.stack.includes("GitHub App / REST API"));
    assert.ok(karina.stack.includes("Qwen / LM Studio"));
    assert.equal(karina.capacity, 12);
    assert.equal(karina.avatar_url, "avatar.png");
    assert.equal(workspace.employee("sofia").role, "Моя роль");
    assert.deepEqual(workspace.employee("sofia").stack, ["Мой навык"]);
    const before = workspace.employees();
    new Workspace(database, {});
    assert.deepEqual(workspace.employees(), before);
});

test("a fresh workspace includes Sofia's interface and backend skills", (t) => {
    const database = openDatabase(":memory:");
    t.after(() => database.close());
    const workspace = new Workspace(database, {});
    assert.ok(workspace.employee("sofia").stack.includes("HTML / CSS"));
    assert.ok(workspace.employee("sofia").stack.includes("SQLite"));
    assert.equal(workspace.employee("karina").executor_type, "human");
});
