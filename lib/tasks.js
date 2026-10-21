const { randomUUID } = require("node:crypto");
const { AppError, publicError } = require("./errors");
const { branchName, validateDraft, taskTypes, validText } = require("./task-draft");
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

    create({ requestId, title, projectId, assigneeId = null, type = "feature", useAi = true } = {}) {
        return this.serial(async () => {
            if (typeof requestId !== "string" || !requestIdPattern.test(requestId) || typeof title !== "string" || !title.trim() || title.trim().length > 500) {
                throw new AppError(400, "task_input", "Нужны requestId (16–80 букв, цифр или дефисов) и название задачи длиной до 500 символов.");
            }
            if (typeof type !== "string" || !Object.hasOwn(taskTypes, type) || typeof useAi !== "boolean") throw new AppError(400, "task_type", "Укажите тип задачи и способ подготовки черновика.");
            title = title.trim();
            let task = this.store.list().find((item) => item.requestId === requestId);
            if (task && (task.input !== title || task.projectId !== projectId || (task.assigneeId ?? null) !== assigneeId || (task.type || "feature") !== type || (task.useAi ?? true) !== useAi)) throw new AppError(409, "request_conflict", "Этот requestId уже используется другой задачей.");
            if (task) return task;
            await this.projects.context(projectId);
            const project = this.projects.find(projectId);
            const { owner, name: repo, baseBranch, repositoryId, installationId } = project;
            task = await this.store.put({
                id: randomUUID(), requestId, projectId, repositoryId, installationId, input: title, title: title.slice(0, 300), assigneeId, type, useAi, draftVersion: 1, draftRevision: 0,
                description: title, questions: [], clarifications: [], confirmedAt: null,
                column: "todo", state: "generating", acceptanceCriteria: [], steps: [],
                repository: `${owner}/${repo}`, baseBranch, branch: null, baseSha: null,
                branchUrl: null, createAttempted: false, error: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
            return useAi ? this.prepare(task) : this.save(task, { state: "draft_ready" });
        });
    }

    retry(id) {
        return this.serial(async () => {
            const task = this.find(id);
            if (task.state === "branch_created") return task;
            return task.branch ? this.process(task) : this.prepare(task);
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

    async prepare(task) {
        if (!task.projectId) throw new AppError(409, "legacy_task", "Прежняя задача не привязана к проверенному проекту.");
        task = await this.save(task, { state: "generating", draftVersion: 1, type: task.type || "feature", description: task.description || task.input, questions: task.questions || [], draftRevision: (task.draftRevision || 0) + 1, error: null });
        try {
            const draft = validateDraft(await this.generate(task.input, { repository: task.repository }));
            return await this.save(task, { ...draft, state: draft.questions.length ? "clarification_required" : "draft_ready" });
        } catch (error) {
            if (error.code === "store_write") throw error;
            return this.save(task, { state: "generation_error", error: publicError(error) });
        }
    }

    confirm(id, { title, description, answers = [], draftRevision } = {}) {
        return this.serial(async () => {
            let task = this.find(id);
            if (!task.projectId) throw new AppError(409, "legacy_task", "Прежняя задача не привязана к проверенному проекту.");
            // Повтор подтверждения не меняет утверждённый текст и не создаёт вторую ветку.
            if (task.branch) return task;
            if (task.draftVersion && draftRevision !== task.draftRevision) throw new AppError(409, "draft_changed", "Черновик изменился в другой вкладке. Обновите доску и проверьте новые вопросы.");
            const questions = task.questions || [];
            if (!validText(title, 300) || !validText(description, 1500) || !Array.isArray(answers) ||
                answers.length !== questions.length || !answers.every((answer) => validText(answer, 1000))) {
                throw new AppError(400, "task_confirmation", "Проверьте название, описание и ответьте на каждый вопрос перед созданием ветки.");
            }
            task = await this.save(task, {
                title: title.trim(), description: description.trim(),
                clarifications: questions.map((question, index) => ({ question, answer: answers[index].trim() })),
                branch: branchName(task.type || "feature", task.id), confirmedAt: new Date().toISOString(),
                state: "branch_pending", error: null
            });
            return this.process(task);
        });
    }

    async process(task) {
        if (!task.projectId || !task.branch) throw new AppError(409, "task_unconfirmed", "Сначала проверьте и подтвердите черновик задачи.");
        let github;
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
