// Narrow checks for technical facts available in source code, not a semantic review of the task.
const rules = [
    ["Формат идентификатора определяется кодом. Уточняйте поведение при неверном ID, а не его тип.", /(?:формат|тип)\s+(?:самого\s+)?(?:id\b|идентификатор)|(?:id\b|идентификатор).{0,40}(?:строка|число|uuid|автоинкремент)|(?:type|format)\s+of\s+(?:the\s+)?(?:id|identifier)/iu],
    ["Место и технология хранения определяются по коду. Можно уточнять сроки хранения и сохранность данных.", /(?:где|в ч[её]м).{0,45}(?:храня|храни|хранен)|(?:как[а-яё]*|какая).{0,40}(?:хранилищ|субд|баз[аы] данных|orm|фреймворк)|where.{0,35}(?:stored|storage)|which.{0,30}\b(?:database|framework|orm)\b/iu],
    ["Технические имена полей, таблиц, методов и файлов разработчик найдёт в коде.", /(?:как[а-яё]*|как).{0,30}(?:имя|назван|называ).{0,30}(?:пол[яею]|таблиц|метод|функци|файл|класс|переменн)|(?:имя|назван).{0,15}(?:пол[яею]|таблиц|метод|функци|файл).{0,25}(?:использ|выбра)|(?:name).{0,25}(?:field|table|method|file|variable)/iu],
    ["HTTP-метод и путь API определяются существующим кодом; спрашивайте об ожидаемом результате операции.", /(?:как[а-яё]*)\s+(?:http[- ]?метод|путь.{0,15}(?:api|удалени|запрос)|endpoint|эндпоинт|метод и путь|url.{0,15}(?:api|запрос))|(?:укаж|назов).{0,25}(?:http[- ]?метод|путь api|endpoint|эндпоинт)|(?:which|what).{0,25}(?:http method|endpoint|api path)/iu],
    ["Пути файлов и команды запуска/тестов доступны в репозитории.", /(?:как[а-яё]*|где|укаж).{0,40}(?:файл[еуыа]?\s+(?:реализ|наход|располож|измен|лежит)|пут[ьи] к файл|package\.json|команд[ауы].{0,20}(?:запуск|тест))|which file.{0,20}(?:implement|edit|change|locat)|what.{0,20}(?:file path|test command|start command)/iu]
];
const normalize = (text) => text.trim().toLocaleLowerCase("ru").replace(/[\s?!.,:;]+/g, " ").trim();

function questionIssues(questions, clarifications = []) {
    const answered = new Set(clarifications.map((item) => normalize(item.question)));
    return questions.flatMap((question) => {
        const rule = rules.find(([, pattern]) => pattern.test(question));
        const reason = answered.has(normalize(question)) ? "Этот вопрос уже получил ответ. Выберите другое нерешённое решение." : rule?.[0];
        return reason ? [{ question, reason }] : [];
    });
}

module.exports = { questionIssues };
