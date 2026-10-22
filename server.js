const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadConfig, validateGitHub } = require("./lib/config");
const { GitHubClient } = require("./lib/github");
const { createLlm } = require("./lib/llm");
const { TaskStore } = require("./lib/store");
const { TaskService } = require("./lib/tasks");
const { ProjectService } = require("./lib/projects");
const { AppError, publicError } = require("./lib/errors");
const { readJson, readRaw } = require("./lib/http-json");
const { createAuth } = require("./lib/auth");
const { openDatabase } = require("./lib/database");
const { Workspace } = require("./lib/workspace");

const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/projects.html", ["projects.html", "text/html; charset=utf-8"]],
    ["/projects.js", ["projects.js", "text/javascript; charset=utf-8"]],
    ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]]
]);
for (const route of ["/team", "/events", "/profile", "/login"]) assets.set(route, ["public/index.html", "text/html; charset=utf-8"]);
assets.set("/js/app.js", ["public/js/app.js", "text/javascript; charset=utf-8"]);
assets.set("/css/style.css", ["public/css/style.css", "text/css; charset=utf-8"]);

async function createApp({ config = loadConfig(), github = new GitHubClient(config.github), generate = createLlm(config.llm), store } = {}) {
    if (config.sharedOrigin && (!config.auth?.username || !config.auth?.password || (config.auth?.secret || "").length < 32)) {
        throw new AppError(500, "shared_configuration", "Для общей доски требуется полностью настроенный вход.");
    }
    store = store || await new TaskStore(config.dataDir).open();
    const projects = new ProjectService(store, github);
    const tasks = new TaskService(store, github, generate, projects);
    let database;
    let workspace;
    const auth = createAuth({ ...config.auth, secure: Boolean(config.sharedOrigin) });
    try {
        database = openDatabase(path.join(config.dataDir, "task-manager.sqlite"));
        workspace = new Workspace(database, store);
    } catch (error) {
        database?.close();
        await store.close();
        throw error;
    }
    try { await tasks.recover(); } catch (error) {
        database.close();
        await store.close();
        throw error;
    }
    const json = (response, status, body) => {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(body));
    };
    const server = http.createServer(async (request, response) => {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        try {
            const port = server.address()?.port;
            const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
            if (config.sharedOrigin) allowedHosts.push(new URL(config.sharedOrigin).host);
            if (!allowedHosts.includes(request.headers.host)) throw new AppError(403, "host", "Недопустимый Host.");
            const origin = config.sharedOrigin || `http://${request.headers.host}`;
            const url = new URL(request.url, origin);
            if (url.origin !== origin) throw new AppError(403, "host", "Недопустимый адрес запроса.");
            const route = url.pathname;
            const mutation = ["POST", "PATCH", "DELETE"].includes(request.method);
            if (route !== "/api/webhooks/github" && mutation &&
                ((config.sharedOrigin && request.headers.origin !== origin) || (request.headers.origin && request.headers.origin !== origin) || ["cross-site", "same-site"].includes(request.headers["sec-fetch-site"]))) {
                throw new AppError(403, "origin", "Операция разрешена только со страницы локального приложения.");
            }
            if (request.method === "POST" && route === "/api/webhooks/github") {
                const result = workspace.webhook(await readRaw(request), request.headers, config.webhookSecret);
                json(response, result.duplicate ? 200 : 202, result);
                return;
            }
            if (request.method === "GET" && route === "/api/health") {
                json(response, 200, { ok: true });
                return;
            }
            if (request.method === "GET" && route === "/api/auth/status") {
                json(response, 200, auth.status(request));
                return;
            }
            if (request.method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(route)) {
                if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError(415, "content_type", "Используйте application/json.");
                const body = await readJson(request, 16_384);
                if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "body", "Ожидался объект.");
                response.setHeader("Set-Cookie", route.endsWith("/login") ? auth.login(body) : auth.logout());
                json(response, 200, { ok: true });
                return;
            }
            if (route.startsWith("/api/")) auth.require(request);
            if (request.method === "GET" && assets.has(route)) {
                const [file, type] = assets.get(route);
                const content = await fs.readFile(path.join(config.root, file));
                response.writeHead(200, { "Content-Type": type });
                response.end(content);
                return;
            }
            if (request.method === "GET" && route === "/api/status") {
                let configurationError = null;
                try { validateGitHub(config.github); } catch (error) { configurationError = publicError(error); }
                json(response, 200, {
                    installationUrl: /^\d+$/.test(config.github.installationId) ? `https://github.com/settings/installations/${config.github.installationId}` : null,
                    hasLegacyTasks: store.list().some((task) => !task.projectId),
                    configured: !configurationError,
                    error: configurationError
                });
                return;
            }
            if (request.method === "GET" && route === "/api/employees") {
                json(response, 200, workspace.employees());
                return;
            }
            const employee = route.match(/^\/api\/employees\/([a-z\d-]+)$/i);
            if (request.method === "GET" && employee) {
                json(response, 200, workspace.employee(employee[1]));
                return;
            }
            if (request.method === "GET" && ["/api/profile", "/api/events"].includes(route)) {
                const projectId = url.searchParams.get("projectId");
                if (projectId) projects.find(projectId);
                if (route === "/api/events") {
                    if (!projectId) throw new AppError(400, "project_required", "Выберите проект для просмотра событий.");
                    json(response, 200, workspace.events(projectId));
                } else {
                    const username = auth.status(request).username;
                    const selected = username ? workspace.employees().find((item) => item.id === username) : null;
                    const assigned = selected ? store.list().filter((task) => task.assigneeId === selected.id && (!projectId || task.projectId === projectId)) : [];
                    json(response, 200, selected ? { ...selected, stats: { in_progress: assigned.filter((task) => task.column === "progress").length, in_review: assigned.filter((task) => task.column === "review").length } } : { username, employee: null });
                }
                return;
            }
            if (request.method === "POST" && route === "/api/ai/generate-task") {
                if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError(415, "content_type", "Используйте application/json.");
                const body = await readJson(request, 16_384);
                if (typeof body?.prompt !== "string" || body.prompt.trim().length < 5 || body.prompt.length > 500) throw new AppError(400, "prompt", "Опишите задачу: от 5 до 500 символов.");
                if (body.projectId) projects.find(body.projectId);
                const { validateDraft } = require("./lib/task-draft");
                const spec = validateDraft(await generate(body.prompt, { repository: body.projectId ? projects.find(body.projectId).fullName : null }));
                json(response, 200, spec);
                return;
            }
            if (request.method === "GET" && route === "/api/tasks") {
                const projectId = url.searchParams.get("projectId");
                if (!projectId) throw new AppError(400, "project_required", "Выберите проект для просмотра задач.");
                json(response, 200, { tasks: tasks.list(projectId) });
                return;
            }
            if (request.method === "GET" && route === "/api/projects") {
                json(response, 200, { projects: projects.list() });
                return;
            }
            if (request.method === "GET" && route === "/api/github/repositories") {
                json(response, 200, { repositories: await projects.catalog((url.searchParams.get("search") || "").slice(0, 200)) });
                return;
            }
            const branchList = route.match(/^\/api\/github\/repositories\/(\d+)\/branches$/);
            if (request.method === "GET" && branchList) {
                json(response, 200, { branches: await projects.branches(Number(branchList[1])) });
                return;
            }
            const projectUpdate = route.match(/^\/api\/projects\/([a-f\d-]{36})$/i);
            const confirm = route.match(/^\/api\/tasks\/([a-f\d-]{36})\/confirm$/i);
            const retry = route.match(/^\/api\/tasks\/([a-f\d-]{36})\/branch\/retry$/i);
            const move = route.match(/^\/api\/tasks\/([a-f\d-]{36})\/column$/i);
            const projectMutation = request.method === "POST" && ["/api/projects", "/api/github/repositories/resolve"].includes(route);
            if ((request.method === "POST" && (route === "/api/tasks" || confirm || retry || move || projectMutation)) || (request.method === "PATCH" && projectUpdate)) {
                if ((request.headers.origin && request.headers.origin !== origin) ||
                    ["cross-site", "same-site"].includes(request.headers["sec-fetch-site"])) {
                    throw new AppError(403, "origin", "Операция разрешена только со страницы локального приложения.");
                }
                if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
                    throw new AppError(415, "content_type", "Используйте Content-Type: application/json.");
                }
                const body = await readJson(request, 16_384);
                if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "body", "Ожидался JSON-объект.");
                if (projectMutation || projectUpdate) {
                    if (route === "/api/github/repositories/resolve") json(response, 200, { repository: await projects.resolve(body.url) });
                    else if (projectUpdate) json(response, 200, { project: await projects.update(projectUpdate[1], body) });
                    else json(response, 200, { project: await projects.connect(body) });
                    return;
                }
                let task;
                if (confirm) task = await tasks.confirm(confirm[1], body);
                else if (retry) task = await tasks.retry(retry[1]);
                else if (move) task = await tasks.move(move[1], body.column);
                else {
                    if (body.assigneeId != null) workspace.employee(body.assigneeId);
                    task = await tasks.create(body);
                }
                json(response, 200, { task });
                return;
            }
            throw new AppError(request.method === "GET" ? 404 : 405, "route", "Ресурс или метод недоступен.");
        } catch (error) {
            json(response, error instanceof AppError ? error.status : 500, { error: publicError(error) });
        }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    const close = async () => {
        if (server.listening) {
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeIdleConnections();
            });
        }
        await tasks.queue;
        await projects.queue;
        await store.close();
        database.close();
    };
    return { server, tasks, projects, store, close };
}

async function main() {
    const config = loadConfig();
    const app = await createApp({ config });
    app.server.once("error", async (error) => {
        console.error(error.code === "EADDRINUSE" ? "Порт занят. Остановите другой сервер или измените PORT в .env." : "Не удалось запустить HTTP-сервер.");
        await app.close();
        process.exitCode = 1;
    });
    app.server.listen(config.port, "127.0.0.1", () => {
        console.log(`Task Manager: ${config.sharedOrigin || `http://127.0.0.1:${app.server.address().port}`}`);
    });
    let closing = false;
    const stop = async () => {
        if (closing) return;
        closing = true;
        await app.close();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(publicError(error).message);
        process.exitCode = 1;
    });
}

module.exports = { createApp };
