const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const defaults = require("../ai.config.example.json");

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-manager-config-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, write: (value) => fs.writeFile(path.join(root, "ai.config.json"), JSON.stringify(value)) };
}

test("AI API, model and generation settings are read from the separate root file", async (t) => {
    const f = await fixture(t);
    const config = { ...defaults, endpoint: "https://example.test/v1/chat/completions", model: "another-model", timeoutMs: 45000, apiKeyEnv: "CUSTOM_AI_KEY", generation: { ...defaults.generation, temperature: 0.3, max_tokens: 800 } };
    await f.write(config);
    const actual = loadConfig({ CUSTOM_AI_KEY: "server-test-key", LM_STUDIO_MODEL: "obsolete-model", LM_STUDIO_ENDPOINT: "http://obsolete.test" }, f.root).llm;
    assert.equal(actual.endpoint, config.endpoint);
    assert.equal(actual.model, "another-model");
    assert.equal(actual.timeoutMs, 45000);
    assert.deepEqual(actual.generation, config.generation);
    assert.equal(actual.apiKey, "server-test-key");
});

test("missing local AI file uses safe defaults without requiring a key", async (t) => {
    const f = await fixture(t);
    const actual = loadConfig({}, f.root).llm;
    assert.equal(actual.endpoint, defaults.endpoint);
    assert.equal(actual.model, defaults.model);
    assert.equal(actual.apiKey, "");
});

test("invalid AI settings fail clearly without echoing config or secrets", async (t) => {
    const f = await fixture(t);
    for (const config of [null, { ...defaults, endpoint: "file:///private-data" }, { ...defaults, endpoint: "https://secret:password@example.test" }, { ...defaults, timeoutMs: -1 }, { ...defaults, generation: { ...defaults.generation, max_tokens: 0 } }, { ...defaults, generation: { ...defaults.generation, temperature: "hot" } }]) {
        await f.write(config);
        assert.throws(() => loadConfig({}, f.root), (error) => error.code === "ai_configuration" && !error.message.includes("password"));
    }
    await fs.writeFile(path.join(f.root, "ai.config.json"), "{broken JSON");
    assert.throws(() => loadConfig({}, f.root), { code: "ai_configuration" });
});

test("provider-specific sampling options can be removed in the editable AI file", async (t) => {
    const f = await fixture(t);
    const generation = { temperature: 0.3, max_tokens: 800 };
    await f.write({ ...defaults, generation });
    assert.deepEqual(loadConfig({}, f.root).llm.generation, generation);
});
