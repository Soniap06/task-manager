const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { fixture, sha } = require("./helpers");
const { parseRepositoryUrl } = require("../lib/projects");
const { TaskStore } = require("../lib/store");
const { AppError } = require("../lib/errors");

test("GitHub URL parsing accepts repo links and rejects arbitrary destinations", () => {
    assert.equal(parseRepositoryUrl("https://github.com/example/habits.git"), "example/habits");
    for (const url of ["http://github.com/a/b", "https://evil.test/a/b", "https://user:password@github.com/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b?x=1", "https://github.com:444/a/b"]) {
        assert.throws(() => parseRepositoryUrl(url), { code: "repository_url" });
    }
});

test("connects once, resolves only allowed repos, checks actual default branch", async (t) => {
    const f = await fixture(t);
    const count = f.store.projects().length;
    assert.equal((await f.projects.connect({ repositoryId: 101 })).id, f.project.id);
    assert.equal(f.store.projects().length, count);
    assert.equal((await f.projects.resolve("https://github.com/example/habits.git")).repositoryId, 202);
    await assert.rejects(f.projects.resolve("https://github.com/unknown/repo"), { code: "repository_access" });
    await assert.rejects(f.projects.connect({ repositoryId: 303 }), { code: "repository_access" });
    assert.equal(f.github.creates, 0);
});

test("tasks and retries remain isolated in two projects after base changes", async (t) => {
    const f = await fixture(t);
    const b = await f.projects.connect({ repositoryId: 202 });
    const request = { projectId: f.project.id, requestId: randomUUID(), title: "Задача A" };
    const aTask = await f.service.create(request);
    const bTask = await f.service.create({ projectId: b.id, requestId: randomUUID(), title: "Задача B" });
    assert.ok(f.github.refs.has(f.github.key(aTask.branch, 101)));
    assert.ok(f.github.refs.has(f.github.key(bTask.branch, 202)));
    assert.equal(f.service.list(b.id).length, 1);
    await assert.rejects(f.service.create({ ...request, projectId: b.id }), { code: "request_conflict" });
    await f.projects.update(f.project.id, { baseBranch: "develop" });
    await f.service.save(aTask, { state: "branch_pending" });
    await f.service.recover();
    assert.equal(f.service.list(f.project.id)[0].baseBranch, "main");
    assert.equal(f.service.list(f.project.id)[0].baseSha, sha);
    assert.equal(f.github.creates, 2);
});

test("revoked access and archived projects cannot create new branches", async (t) => {
    const f = await fixture(t);
    await f.projects.update(f.project.id, { archived: true });
    await assert.rejects(f.service.create({ projectId: f.project.id, requestId: randomUUID(), title: "Задача" }), { code: "project_archived" });
    assert.equal(f.store.list().length, 0);
    await f.projects.update(f.project.id, { archived: false });
    f.github.listRepositories = async () => [];
    await assert.rejects(f.service.create({ projectId: f.project.id, requestId: randomUUID(), title: "Задача" }), { code: "repository_access" });
    assert.equal(f.github.creates, 0);
});

test("JSON v1 migration preserves original data and never guesses a project", async (t) => {
    const f = await fixture(t);
    await f.store.close();
    const original = JSON.stringify({ version: 1, tasks: [{ id: randomUUID(), requestId: randomUUID(), title: "Old task", repository: "example/old", state: "branch_pending", createAttempted: true }] });
    await fs.writeFile(path.join(f.dir, "tasks.json"), original);
    const store = await new TaskStore(f.dir).open();
    t.after(() => store.close());
    assert.equal(store.list()[0].projectId, null);
    assert.equal(store.list()[0].repository, "example/old");
    assert.equal(store.projects().length, 0);
    assert.equal(await fs.readFile(path.join(f.dir, "tasks.json.v1-backup"), "utf8"), original);
});

test("disconnecting while LLM runs prevents the later GitHub write", async (t) => {
    const f = await fixture(t);
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    f.service.generate = async () => {
        entered();
        await new Promise((resolve) => { release = resolve; });
        return require("./helpers").specification;
    };
    const creating = f.service.create({ projectId: f.project.id, requestId: randomUUID(), title: "Долгая задача" });
    await started;
    await f.projects.update(f.project.id, { archived: true });
    release();
    const task = await creating;
    assert.equal(task.state, "branch_error");
    assert.equal(task.error.code, "project_archived");
    assert.equal(f.github.creates, 0);
});

test("connect uses a non-main default and rejects archived or empty repositories", async (t) => {
    const f = await fixture(t);
    const listing = await f.github.listRepositories();
    f.github.listRepositories = async () => listing.map((repo) => ({ ...repo, default_branch: "trunk" }));
    f.github.baseSha = async (branch) => { assert.equal(branch, "trunk"); return sha; };
    assert.equal((await f.projects.connect({ repositoryId: 202 })).baseBranch, "trunk");
    f.github.listRepositories = async () => listing.map((repo) => ({ ...repo, archived: true }));
    await assert.rejects(f.projects.connect({ repositoryId: 202 }), { code: "repository_archived" });
    f.github.listRepositories = async () => listing;
    f.github.baseSha = async () => { throw new AppError(502, "github_404", "No base branch"); };
    await assert.rejects(f.projects.connect({ repositoryId: 202 }), { code: "github_404" });
    assert.equal(f.github.creates, 0);
});

test("repository rename uses the same GitHub ID without redirecting tasks", async (t) => {
    const f = await fixture(t);
    const task = await f.service.create({ projectId: f.project.id, requestId: randomUUID(), title: "Задача" });
    await f.service.save(task, { state: "branch_pending", branchUrl: null });
    const listing = await f.github.listRepositories();
    f.github.listRepositories = async () => listing.map((repo) => repo.id === 101 ? { ...repo, name: "renamed", full_name: "example/renamed" } : repo);
    const result = await f.service.retry(task.id);
    assert.equal(result.repositoryId, 101);
    assert.ok(result.branchUrl.includes("/renamed/"));
    assert.equal(f.projects.find(f.project.id).fullName, "example/renamed");
    assert.equal(f.github.creates, 1);
});
