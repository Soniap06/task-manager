const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../lib/store");
const { TaskService } = require("../lib/tasks");
const { ProjectService } = require("../lib/projects");
const { loadConfig } = require("../lib/config");

const sha = "a".repeat(40);
const specification = { title: "Форма входа", branch: "feat/login-form", acceptanceCriteria: ["Форма доступна"], steps: ["Добавить поля"] };

function githubStub() {
    return {
        config: { appId: "1", installationId: "2", privateKeyPath: "/unused/test.pem", owner: "example", repo: "test", baseBranch: "main" },
        refs: new Map(), creates: 0,
        key(name, id = 101) { return `${id}:${name}`; },
        async getRef(name, id) { return this.refs.get(this.key(name, id)) || null; },
        async baseSha() { return sha; },
        async createBranch(name, value, id) { this.creates++; this.refs.set(this.key(name, id), value); },
        branchUrl(name, repo = "test") { return `https://github.com/example/${repo}/tree/${encodeURIComponent(name)}`; },
        async listRepositories() {
            return [101, 202].map((id) => ({ id, owner: { login: "example" }, name: id === 101 ? "test" : "habits", full_name: `example/${id === 101 ? "test" : "habits"}`, default_branch: "main", private: true, archived: false }));
        },
        forRepository(project) {
            const root = this;
            return {
                config: { ...root.config, owner: project.owner, repo: project.name, baseBranch: project.baseBranch, repositoryId: project.repositoryId },
                getRef: (name) => root.getRef(name, project.repositoryId),
                baseSha: () => root.baseSha(project.baseBranch),
                createBranch: (name, value) => root.createBranch(name, value, project.repositoryId),
                branchUrl: (name) => root.branchUrl(name, project.name),
                listBranches: async () => ["main", "develop"]
            };
        }
    };
}

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-manager-test-"));
    const store = await new TaskStore(dir).open();
    const github = githubStub();
    const projects = new ProjectService(store, github);
    const project = await projects.connect({ repositoryId: 101 });
    let generations = 0;
    const service = new TaskService(store, github, async () => { generations++; return specification; }, projects);
    const config = loadConfig({ DATA_DIR: dir, PORT: "0" });
    config.github = github.config;
    t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return { dir, store, github, service, projects, project, config, generations: () => generations };
}

module.exports = { fixture, githubStub, specification, sha };
