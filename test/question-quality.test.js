const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { questionIssues } = require("../lib/question-quality");
const { createLlm } = require("../lib/llm");
const { fixture, specification } = require("./helpers");
const grilling = { minimum: 9, maximum: 30, answered: 0 };
const reply = (questions) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...specification, questions }) } }] }));
const good = ["Нужно ли подтверждать удаление?", "Можно ли отменить удаление?", "Что показать после удаления последней привычки?"];
const bad = ["Какой формат ID привычки (строка, число) и какие значения считаются валидными?", "Где хранятся привычки (в памяти, в базе данных) и какой тип хранилища используется?", "Какой HTTP-метод и путь для удаления привычки (например, DELETE /habits/{id})?"];

test("rejects the technical questions actually returned by Qwen and technical names", () => {
    for (const question of [...bad, "Какое имя должно быть у поля для цвета категории?", "В каком файле реализовать удаление?", "Какой фреймворк используется?", "Какую команду запуска использовать?"]) {
        assert.equal(questionIssues([question]).length, 1, question);
    }
});

test("keeps product behavior, invalid-ID errors, field choices and user file formats", () => {
    const questions = [...good, "Как реагировать на неизвестный ID?", "Какое сообщение показать при неверном формате ID?", "Какой формат ответа при ошибке 404?", "Какие поля нужны категории: название, цвет, иконка?", "Как долго хранить историю?", "Нужно ли сохранять данные после перезапуска?", "Какой файл должен скачать пользователь при экспорте?", "Which file format should users download?", "Какую ошибку возвращать, если путь API не существует?", "Как назвать кнопку удаления?"];
    for (const question of questions) assert.deepEqual(questionIssues([question]), [], question);
});

test("one replacement request carries specific feedback without changing saved answers or budget", async () => {
    let calls = 0;
    const clarifications = [{ question: "Нужны ли категории?", answer: "Нет", round: 1 }];
    const generate = createLlm({}, { fetchFn: async (_, options) => {
        const body = JSON.parse(options.body);
        calls++;
        if (calls === 1) return reply(bad);
        const last = JSON.parse(body.messages.at(-1).content);
        assert.equal(last.correction.rejected.length, 3);
        assert.equal(last.correction.rejected[0].question, bad[0]);
        assert.equal(last.grilling.answered, 3);
        assert.deepEqual(last.lastAnswers, [{ question: "Нужны ли категории?", answer: "Нет" }]);
        return reply(good);
    } });
    const value = await generate("Удаление", { grilling: { ...grilling, answered: 3 }, clarifications });
    assert.deepEqual(value.questions, good);
    assert.equal(calls, 2);
});

test("two rejected batches stop rather than insert fallback questions", async () => {
    let calls = 0;
    const generate = createLlm({}, { fetchFn: async () => { calls++; return reply(bad); } });
    await assert.rejects(generate("Удаление", { grilling }), { code: "llm_questions" });
    assert.equal(calls, 2);
});

test("an already answered question is replaced, and good batches never need another call", async () => {
    let calls = 0;
    const generate = createLlm({}, { fetchFn: async () => { calls++; return reply(calls === 1 ? good : ["Нужен ли архив?", "Что показывать при пустом списке?", "Кто может удалять привычки?"]); } });
    await generate("Удаление", { grilling, clarifications: [{ question: good[0], answer: "Да" }] });
    assert.equal(calls, 2);
    calls = 0;
    await generate("Удаление", { grilling });
    assert.equal(calls, 1);
});

test("failed replacement preserves submitted history and never confirms a branch", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.service.generate = createLlm({}, { fetchFn: async () => reply(++calls === 1 ? good : bad) });
    let task = await f.service.create({ projectId: f.project.id, requestId: randomUUID(), title: "Удаление", grilling: true });
    task = await f.service.clarify(task.id, { title: task.title, description: task.description, answers: ["Да", "Нет", "Пустое состояние"], draftRevision: task.draftRevision });
    assert.equal(task.state, "generation_error");
    assert.equal(task.error.code, "llm_questions");
    assert.equal(task.clarifications.length, 3);
    assert.deepEqual(task.questions, []);
    assert.equal(f.github.creates, 0);
    assert.equal(task.branch, null);
    assert.equal(calls, 3);
});
