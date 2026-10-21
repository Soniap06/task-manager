const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { specification } = require("./helpers");

class Element {
    constructor(tag = "div") { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ""; this.disabled = false; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    set innerHTML(value) { throw new Error(`Unsafe HTML interpolation: ${value}`); }
}
const projectA = { id: "00000000-0000-4000-8000-000000000001", fullName: "example/books", repositoryId: 101, baseBranch: "main", archived: false };
const projectB = { ...projectA, id: "00000000-0000-4000-8000-000000000002", repositoryId: 202, fullName: "example/habits" };
const draftKey = (id) => `task-manager.pending-create.v2:${id}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function browser(handler, draft = null, page = "index", search = "") {
    const html = fs.readFileSync(require.resolve(`../${page}.html`), "utf8");
    const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
    const storage = new Map(draft ? [[draftKey(draft.projectId), JSON.stringify(draft)]] : []);
    const session = new Map();
    const calls = [];
    const context = vm.createContext({
        document: { getElementById: (id) => nodes[id], createElement: (tag) => new Element(tag) },
        localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
        sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) },
        crypto: { randomUUID }, AbortSignal, URLSearchParams, location: { search },
        fetch: async (url, options) => {
            calls.push({ url, options });
            let result;
            if (url === "/api/status") result = { configured: true };
            else if (url === "/api/projects" && options.method !== "POST") result = { projects: [projectA, projectB] };
            else result = await handler(url, options);
            return { ok: true, json: async () => result };
        }
    });
    vm.runInContext(fs.readFileSync(require.resolve(page === "index" ? "../script.js" : "../projects.js"), "utf8"), context);
    return { nodes, storage, session, context, calls };
}
const task = (patch = {}) => ({ ...specification, branch: "feat/example", projectId: projectA.id, repository: projectA.fullName, id: "task-1", column: "todo", state: "branch_created", branchUrl: "https://github.com/example/books/tree/feat/example", ...patch });

test("browser guards double Enter and renders model output as text", async () => {
    let release;
    let creates = 0;
    const f = browser(async (url, options) => {
        if (options.method !== "POST") return { tasks: [] };
        creates++;
        await new Promise((resolve) => { release = resolve; });
        return { task: task({ title: "<img src=x onerror=alert(1)>" }) };
    });
    await tick();
    f.nodes.taskInput.value = "Новая задача";
    const first = f.nodes.addTaskButton.listeners.click();
    await tick();
    f.nodes.taskInput.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(creates, 1);
    assert.equal(f.nodes.addTaskButton.disabled, true);
    release();
    await first;
    assert.equal(f.nodes.todo.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
    assert.equal(f.nodes.addTaskButton.disabled, false);
    assert.equal(f.storage.size, 0);
});

test("browser retains the same requestId after a lost response", async () => {
    let calls = 0;
    const ids = [];
    const f = browser(async (url, options) => {
        if (options.method !== "POST") return { tasks: [] };
        ids.push(JSON.parse(options.body).requestId);
        if (++calls === 1) throw new Error("Network lost");
        return { task: task({ state: "branch_error", error: { message: "Недостаточно прав" } }) };
    });
    await tick();
    f.nodes.taskInput.value = "Новая задача";
    await f.nodes.addTaskButton.listeners.click();
    assert.equal(f.storage.size, 1);
    await f.nodes.addTaskButton.listeners.click();
    assert.equal(ids[0], ids[1]);
    assert.equal(f.storage.size, 0);
});

test("board search and drag/drop preserve project tasks and only request a status change", async () => {
    let mutation;
    const f = browser(async (url, options) => {
        if (url === "/api/employees") return [];
        if (options.method === "POST") {
            mutation = { url, body: JSON.parse(options.body) };
            return { task: task({ column: "review" }) };
        }
        return { tasks: [task(), task({ id: "task-2", title: "Другая задача", acceptanceCriteria: [] })] };
    });
    await tick();
    f.nodes.taskSearch.value = "Форма";
    f.nodes.taskSearch.listeners.input();
    assert.equal(f.nodes.todo.children.length, 1);
    f.nodes.taskSearch.value = "";
    f.nodes.taskSearch.listeners.input();
    assert.equal(f.nodes.todo.children.length, 2);
    f.nodes.review.listeners.drop({ preventDefault() {}, dataTransfer: { getData: () => "task-1" } });
    await tick();
    assert.equal(mutation.url, "/api/tasks/task-1/column");
    assert.equal(mutation.body.column, "review");
    assert.equal(f.nodes.review.children.length, 1);
});

test("saved tasks resolve a matching pending draft in their own project", async () => {
    const draft = { projectId: projectA.id, requestId: randomUUID(), title: "Черновик" };
    const f = browser(async () => ({ tasks: [task({ requestId: draft.requestId, column: "review" })] }), draft);
    await tick();
    assert.equal(f.nodes.review.children.length, 1);
    assert.equal(f.storage.size, 0);
    assert.equal(f.nodes.taskInput.value, "");
});

test("switching project during generation does not render task A on board B", async () => {
    let release;
    const f = browser(async (url, options) => {
        if (options.method !== "POST") return { tasks: [] };
        const body = JSON.parse(options.body);
        assert.equal(body.projectId, projectA.id);
        await new Promise((resolve) => { release = resolve; });
        return { task: task() };
    });
    await tick();
    f.nodes.taskInput.value = "Задача проекта A";
    const creating = f.nodes.addTaskButton.listeners.click();
    await tick();
    await vm.runInContext(`selectProject("${projectB.id}")`, f.context);
    release();
    await creating;
    assert.equal(f.session.get("task-manager.active-project.v1"), projectB.id);
    assert.equal(f.nodes.todo.children.length, 0);
    assert.ok(f.calls.some((call) => call.url.includes(`projectId=${projectB.id}`)));
});

test("late board A response cannot overwrite the newer board B", async () => {
    let release;
    const f = browser(async (url) => {
        if (url.includes(projectA.id)) await new Promise((resolve) => { release = resolve; });
        return { tasks: [task({ projectId: url.includes(projectA.id) ? projectA.id : projectB.id, title: url.includes(projectA.id) ? "A" : "B" })] };
    });
    await tick();
    await vm.runInContext(`selectProject("${projectB.id}")`, f.context);
    release();
    await tick();
    assert.equal(f.nodes.todo.children[0].children[0].textContent, "B");
});


test("board validates project URL and loads only the selected project", async () => {
    const f = browser(async (url) => {
        assert.equal(url, `/api/tasks?projectId=${projectB.id}`);
        return { tasks: [] };
    }, null, "index", `?projectId=${projectB.id}`);
    await tick();
    assert.equal(f.nodes.projectInfo.textContent, projectB.fullName);
    assert.equal(f.session.get("task-manager.active-project.v1"), projectB.id);
    const invalid = browser(async (url) => {
        assert.equal(url, `/api/tasks?projectId=${projectA.id}`);
        return { tasks: [] };
    }, null, "index", "?projectId=https://untrusted.example/repo");
    await tick();
    assert.equal(invalid.nodes.projectInfo.textContent, projectA.fullName);
});

test("projects page persists selection and links to its board without loading tasks", async () => {
    const f = browser(async (url) => { throw new Error(`Unexpected request ${url}`); }, null, "projects");
    await tick();
    f.nodes.projectSelect.value = projectB.id;
    await f.nodes.projectSelect.listeners.change();
    assert.equal(f.session.get("task-manager.active-project.v1"), projectB.id);
    assert.equal(f.nodes.openBoardLink.href, `index.html?projectId=${projectB.id}`);
    assert.equal(f.nodes.projectBaseInput.value, "main");
    assert.equal(f.calls.length, 2);
});

test("projects page connects a selected repository and opens its own board", async () => {
    const repo = { repositoryId: 303, fullName: "example/new", defaultBranch: "develop", archived: false };
    const f = browser(async (url, options) => {
        if (url === "/api/github/repositories") return { repositories: [repo] };
        if (url.endsWith("/branches")) return { branches: ["develop"] };
        if (url === "/api/projects" && options.method === "POST") return { project: projectB };
        throw new Error(`Unexpected request ${url}`);
    }, null, "projects");
    await tick();
    await f.nodes.loadReposButton.listeners.click();
    f.nodes.repositorySelect.value = "303";
    await f.nodes.repositorySelect.listeners.change();
    assert.equal(f.nodes.baseBranchInput.value, "develop");
    await f.nodes.connectRepoButton.listeners.click();
    const post = f.calls.find((call) => call.url === "/api/projects" && call.options.method === "POST");
    assert.deepEqual(JSON.parse(post.options.body), { repositoryId: 303, baseBranch: "develop" });
    assert.equal(f.nodes.openBoardLink.href, `index.html?projectId=${projectB.id}`);
});


test("board hides task details until opening the accessible task dialog", async () => {
    const item = task({ acceptanceCriteria: ["<b>Критерий</b>"], steps: ["Первый шаг"] });
    const f = browser(async () => ({ tasks: [item] }));
    await tick();
    const card = f.nodes.todo.children[0];
    assert.equal(card.children.length, 2);
    assert.equal(f.nodes.taskDialog.open, false);
    assert.equal(f.nodes.connectionStatus.textContent, "");
    card.children[0].listeners.click();
    assert.equal(f.nodes.taskDialog.open, true);
    assert.equal(f.nodes.taskDialogTitle.textContent, item.title);
    const content = f.nodes.taskDialogContent;
    assert.equal(content.children[0].textContent, item.repository);
    assert.equal(content.children[1].children[0].href, item.branchUrl);
    const details = content.children[3];
    assert.ok(details.children.some((node) => node.tag === "ul" && node.children[0].textContent === "<b>Критерий</b>"));
    assert.ok(details.children.some((node) => node.tag === "ol" && node.children[0].textContent === "Первый шаг"));
    f.nodes.closeTaskDialog.listeners.click();
    assert.equal(f.nodes.taskDialog.open, false);
});

test("task dialog shows an error and retry, then updates after successful retry", async () => {
    const f = browser(async (url, options) => options.method === "POST" ? { task: task() } : { tasks: [task({ state: "branch_error", error: { message: "Нет доступа" } })] });
    await tick();
    f.nodes.todo.children[0].children[0].listeners.click();
    assert.equal(f.nodes.taskDialogContent.children[3].textContent, "Нет доступа");
    await f.nodes.taskDialogContent.children.at(-1).listeners.click();
    assert.equal(f.nodes.taskDialog.open, true);
    assert.equal(f.nodes.taskDialogContent.children[2].textContent, "Ветка создана в GitHub");
    await vm.runInContext(`selectProject("${projectB.id}")`, f.context);
    assert.equal(f.nodes.taskDialog.open, false);
});

test("repository search clears a hidden selection and prevents connecting the wrong repository", async () => {
    const repo = { repositoryId: 303, fullName: "example/books", defaultBranch: "main", archived: false };
    const f = browser(async (url) => {
        if (url === "/api/github/repositories") return { repositories: [repo] };
        if (url.endsWith("/branches")) return { branches: ["main"] };
        throw new Error(`Unexpected request ${url}`);
    }, null, "projects");
    await tick();
    await f.nodes.loadReposButton.listeners.click();
    f.nodes.repositorySelect.value = "303";
    await f.nodes.repositorySelect.listeners.change();
    assert.equal(f.nodes.connectRepoButton.disabled, false);
    f.nodes.repoSearch.value = "habits";
    f.nodes.repoSearch.listeners.input();
    assert.equal(f.nodes.repositorySelect.value, "");
    assert.equal(f.nodes.connectRepoButton.disabled, true);
    assert.equal(f.nodes.baseBranchInput.value, "");
    assert.equal(f.nodes.repositoryBranches.children.length, 0);
    await f.nodes.connectRepoButton.listeners.click();
    assert.equal(f.calls.some((call) => call.options.method === "POST"), false);
});

const descendants = (node) => [node, ...node.children.flatMap(descendants)];

test("draft opens questions, blocks empty answers and only confirms explicit reviewed values", async () => {
    let confirmBody;
    const draft = task({ branch: null, branchUrl: null, draftVersion: 1, state: "clarification_required", draftRevision: 1, input: "Исходный запрос", questions: ["По префиксу или подстроке?"] });
    const f = browser(async (url, options) => {
        if (url === "/api/employees") return [];
        if (options.method !== "POST") return { tasks: [] };
        if (url.endsWith("/confirm")) { confirmBody = JSON.parse(options.body); return { task: task({ ...draft, ...confirmBody, branch: "feat/task-id", state: "branch_created" }) }; }
        return { task: draft };
    });
    await tick();
    f.nodes.taskInput.value = "Исходный запрос";
    await f.nodes.addTaskButton.listeners.click();
    assert.equal(f.nodes.taskDialog.open, true);
    let nodes = descendants(f.nodes.taskDialogContent);
    const confirm = nodes.find((node) => node.className === "confirm-task");
    await confirm.listeners.click();
    assert.equal(confirmBody, undefined);
    assert.ok(nodes.some((node) => node.textContent === "Заполните название, описание и ответы на все вопросы."));
    for (const [key, value] of [["title", "Новое название"], ["description", "Проверенное описание"], ["answers", "По подстроке"]]) {
        const input = nodes.find((node) => node.dataset.editor === key);
        input.value = value;
        input.listeners.input();
    }
    await confirm.listeners.click();
    assert.deepEqual(confirmBody, { title: "Новое название", description: "Проверенное описание", answers: ["По подстроке"], draftRevision: 1 });
    assert.ok(descendants(f.nodes.taskDialogContent).some((node) => node.textContent === "Ветка создана в GitHub"));
});

test("AI failure leaves editable manual draft, and failed confirmation preserves typed values", async () => {
    const draft = task({ branch: null, branchUrl: null, draftVersion: 1, state: "generation_error", input: "Исходный текст", questions: [], error: { message: "Нет модели" } });
    const f = browser(async (url, options) => {
        if (url === "/api/employees") return [];
        if (options.method === "POST") throw new Error("Network lost");
        return { tasks: [draft] };
    });
    await tick();
    f.nodes.todo.children[0].children[0].listeners.click();
    let nodes = descendants(f.nodes.taskDialogContent);
    const input = nodes.find((node) => node.dataset.editor === "description");
    input.value = "Мой текст <script>";
    input.listeners.input();
    await nodes.find((node) => node.className === "confirm-task").listeners.click();
    nodes = descendants(f.nodes.taskDialogContent);
    assert.equal(nodes.find((node) => node.dataset.editor === "description").value, "Мой текст <script>");
    assert.ok(nodes.some((node) => node.textContent?.startsWith("Нет ответа сервера.")));
    assert.equal(f.nodes.addTaskButton.disabled, false);
});
