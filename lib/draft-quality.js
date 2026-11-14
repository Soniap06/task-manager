// Conservative checks for known regressions, not a general semantic verifier.
const { lexicalRepeat, factIssues } = require("./text-evidence");
const unresolved = (text) => /(?:не знаю|не определ|не реш|пока не выб|затрудня|не относится)/iu.test(text);
const axes = [
    ["unknown-id", /(?:неизвестн|несуществующ|не существующ|не найден|отсутствующ).{0,30}(?:id|идентификатор|привычк)|(?:id|идентификатор|привычк).{0,30}(?:неизвестн|несуществующ|не найден)/iu],
    ["authorization", /авторизац|аутентификац|провер.{0,15}прав|прав.{0,15}(?:доступ|удален)|кто может/iu],
    ["import", /импорт/iu],
    ["category-cardinality", /(?:сколько|несколько|одн[ау]|множеств).{0,40}категори|категори.{0,40}(?:сколько|одновремен|одн[ау]|несколько)/iu],
    ["category-uniqueness", /дубликат|(?:одинаков|уникальн|дублир|дубликат).{0,35}(?:назван|им[еёя])|(?:назван|им[еёя]).{0,35}(?:одинаков|уникальн|дублир|дубликат)/iu],
    ["search-match", /префикс|подстрок|начал.{0,20}(?:назван|слов)|полно[ем].{0,15}совпад/iu],
    ["search-case", /регистр/iu],
    ["search-empty", /пуст.{0,20}(?:строк|запрос|поиск)|(?:строк|запрос|поиск).{0,20}пуст/iu],
    ["search-no-results", /(?:нет|отсутств|не найден).{0,20}(?:совпад|результат)|ничего не найден/iu]
];
function questionAxes(text) {
    // Error text/response shape is a different decision from the already known status.
    const specificError = /(?:сообщени|текст|формат|тел[оа]).{0,25}(?:ошиб|ответ)|(?:ошиб|ответ).{0,25}(?:сообщени|текст|формат|тел[оа])/iu.test(text);
    return axes.filter(([key, pattern]) => pattern.test(text) && !(key === "unknown-id" && specificError)).map(([key]) => key);
}
function historyIssues(questions, clarifications = [], input = "") {
    const answered = new Set();
    for (const item of clarifications) {
        if (item.answer?.trim() && !unresolved(item.answer)) for (const axis of questionAxes(item.question)) answered.add(axis);
    }
    if (/404/.test(input) && /неизвестн|несуществующ/iu.test(input)) answered.add("unknown-id");
    if (/импорт.{0,25}(?:не нужен|не требуется)|без импорта/iu.test(input)) answered.add("import");
    if (/(?:авторизац|прав[ао]).{0,40}не менять|не менять.{0,40}(?:авторизац|прав[ао])/iu.test(input)) answered.add("authorization");
    const seen = new Set();
    return questions.flatMap((question) => {
        const topics = questionAxes(question);
        const duplicate = lexicalRepeat(question, clarifications) || topics.some((key) => answered.has(key) || seen.has(key));
        topics.forEach((key) => seen.add(key));
        return duplicate ? [{ question, reason: "Это решение уже задано в исходном запросе, ответах или текущей пачке. Не спрашивайте его другими словами." }] : [];
    });
}
function descriptionIssues(description, input = "", clarifications = []) {
    // Only user input/answers are evidence. Prior model drafts/questions are not facts.
    const evidence = [input, ...clarifications.map((item) => item.answer || "")].join("\n");
    const findings = factIssues(description, input, clarifications);
    const claims = [
        [/(?:отдельн.{0,15}(?:страниц|спис(?:ок|к))|страниц.{0,15}результат)/iu, /отдельн.{0,15}(?:страниц|спис(?:ок|к))|страниц.{0,15}результат/iu, "Не согласовано отдельное место отображения результатов."],
        [/(?:уникальн.{0,20}(?:им[яе]|назван)|(?:им[яе]|назван).{0,20}уникальн)/iu, /уникальн|одинаков.{0,20}(?:им[яе]|назван)|дубликат|дублиру/iu, "Не согласовано требование уникальности имени."],
        [/флаг.{0,15}активност|активна\/неактивна/iu, /флаг.{0,15}активност|активна|неактивна/iu, "Не согласован флаг активности."],

    ];
    for (const [claim, support, reason] of claims) {
        if (support ? claim.test(description) && !support.test(evidence) : [...description.matchAll(claim)].some(([code]) => !evidence.includes(code))) findings.push({ question: "description", reason });
    }
    if (/тест/iu.test(input) && !/тест/iu.test(description)) findings.push({ question: "description", reason: "Потеряно исходное требование к тестам." });
    const requiredCodes = new Set(input.match(/\b(?:400|401|403|404|409|500)\b/g) || []);
    for (const { answer } of clarifications) {
        // Only an explicit replacement changes the source requirement; a question does not.
        for (const change of (answer || "").matchAll(/вместо\s+(?<old>[1-5]\d{2})[^\d.!?]{0,40}(?<next>[1-5]\d{2})/giu)) {
            if (requiredCodes.delete(change.groups.old)) requiredCodes.add(change.groups.next);
        }
    }
    for (const code of requiredCodes) {
        if (!description.includes(code)) findings.push({ question: "description", reason: `Потерян согласованный статус ${code}.` });
    }
    return findings;
}
module.exports = { historyIssues, descriptionIssues };
