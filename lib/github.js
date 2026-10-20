const { readFile } = require("node:fs/promises");
const { createPrivateKey, sign } = require("node:crypto");
const { AppError } = require("./errors");
const { validateGitHub } = require("./config");
const { readJson } = require("./http-json");

function createJwt(appId, privateKey, now = Date.now()) {
    const seconds = Math.floor(now / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: String(appId), iat: seconds - 60, exp: seconds + 540 })}`;
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
}

function githubError(status, rateLimited = false) {
    const messages = {
        401: "GitHub отклонил авторизацию App. Проверьте ID и приватный ключ.",
        403: "GitHub запретил действие. Проверьте Contents: Read and write и правила репозитория.",
        404: "GitHub не нашёл репозиторий или ветку. Проверьте установку App и настройки базы.",
        409: "GitHub сообщил о конфликте. Проверьте базовую ветку и состояние репозитория.",
        422: "GitHub отклонил создание ветки: конфликт имени, правила репозитория или неверный ref."
    };
    const error = new AppError(502, rateLimited || status === 429 ? "github_rate_limit" : `github_${status}`,
        rateLimited || status === 429 ? "Достигнут лимит GitHub API. Повторите позже." : messages[status] || "GitHub временно недоступен. Повторите запрос позже.");
    error.upstreamStatus = status;
    return error;
}

class GitHubClient {
    constructor(config, { fetchFn = fetch, now = Date.now, timeoutMs = 15_000, tokens = new Map() } = {}) {
        this.config = config;
        this.fetchFn = fetchFn;
        this.now = now;
        this.timeoutMs = timeoutMs;
        this.tokens = tokens;
    }

    async request(route, { method = "GET", token, body } = {}) {
        let response;
        try {
            response = await this.fetchFn(`https://api.github.com${route}`, {
                method,
                redirect: "error",
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: {
                    Accept: "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "X-GitHub-Api-Version": "2026-03-10",
                    "User-Agent": "task-manager-github-app",
                    Authorization: `Bearer ${token}`
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw githubError(response.status, response.headers.get("x-ratelimit-remaining") === "0");
            }
            return await readJson(response.body);
        } catch (error) {
            if (error.upstreamStatus) throw error;
            throw new AppError(502, "github_unavailable", "Не удалось получить ответ GitHub. Проверьте сеть и повторите запрос.");
        }
    }

    async installationToken(scope = "write") {
        validateGitHub(this.config);
        if (scope === "write" && !this.config.repositoryId && !this.config.repo) {
            throw new AppError(400, "repository_context", "Для записи сначала выберите проверенный проект.");
        }
        const permissions = { contents: scope === "discovery" ? "read" : "write" };
        const repositories = scope === "discovery" ? {} : this.config.repositoryId ? { repository_ids: [this.config.repositoryId] } : { repositories: [this.config.repo] };
        const cacheKey = JSON.stringify([this.config.installationId, permissions, repositories]);
        const cached = this.tokens.get(cacheKey);
        if (cached && cached.expiresAt > this.now() + 60_000) return cached.value;
        let key;
        try {
            key = createPrivateKey(await readFile(this.config.privateKeyPath));
            if (key.asymmetricKeyType !== "rsa") throw new Error("RSA required");
        } catch {
            throw new AppError(503, "github_key", "Не удалось прочитать RSA-ключ GitHub App. Проверьте GITHUB_PRIVATE_KEY_PATH и права файла.");
        }
        const result = await this.request(`/app/installations/${this.config.installationId}/access_tokens`, {
            method: "POST",
            token: createJwt(this.config.appId, key, this.now()),
            body: { ...repositories, permissions }
        });
        const expiresAt = Date.parse(result.expires_at);
        if (typeof result.token !== "string" || !result.token || !(expiresAt > this.now() + 60_000)) {
            throw new AppError(502, "github_token", "GitHub вернул некорректный installation token.");
        }
        this.tokens.set(cacheKey, { value: result.token, expiresAt });
        return result.token;
    }

    async api(route, options = {}, scope = "write") {
        try {
            return await this.request(route, { ...options, token: await this.installationToken(scope) });
        } catch (error) {
            if (error.upstreamStatus !== 401) throw error;
            this.tokens.clear();
            return this.request(route, { ...options, token: await this.installationToken(scope) });
        }
    }

    forRepository(project) {
        return new GitHubClient({
            ...this.config,
            installationId: String(project.installationId), repositoryId: project.repositoryId,
            owner: project.owner, repo: project.name, baseBranch: project.baseBranch
        }, { fetchFn: this.fetchFn, now: this.now, timeoutMs: this.timeoutMs, tokens: this.tokens });
    }

    async listRepositories() {
        const repositories = [];
        for (let page = 1; page <= 100; page++) {
            const result = await this.api(`/installation/repositories?per_page=100&page=${page}`, {}, "discovery");
            if (!Array.isArray(result.repositories)) throw new AppError(502, "github_catalog", "GitHub вернул некорректный список репозиториев.");
            repositories.push(...result.repositories);
            if (repositories.length >= result.total_count || result.repositories.length < 100) return repositories;
        }
        throw new AppError(502, "github_catalog_limit", "Слишком большой каталог репозиториев. Ограничьте доступ установки GitHub App.");
    }

    async listBranches() {
        const branches = [];
        for (let page = 1; page <= 100; page++) {
            const result = await this.api(`${this.repoPath}/branches?per_page=100&page=${page}`, {}, "discovery");
            if (!Array.isArray(result)) throw new AppError(502, "github_branches", "GitHub вернул некорректный список веток.");
            branches.push(...result.map((branch) => branch.name));
            if (result.length < 100) return branches;
        }
        throw new AppError(502, "github_branch_limit", "Слишком много веток для выбора. Укажите базовую ветку вручную.");
    }

    get repoPath() {
        return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
    }

    async getRef(branch) {
        try {
            const result = await this.api(`${this.repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
            if (result.ref !== `refs/heads/${branch}` || !/^[a-f\d]{40}$/i.test(result.object?.sha)) {
                throw new AppError(502, "github_ref", "GitHub вернул некорректную ссылку на ветку.");
            }
            return result.object.sha;
        } catch (error) {
            if (error.upstreamStatus === 404) return null;
            throw error;
        }
    }

    async baseSha() {
        const sha = await this.getRef(this.config.baseBranch);
        if (!sha) throw githubError(404);
        return sha;
    }

    async createBranch(name, sha) {
        const result = await this.api(`${this.repoPath}/git/refs`, { method: "POST", body: { ref: `refs/heads/${name}`, sha } });
        if (result.ref !== `refs/heads/${name}` || result.object?.sha !== sha) {
            throw new AppError(502, "github_ref", "GitHub не подтвердил создание ожидаемой ветки.");
        }
    }

    branchUrl(name) {
        return `https://github.com/${this.config.owner}/${this.config.repo}/tree/${encodeURIComponent(name)}`;
    }
}

module.exports = { GitHubClient, createJwt };
