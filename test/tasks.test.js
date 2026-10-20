const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fixture, specification, sha } = require("./helpers");
const { TaskStore } = require("../lib/store");
const { TaskService } = require("../lib/tasks");
const { AppError } = require("../lib/errors");

const input = (projectId) => ({ projectId, requestId: randomUUID(), title: "Форма входа" });

test("parallel requests create one persistent task and one branch; moving never creates a branch", async (t) => {
    const f = await fixture(t);
    const request = input(f.project.id);
    const results = await Promise.all([f.service.create(request), f.service.create(request), f.service.create(request)]);
    assert.equal(new Set(results.map((task) => task.id)).size, 1);
    assert.equal(results[0].state, "branch_created");
    assert.equal(results[0].baseSha, sha);
    assert.ok(results[0].branchUrl.startsWith("https://github.com/example/test/tree/"));
    assert.equal(f.github.creates, 1);
    assert.equal(f.generations(), 1);
    await assert.rejects(f.service.create({ ...request, title: "Другая задача" }), { code: "request_conflict" });
    await f.service.move(results[0].id, "review");
    assert.equal(f.github.creates, 1);
    await f.store.close();
    const reopened = await new TaskStore(f.dir).open();
    t.after(() => reopened.close());
    assert.equal(reopened.list()[0].column, "review");
    const resumed = new TaskService(reopened, f.github, async () => { throw new Error("Should not regenerate"); });
    assert.equal((await resumed.create(request)).state, "branch_created");
    assert.equal((await resumed.retry(results[0].id)).state, "branch_created");
    assert.equal(f.github.creates, 1);
});

test("timeout after successful GitHub creation is reconciled without another POST", async (t) => {
    const f = await fixture(t);
    f.github.createBranch = async function(name, value) { this.creates++; this.refs.set(this.key(name), value); throw new AppError(502, "github_unavailable", "Timeout"); };
    const task = await f.service.create(input(f.project.id));
    assert.equal(task.state, "branch_created");
    await f.service.retry(task.id);
    assert.equal(f.github.creates, 1);
});

test("failed branch creation is retained and can be retried without LLM regeneration", async (t) => {
    const f = await fixture(t);
    const create = f.github.createBranch;
    f.github.createBranch = async () => { throw new AppError(502, "github_403", "Недостаточно прав"); };
    const task = await f.service.create(input(f.project.id));
    assert.equal(task.state, "branch_error");
    assert.equal(task.branchUrl, null);
    f.github.createBranch = create;
    const retried = await f.service.retry(task.id);
    assert.equal(retried.state, "branch_created");
    assert.equal(retried.branch, task.branch);
    assert.equal(f.generations(), 1);
});

test("invalid LLM result cannot trigger GitHub writes; retry can recover generation", async (t) => {
    const f = await fixture(t);
    f.service.generate = async () => ({ ...specification, branch: "main" });
    const task = await f.service.create(input(f.project.id));
    assert.equal(task.state, "generation_error");
    assert.equal(f.github.creates, 0);
    f.service.generate = async () => specification;
    assert.equal((await f.service.retry(task.id)).state, "branch_created");
});

test("pre-existing foreign branch is not adopted, even at the expected SHA", async (t) => {
    const f = await fixture(t);
    f.github.getRef = async () => sha;
    const task = await f.service.create(input(f.project.id));
    assert.equal(task.state, "branch_error");
    assert.equal(task.error.code, "branch_conflict");
    assert.equal(f.github.creates, 0);
});

test("restart reconciles a pending successful POST and preserves the original base", async (t) => {
    const f = await fixture(t);
    const task = await f.service.create(input(f.project.id));
    await f.service.save(task, { state: "branch_pending", branchUrl: null });
    f.github.baseSha = async () => "b".repeat(40);
    const restarted = new TaskService(f.store, f.github, async () => { throw new Error("No LLM"); });
    await restarted.recover();
    assert.equal(restarted.list(f.project.id)[0].state, "branch_created");
    assert.equal(restarted.list(f.project.id)[0].baseSha, sha);
    assert.equal(f.github.creates, 1);
});

test("repository changes cannot redirect an existing task's retry", async (t) => {
    const f = await fixture(t);
    f.github.createBranch = async () => { throw new AppError(502, "github_403", "Forbidden"); };
    const task = await f.service.create(input(f.project.id));
    f.github.config.installationId = "3";
    const result = await f.service.retry(task.id);
    assert.equal(result.error.code, "installation_changed");
});

test("failed persistence before POST prevents GitHub writes", async (t) => {
    const f = await fixture(t);
    const put = f.store.put.bind(f.store);
    f.store.put = async (task) => {
        if (task.createAttempted) throw new AppError(503, "store_write", "No space");
        return put(task);
    };
    await assert.rejects(f.service.create(input(f.project.id)), { code: "store_write" });
    assert.equal(f.github.creates, 0);
    assert.equal(f.store.list()[0].state, "branch_pending");
});

test("failure saving success is reconciled by retry rather than duplicated", async (t) => {
    const f = await fixture(t);
    const put = f.store.put.bind(f.store);
    f.store.put = async (task) => {
        if (task.state === "branch_created") throw new AppError(503, "store_write", "No space");
        return put(task);
    };
    const request = input(f.project.id);
    await assert.rejects(f.service.create(request), { code: "store_write" });
    f.store.put = put;
    await f.service.retry(f.store.list()[0].id);
    assert.equal(f.github.creates, 1);
    assert.equal(f.store.list()[0].state, "branch_created");
});

test("store refuses concurrent servers and preserves corrupt files", async (t) => {
    const f = await fixture(t);
    await assert.rejects(new TaskStore(f.dir).open(), { code: "store_locked" });
    await f.store.close();
    await fs.writeFile(path.join(f.dir, "tasks.json"), "broken JSON");
    await assert.rejects(new TaskStore(f.dir).open(), { code: "store_invalid" });
    assert.equal(await fs.readFile(path.join(f.dir, "tasks.json"), "utf8"), "broken JSON");
});
