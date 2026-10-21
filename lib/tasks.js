const { randomUUID } = require("node:crypto");
const { AppError, publicError } = require("./errors");
const { branchName, validateSpecification } = require("./llm");
const { ProjectService } = require("./projects");

const columns = ["todo", "progress", "review"];
const requestIdPattern = /^[a-z0-9-]{16,80}$/i;

class TaskService {
    constructor(store, github, generate, projects = new ProjectService(store, github)) {
        this.store = store;
        this.github = github;
        this.generate = generate;
        this.projects = projects;
        this.queue = Promise.resolve();
    }

    serial(action) {
        const next = this.queue.then(action);
        this.queue = next.catch(() => {});
        return next;
    }

    list(projectId) {
        if (projectId !== "legacy") this.projects.find(projectId);
        return this.store.list().filter((task) => projectId === "legacy" ? !task.projectId : task.projectId === projectId)
            .map(({ createAttempted, ...task }) => task);
    }

    async save(task, patch) {
        return this.store.put({ ...task, ...patch, updatedAt: new Date().toISOString() });
    }

    create({ requestId, title, projectId, assigneeId = null } = {}) {
        return this.serial(async () => {
            if (typeof requestId !== "string" || !requestIdPattern.test(requestId) || typeof title !== "string" || !title.trim() || title.trim().length > 500) {
                throw new AppError(400, "task_input", "Нужны requestId (16–80 букв, цифр или дефисов) и название задачи длиной до 500 символов.");
            }
            title = title.trim();
            let task = this.store.list().find((item) => item.requestId === requestId);
            if (task && (task.input !== title || task.projectId !== projectId || (task.assigneeId ?? null) !== assigneeId)) throw new AppError(409, "request_conflict", "Этот requestId уже используется другой задачей.");
            if (task) return task;
            await this.projects.context(projectId);
            const project = this.projects.find(projectId);
            const { owner, name: repo, baseBranch, repositoryId, installationId } = project;
            task = await this.store.put({
                id: randomUUID(), requestId, projectId, repositoryId, installationId, input: title, title, assigneeId,
                column: "todo", state: "generating", acceptanceCriteria: [], steps: [],
                repository: `${owner}/${repo}`, baseBranch, branch: null, baseSha: null,
                branchUrl: null, createAttempted: false, error: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
            return this.process(task);
        });
    }

    retry(id) {
        return this.serial(async () => {
            const task = this.find(id);
            if (task.state === "branch_created") return task;
            return this.process(task);
        });
    }

    find(id) {
        const task = this.store.list().find((item) => item.id === id);
        if (!task) throw new AppError(404, "task_not_found", "Задача не найдена.");
        return task;
    }

    move(id, column) {
        return this.serial(async () => {
            if (!columns.includes(column)) throw new AppError(400, "task_column", "Неизвестная колонка.");
            return this.save(this.find(id), { column });
        });
    }

    async process(task) {
        if (!task.projectId) throw new AppError(409, "legacy_task", "Прежняя задача не привязана к проверенному проекту. Внешняя запись запрещена.");
        let github;
        try { github = await this.projects.context(task.projectId, task); } catch (error) {
            return this.save(task, { state: "branch_error", error: publicError(error) });
        }
        if (!task.branch) {
            task = await this.save(task, { state: "generating", error: null });
            let specification;
            try {
                specification = validateSpecification(await this.generate(task.input));
            } catch (error) {
                return this.save(task, { state: "generation_error", error: publicError(error) });
            }
            task = await this.save(task, {
                ...specification, branch: branchName(specification.branch, task.id),
                state: "branch_pending", error: null
            });
        }
        task = await this.save(task, { state: "branch_pending", error: null });
        try {
            // Проект могли отключить, пока модель готовила описание.
            github = await this.projects.context(task.projectId, task);
            const existing = await github.getRef(task.branch);
            if (existing) {
                if (!task.createAttempted || existing !== task.baseSha) {
                    throw new AppError(409, "branch_conflict", "Ветка с таким именем уже существует или изменилась. Автоматическая перезапись запрещена; проверьте её в GitHub.");
                }
            } else {
                if (!task.baseSha) task = await this.save(task, { baseSha: await github.baseSha() });
                task = await this.save(task, { createAttempted: true });
                try {
                    await github.createBranch(task.branch, task.baseSha);
                } catch (error) {
                    // Потерянный ответ POST не означает, что GitHub не создал ref.
                    let recovered = false;
                    try { recovered = await github.getRef(task.branch) === task.baseSha; } catch { /* Сохранить первоначальную ошибку. */ }
                    if (!recovered) throw error;
                }
            }
        } catch (error) {
            if (error.code === "store_write") throw error;
            return this.save(task, { state: "branch_error", error: publicError(error) });
        }
        return this.save(task, { state: "branch_created", error: null, branchUrl: github.branchUrl(task.branch) });
    }

    async recover() {
        // Не генерировать новые описания и не повторять отклонённые операции при старте.
        // Завершить только ранее сохранённые попытки, реально достигшие GitHub.
        for (const task of this.store.list()) {
            if (task.state === "branch_pending" && task.createAttempted) {
                try { await this.retry(task.id); } catch (error) {
                    if (error.code === "store_write") throw error;
                    await this.save(task, { state: "branch_error", error: publicError(error) });
                }
            }
        }
    }
}

module.exports = { TaskService, columns };
