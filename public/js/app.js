const content = document.getElementById("content");
const pageTitle = document.getElementById("pageTitle");
const page = location.pathname.slice(1);
let projectId = new URLSearchParams(location.search).get("projectId") || "";
try { projectId ||= sessionStorage.getItem("task-manager.active-project.v1") || ""; } catch { /* Необязательный выбор. */ }

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(150_000) });
    const result = await response.json();
    if (response.status === 401 && page !== "login") location.assign("/login");
    if (!response.ok) throw new Error(result.error?.message || "Ошибка API.");
    return result;
}

function link(text, href) {
    const element = node("a", text, "btn light");
    element.href = href;
    return element;
}

function person(employee) {
    const element = node("div", undefined, "person");
    const initials = node("span", employee.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join(""), "avatar-mini");
    const text = node("div");
    text.append(node("h3", employee.name), node("p", employee.role));
    element.append(initials, text);
    return element;
}

function skills(employee) {
    const element = node("div", undefined, "stack");
    for (const skill of employee.stack) element.append(node("span", skill, "chip"));
    return element;
}

async function selectProject() {
    const { projects } = await api("/api/projects");
    const available = projects.filter((project) => !project.archived);
    if (!available.some((project) => project.id === projectId)) projectId = available[0]?.id || "";
    const label = node("label", "Рабочий проект ", "workspace-project");
    const select = node("select");
    for (const project of available) {
        const option = node("option", project.fullName);
        option.value = project.id;
        select.append(option);
    }
    select.value = projectId;
    select.disabled = !available.length;
    label.append(select, link("Настроить проекты", "/projects.html"));
    content.append(label);
    select.onchange = () => {
        projectId = select.value;
        try { sessionStorage.setItem("task-manager.active-project.v1", projectId); } catch { /* Выбор остаётся на странице. */ }
        location.assign(`/${page}?projectId=${encodeURIComponent(projectId)}`);
    };
    document.querySelector(".project-chip").textContent = available.find((project) => project.id === projectId)?.fullName || "Проект не выбран";
}

async function team() {
    const employees = await api("/api/employees");
    const tasks = projectId ? (await api(`/api/tasks?projectId=${encodeURIComponent(projectId)}`)).tasks : [];
    const grid = node("div", undefined, "team");
    for (const employee of employees) {
        const count = tasks.filter((task) => task.assigneeId === employee.id).length;
        const card = node("article", undefined, "employee");
        card.append(person(employee), node("span", employee.executor_type === "ai_agent" ? "✦ AI Agent · выполнение пока не подключено" : "● Человек", "badge"), skills(employee));
        card.append(node("p", `Назначено задач: ${count}. Ёмкость: ${employee.capacity} ч. за спринт.`, "note"));
        grid.append(card);
    }
    content.append(grid);
}

async function events() {
    if (!projectId) { content.append(node("p", "Подключите проект для просмотра событий.")); return; }
    const records = await api(`/api/events?projectId=${encodeURIComponent(projectId)}`);
    const list = node("div", undefined, "events");
    for (const record of records) {
        const card = node("article", undefined, "event");
        const text = node("div", undefined, "event-body");
        text.append(node("h3", record.event_type), node("p", record.payload_summary));
        const time = node("time", new Date(record.created_at).toLocaleString("ru-RU"));
        time.dateTime = record.created_at;
        card.append(text, time);
        list.append(card);
    }
    content.append(records.length ? list : node("p", "Событий пока нет. Они появятся после получения подписанных webhook GitHub."));
}

async function profile() {
    const employee = await api(`/api/profile${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    if (!employee.id) {
        content.append(node("p", employee.username ? `Для логина «${employee.username}» сотрудник пока не привязан.` : "Вы работаете локально без входа. Для персонального профиля настройте авторизацию."));
        return;
    }
    const card = node("section", undefined, "profile");
    card.append(person(employee), skills(employee), node("p", `Ёмкость: ${employee.capacity} ч. за спринт.`));
    card.append(node("p", `В работе: ${employee.stats.in_progress}. На проверке: ${employee.stats.in_review}.`));
    content.append(card);
}

async function login() {
    const status = await api("/api/auth/status");
    if (!status.enabled) {
        content.append(node("p", "Сейчас включён локальный режим без авторизации. Вход настраивается через .env."), link("Открыть доску", "/"));
        return;
    }
    const form = node("form", undefined, "login");
    form.append(node("h2", "Вход в Task Manager"));
    const username = node("input");
    username.name = "username";
    username.autocomplete = "username";
    username.required = true;
    const password = node("input");
    password.name = "password";
    password.type = "password";
    password.autocomplete = "current-password";
    password.required = true;
    for (const [text, input] of [["Логин", username], ["Пароль", password]]) {
        const label = node("label", text, "field");
        label.append(input);
        form.append(label);
    }
    const error = node("p");
    error.setAttribute("role", "alert");
    const button = node("button", "Войти", "btn primary");
    button.type = "submit";
    form.append(error, button);
    form.onsubmit = async (event) => {
        event.preventDefault();
        button.disabled = true;
        error.textContent = "";
        try {
            await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: username.value, password: password.value }) });
            location.assign("/");
        } catch (cause) { error.textContent = cause.message; }
        finally { button.disabled = false; }
    };
    content.append(form);
}

document.getElementById("menuToggle").onclick = () => document.getElementById("navMenu").classList.toggle("open");
document.getElementById("logoutLink").onclick = async (event) => {
    event.preventDefault();
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); location.assign("/login"); }
    catch (error) { content.append(node("p", error.message)); }
};
(async () => {
    pageTitle.textContent = { team: "Сотрудники", events: "События GitHub", profile: "Профиль", login: "Авторизация" }[page] || "Task Manager";
    const status = await api("/api/auth/status");
    document.querySelector(".top-user").textContent = status.username || "Локальная команда";
    document.getElementById("logoutLink").hidden = !status.authenticated;
    document.getElementById("loginLink").hidden = status.authenticated;
    if (page === "login") await login();
    else {
        await selectProject();
        if (page === "team") await team();
        else if (page === "events") await events();
        else if (page === "profile") await profile();
    }
})().catch((error) => content.append(node("p", error.message, "panel")));
