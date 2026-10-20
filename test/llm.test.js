const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createLlm, validateSpecification, branchName } = require("../lib/llm");
const { specification } = require("./helpers");

test("server sends the task to configured LM Studio and validates JSON", async () => {
    const generate = createLlm({ endpoint: "http://127.0.0.1:1234/v1/chat/completions", model: "local-model" }, {
        fetchFn: async (url, options) => {
            assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
            const body = JSON.parse(options.body);
            assert.equal(body.model, "local-model");
            assert.equal(body.messages[1].content, "Название задачи: Вход");
            assert.equal(options.headers.Authorization, undefined);
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(specification) } }] }));
        }
    });
    assert.deepEqual(await generate("Вход"), specification);
    assert.equal(branchName(specification.branch, "123"), "feat/task-123-login-form");
});

for (const patch of [{ branch: "../../main" }, { branch: "feat/a..b" }, { branch: "main" }, { title: "" }, { steps: [] }, { acceptanceCriteria: [null] }, { title: "x".repeat(301) }]) {
    test(`invalid LLM contract is rejected: ${JSON.stringify(patch).slice(0, 65)}`, () => {
        assert.throws(() => validateSpecification({ ...specification, ...patch }), { code: "llm_contract" });
    });
}

test("malformed JSON, HTTP failure and offline model produce safe errors", async () => {
    for (const [response, code] of [
        [new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] })), "llm_json"],
        [new Response("private provider error", { status: 503 }), "llm_http"]
    ]) {
        const generate = createLlm({}, { fetchFn: async () => response });
        await assert.rejects(generate("Вход"), (error) => error.code === code && !error.message.includes("private provider"));
    }
    await assert.rejects(createLlm({}, { fetchFn: async () => { throw new Error("private endpoint"); } })("Вход"), { code: "llm_unavailable" });
});

test("LM Studio reasoning field is accepted only as an entire valid schema JSON", async () => {
    const valid = JSON.stringify(specification);
    const generate = (message) => createLlm({}, {
        fetchFn: async () => new Response(JSON.stringify({ choices: [{ message }] }))
    })("Вход");
    assert.deepEqual(await generate({ content: "", reasoning_content: valid }), specification);
    await assert.rejects(generate({ content: "", reasoning_content: `My reasoning: ${valid}` }), { code: "llm_json" });
    await assert.rejects(generate({ content: "not JSON", reasoning_content: valid }), { code: "llm_json" });
    await assert.rejects(generate({ content: "", reasoning_content: JSON.stringify({ ...specification, branch: "main" }) }), { code: "llm_contract" });
});
