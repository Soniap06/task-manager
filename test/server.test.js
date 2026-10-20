const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { createApp } = require("../server");
const { fixture, specification } = require("./helpers");

async function start(t) {
    const f = await fixture(t);
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
    assert.equal(task.state, "branch_created");
    const again = await fetch(`${f.origin}/api/tasks`, { method: "POST", headers, body });
    assert.equal((await again.json()).task.id, task.id);
    const moved = await fetch(`${f.origin}/api/tasks/${task.id}/column`, { method: "POST", headers, body: JSON.stringify({ column: "progress" }) });
    assert.equal((await moved.json()).task.column, "progress");
    const board = await (await fetch(`${f.origin}/api/tasks?projectId=${f.project.id}`)).json();
    assert.equal(board.tasks.length, 1);
    assert.equal(board.tasks[0].column, "progress");
    assert.equal(f.github.creates, 1);
});

test("HTTP: only explicit frontend assets are served, including with encoded paths", async (t) => {
    const f = await start(t);
    for (const resource of ["/", "/script.js", "/style.css", "/projects.html", "/projects.js"]) {
        const response = await fetch(f.origin + resource);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.ok(response.headers.get("content-security-policy").includes("connect-src 'self'"));
    }
    for (const resource of ["/.env", "/.env.example", "/.git/config", "/server.js", "/ai-api.js", "/lib/github.js", "/.data/tasks.json", "/github-app-keys/test.pem", "/%2eenv", "/%2e%2e/.env"]) {
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
