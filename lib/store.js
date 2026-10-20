const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AppError } = require("./errors");

class TaskStore {
    constructor(directory) {
        this.directory = directory;
        this.file = path.join(directory, "tasks.json");
        this.lockFile = path.join(directory, "server.lock");
        this.document = { version: 2, projects: [], tasks: [] };
        this.writes = Promise.resolve();
    }

    async open() {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
            this.lock = await fs.open(this.lockFile, "wx", 0o600);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            try {
                const old = await fs.readFile(this.lockFile, "utf8");
                const pid = Number(old);
                if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid lock");
                try { process.kill(pid, 0); } catch (cause) {
                    if (cause.code !== "ESRCH") throw cause;
                    if (await fs.readFile(this.lockFile, "utf8") !== old) throw new Error("Lock changed");
                    await fs.unlink(this.lockFile);
                    this.lock = await fs.open(this.lockFile, "wx", 0o600);
                }
            } catch {
                throw new AppError(503, "store_locked", "Не удалось открыть блокировку DATA_DIR. Убедитесь, что другой сервер не работает с тем же каталогом.");
            }
            if (!this.lock) throw new AppError(503, "store_locked", "Другой сервер уже использует DATA_DIR.");
        }
        await this.lock.writeFile(String(process.pid));
        try {
            const content = JSON.parse(await fs.readFile(this.file, "utf8"));
            if (![1, 2].includes(content.version) || !Array.isArray(content.tasks) || content.tasks.some((task) => !task.id || !task.requestId) ||
                (content.version === 2 && (!Array.isArray(content.projects) || content.projects.some((project) => !project.id || !project.repositoryId)))) {
                throw new Error("Invalid store");
            }
            if (content.version === 1) {
                // Нет подтверждённого installation/repository ID: запрещено угадывать назначение старых задач.
                await fs.copyFile(this.file, `${this.file}.v1-backup`, require("node:fs").constants.COPYFILE_EXCL).catch((error) => {
                    if (error.code !== "EEXIST") throw error;
                });
                await this.change(() => ({ version: 2, projects: [], tasks: content.tasks.map((task) => ({ ...task, projectId: null, legacyUnlinked: true })) }));
            } else this.document = content;
        } catch (error) {
            if (error.code !== "ENOENT") {
                await this.close();
                throw new AppError(503, "store_invalid", "Не удалось прочитать/мигрировать tasks.json. Исходные данные сохранены; проверьте файл и резервную копию.");
            }
        }
        return this;
    }

    list() { return structuredClone(this.document.tasks); }
    projects() { return structuredClone(this.document.projects); }

    change(transform) {
        const operation = this.writes.then(async () => {
            const next = transform(structuredClone(this.document));
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                const file = await fs.open(temporary, "wx", 0o600);
                try {
                    await file.writeFile(JSON.stringify(next, null, 2));
                    await file.sync();
                } finally { await file.close(); }
                await fs.rename(temporary, this.file);
                this.document = next;
            } catch {
                await fs.unlink(temporary).catch(() => {});
                throw new AppError(503, "store_write", "Не удалось сохранить данные. Проверьте DATA_DIR и повторите тот же запрос.");
            }
        });
        this.writes = operation.catch(() => {});
        return operation;
    }

    async put(task) {
        await this.change((next) => {
            const index = next.tasks.findIndex((item) => item.id === task.id);
            if (index === -1) next.tasks.push(structuredClone(task));
            else next.tasks[index] = structuredClone(task);
            return next;
        });
        return structuredClone(task);
    }

    async putProject(project) {
        await this.change((next) => {
            const index = next.projects.findIndex((item) => item.id === project.id);
            if (index === -1) next.projects.push(structuredClone(project));
            else next.projects[index] = structuredClone(project);
            return next;
        });
        return structuredClone(project);
    }

    async close() {
        await this.writes;
        if (!this.lock) return;
        await this.lock.close();
        this.lock = null;
        await fs.unlink(this.lockFile).catch(() => {});
    }
}

module.exports = { TaskStore };
