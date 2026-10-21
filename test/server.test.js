const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { createApp } = require("../server");
const { fixture, specification } = require("./helpers");

async function start(t, overrides = {}) {
    const f = await fixture(t);
    Object.assign(f.config, overrides);
    const app = await createApp({ config: f.config, store: f.store, github: f.github, generate: async () => specification });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    t.after(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    return { ...f, ...app, origin };
}

test("HTTP: creates, reloads, repeats and moves a task with one GitHub branch", async (t) => {
    const f = await start(t);
    const headers = { "Content-Type": "application/json", Origin: f.origin };
    const body = JSON.stringify({ projectId: f.project.id, requestId: randomUUID(), title: "Форма входа" });
    const response = await fetch(`${f.origin}/api/tasks`, { method: "POST", headers, body });
    assert.equal(response.status, 200);
    const { task } = await response.json();
    assert.equal(task.state, "draft_ready");
    assert.equal(f.github.creates, 0);
    const confirmed = await fetch(`${f.origin}/api/tasks/${task.id}/confirm`, { method: "POST", headers, body: JSON.stringify(task) });
    assert.equal((await confirmed.json()).task.state, "branch_created");
    const again = await fetch(`${f.origin}/api/tasks`, { method: "POST", headers, body });
    assert.equal((await again.json()).task.id, task.id);
    const moved = await fetch(`${f.origin}/api/tasks/${task.id}/column`, { method: "POST", headers, body: JSON.stringify({ column: "progress" }) });
    assert.equal((await moved.json()).task.column, "progress");
    const board = await (await fetch(`${f.origin}/api/tasks?projectId=${f.project.id}`)).json();
    assert.equal(board.tasks.length, 1);
    assert.equal(board.tasks[0].column, "progress");
    assert.equal(f.github.creates, 1);
});

test("HTTP: optional auth protects all project APIs, rejects forged cookies and supports logout", async (t) => {
    const f = await start(t, { auth: { username: "sofia", password: "test-password", secret: "s".repeat(32) } });
    const request = (route, body, extra = {}) => fetch(f.origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
    for (const path of ["/api/projects", "/api/tasks?projectId=" + f.project.id, "/api/employees", "/api/profile", "/api/events?projectId=" + f.project.id]) {
        assert.equal((await fetch(f.origin + path)).status, 401, path);
    }
    assert.equal((await fetch(f.origin + "/api/projects", { headers: { Cookie: "tm_session=%ZZ" } })).status, 401);
    assert.equal((await request("/api/auth/login", { username: "sofia", password: "wrong" })).status, 401);
    assert.equal((await request("/api/auth/login", { username: "sofia", password: "test-password" }, { Origin: "https://evil.example" })).status, 403);
    const response = await request("/api/auth/login", { username: "sofia", password: "test-password" });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie.split(";")[0] };
    assert.equal((await fetch(f.origin + "/api/projects", { headers })).status, 200);
    const profile = await (await fetch(f.origin + "/api/profile", { headers })).json();
    assert.equal(profile.name, "Пескова София");
    const logout = await request("/api/auth/logout", {});
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await fetch(f.origin + "/api/projects", { headers: { Cookie: headers.Cookie + "forged" } })).status, 401);
    assert.equal(f.github.creates, 0);
});

test("HTTP: partially configured auth fails closed while health and login pages remain available", async (t) => {
    const f = await start(t, { auth: { username: "sofia" } });
    assert.equal((await fetch(f.origin + "/api/projects")).status, 503);
    assert.equal((await fetch(f.origin + "/api/health")).status, 200);
    assert.equal((await fetch(f.origin + "/login")).status, 200);
});

test("HTTP: team, profile and pure AI preview share the existing application without GitHub writes", async (t) => {
    const f = await start(t);
    const employees = await (await fetch(f.origin + "/api/employees")).json();
    assert.equal(employees.length, 3);
    assert.ok(employees.every((employee) => Array.isArray(employee.stack)));
    assert.equal((await fetch(f.origin + "/api/employees/missing")).status, 404);
    assert.equal((await (await fetch(f.origin + "/api/profile")).json()).employee, null);
    const preview = await fetch(f.origin + "/api/ai/generate-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Форма входа", projectId: f.project.id }) });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), specification);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.github.creates, 0);
    for (const path of ["/team", "/events", "/profile", "/login", "/css/style.css", "/js/app.js"]) assert.equal((await fetch(f.origin + path)).status, 200);
    for (const path of ["/data/task-manager.db", "/.data/task-manager.sqlite", "/package-lock.json"]) assert.equal((await fetch(f.origin + path)).status, 404);
});

test("HTTP: assigning a known employee persists with the task; unknown employee cannot create a branch", async (t) => {
    const f = await start(t);
    const requestId = randomUUID();
    const post = (assigneeId) => fetch(f.origin + "/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.id, requestId, title: "Форма входа", assigneeId }) });
    assert.equal((await post("missing")).status, 404);
    assert.equal(f.github.creates, 0);
    const response = await post("karina");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).task.assigneeId, "karina");
    assert.equal(f.store.list()[0].assigneeId, "karina");
    assert.equal((await post("sofia")).status, 409);
    assert.equal(f.github.creates, 0);
});

test("HTTP: signed webhooks are scoped to connected projects, deduplicated and stored in SQLite", async (t) => {
    const { createHmac } = require("node:crypto");
    const f = await start(t, { webhookSecret: "test-webhook-secret" });
    const post = (payload, event = "push", signature, delivery = "delivery-1") => {
        const body = JSON.stringify(payload);
        return fetch(f.origin + "/api/webhooks/github", { method: "POST", headers: {
            "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": delivery,
            "X-Hub-Signature-256": signature || "sha256=" + createHmac("sha256", f.config.webhookSecret).update(body).digest("hex")
        }, body });
    };
    const payload = { repository: { id: 101 }, installation: { id: 2 }, ref: "refs/heads/main", sender: { login: "sofia" }, head_commit: { message: "update" } };
    assert.equal((await post(payload, "push", "sha256=" + "0".repeat(64))).status, 401);
    assert.equal((await post({ ...payload, repository: { id: 999 } })).status, 404);
    assert.equal((await post({ ...payload, installation: { id: 999 } })).status, 404);
    assert.equal((await post(payload, "ping")).status, 202);
    assert.equal((await post(payload)).status, 202);
    assert.equal((await (await post(payload)).json()).duplicate, true);
    const pr = { ...payload, action: "opened", number: 7, pull_request: { title: "Review <script>", number: 7 } };
    assert.equal((await post(pr, "pull_request", null, "delivery-2")).status, 202);
    const records = await (await fetch(f.origin + "/api/events?projectId=" + f.project.id)).json();
    assert.equal(records.length, 2);
    assert.ok(records.some((event) => event.payload_summary.includes("opened")));
    assert.equal((await fetch(f.origin + "/api/events")).status, 400);
    assert.equal(f.github.creates, 0);
});

test("HTTP: only explicit frontend assets are served, including with encoded paths", async (t) => {
    const f = await start(t);
    for (const resource of ["/", "/script.js", "/style.css", "/projects.html", "/projects.js"]) {
        const response = await fetch(f.origin + resource);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.ok(response.headers.get("content-security-policy").includes("connect-src 'self'"));
    }
    for (const resource of ["/.env", "/.env.example", "/ai.config.json", "/ai.config.example.json", "/.git/config", "/server.js", "/ai-api.js", "/lib/github.js", "/.data/tasks.json", "/github-app-keys/test.pem", "/%2eenv", "/%2e%2e/.env"]) {
        assert.equal((await fetch(f.origin + resource)).status, 404, resource);
    }
});

test("HTTP: cross-origin requests, bad JSON and oversized bodies cannot create branches", async (t) => {
    const f = await start(t);
    const post = (headers, body = "{}") => fetch(`${f.origin}/api/tasks`, { method: "POST", headers, body });
    assert.equal((await post({ "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post({ "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ "Content-Type": "application/json" }, "{")).status, 400);
    assert.equal((await post({ "Content-Type": "application/json" }, "null")).status, 400);
    assert.equal((await post({ "Content-Type": "application/json" }, JSON.stringify({ title: "x".repeat(20_000) }))).status, 413);
    assert.equal((await fetch(`${f.origin}/api/tasks`, { method: "OPTIONS" })).status, 405);
    const hostileHostStatus = await new Promise((resolve, reject) => {
        const request = http.get(f.origin, { headers: { Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on("error", reject);
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal(f.github.creates, 0);
});

test("HTTP: project catalog, link connection, base changes and disconnect never write GitHub refs", async (t) => {
    const f = await start(t);
    const headers = { "Content-Type": "application/json", Origin: f.origin };
    const mutate = async (url, method, value) => {
        const response = await fetch(f.origin + url, { method, headers, body: JSON.stringify(value) });
        assert.equal(response.status, 200);
        return response.json();
    };
    const catalog = await (await fetch(f.origin + "/api/github/repositories")).json();
    assert.equal(catalog.repositories.length, 2);
    assert.equal((await mutate("/api/github/repositories/resolve", "POST", { url: "https://github.com/example/habits.git" })).repository.repositoryId, 202);
    const { project } = await mutate("/api/projects", "POST", { repositoryId: 202, installationId: "untrusted-id" });
    assert.equal(project.installationId, "2");
    assert.equal((await mutate(`/api/projects/${project.id}`, "PATCH", { baseBranch: "develop" })).project.baseBranch, "develop");
    assert.equal((await mutate(`/api/projects/${project.id}`, "PATCH", { archived: true })).project.archived, true);
    assert.equal((await fetch(f.origin + "/api/tasks")).status, 400);
    assert.equal(f.github.creates, 0);
});

test("HTTP: confirmation is explicit, scoped, validates answers and remains idempotent", async (t) => {
    const f = await start(t);
    f.tasks.generate = async () => ({ ...specification, questions: ["Как искать?"] });
    const post = (route, body, extra = {}) => fetch(f.origin + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: f.origin, ...extra }, body: JSON.stringify(body) });
    const source = "Добавить поиск. Способ не выбран.";
    const { task } = await (await post("/api/tasks", { projectId: f.project.id, requestId: randomUUID(), title: source, type: "tests" })).json();
    const route = `/api/tasks/${task.id}/confirm`;
    assert.equal(task.state, "clarification_required");
    assert.equal(f.github.creates, 0);
    assert.equal((await post(route, { ...specification, draftRevision: task.draftRevision, answers: [] })).status, 400);
    assert.equal((await post(route, { ...specification, answers: ["По подстроке"] }, { Origin: "https://evil.example" })).status, 403);
    const payload = { draftRevision: task.draftRevision, title: "Поиск", description: "Проверенное описание", answers: ["По подстроке"], branch: "main", repository: "evil/repo" };
    const confirmed = await (await post(route, payload)).json();
    assert.equal(confirmed.task.input, source);
    assert.equal(confirmed.task.repository, f.project.fullName);
    assert.equal(confirmed.task.branch, `chore/task-${task.id}`);
    assert.equal(confirmed.task.clarifications[0].answer, "По подстроке");
    assert.equal((await post(route, payload)).status, 200);
    const board = await (await fetch(f.origin + `/api/tasks?projectId=${f.project.id}`)).json();
    assert.equal(board.tasks[0].description, payload.description);
    assert.equal(f.github.creates, 1);
});
