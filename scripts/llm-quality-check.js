// Real-model diagnostics only. Does not import TaskService, storage or GitHub.
const { loadConfig } = require("../lib/config");
const { createLlm } = require("../lib/llm");
const { publicError } = require("../lib/errors");

const cases = [
    {
        name: "Итог двух раундов: сохранить правила повторяющихся задач",
        input: "Добавить повторяющиеся задачи. Нужно согласовать периодичность, поведение при пропуске, момент создания следующей задачи, сохранение исполнителя и возможность остановить повторение. Пока ни одно из этих решений не выбрано. Не добавлять уведомления, экспорт или новые роли. Добавить тесты согласованного поведения.",
        history: [
            { question: "Как часто должна повторяться задача?", answer: "Еженедельно. День недели пока не выбран, его нужно уточнить.", round: 1 },
            { question: "Что происходит при пропуске?", answer: "Просроченная задача остаётся открытой. Автоматически завершать или пропускать её не нужно.", round: 1 },
            { question: "Когда создавать следующую задачу?", answer: "Только после завершения предыдущей задачи. Пропуск сам по себе новую задачу не создаёт.", round: 1 },
            { question: "Сохранять ли исполнителя?", answer: "Исполнитель сохраняется из предыдущей задачи.", round: 1 },
            { question: "Как остановить повторение?", answer: "Отдельное действие «Остановить повторение» в карточке. Текущую задачу при этом не удалять.", round: 1 },
            { question: "Какой день недели выбран?", answer: "По вторникам.", round: 2 }
        ],
        finalize: true,
        expected: (draft) => !draft.questions.length && /вторник/iu.test(draft.description) && /завершен/iu.test(draft.description) && /исполнител/iu.test(draft.description) && /не удал/iu.test(draft.description) && /тест/iu.test(draft.description)
    },
    {
        name: "Ясная исходная задача: без обязательного первого раунда",
        input: "Добавить удаление привычки по ID. Если ID неизвестен, вернуть 404. Добавить тесты успешного удаления и неизвестного ID. Интерфейс не менять.",
        history: [],
        expected: (draft) => !draft.questions.length && /404/.test(draft.description) && /тест/iu.test(draft.description) && /интерфейс/iu.test(draft.description)
    },
    {
        name: "Поиск после выбора: не переспрашивать выбранное поведение",
        input: "Добавить поиск товаров по названию. Не решено, искать по подстроке или только по началу названия. Нужно уточнить именно это поведение. Другие функции не добавлять.",
        history: [{ question: "Искать по подстроке или только по началу названия?", answer: "По подстроке. Других изменений не нужно." }],
        expected: (draft) => !draft.questions.length && /подстрок/iu.test(draft.description) && /товар/iu.test(draft.description)
    },
    {
        change: true,
        name: "Итог: явно изменённый статус важнее исходного",
        input: "Для неизвестного ID возвращать 404. Добавить тесты неизвестного ID. Интерфейс не менять.",
        history: [{ question: "Меняем статус?", answer: "Да. Вместо 404 теперь возвращать 410." }],
        finalize: true,
        expected: (draft) => !draft.questions.length && /410/.test(draft.description) && !/404/.test(draft.description) && /тест/iu.test(draft.description) && /интерфейс/iu.test(draft.description)
    },
    {
        change: true,
        name: "Итог: последнее нет отменяет прежнее да",
        input: "Добавить страницу отчётов. Решение по экспорту указано в ответах. Других функций не добавлять.",
        history: [
            { question: "Нужен ли экспорт?", answer: "Нет." },
            { question: "Нужен ли экспорт?", answer: "Да, нужен экспорт." },
            { question: "Нужен ли экспорт?", answer: "Нет, экспорт не нужен. Окончательное решение: без экспорта." }
        ],
        finalize: true,
        expected: (draft) => !draft.questions.length && /без(?:\s+\p{L}+){0,3}\s+экспорта|экспорт.{0,25}(?:не нужен|не требуется|не добавлять|не реализ|исключ|запрещ)/iu.test(draft.description)
    },
    {
        change: true,
        name: "Итог: явное разрешение меняет прежний запрет интерфейса",
        input: "Добавить фильтр товаров. Интерфейс не менять.",
        history: [{ question: "Меняем интерфейс?", answer: "Теперь можно менять интерфейс для кнопки фильтра. Добавить кнопку фильтра. Остальное не менять." }],
        finalize: true,
        expected: (draft) => !draft.questions.length && /кнопк/iu.test(draft.description) && /фильтр/iu.test(draft.description) && /товар/iu.test(draft.description)
    },
    {
        name: "Категории после ответов: не возвращаться к импорту и кратности",
        input: "Добавить категории привычек. Только название и необязательный цвет. Одной привычке можно назначить одну категорию. При удалении категории привычки остаются без категории. Импорт не нужен. Других функций не нужно.",
        history: [
            { question: "Можно ли несколько категорий на привычку?", answer: "Нет. Только одна категория." },
            { question: "Нужен ли импорт?", answer: "Нет." },
            { question: "Цвет обязателен?", answer: "Нет. Цвет необязателен." }
        ],
        expected: (draft) => !draft.questions.length && /необязател/iu.test(draft.description) && /импорт.{0,15}(?:не нужен|не требуется)|без импорта/iu.test(draft.description)
    },
    {
        name: "Согласованные уведомления: не открывать заново время и канал",
        input: "Добавить ежедневное напоминание о привычке. Канал и время уточнены в ответах. Дополнительные функции не нужны.",
        history: [
            { question: "В какое время напоминать?", answer: "В 08:00 по местному времени пользователя." },
            { question: "Нужна ли отправка email?", answer: "Нет." },
            { question: "Как доставлять напоминание?", answer: "Только уведомление внутри приложения." }
        ],
        expected: (draft) => !draft.questions.length && /08:00/.test(draft.description) && /внутри приложени/iu.test(draft.description) && !draft.description.split(/[.!;\n]/u).some((clause) => /(?:отправлять|отправка).{0,10}email/iu.test(clause) && !/запрещ|не отправ|отправка.{0,15}не нужна/iu.test(clause))
    },
    {
        name: "Итог восстановления: старый draft и предложение вопроса не являются решением",
        input: "Добавить очистку резервных копий. Хранить копии 30 дней. Резервные копии младше этого срока не удалять. Добавить тесты. Интерфейс не менять.",
        history: [{ question: "Можно удалять копии через 60 дней?", answer: "Нет. Только после 30 дней, как указано в исходной задаче." }],
        description: "Удалять копии через 60 дней и добавить новую страницу настроек.",
        finalize: true,
        expected: (draft) => !draft.questions.length && /30/.test(draft.description) && !/60|страниц/iu.test(draft.description) && /тест/iu.test(draft.description) && /интерфейс/iu.test(draft.description)
    },
    {
        name: "Настоящая неясность: не пропустить явно невыбранный способ поиска",
        input: "Добавить поиск товаров по названию. Не решено, искать по подстроке или только по началу названия. Нужно уточнить именно это поведение. Другие функции не добавлять.",
        history: [],
        expected: (draft) => draft.questions.some((q) => /подстрок/iu.test(q) && /начал|префикс/iu.test(q) && /\?$/.test(q.trim()))
    }
];

async function main() {
    const config = loadConfig().llm;
    const generate = createLlm(config);
    let passed = 0;
    const selected = process.argv.includes("--changes") ? cases.filter((item) => item.change) : cases;
    console.log("Реальная модель. Синтетические данные; карточки, БД и GitHub не используются.");
    for (const item of selected) {
        const started = Date.now();
        try {
            const draft = await generate(item.input, {
                repository: "example/quality-check",
                description: item.description || item.input,
                clarifications: item.history.map((pair) => ({ ...pair, round: pair.round || 1 })),
                grilling: { minimum: 0, maximum: 30, answered: item.history.length, finalize: item.finalize === true }
            });
            const ok = item.expected(draft);
            if (ok) passed++;
            console.log(JSON.stringify({ case: item.name, ok, draft, seconds: (Date.now() - started) / 1000 }));
        } catch (error) {
            console.log(JSON.stringify({ case: item.name, ok: false, error: publicError(error), seconds: (Date.now() - started) / 1000 }));
        }
    }
    console.log(`Целевые сценарии: ${passed}/${selected.length}. Это ограниченные проверки; смысл всего текста дополнительно оценивает человек.`);
    if (passed !== selected.length) process.exitCode = 1;
}
main().catch(() => { console.error("Не удалось запустить проверку модели. Проверьте конфигурацию API."); process.exitCode = 1; });
