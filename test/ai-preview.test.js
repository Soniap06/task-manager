const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createLlm } = require("../lib/llm");
const { loadConfig } = require("../lib/config");
const { specification } = require("./helpers");

test("shared local/cloud AI client sends the optional key only as server Authorization", async () => {
    const config = loadConfig({ AI_API_KEY: "test-cloud-key" }).llm;
    assert.equal(config.apiKey, "test-cloud-key");
    const generate = createLlm(config, { fetchFn: async (url, request) => {
        assert.equal(request.headers.Authorization, "Bearer test-cloud-key");
        assert.ok(!request.body.includes("test-cloud-key"));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(specification) } }] }));
    } });
    assert.deepEqual(await generate("Форма доступна"), specification);
});
