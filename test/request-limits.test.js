const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWindowLimit, singleGeneration } = require("../lib/request-limits");

test("attempt budget cannot be exceeded and resets after the interval", () => {
    let now = 0;
    const allow = createWindowLimit(2, 60_000, () => now);
    assert.equal(allow(), true);
    assert.equal(allow(), true);
    assert.equal(allow(), false);
    now = 59_999;
    assert.equal(allow(), false);
    now = 60_000;
    assert.equal(allow(), true);
});

test("parallel model calls are rejected and slot is released after success or failure", async () => {
    let release;
    const generate = singleGeneration(() => new Promise((resolve) => { release = resolve; }));
    const first = generate();
    await assert.rejects(generate(), { code: "ai_busy", status: 429 });
    release("draft");
    assert.equal(await first, "draft");
    const second = generate();
    release("next");
    assert.equal(await second, "next");
    const failing = singleGeneration(async () => { throw new Error("offline"); });
    await assert.rejects(failing(), /offline/);
    await assert.rejects(failing(), /offline/);
});
