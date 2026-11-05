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

test("shared mode accepts only a canonical Tailscale HTTPS origin and complete authentication", () => {
    const env = { SHARED_ORIGIN: "https://karina.example-tail.ts.net", DEMO_USERNAME: "team", DEMO_PASSWORD: "test-pass", SESSION_SECRET: "s".repeat(32) };
    assert.equal(loadConfig(env).sharedOrigin, env.SHARED_ORIGIN);
    for (const origin of ["http://karina.example-tail.ts.net", "https://evil.test", "https://karina.example-tail.ts.net/", "https://user:secret@karina.example-tail.ts.net", "https://karina.example-tail.ts.net/path"]) {
        assert.throws(() => loadConfig({ ...env, SHARED_ORIGIN: origin }), { code: "shared_configuration" });
    }
    for (const field of ["DEMO_USERNAME", "DEMO_PASSWORD", "SESSION_SECRET"]) {
        assert.throws(() => loadConfig({ ...env, [field]: "" }), { code: "shared_configuration" });
    }
});

test("DuckDNS requires an exact HTTPS origin and authentication", () => {
    const env = { SHARED_ORIGIN: "https://task-manager-karina-sonia.duckdns.org", DEMO_USERNAME: "team", DEMO_PASSWORD: "test-pass", SESSION_SECRET: "s".repeat(32) };
    assert.equal(loadConfig(env).sharedOrigin, env.SHARED_ORIGIN);
    for (const origin of ["http://task.duckdns.org", "https://task.duckdns.org/", "https://task.duckdns.org:444", "https://task.duckdns.org.evil.test", "https://user:pass@task.duckdns.org"]) {
        assert.throws(() => loadConfig({ ...env, SHARED_ORIGIN: origin }), { code: "shared_configuration" });
    }
});

test("fresh setup creates both configs and preserves personal settings on repeat", async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, "scripts"));
    for (const name of [".env.example", "ai.config.example.json", "scripts/setup.mjs"]) {
        await fs.copyFile(path.join(__dirname, "..", name), path.join(f.root, name));
    }
    const { execFileSync } = require("node:child_process");
    execFileSync(process.execPath, [path.join(f.root, "scripts/setup.mjs")]);
    assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), await fs.readFile(path.join(f.root, ".env.example"), "utf8"));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, "ai.config.json"), "utf8")), defaults);
    await fs.writeFile(path.join(f.root, ".env"), "PERSONAL_SETTING=keep\n");
    await fs.writeFile(path.join(f.root, "ai.config.json"), '{"personal":"keep"}\n');
    execFileSync(process.execPath, [path.join(f.root, "scripts/setup.mjs")]);
    assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), "PERSONAL_SETTING=keep\n");
    assert.equal(await fs.readFile(path.join(f.root, "ai.config.json"), "utf8"), '{"personal":"keep"}\n');
});
