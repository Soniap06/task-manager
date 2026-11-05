const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, specification, sha } = require("./helpers");
const { branchName, validateBranchSlug } = require("../lib/task-draft");
const { createLlm } = require("../lib/llm");

const input = (f, patch = {}) => ({ requestId: randomUUID(), projectId: f.project.id, title: "Категории привычек", readableBranch: true, ...patch });
const confirmation = (task, branchSlug = "habit-categories") => ({ title: task.title, description: task.description, draftRevision: task.draftRevision, branchSlug });

test("readable names use trusted type and ID while rejecting invalid semantic names", () => {
    for (const [type, prefix] of [["feature", "feat"], ["fix", "fix"], ["tests", "test"], ["docs", "docs"]]) {
        assert.equal(branchName(type, "abcd1234-1234-4000-8000-123456789012", "habit-categories"), `${prefix}/habit-categories-abcd1234`);
    }
    for (const slug of [undefined, null, "", "Hi", "a", "Привычки", "feat/foo", "-foo", "foo-", "foo--bar", "foo..bar", "a".repeat(61), "foo bar", "foo\n"]) {
        assert.throws(() => validateBranchSlug(slug), { code: "branch_slug" });
    }
});

test("separate naming request uses final draft and accepts only a slug", async () => {
    const generate = createLlm({}, { fetchFn: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.response_format.json_schema.schema.required, ["slug"]);
        assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
        assert.equal(JSON.parse(body.messages[1].content).draft.description, "Добавить необязательные категории");
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"slug":"habit-categories"}' } }] }));
    } });
    assert.deepEqual(await generate("Категории", { branchNaming: true, description: "Добавить необязательные категории" }), { slug: "habit-categories" });
    for (const result of [{ slug: "feat/foo" }, { slug: "habit-categories", prefix: "main" }]) {
        const bad = createLlm({}, { fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] })) });
        await assert.rejects(bad("Задача", { branchNaming: true }));
    }
});

test("suggestion creates no ref, edited slug is confirmed once and existing branches stay unchanged", async (t) => {
    const f = await fixture(t);
    let namingContext;
    f.service.generate = async (text, context) => {
        if (context.branchNaming) { namingContext = context; return { slug: "habit-categories" }; }
        return specification;
    };
    const draft = await f.service.create(input(f, { type: "docs" }));
    assert.equal(draft.branchSlug, "habit-categories");
    assert.equal(namingContext.description, specification.description);
    assert.equal(f.github.creates, 0);
    await assert.rejects(f.service.confirm(draft.id, confirmation(draft, "../bad")), { code: "branch_slug" });
    assert.equal(f.service.find(draft.id).branch, null);
    const done = await f.service.confirm(draft.id, confirmation(draft, "category-guide"));
    assert.equal(done.branch, `docs/category-guide-${draft.id.slice(0, 8)}`);
    assert.equal(done.state, "branch_created");
    const again = await f.service.confirm(draft.id, confirmation(draft, "other-name"));
    assert.equal(again.branch, done.branch);
    assert.equal(f.github.creates, 1);
});

test("offline naming preserves the task and permits manual naming; occupied refs are never overwritten", async (t) => {
    const f = await fixture(t);
    f.service.generate = async (text, context) => {
        if (context.branchNaming) throw new Error("private failure");
        return specification;
    };
    const draft = await f.service.create(input(f, { type: "fix" }));
    assert.equal(draft.state, "draft_ready");
    assert.equal(draft.branchSlug, "");
    assert.ok(draft.branchSuggestionError);
    assert.equal(JSON.stringify(draft).includes("private failure"), false);
    const name = branchName("fix", draft.id, "habit-delete-validation");
    f.github.refs.set(f.github.key(name), sha);
    await assert.rejects(f.service.confirm(draft.id, confirmation(draft, "habit-delete-validation")), { code: "branch_conflict" });
    assert.equal(f.service.find(draft.id).branch, null);
    assert.equal(f.github.creates, 0);
    const done = await f.service.confirm(draft.id, confirmation(draft, "habit-delete-guard"));
    assert.equal(done.state, "branch_created");
});

test("manual cards require a valid name without calling the model", async (t) => {
    const f = await fixture(t);
    const draft = await f.service.create(input(f, { useAi: false, type: "tests" }));
    await assert.rejects(f.service.confirm(draft.id, { ...confirmation(draft), branchSlug: undefined }), { code: "branch_slug" });
    const done = await f.service.confirm(draft.id, confirmation(draft, "habit-history"));
    assert.match(done.branch, /^test\/habit-history-/);
    assert.equal(f.generations(), 0);
});


test("grilling suggests a name only after the final batch, using the resulting description", async (t) => {
    const f = await fixture(t);
    let names = 0;
    f.service.generate = async (text, context) => {
        if (context.branchNaming) { names++; assert.equal(context.description, "Финальная задача"); return { slug: "habit-categories" }; }
        const count = context.clarifications?.length || 0;
        return { ...specification, description: count === 9 ? "Финальная задача" : "Промежуточная задача", questions: count < 9 ? [1, 2, 3].map((n) => `Вопрос ${count + n}?`) : [] };
    };
    let draft = await f.service.create(input(f, { grilling: true }));
    for (let i = 0; i < 3; i++) {
        assert.equal(names, 0);
        assert.equal(f.github.creates, 0);
        draft = await f.service.clarify(draft.id, { ...confirmation(draft), answers: draft.questions.map(() => "Ответ") });
    }
    assert.equal(names, 1);
    assert.equal(draft.grillingReady, true);
    assert.equal(draft.branchSlug, "habit-categories");
    assert.equal(f.github.creates, 0);
});


test("model-supplied duplicate type prefix is removed before preview", async (t) => {
    const f = await fixture(t);
    f.service.generate = async (text, context) => context.branchNaming ? { slug: "fix-habit-deletion" } : specification;
    const task = await f.service.create(input(f, { type: "fix" }));
    assert.equal(task.branchSlug, "habit-deletion");
    const done = await f.service.confirm(task.id, confirmation(task, task.branchSlug));
    assert.match(done.branch, /^fix\/habit-deletion-/);
});
