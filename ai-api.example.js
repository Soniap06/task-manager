// Только локальный LM Studio. Секреты нельзя хранить в браузерном JavaScript.
// model должен совпадать с идентификатором модели, загруженной в LM Studio.
window.AI_API_CONFIG = {
    provider: "lm-studio",
    endpoint: "/api/ai",
    apiKey: "",
    model: "qwen/qwen3.5-9b"
};

async function generateTaskSpecification(taskName) {
    const config = window.AI_API_CONFIG;

    if (!config || !config.endpoint || !config.model) {
        throw new Error("Настройте endpoint и model в файле ai-api.js");
    }

    const headers = {
        "Content-Type": "application/json"
    };

    if (config.apiKey) {
        headers.Authorization = "Bearer " + config.apiKey;
    }

    const response = await fetch(config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "task_specification",
                    strict: true,
                    schema: {
                        type: "object",
                        properties: {
                            title: { type: "string" },
                            branch: { type: "string" },
                            acceptanceCriteria: {
                                type: "array",
                                items: { type: "string" }
                            },
                            steps: {
                                type: "array",
                                items: { type: "string" }
                            }
                        },
                        required: ["title", "branch", "acceptanceCriteria", "steps"],
                        additionalProperties: false
                    }
                }
            },
            messages: [
                {
                    role: "system",
                    content: [
                        "Ты технический аналитик.",
                        "По короткому названию задачи подготовь понятное ТЗ на русском языке.",
                        "Верни только JSON без markdown в формате:",
                        '{"title":"...","branch":"feat/example-name","acceptanceCriteria":["..."],"steps":["..."]}',
                        "Название ветки должно быть в kebab-case и начинаться с feat/, fix/ или chore/."
                    ].join(" ")
                },
                {
                    role: "user",
                    content: `Название задачи: ${taskName}`
                }
            ]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API вернул ошибку ${response.status}: ${errorText || "без описания"}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content = message?.content || message?.reasoning_content;

    if (!content) {
        throw new Error("AI API не вернул содержимое ответа");
    }

    try {
        return JSON.parse(content);
    } catch {
        throw new Error("AI API вернул ответ не в формате JSON");
    }
}
