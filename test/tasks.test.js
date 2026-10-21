const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fixture, specification, sha, createConfirmed } = require("./helpers");
const { TaskStore } = require("../lib/store");
const { TaskService } = require("../lib/tasks");
const { AppError } = require("../lib/errors");

const input = (projectId) => ({ projectId, requestId: randomUUID(), title: "Форма входа" });

test("parallel requests create one persistent task and one branch; moving never creates a branch", async (t) => {
    const f = await fixture(t);
    const request = input(f.project.id);
    const results = await Promise.all([createConfirmed(f.service, request), createConfirmed(f.service, request), createConfirmed(f.service, request)]);
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
    const task = await createConfirmed(f.service, input(f.project.id));
    assert.equal(task.state, "branch_created");
    await f.service.retry(task.id);
    assert.equal(f.github.creates, 1);
});

test("failed branch creation is retained and can be retried without LLM regeneration", async (t) => {
    const f = await fixture(t);
    const create = f.github.createBranch;
    f.github.createBranch = async () => { throw new AppError(502, "github_403", "Недостаточно прав"); };
    const task = await createConfirmed(f.service, input(f.project.id));
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
    const task = await createConfirmed(f.service, input(f.project.id));
    assert.equal(task.state, "generation_error");
    assert.equal(f.github.creates, 0);
    f.service.generate = async () => specification;
    const ready = await f.service.retry(task.id);
    assert.equal(ready.state, "draft_ready");
    assert.equal((await f.service.confirm(task.id, ready)).state, "branch_created");
});

test("pre-existing foreign branch is not adopted, even at the expected SHA", async (t) => {
    const f = await fixture(t);
    f.github.getRef = async () => sha;
    const task = await createConfirmed(f.service, input(f.project.id));
    assert.equal(task.state, "branch_error");
    assert.equal(task.error.code, "branch_conflict");
    assert.equal(f.github.creates, 0);
});

test("restart reconciles a pending successful POST and preserves the original base", async (t) => {
    const f = await fixture(t);
    const task = await createConfirmed(f.service, input(f.project.id));
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
    const task = await createConfirmed(f.service, input(f.project.id));
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
    await assert.rejects(createConfirmed(f.service, input(f.project.id)), { code: "store_write" });
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
    await assert.rejects(createConfirmed(f.service, request), { code: "store_write" });
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

test("generation receives the task repository and truncated output cannot create a GitHub branch", async (t) => {
    const f = await fixture(t);
    const { createLlm } = require("../lib/llm");
    const generate = createLlm({}, { fetchFn: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(specification) } }] })) });
    f.service.generate = async (title, context) => {
        assert.equal(context.repository, f.project.fullName);
        assert.equal(title, "Форма входа");
        return generate(title, context);
    };
    const result = await createConfirmed(f.service, input(f.project.id));
    assert.equal(result.state, "generation_error");
    assert.equal(result.error.code, "llm_truncated");
    assert.equal(f.github.creates, 0);
    f.service.generate = async () => specification;
    const ready = await f.service.retry(result.id);
    assert.equal(ready.state, "draft_ready");
    assert.equal((await f.service.confirm(result.id, ready)).state, "branch_created");
    assert.equal(f.github.creates, 1);
});

test("extra model fields cannot trigger a GitHub write", async (t) => {
    const f = await fixture(t);
    const { createLlm } = require("../lib/llm");
    f.service.generate = createLlm({}, { fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...specification, acceptanceCriteria: ["Пустой запрос возвращает все записи"] }) } }] })) });
    const result = await createConfirmed(f.service, input(f.project.id));
    assert.equal(result.state, "generation_error");
    assert.equal(result.error.code, "llm_contract");
    assert.equal(f.github.creates, 0);
});


test("creation and clarification retries never create a branch before explicit confirmation", async (t) => {
    const f = await fixture(t);
    f.service.generate = async () => ({ ...specification, questions: ["Искать по подстроке или префиксу?"] });
    const request = { ...input(f.project.id), type: "fix" };
    const draft = await f.service.create(request);
    assert.equal(draft.state, "clarification_required");
    assert.equal(draft.branch, null);
    assert.equal(draft.input, request.title);
    assert.equal(f.github.creates, 0);
    assert.equal((await f.service.retry(draft.id)).state, "clarification_required");
    assert.equal(f.github.creates, 0);
    await assert.rejects(f.service.confirm(draft.id, { ...specification, draftRevision: f.service.find(draft.id).draftRevision, answers: [] }), { code: "task_confirmation" });
    await assert.rejects(f.service.confirm(draft.id, { ...specification, draftRevision: f.service.find(draft.id).draftRevision, answers: [" "] }), { code: "task_confirmation" });
    const confirmed = await f.service.confirm(draft.id, { title: "Поиск привычек", description: "Описание после проверки", draftRevision: f.service.find(draft.id).draftRevision, answers: ["По подстроке"] });
    assert.equal(confirmed.branch, `fix/task-${draft.id}`);
    assert.equal(confirmed.input, request.title);
    assert.deepEqual(confirmed.clarifications, [{ question: draft.questions[0], answer: "По подстроке" }]);
    assert.equal(confirmed.title, "Поиск привычек");
    assert.equal(confirmed.description, "Описание после проверки");
    await f.service.confirm(draft.id, { title: "Не заменять", description: "После подтверждения" });
    assert.equal(f.service.find(draft.id).title, "Поиск привычек");
    assert.equal(f.github.creates, 1);
});

test("manual drafts and failed AI can be confirmed without another model call", async (t) => {
    const f = await fixture(t);
    for (const type of ["feature", "fix", "tests", "docs"]) {
        const request = { ...input(f.project.id), type, useAi: false };
        const draft = await f.service.create(request);
        assert.equal(draft.state, "draft_ready");
        assert.equal(draft.description, request.title);
        assert.equal(f.generations(), 0);
        const result = await f.service.confirm(draft.id, draft);
        assert.match(result.branch, new RegExp(`^${type === "feature" ? "feat" : type === "fix" ? "fix" : "chore"}/task-`));
    }
    f.service.generate = async () => { throw new AppError(502, "llm_unavailable", "Нет модели"); };
    const failed = await f.service.create(input(f.project.id));
    assert.equal(failed.state, "generation_error");
    assert.equal(failed.description, failed.input);
    assert.equal((await f.service.confirm(failed.id, failed)).state, "branch_created");
});

test("task type participates in idempotency and rejects unsupported values", async (t) => {
    const f = await fixture(t);
    const request = { ...input(f.project.id), type: "tests" };
    await f.service.create(request);
    await assert.rejects(f.service.create({ ...request, type: "feature" }), { code: "request_conflict" });
    await assert.rejects(f.service.create({ ...input(f.project.id), type: "main" }), { code: "task_type" });
    assert.equal(f.github.creates, 0);
});


test("regenerating a draft invalidates stale answers from another tab", async (t) => {
    const f = await fixture(t);
    f.service.generate = async () => ({ ...specification, questions: ["Первый вопрос?"] });
    const draft = await f.service.create(input(f.project.id));
    f.service.generate = async () => ({ ...specification, questions: ["Другой вопрос?"] });
    const revised = await f.service.retry(draft.id);
    await assert.rejects(f.service.confirm(draft.id, { ...draft, answers: ["Старый ответ"] }), { code: "draft_changed" });
    assert.equal(f.github.creates, 0);
    assert.equal((await f.service.confirm(draft.id, { ...revised, answers: ["Новый ответ"] })).state, "branch_created");
    assert.equal(f.service.find(draft.id).clarifications[0].question, "Другой вопрос?");
});


test("previous unconfirmed cards can enter the new draft flow without changing repository", async (t) => {
    const f = await fixture(t);
    const created = await f.service.create(input(f.project.id));
    const { draftVersion, draftRevision, description, questions, ...oldCard } = created;
    await f.store.put({ ...oldCard, state: "generation_error" });
    const ready = await f.service.retry(created.id);
    assert.equal(ready.draftVersion, 1);
    assert.equal(ready.state, "draft_ready");
    assert.equal(ready.input, created.input);
    assert.equal(f.github.creates, 0);
    const result = await f.service.confirm(ready.id, ready);
    assert.equal(result.repositoryId, created.repositoryId);
    assert.equal(result.state, "branch_created");
});
