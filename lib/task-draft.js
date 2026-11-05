const { AppError } = require("./errors");

const taskTypes = { feature: "feat", fix: "fix", tests: "test", docs: "docs" };
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function validateDraft(value, { maxQuestions = 3 } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !["title", "description", "questions"].includes(key)) ||
        !validText(value.title, 300) || !validText(value.description, 1500) ||
        !Array.isArray(value.questions) || value.questions.length > maxQuestions ||
        !value.questions.every((question) => validText(question, 240)) ||
        new Set(value.questions.map((question) => question.trim().toLocaleLowerCase("ru"))).size !== value.questions.length) {
        throw new AppError(502, "llm_contract", `Модель должна вернуть название, краткое описание и не более ${maxQuestions} разных вопросов.`);
    }
    return { title: value.title.trim(), description: value.description.trim(), questions: value.questions.map((question) => question.trim()) };
}

function validateBranchSlug(value) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) || value.length < 3 || value.length > 60) {
        throw new AppError(400, "branch_slug", "Введите название ветки на английском: 3–60 строчных букв, цифры и одиночные дефисы, например habit-categories. Без префикса и ID.");
    }
    return value;
}

function branchName(type, taskId, slug) {
    if (typeof type !== "string" || !Object.hasOwn(taskTypes, type)) throw new AppError(400, "task_type", "Выберите тип задачи: функция, исправление, тесты или документация.");
    if (slug !== undefined) return `${taskTypes[type]}/${validateBranchSlug(slug)}-${taskId.replace(/-/g, "").slice(0, 8)}`;
    const legacyPrefix = ["tests", "docs"].includes(type) ? "chore" : taskTypes[type];
    return `${legacyPrefix}/task-${taskId}`;
}

module.exports = { validateDraft, branchName, taskTypes, validText, validateBranchSlug };
