const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, specification } = require("./helpers");
const { AppError } = require("../lib/errors");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createLlm } = require("../lib/llm");

const payload = (task) => ({ title: task.title, description: task.description, draftRevision: task.draftRevision, answers: task.questions.map(() => "Решение пользователя") });
async function setup(t, maximum = 9) {
    const f = await fixture(t);
    const contexts = [];
    f.service.generate = async (input, context) => {
        contexts.push(structuredClone(context));
        const answered = context.clarifications.length;
        return { ...specification, questions: answered < maximum ? Array.from({ length: Math.min(3, maximum - answered) }, (_, i) => `Какое поведение ${answered + i + 1}?`) : [] };
    };
    const task = await f.service.create({ requestId: randomUUID(), projectId: f.project.id, title: "Добавить категории привычек", grilling: true });
    return { ...f, task, contexts };
}

test("nine questions in three dependent rounds, separate confirmation and preserved history", async (t) => {
    const f = await setup(t);
    let task = f.task;
    for (let round = 0; round < 3; round++) {
        await assert.rejects(f.service.confirm(task.id, payload(task)), { code: "grilling_incomplete" });
        const stale = payload(task);
        task = await f.service.clarify(task.id, stale);
        await assert.rejects(f.service.clarify(task.id, stale));
        assert.equal(f.github.creates, 0);
        assert.equal(task.clarifications.length, (round + 1) * 3);
    }
    assert.equal(task.state, "draft_ready");
    assert.equal(f.contexts[3].clarifications.length, 9);
    assert.equal(task.input, f.task.input);
    assert.equal((await f.service.confirm(task.id, payload(task))).state, "branch_created");
    assert.equal(f.service.find(task.id).clarifications.length, 9);
    assert.equal(f.github.creates, 1);
});

test("complex tasks can reach thirty questions and never ask thirty-one", async (t) => {
    const f = await setup(t, 30);
    let task = f.task;
    for (let i = 0; i < 10; i++) task = await f.service.clarify(task.id, payload(task));
    assert.equal(task.clarifications.length, 30);
    assert.equal(task.state, "draft_ready");
    f.service.generate = async () => ({ ...specification, questions: ["Ещё один?"] });
    task = await f.service.retry(task.id);
    assert.equal(task.error.code, "grilling_budget");
    await assert.rejects(f.service.confirm(task.id, payload(task)), { code: "grilling_incomplete" });
    assert.equal(f.github.creates, 0);
});

test("early completion and repeated answered questions fail without false readiness", async (t) => {
    const f = await setup(t);
    f.service.generate = async () => specification;
    let task = await f.service.clarify(f.task.id, payload(f.task));
    assert.equal(task.error.code, "grilling_budget");
    assert.equal(task.clarifications.length, 3);
    f.service.generate = async () => ({ ...specification, questions: [f.task.questions[0], "Новая граница?", "Новый сценарий?"] });
    task = await f.service.retry(task.id);
    assert.equal(task.error.code, "grilling_repeat");
    assert.equal(task.grillingReady, false);
});

test("answers persist across model failure and retry; manual bypass requires explicit consent", async (t) => {
    const f = await setup(t);
    f.service.generate = async () => { throw new AppError(502, "llm_unavailable", "offline"); };
    const task = await f.service.clarify(f.task.id, payload(f.task));
    assert.equal(task.state, "generation_error");
    const persisted = JSON.parse(await fs.readFile(path.join(f.dir, "tasks.json"), "utf8"));
    assert.equal(persisted.tasks.find((x) => x.id === task.id).clarifications.length, 3);
    await assert.rejects(f.service.confirm(task.id, payload(task)), { code: "grilling_incomplete" });
    assert.equal((await f.service.confirm(task.id, { ...payload(task), manual: true })).grillingAbandoned, true);
});

test("LLM receives answers, current draft and question budget as data", async () => {
    const clarifications = [{ question: "Удалять привычки?", answer: "Нет", round: 1 }];
    const grilling = { minimum: 9, maximum: 30, answered: 1 };
    const generate = createLlm({}, { fetchFn: async (_, options) => {
        const body = JSON.parse(options.body);
        const data = JSON.parse(body.messages[1].content);
        assert.deepEqual(data.clarifications, clarifications);
        assert.deepEqual(data.grilling, grilling);
        assert.equal(data.draft.description, "Не удалять привычки");
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(specification) } }] }));
    } });
    await generate("Категории", { clarifications, grilling, description: "Не удалять привычки" });
});

test("rounds accept five and four questions and reject six", async (t) => {
    const f = await setup(t);
    f.service.generate = async (_, context) => ({ ...specification, questions: context.clarifications.length < 9 ? Array.from({ length: context.clarifications.length ? 4 : 5 }, (_, i) => `Выбор ${context.clarifications.length + i}?`) : [] });
    let task = await f.service.retry(f.task.id);
    assert.equal(task.questions.length, 5);
    task = await f.service.clarify(task.id, payload(task));
    assert.equal(task.questions.length, 4);
    task = await f.service.clarify(task.id, payload(task));
    assert.equal(task.state, "draft_ready");
    f.service.generate = async () => ({ ...specification, questions: Array.from({ length: 6 }, (_, i) => `Лишний ${i}?`) });
    task = await f.service.retry(task.id);
    assert.equal(task.error.code, "llm_contract");
    assert.equal(f.github.creates, 0);
});

test("a short final round finishes interview and cannot be followed by more questions", async (t) => {
    const f = await setup(t);
    f.service.generate = async (_, context) => ({ ...specification, questions: Array.from({ length: context.clarifications.length === 3 ? 4 : 2 }, (_, i) => `Решение ${context.clarifications.length + i}?`) });
    // The first three answers are already a valid full round.
    let task = await f.service.clarify(f.task.id, payload(f.task));
    task = await f.service.clarify(task.id, payload(task));
    assert.equal(task.clarifications.length, 7);
    assert.equal(task.questions.length, 2);
    task = await f.service.clarify(task.id, payload(task));
    assert.equal(task.error.code, "grilling_round");
    assert.equal(task.clarifications.length, 9);
    f.service.generate = async (_, context) => {
        assert.equal(context.grilling.finalize, true);
        return specification;
    };
    task = await f.service.retry(task.id);
    assert.equal(task.state, "draft_ready");
    assert.equal(f.github.creates, 0);
});
