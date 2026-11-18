/* Общий справочник формы и серверной валидации. ID групп стабильны для будущего планировщика. */
(function (root) {
    const options = {
        roles: ["Frontend-разработчик", "Backend-разработчик", "Fullstack-разработчик", "UI/UX-дизайнер", "Тестировщик", "DevOps-инженер", "Аналитик", "Менеджер проекта", "ИИ-ассистент"],
        grades: ["Стажёр", "Junior", "Middle", "Senior", "Lead", "Не применимо"],
        groups: [
            { id: "frontend", name: "Frontend" }, { id: "backend", name: "Backend" },
            { id: "data", name: "Данные" }, { id: "integrations", name: "Интеграции" },
            { id: "testing", name: "Тестирование" }, { id: "design", name: "Дизайн" },
            { id: "infrastructure", name: "Инфраструктура" }, { id: "ai", name: "ИИ" }, { id: "management", name: "Управление" }
        ],
        technologies: [
            ["Языки", ["JavaScript", "TypeScript", "Python", "Java", "C#", "C++", "Go", "PHP"]],
            ["Frontend", ["HTML", "CSS", "React", "Vue", "Angular", "Next.js"]],
            ["Backend", ["Node.js", "Express", "FastAPI", "Django", "Spring", "ASP.NET Core"]],
            ["Данные", ["SQL", "SQLite", "PostgreSQL", "MySQL", "MongoDB", "Redis"]],
            ["Интеграции", ["REST API", "GitHub API", "Webhooks", "WebSocket"]],
            ["Тестирование", ["Ручное тестирование", "Unit-тестирование", "Интеграционное тестирование", "E2E-тестирование", "Playwright", "Jest", "pytest"]],
            ["Дизайн", ["UI/UX", "Figma", "Прототипирование", "Адаптивная вёрстка", "Доступность"]],
            ["Инфраструктура", ["Git / GitHub", "Linux", "Docker", "CI/CD", "Nginx", "Caddy", "Развёртывание на сервере"]],
            ["ИИ", ["Работа с LLM", "Промптинг", "LM Studio", "Оценка ответов LLM"]],
            ["Управление", ["Анализ требований", "Декомпозиция задач", "Планирование спринтов", "Документация", "Код-ревью"]]
        ]
    };
    if (typeof module !== "undefined" && module.exports) module.exports = options;
    else root.EmployeeOptions = options;
})(typeof globalThis === "undefined" ? this : globalThis);
