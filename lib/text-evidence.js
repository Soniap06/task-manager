// Language-independent facts and conservative Russian lexical comparisons.
// These are guards, not a proof of semantic equivalence.
const stop = new Set("нужно нужен нужна нужны необходимо требуется следует должен должна должны ли как какой какая какое какие что где когда это для при после перед если или будет быть у в на и а с по от до из во со об про нам мне можно надо чтобы делать сделать реализовать добавить пользователь пользователю системой систем система".split(" "));
function terms(text) {
    return [...new Set((text.toLocaleLowerCase("ru").replace(/ё/g, "е").match(/[\p{L}]+/gu) || [])
        .filter((word) => word.length > 2 && !stop.has(word))
        .map((word) => word.length > 5 ? word.replace(/(?:иями|ами|ями|ого|ему|ому|ить|ать|ять|ется|ются|ение|ения|ений|ость|ости|овать|ировать|ах|ях|ой|ый|ий|ая|ое|ые|ие|ов|ев|ам|ям|ом|ем|ы|а|я|у|ю|е|и)$/u, "") : word))];
}
function lexicalRepeat(question, history) {
    const current = terms(question);
    if (current.length < 3) return false;
    return history.some(({ question: previous, answer }) => {
        if (!answer?.trim() || /не знаю|не определ|не реш|не относится/iu.test(answer)) return false;
        const prior = terms(previous);
        const shared = current.filter((word) => prior.includes(word)).length;
        return shared >= 3 && shared / Math.max(current.length, prior.length) >= 0.8;
    });
}
function factIssues(description, input, clarifications) {
    const evidence = [input, ...clarifications.map(({ answer }) => answer || "")].join("\n");
    const issues = [];
    // Preserve decimal values as one fact, and never borrow numbers from questions.
    const numbers = (text) => text.replace(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu, "").match(/\d+(?:[.,]\d+)?/g) || [];
    const known = new Set(numbers(evidence));
    for (const value of new Set(numbers(description))) {
        if (!known.has(value)) issues.push({ question: "description", reason: `Число ${value} не подтверждено исходным запросом или ответами.` });
    }
    const primary = input.split(/[.!?;\n]/u)[0].trim();
    const primaryTerms = terms(primary);
    if (/^(?:добавить|реализовать|создать|настроить|обновить|исправить)\s/iu.test(primary) && primary.length <= 160 && primaryTerms.length >= 2 && primaryTerms.length <= 5 && !/\d|вместо|или/iu.test(primary)) {
        const outputTerms = terms(description);
        const missing = primaryTerms.filter((word) => !outputTerms.includes(word));
        if (missing.length) issues.push({ question: "description", reason: `В описании потеряна часть исходной цели «${primary}». Сохраните её полностью, а не только последнее уточнение.` });
    }
    const timeValues = (text) => [...text.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)].map((match) => `${Number(match[1])}:${match[2]}`);
    const clearTimeEvidence = [input, ...clarifications.map(({ answer }) => answer || "")].filter((text) => !/не знаю|не определ|не реш|не\s+\d{1,2}:/iu.test(text));
    const agreedTimes = new Set(clearTimeEvidence.flatMap(timeValues));
    const knownTimes = new Set(timeValues(evidence));
    if (timeValues(description).some((value) => !knownTimes.has(value))) issues.push({ question: "description", reason: "В описании добавлено неподтверждённое время." });
    if (agreedTimes.size === 1 && !timeValues(description).includes([...agreedTimes][0])) {
        issues.push({ question: "description", reason: "Потеряно явно указанное время. Сохраните время и его контекст из исходного запроса/ответов." });
    }
    const clauses = description.split(/[.!?;\n]+/u);
    const negative = /(?:^|[^\p{L}])(?:не|без)(?:$|[^\p{L}])|исключ|запрещ/iu;
    for (const pattern of [/\bUI\b|интерфейс/iu, /авторизац/iu, /(?:^|[^\p{L}])БД(?:$|[^\p{L}])|баз[ауые] данных/iu]) {
        let forbidChange = false;
        let explicitlyAllowed = false;
        for (const clause of evidence.split(/[.!?;\n]+/u)) {
            if (!pattern.test(clause)) continue;
            if (/не менять|не изменять|без изменени/iu.test(clause)) { forbidChange = true; explicitlyAllowed = false; }
            else if (/(?:теперь|разреш|можно).{0,30}(?:менять|изменять)|(?:менять|изменять).{0,30}(?:теперь можно|разрешено)/iu.test(clause)) { forbidChange = false; explicitlyAllowed = true; }
        }
        if (explicitlyAllowed && clauses.some((clause) => pattern.test(clause) && /не менять|не изменять|без изменени/iu.test(clause))) {
            issues.push({ question: "description", reason: "Описание вернуло старый запрет после явного разрешения пользователя. Сохраните последнее согласованное изменение." });
        }
        if (forbidChange && !clauses.some((clause) => pattern.test(clause) && negative.test(clause))) {
            issues.push({ question: "description", reason: "Потерян явный запрет менять интерфейс, авторизацию или базу данных. Сохраните исходное ограничение." });
        }
    }
    const latestDecisions = new Map();
    for (const item of clarifications) {
        const topic = terms(item.question);
        // A clear latest yes/no replaces the previous decision on the same single topic.
        if (topic.length === 1 && /^(?:нуж|требуе|добав|поддерж|разреш)/iu.test(item.question.trim()) && /^(?:да|нет)(?:[,.!\s]|$)/iu.test(item.answer?.trim() || "")) {
            latestDecisions.set(topic[0], item);
        }
    }
    for (const [topic, { question, answer }] of latestDecisions) {
        if (!/^нет(?:[,.!\s]|$)/iu.test(answer.trim())) continue;
        for (const clause of clauses) {
            if (terms(clause).includes(topic) && !/(?:^|[^\p{L}])(?:не|без)(?:$|[^\p{L}])|исключ|запрещ/iu.test(clause)) {
                issues.push({ question: "description", reason: `Условие противоречит ответу «Нет» на вопрос: ${question}` });
                break;
            }
        }
    }
    return issues;
}
module.exports = { lexicalRepeat, factIssues };
