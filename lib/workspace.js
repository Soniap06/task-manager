const { randomUUID, createHmac, createHash } = require("node:crypto");
const { AppError } = require("./errors");
const { safeEqual } = require("./auth");

const EMPLOYEE_FIELDS = new Set(["name", "role", "executor_type", "stack", "capacity", "avatar_url"]);

function employeeInput(input, { partial = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new AppError(400, "employee_body", "Ожидался объект сотрудника.");
    }
    if (Object.keys(input).some((field) => !EMPLOYEE_FIELDS.has(field))) {
        throw new AppError(400, "employee_fields", "Есть неизвестные поля сотрудника.");
    }

    const result = {};
    const text = (field, label, maximum) => {
        if (partial && !Object.hasOwn(input, field)) return;
        const value = input[field];
        if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
            throw new AppError(400, `employee_${field}`, `Укажите ${label}: не более ${maximum} символов.`);
        }
        result[field] = value.trim();
    };

    text("name", "имя", 120);
    text("role", "должность", 120);

    if (!partial || Object.hasOwn(input, "executor_type")) {
        const executorType = Object.hasOwn(input, "executor_type") ? input.executor_type : "human";
        if (!["human", "ai_agent"].includes(executorType)) {
            throw new AppError(400, "employee_executor_type", "Тип исполнителя должен быть human или ai_agent.");
        }
        result.executor_type = executorType;
    }
    if (!partial || Object.hasOwn(input, "stack")) {
        const stack = Object.hasOwn(input, "stack") ? input.stack : [];
        if (!Array.isArray(stack) || stack.length > 50 || stack.some((skill) => typeof skill !== "string" || !skill.trim() || skill.trim().length > 100)) {
            throw new AppError(400, "employee_stack", "Стек должен быть списком из строк до 100 символов.");
        }
        result.stack = stack.map((skill) => skill.trim());
    }
    if (!partial || Object.hasOwn(input, "capacity")) {
        const capacity = Object.hasOwn(input, "capacity") ? input.capacity : 0;
        if (!Number.isSafeInteger(capacity) || capacity < 0) {
            throw new AppError(400, "employee_capacity", "Доступные часы должны быть целым неотрицательным числом.");
        }
        result.capacity = capacity;
    }
    if (!partial || Object.hasOwn(input, "avatar_url")) {
        const avatarUrl = input.avatar_url;
        if (avatarUrl == null || (typeof avatarUrl === "string" && !avatarUrl.trim())) {
            result.avatar_url = null;
        } else if (typeof avatarUrl === "string" && avatarUrl.trim().length <= 2048) {
            const value = avatarUrl.trim();
            const localPath = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
            let secureUrl = false;
            try {
                const parsed = new URL(value);
                secureUrl = parsed.protocol === "https:" && !parsed.username && !parsed.password;
            } catch { /* Разрешены только HTTPS-адреса или локальные пути. */ }
            if (!localPath && !secureUrl) throw new AppError(400, "employee_avatar_url", "Аватар должен быть HTTPS-ссылкой или локальным путём.");
            result.avatar_url = value;
        } else {
            throw new AppError(400, "employee_avatar_url", "Некорректная ссылка на аватар.");
        }
    }
    return result;
}

class Workspace {
    constructor(database, store) {
        this.database = database;
        this.store = store;
        // Только карточки команды. Демонстрационные задачи и события не выдаются за реальные.
        const insert = database.prepare("INSERT OR IGNORE INTO employees (id, name, role, executor_type, stack, capacity) VALUES (?, ?, ?, ?, ?, ?)");
        const profiles = [
            ["karina", "Халикова Карина", "Разработчик интеграций GitHub и ИИ", ["JavaScript", "Node.js", "Git / GitHub", "GitHub App / REST API", "Qwen / LM Studio", "Интеграционное тестирование"], "Frontend Developer", ["React", "UI/UX"]],
            ["sofia", "Пескова София", "Разработчик интерфейса и Backend", ["HTML / CSS", "JavaScript", "UI/UX", "Node.js", "SQLite", "REST API", "Авторизация"], "Backend Developer", ["Node.js", "SQLite", "GitHub API"]]
        ];
        // Обновляем только прежние демонстрационные роли/навыки, сохраняя личные правки и остальные поля.
        const update = database.prepare("UPDATE employees SET role=?, stack=? WHERE id=? AND role=? AND stack=?");
        for (const [id, name, role, stack, previousRole, previousStack] of profiles) {
            insert.run(id, name, role, "human", JSON.stringify(stack), 4);
            update.run(role, JSON.stringify(stack), id, previousRole, JSON.stringify(previousStack));
        }
        insert.run("qwen", "Qwen Code Agent", "AI Assistant", "ai_agent", JSON.stringify(["Code Review", "Auto-Tests", "Refactoring"]), 0);
    }

    employees() {
        return this.database.prepare("SELECT * FROM employees ORDER BY name").all().map((employee) => ({ ...employee, stack: JSON.parse(employee.stack) }));
    }

    employee(id) {
        const employee = this.employees().find((item) => item.id === id);
        if (!employee) throw new AppError(404, "employee_not_found", "Сотрудник не найден.");
        return employee;
    }

    createEmployee(input) {
        const employee = employeeInput(input);
        const id = randomUUID();
        this.database.prepare("INSERT INTO employees (id, name, role, executor_type, stack, capacity, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(id, employee.name, employee.role, employee.executor_type, JSON.stringify(employee.stack), employee.capacity, employee.avatar_url);
        return this.employee(id);
    }

    updateEmployee(id, input) {
        this.employee(id);
        const employee = employeeInput(input, { partial: true });
        const fields = Object.keys(employee);
        if (!fields.length) throw new AppError(400, "employee_fields", "Укажите поля сотрудника для изменения.");
        const columns = { name: "name", role: "role", executor_type: "executor_type", stack: "stack", capacity: "capacity", avatar_url: "avatar_url" };
        const values = fields.map((field) => field === "stack" ? JSON.stringify(employee[field]) : employee[field]);
        const assignments = fields.map((field) => `${columns[field]}=?`).join(", ");
        this.database.prepare(`UPDATE employees SET ${assignments} WHERE id=?`).run(...values, id);
        return this.employee(id);
    }

    syncProjects() {
        const upsert = this.database.prepare("INSERT INTO projects (id, github_repository_id, installation_id, owner, name, base_branch) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET base_branch=excluded.base_branch");
        for (const project of this.store.projects()) {
            upsert.run(project.id, project.repositoryId, Number(project.installationId), project.owner, project.name, project.baseBranch);
        }
    }

    events(projectId) {
        return this.database.prepare("SELECT * FROM events WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT 100").all(projectId);
    }

    webhook(raw, headers, secret) {
        if (!secret) throw new AppError(503, "webhook_configuration", "GITHUB_WEBHOOK_SECRET не настроен.");
        const signature = headers["x-hub-signature-256"] || "";
        const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
        if (!/^sha256=[a-f0-9]{64}$/.test(signature) || !safeEqual(signature, expected)) throw new AppError(401, "webhook_signature", "Неверная подпись GitHub.");
        let payload;
        try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new AppError(400, "webhook_json", "Некорректный JSON."); }
        if (!payload || typeof payload !== "object") throw new AppError(400, "webhook_json", "Ожидался объект события.");
        const type = headers["x-github-event"];
        if (!["push", "pull_request", "pull_request_review"].includes(type)) return { ok: true, ignored: true };
        const project = this.store.projects().find((item) => !item.archived && item.repositoryId === payload.repository?.id &&
            (!payload.installation || String(payload.installation.id) === String(item.installationId)));
        if (!project) throw new AppError(404, "webhook_project", "Репозиторий события не подключён.");
        const delivery = headers["x-github-delivery"] || createHash("sha256").update(raw).digest("hex");
        if (typeof delivery !== "string" || delivery.length > 200) throw new AppError(400, "webhook_delivery", "Некорректный ID доставки.");
        if (this.database.prepare("SELECT 1 FROM webhook_deliveries WHERE delivery_id=?").get(delivery)) return { ok: true, duplicate: true };
        const pr = payload.pull_request || {};
        const summary = type === "push" ? `Push: ${payload.sender?.login || payload.pusher?.name || "unknown"} в ${payload.ref || "ветку"} — ${payload.head_commit?.message || "обновление коммитов"}` :
            type === "pull_request" ? `Pull Request #${payload.number || pr.number || "?"} ${payload.action || "updated"}: ${pr.title || "без названия"}` :
                `Review для PR #${pr.number || "?"}: ${payload.review?.state || "submitted"} от ${payload.review?.user?.login || "unknown"}`;
        this.syncProjects();
        this.database.exec("BEGIN IMMEDIATE");
        try {
            this.database.prepare("INSERT INTO events (id, project_id, event_type, payload_summary) VALUES (?, ?, ?, ?)").run(randomUUID(), project.id, type, summary.slice(0, 2000));
            this.database.prepare("INSERT INTO webhook_deliveries (delivery_id) VALUES (?)").run(delivery);
            this.database.exec("COMMIT");
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
        return { ok: true };
    }
}

module.exports = { Workspace };
