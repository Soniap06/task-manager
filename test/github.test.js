const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, verify } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createJwt, GitHubClient } = require("../lib/github");
const { fixture, sha } = require("./helpers");

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

test("JWT uses RS256, the configured issuer, clock skew and short expiry", () => {
    const now = 1_700_000_000_000;
    const jwt = createJwt("123", keys.privateKey, now);
    const [header, claims, signature] = jwt.split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
    assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { iss: "123", iat: now / 1000 - 60, exp: now / 1000 + 540 });
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, "base64url")), true);
});

async function clientFixture(t, handler) {
    const f = await fixture(t);
    const keyFile = path.join(f.dir, "test.pem");
    await fs.writeFile(keyFile, keys.privateKey.export({ type: "pkcs1", format: "pem" }));
    let now = Date.now();
    let tokens = 0;
    const requests = [];
    const client = new GitHubClient({ ...f.github.config, privateKeyPath: keyFile }, {
        now: () => now,
        fetchFn: async (url, options) => {
            assert.ok(url.startsWith("https://api.github.com/"));
            assert.equal(options.redirect, "error");
            requests.push({ url, options });
            if (url.endsWith("/access_tokens")) {
                tokens++;
                const body = JSON.parse(options.body);
                assert.ok(["read", "write"].includes(body.permissions.contents));
                if (body.permissions.contents === "read") assert.equal(body.repositories, undefined);
                else if (!body.repository_ids) assert.deepEqual(body.repositories, ["test"]);
                return json({ token: `test-token-${tokens}`, expires_at: new Date(now + 3_600_000).toISOString() });
            }
            return handler ? handler(url, options) : json({ ref: "refs/heads/main", object: { sha } });
        }
    });
    return { client, requests, tokens: () => tokens, advance: (ms) => { now += ms; } };
}

test("installation token is scoped, cached and renewed before expiry", async (t) => {
    const f = await clientFixture(t);
    assert.equal(await f.client.baseSha(), sha);
    await f.client.baseSha();
    assert.equal(f.tokens(), 1);
    f.advance(3_550_000);
    await f.client.baseSha();
    assert.equal(f.tokens(), 2);
});

test("401 refreshes an installation token once", async (t) => {
    let calls = 0;
    const f = await clientFixture(t, () => ++calls === 1 ? json({}, 401) : json({ ref: "refs/heads/main", object: { sha } }));
    await f.client.baseSha();
    assert.equal(f.tokens(), 2);
    assert.equal(calls, 2);
});

for (const status of [401, 403, 404, 409, 422, 429, 500]) {
    test(`GitHub ${status} is a safe, explicit error`, async (t) => {
        const f = await clientFixture(t, () => json({ message: "DO-NOT-LEAK-secret" }, status));
        await assert.rejects(f.client.baseSha(), (error) => {
            assert.equal(error.upstreamStatus, status);
            assert.ok(!error.message.includes("DO-NOT-LEAK"));
            return true;
        });
    });
}

test("missing ref returns null; create uses exact refs/heads and base SHA", async (t) => {
    const f = await clientFixture(t, (url, options) => {
        if (options.method === "POST") {
            assert.deepEqual(JSON.parse(options.body), { ref: "refs/heads/feat/task-one", sha });
            return json({ ref: "refs/heads/feat/task-one", object: { sha } }, 201);
        }
        return json({}, 404);
    });
    assert.equal(await f.client.getRef("feat/task-one"), null);
    await f.client.createBranch("feat/task-one", sha);
    assert.ok(f.requests.some((r) => r.url.endsWith("/git/ref/heads/feat%2Ftask-one")));
});

test("network errors do not expose tokens or raw exception text", async (t) => {
    const f = await clientFixture(t, () => { throw new Error("Authorization: private-token"); });
    await assert.rejects(f.client.baseSha(), (error) => error.code === "github_unavailable" && !error.message.includes("private-token"));
});

test("discovery paginates and write tokens are isolated by repository ID", async (t) => {
    const f = await clientFixture(t, (url, options) => {
        if (url.includes("/installation/repositories")) {
            const page = new URL(url).searchParams.get("page");
            return json({ total_count: 101, repositories: page === "1" ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }] });
        }
        return json({ ref: "refs/heads/main", object: { sha } });
    });
    assert.equal((await f.client.listRepositories()).length, 101);
    const first = f.client.forRepository({ owner: "example", name: "a", repositoryId: 101, installationId: "2", baseBranch: "main" });
    const second = f.client.forRepository({ owner: "example", name: "b", repositoryId: 202, installationId: "2", baseBranch: "main" });
    await first.baseSha();
    await second.baseSha();
    await first.baseSha();
    const scopes = f.requests.filter((item) => item.url.endsWith("/access_tokens")).map((item) => JSON.parse(item.options.body));
    assert.equal(scopes.length, 3);
    assert.deepEqual(scopes[1].repository_ids, [101]);
    assert.deepEqual(scopes[2].repository_ids, [202]);
});
