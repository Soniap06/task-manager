const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDatabase } = require("../lib/database");
const { Workspace } = require("../lib/workspace");
const { createApp } = require("../server");
const { fixture } = require("./helpers");
// Достаточная для проверки границ хранилища JPEG-сигнатура; декодирование проверяется браузером.
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const avatar = { contentType: "image/jpeg", data: jpeg.toString("base64") };
const input = { name: "Тестовый сотрудник", role: "Backend-разработчик", grade: "Middle", groups: ["backend", "data"], stack: ["Node.js", "SQLite"], capacity: 8 };
function workspace(t) {
    const database = openDatabase(":memory:");
    t.after(() => database.close());
    return { database, workspace: new Workspace(database, {}) };
}

test("employee details migrate from v2 without replacing old roles, stack or assignments", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "employee-v2-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, "workspace.sqlite");
    let db = new DatabaseSync(filename);
    for (const file of ["001-initial.sql", "002-webhook-deliveries.sql"]) db.exec(fs.readFileSync(path.join(__dirname, "../db/migrations", file), "utf8"));
    db.exec("PRAGMA user_version=2; INSERT INTO employees (id,name,role,executor_type,stack,capacity) VALUES ('custom','Личное имя','Личная должность','human','[\"Свой навык\"]',12)");
    db.exec("INSERT INTO projects (id,github_repository_id,installation_id,owner,name,base_branch) VALUES ('p',1,2,'example','project','main'); INSERT INTO tasks (id,project_id,title,assignee_id) VALUES ('t','p','Сохранить назначение','custom')");
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare("SELECT assignee_id FROM tasks WHERE id='t'").get().assignee_id, "custom");
    const employee = new Workspace(db, {}).employee("custom");
    assert.equal(employee.role, "Личная должность");
    assert.deepEqual(employee.stack, ["Свой навык"]);
    assert.equal(employee.capacity, 12);
    assert.equal(employee.grade, "");
    assert.deepEqual(employee.groups, []);
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
});

test("employee stores groups separately from technology; avatar and edits are atomic", (t) => {
    const { database, workspace: w } = workspace(t);
    const employee = w.createEmployee({ ...input, groups: ["backend", "backend", "data"], avatar_upload: avatar });
    assert.deepEqual(employee.groups, ["backend", "data"]);
    assert.deepEqual(employee.stack, input.stack);
    assert.equal(employee.grade, "Middle");
    assert.match(employee.avatar_url, /^\/api\/employees\/[a-f\d-]+\/avatar\?v=[a-f\d]{16}$/);
    assert.equal(employee.avatar_upload, undefined);
    assert.deepEqual(Buffer.from(w.avatar(employee.id).data), jpeg);
    database.exec("CREATE TRIGGER reject_avatar BEFORE INSERT ON employee_avatars BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => w.updateEmployee(employee.id, { name: "Не сохранять", avatar_upload: avatar }), /test failure/);
    assert.equal(w.employee(employee.id).name, employee.name);
    assert.deepEqual(Buffer.from(w.avatar(employee.id).data), jpeg);
    assert.throws(() => w.createEmployee({ ...input, avatar_upload: avatar }), /test failure/);
    assert.equal(w.employees().length, 4);
    const changed = w.updateEmployee(employee.id, { grade: "Senior", groups: ["testing"] });
    assert.deepEqual(changed.stack, employee.stack);
    assert.equal(changed.avatar_url, employee.avatar_url);
    assert.equal(w.updateEmployee(employee.id, { avatar_upload: null }).avatar_url, null);
    assert.throws(() => w.avatar(employee.id), { status: 404 });
});

test("invalid groups, grade and avatar leave employee unchanged", (t) => {
    const { workspace: w } = workspace(t);
    const employee = w.createEmployee(input);
    for (const patch of [
        { groups: ["unknown"] }, { groups: "backend" }, { grade: "Expert" },
        { avatar_upload: { contentType: "image/svg+xml", data: "PHN2Zz4=" } },
        { avatar_upload: { ...avatar, data: "YWJjZA==" } },
        { avatar_upload: { ...avatar, data: "A".repeat(174768) } },
        { avatar_upload: avatar, avatar_url: null }
    ]) {
        assert.throws(() => w.updateEmployee(employee.id, patch), { status: 400 });
        assert.deepEqual(w.employee(employee.id), employee);
    }
});

test("avatar persists after database reopen and is served only with authorized API access", async (t) => {
    const f = await fixture(t);
    const app = await createApp({ config: { ...f.config, auth: { username: "team", password: "synthetic", secret: "x".repeat(40) } }, github: f.github, store: f.store });
    let closed = false;
    t.after(async () => { if (!closed) await app.close(); });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username: "team", password: "synthetic" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "Content-Type": "application/json", Origin: origin, Cookie: cookie };
    const response = await fetch(origin + "/api/employees", { method: "POST", headers, body: JSON.stringify({ ...input, avatar_upload: avatar }) });
    assert.equal(response.status, 201);
    const employee = (await response.json()).employee;
    assert.equal((await fetch(origin + employee.avatar_url)).status, 401);
    const image = await fetch(origin + employee.avatar_url, { headers: { Cookie: cookie } });
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    const cross = await fetch(origin + `/api/employees/${employee.id}`, { method: "PATCH", headers: { ...headers, Origin: "https://other.test" }, body: JSON.stringify({ avatar_upload: null }) });
    assert.equal(cross.status, 403);
    await app.close();
    closed = true;
    const db = openDatabase(path.join(f.dir, "task-manager.sqlite"));
    const w = new Workspace(db, {});
    assert.equal(w.employee(employee.id).grade, "Middle");
    assert.deepEqual(Buffer.from(w.avatar(employee.id).data), jpeg);
    db.close();
});
