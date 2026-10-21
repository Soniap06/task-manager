const { AppError } = require("./errors");

const taskTypes = { feature: "feat", fix: "fix", tests: "chore", docs: "chore" };
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function validateDraft(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !["title", "description", "questions"].includes(key)) ||
        !validText(value.title, 300) || !validText(value.description, 1500) ||
        !Array.isArray(value.questions) || value.questions.length > 3 ||
        !value.questions.every((question) => validText(question, 240)) ||
        new Set(value.questions.map((question) => question.trim().toLocaleLowerCase("ru"))).size !== value.questions.length) {
        throw new AppError(502, "llm_contract", "Модель должна вернуть название, краткое описание и не более трёх разных вопросов.");
    }
    return { title: value.title.trim(), description: value.description.trim(), questions: value.questions.map((question) => question.trim()) };
}

function branchName(type, taskId) {
    if (typeof type !== "string" || !Object.hasOwn(taskTypes, type)) throw new AppError(400, "task_type", "Выберите тип задачи: функция, исправление, тесты или документация.");
    return `${taskTypes[type]}/task-${taskId}`;
}

module.exports = { validateDraft, branchName, taskTypes, validText };
