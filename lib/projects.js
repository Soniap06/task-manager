const { randomUUID } = require("node:crypto");
const { AppError } = require("./errors");

function parseRepositoryUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new AppError(400, "repository_url", "Введите ссылку вида https://github.com/owner/repository."); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash ||
        !/^\/[a-z\d-]+\/[a-z\d_.-]+\/?$/i.test(url.pathname)) {
        throw new AppError(400, "repository_url", "Поддерживается только ссылка https://github.com/owner/repository без дополнительных параметров.");
    }
    return url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "");
}

function validateBaseBranch(value) {
    if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x20~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{") || value.endsWith("/") || value.endsWith(".") || value.startsWith("/")) {
        throw new AppError(400, "base_branch", "Укажите корректную существующую базовую ветку.");
    }
    return value;
}

class ProjectService {
    constructor(store, github) {
        this.store = store;
        this.github = github;
        this.queue = Promise.resolve();
    }

    serial(action) {
        const operation = this.queue.then(action);
        this.queue = operation.catch(() => {});
        return operation;
    }

    list() { return this.store.projects(); }

    find(id) {
        const project = this.list().find((item) => item.id === id);
        if (!project) throw new AppError(404, "project_not_found", "Подключённый проект не найден.");
        return project;
    }

    async catalog(search = "") {
        const repositories = await this.github.listRepositories();
        return repositories.filter((repo) => Number.isSafeInteger(repo.id) && repo.id > 0 && typeof repo.full_name === "string")
            .filter((repo) => repo.full_name.toLowerCase().includes(search.toLowerCase()))
            .map((repo) => ({
                repositoryId: repo.id, fullName: repo.full_name, owner: repo.owner.login, name: repo.name,
                description: (repo.description || "").slice(0, 2000), private: repo.private,
                defaultBranch: repo.default_branch, archived: Boolean(repo.archived || repo.disabled),
                installationId: String(this.github.config.installationId), htmlUrl: `https://github.com/${repo.full_name}`
            }));
    }

    async accessible(repositoryId) {
        if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new AppError(400, "repository_id", "Некорректный ID репозитория.");
        const repo = (await this.catalog()).find((item) => item.repositoryId === repositoryId);
        if (!repo) throw new AppError(403, "repository_access", "Репозиторий недоступен этой GitHub App. Выберите его в настройках установки и обновите список.");
        if (repo.archived) throw new AppError(409, "repository_archived", "Репозиторий архивирован или отключён. Создание веток недоступно.");
        return repo;
    }

    async resolve(url) {
        const fullName = parseRepositoryUrl(url);
        const repo = (await this.catalog()).find((item) => item.fullName.toLowerCase() === fullName.toLowerCase());
        if (!repo) throw new AppError(403, "repository_access", "App не имеет доступа к этой ссылке. Настройте доступ в GitHub и обновите список.");
        return repo;
    }

    async branches(repositoryId) {
        const repo = await this.accessible(repositoryId);
        return this.github.forRepository({ ...repo, baseBranch: repo.defaultBranch }).listBranches();
    }

    connect({ repositoryId, baseBranch } = {}) {
        return this.serial(async () => {
            const repo = await this.accessible(repositoryId);
            baseBranch = validateBaseBranch(baseBranch || repo.defaultBranch);
            const client = this.github.forRepository({ ...repo, baseBranch });
            await client.baseSha();
            const existing = this.list().find((item) => item.repositoryId === repositoryId);
            if (existing && !existing.archived) return existing;
            return this.store.putProject({
                ...repo, id: existing?.id || randomUUID(), baseBranch, archived: false,
                createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
            });
        });
    }

    update(id, patch = {}) {
        return this.serial(async () => {
            const project = this.find(id);
            const next = { ...project, updatedAt: new Date().toISOString() };
            if (patch.archived !== undefined) {
                if (typeof patch.archived !== "boolean") throw new AppError(400, "project_archived", "archived должен быть boolean.");
                next.archived = patch.archived;
            }
            if (patch.baseBranch !== undefined || patch.archived === false) {
                const repo = await this.accessible(project.repositoryId);
                next.baseBranch = validateBaseBranch(patch.baseBranch || project.baseBranch);
                await this.github.forRepository({ ...repo, baseBranch: next.baseBranch }).baseSha();
                Object.assign(next, repo, { archived: patch.archived === false ? false : next.archived });
            }
            return this.store.putProject(next);
        });
    }

    context(id, snapshot = null) {
        return this.serial(async () => {
            const project = this.find(id);
            if (project.archived) throw new AppError(409, "project_archived", "Проект отключён. Подключите его снова перед внешней операцией.");
            if (snapshot && (snapshot.repositoryId !== project.repositoryId || String(snapshot.installationId) !== String(project.installationId))) {
                throw new AppError(409, "repository_changed", "Назначение сохранённой задачи не совпадает с проектом; автоматический перенос запрещён.");
            }
            const repo = await this.accessible(project.repositoryId);
            if (String(repo.installationId) !== String(project.installationId)) throw new AppError(409, "installation_changed", "Установка App изменилась. Переподключите проект после проверки доступа.");
            if (repo.fullName !== project.fullName) {
                await this.store.putProject({ ...project, ...repo, baseBranch: project.baseBranch, archived: project.archived, updatedAt: new Date().toISOString() });
            }
            return this.github.forRepository({ ...repo, baseBranch: snapshot?.baseBranch || project.baseBranch });
        });
    }
}

module.exports = { ProjectService, parseRepositoryUrl, validateBaseBranch };
