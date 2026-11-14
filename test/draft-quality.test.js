const { test } = require("node:test");
const assert = require("node:assert/strict");
const { historyIssues, descriptionIssues } = require("../lib/draft-quality");
const { questionIssues } = require("../lib/question-quality");
test("rejects observed paraphrases while allowing a different error detail", () => {
    const history = [{ question: "Какой результат для неизвестного идентификатора?", answer: "404" }];
    assert.equal(historyIssues(["Какое поведение при попытке удаления несуществующей привычки?"], history).length, 1);
    assert.equal(historyIssues(["Какой формат ответа при неизвестном ID?"], history).length, 0);
    assert.equal(historyIssues(["Какое поведение при попытке удаления несуществующей привычки?"], [{ ...history[0], answer: "Не знаю" }]).length, 0);
});
test("does not reopen explicitly excluded scope and catches the actual field questions", () => {
    const input = "Импорт не нужен. Авторизацию не менять.";
    assert.equal(historyIssues(["Нужна ли проверка прав на удаление?", "Нужен ли импорт?"], [], input).length, 2);
    assert.equal(questionIssues(["Какое поле отвечает за название категории?", "Какое поле отвечает за импорт категорий?"]).length, 2);
    assert.equal(questionIssues(["Какие поля обязательны у категории?"]).length, 0);
});
test("model suggestions are not evidence for description claims", () => {
    assert.equal(descriptionIssues("Показывать результаты на отдельной странице результатов.", "Поиск", [{ question: "На отдельной странице?", answer: "Порядок результатов сохранить" }]).length, 1);
    assert.equal(descriptionIssues("Показывать результаты на отдельной странице результатов.", "Поиск", [{ question: "Где?", answer: "На отдельной странице результатов" }]).length, 0);
    assert.equal(descriptionIssues("Категория имеет уникальное название и флаг активности.", "Добавить категории").length, 2);
    assert.equal(descriptionIssues("Удаление возвращает 204.", "Для неизвестного ID 404. Добавить тесты.").length, 3);
    assert.deepEqual(descriptionIssues("Добавить тесты удаления. Неизвестный ID возвращает 404.", "Для неизвестного ID 404. Добавить тесты."), []);
});

test("final description is corrected once with feedback and rejects a second unsupported result", async () => {
    const { createLlm } = require("../lib/llm");
    let calls = 0;
    const generate = createLlm({}, { fetchFn: async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        if (calls === 2) assert.ok(JSON.parse(body.messages.at(-1).content).correction.rejected.some((issue) => /место отображения/.test(issue.reason)));
        const description = calls === 1 ? "Показывать результаты на отдельной странице результатов." : "Добавить поиск привычек.";
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Поиск", description, questions: [] }) } }] }));
    } });
    const context = { grilling: { minimum: 9, maximum: 30, answered: 9, finalize: true } };
    assert.equal((await generate("Добавить поиск привычек", context)).description, "Добавить поиск привычек.");
    assert.equal(calls, 2);
    const reject = createLlm({}, { fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Поиск", description: "На отдельной странице результатов.", questions: [] }) } }] })) });
    await assert.rejects(reject("Поиск", context), { code: "llm_questions" });
});

test("semantic rejection preserves original history and does not turn user questions into facts", async () => {
    const { createLlm } = require("../lib/llm");
    const history = [{ round: 1, question: "Какой результат для неизвестного идентификатора?", answer: "404" }];
    let calls = 0;
    const generate = createLlm({}, { fetchFn: async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        if (calls === 2) assert.deepEqual(JSON.parse(body.messages.at(-1).content).lastAnswers, history.map(({ question, answer }) => ({ question, answer })));
        const questions = calls === 1 ? ["Какое поведение при попытке удаления несуществующей привычки?"] : ["Нужно ли подтверждение удаления?", "Можно ли отменить удаление?", "Что показать после удаления последней привычки?"];
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Удаление", description: "Удалить привычку. Неизвестный ID — 404.", questions }) } }] }));
    } });
    assert.equal((await generate("Удалить привычку. Неизвестный ID — 404.", { grilling: { minimum: 9, maximum: 30, answered: 5 }, clarifications: history })).questions.length, 3);
    assert.equal(calls, 2);
    assert.equal(history.length, 1);
});

test("duplicate-category paraphrase from the live retest is blocked", () => {
    const history = [{ question: "Разрешены ли одинаковые названия категорий?", answer: "Нет, сравнивать без учёта регистра." }];
    assert.equal(historyIssues(["Как обрабатывать дубликаты категорий при создании (игнорировать или обновлять существующую)?"], history).length, 1);
});

test("new numeric facts cannot come from an unanswered model proposal", () => {
    assert.equal(descriptionIssues("Удалять резервные копии через 60 дней.", "Срок хранения 30 дней.", [{ question: "Хранить 60 дней?", answer: "Не определено" }]).length, 1);
    assert.deepEqual(descriptionIssues("Хранить копии 30 дней.", "Срок хранения 30 дней."), []);
});
test("a short negative answer is not an affirmative requirement", () => {
    const history = [{ question: "Нужен ли экспорт?", answer: "Нет." }];
    assert.equal(descriptionIssues("Добавить экспорт.", "Отчёты", history).length, 1);
    assert.deepEqual(descriptionIssues("Экспорт не требуется.", "Отчёты", history), []);
});
test("lexical paraphrases work outside habit-specific rules without merging different decisions", () => {
    const history = [{ question: "Нужно ли подтверждать удаление резервных копий?", answer: "Да" }];
    assert.equal(historyIssues(["Требуется ли подтверждать удаление резервных копий?"], history).length, 1);
    assert.deepEqual(historyIssues(["Какой срок хранения резервных копий?"], history), []);
});

test("a schema-sized fragment or glued questions is not a valid clarification", () => {
    assert.equal(questionIssues(["Как назвать кнопку? Где показывать результаты?"]).length, 1);
    assert.equal(questionIssues(["Искать по подстроке (например,"]).length, 1);
    assert.equal(questionIssues(["Как показать " + "результаты ".repeat(23)]).length, 1);
    assert.deepEqual(questionIssues(["Какое сообщение показывать при отсутствии результатов?"]), []);
});

test("optional second pass reviews the candidate against source, still using at most two calls", async () => {
    const { createLlm } = require("../lib/llm");
    let calls = 0;
    const generate = createLlm({ reviewDraft: true }, { fetchFn: async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        if (calls === 2) {
            const last = JSON.parse(body.messages.at(-1).content);
            assert.equal(last.correction.candidate.questions[0], "Как очищать поиск?");
            assert.match(last.correction.review, /Candidate не является источником/);
            assert.equal(last.grilling.minimum, 0);
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Поиск", description: "Добавить поиск по названию. Очистка отдельной кнопкой.", questions: calls === 1 ? ["Как очищать поиск?"] : [] }) } }] }));
    } });
    assert.deepEqual((await generate("Добавить поиск по названию. Очистка отдельной кнопкой.", { grilling: { minimum: 0, maximum: 30, answered: 0 } })).questions, []);
    assert.equal(calls, 2);
});

test("final description keeps explicit no-change constraints, not only the feature itself", () => {
    const input = "Удалить привычку. UI, авторизацию и БД не менять.";
    assert.equal(descriptionIssues("Удалить привычку.", input).length, 3);
    assert.deepEqual(descriptionIssues("Удалить привычку. Без изменений интерфейса, авторизации и базы данных.", input), []);
});

test("a clear latest status replacement wins over the old input but a proposal does not", () => {
    const input = "Для неизвестного ID возвращать 404.";
    const history = [{ question: "Меняем статус?", answer: "Да. Вместо 404 теперь возвращать 410." }];
    assert.deepEqual(descriptionIssues("Для неизвестного ID возвращать 410.", input, history), []);
    assert.ok(descriptionIssues("Для неизвестного ID возвращать 404.", input, history).some((issue) => issue.reason.includes("410")));
    assert.ok(descriptionIssues("Для неизвестного ID возвращать 410.", input, [{ question: "Вместо 404 возвращать 410?", answer: "Не знаю" }]).length);
});

test("a later explicit permission can replace an old no-change constraint", () => {
    const input = "Добавить фильтр. Интерфейс не менять.";
    const history = [{ question: "Меняем интерфейс?", answer: "Теперь можно менять интерфейс для кнопки фильтра." }];
    assert.deepEqual(descriptionIssues("Добавить фильтр и кнопку в интерфейсе.", input, history), []);
    assert.ok(descriptionIssues("Добавить фильтр.", input, [{ question: "Меняем интерфейс?", answer: "Пока не решено." }]).length);
});
test("latest clear yes/no wins, while an uncertain answer cannot manufacture consent", () => {
    const question = "Нужен ли экспорт?";
    const no = { question, answer: "Нет, экспорт не нужен." };
    const yes = { question, answer: "Да, нужен экспорт." };
    assert.deepEqual(descriptionIssues("Добавить экспорт.", "Отчёты", [no, yes]), []);
    assert.ok(descriptionIssues("Добавить экспорт.", "Отчёты", [yes, no]).length);
    assert.ok(descriptionIssues("Добавить экспорт.", "Отчёты", [no, { question, answer: "Не знаю." }]).length);
});

test("a later UI answer must not erase the original feature and its subject", () => {
    const input = "Добавить фильтр товаров. Интерфейс не менять.";
    const history = [{ question: "Меняем интерфейс?", answer: "Теперь можно менять интерфейс для кнопки фильтра." }];
    assert.ok(descriptionIssues("Добавить кнопку фильтра. Интерфейс можно менять.", input, history).some((issue) => /исходной цели/.test(issue.reason)));
    assert.deepEqual(descriptionIssues("Добавить фильтр товаров и кнопку в интерфейсе.", input, history), []);
});

test("one unambiguous clock time cannot disappear or be borrowed from a proposal", () => {
    const history = [{ question: "Когда напоминать?", answer: "В 08:00 по местному времени." }];
    assert.ok(descriptionIssues("Добавить напоминание.", "Напоминания", history).length);
    assert.deepEqual(descriptionIssues("Напоминание в 8:00 по местному времени.", "Напоминания", history), []);
    assert.deepEqual(descriptionIssues("Добавить напоминание.", "Напоминания", [{ question: "В 08:00?", answer: "Не определено." }]), []);
});

test("description cannot restore a prohibition superseded by explicit permission", () => {
    const input = "Добавить фильтр товаров. Интерфейс не менять.";
    const history = [{ question: "Меняем интерфейс?", answer: "Теперь можно менять интерфейс для кнопки фильтра." }];
    assert.ok(descriptionIssues("Добавить фильтр товаров. Интерфейс не менять.", input, history).some((issue) => /старый запрет/.test(issue.reason)));
});
