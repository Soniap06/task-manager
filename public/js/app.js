const content = document.getElementById("content");
const pageTitle = document.getElementById("pageTitle");
const page = location.pathname.slice(1);
if (page === "login") {
    document.body.classList.add("login-page");
    document.querySelector(".project-chip").hidden = true;
}
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
    text.append(node("h3", employee.name), node("p", [employee.role, employee.grade].filter(Boolean).join(" · ")));
    if (employee.avatar_url) {
        const avatar = node("img");
        avatar.src = employee.avatar_url;
        avatar.alt = "";
        avatar.referrerPolicy = "no-referrer";
        avatar.addEventListener("error", () => avatar.replaceWith(initials), { once: true });
        element.append(avatar, text);
    } else element.append(initials, text);
    return element;
}

function skills(employee) {
    const element = node("div", undefined, "stack");
    for (const skill of employee.stack) element.append(node("span", skill, "chip"));
    return element;
}

function competencies(employee) {
    const element = node("div", undefined, "competency-tags");
    for (const id of employee.groups || []) {
        const title = EmployeeOptions.groups.find((group) => group.id === id)?.name;
        if (title) element.append(node("span", title, "chip competency"));
    }
    if (!element.children.length) element.append(node("span", "Группы не выбраны", "note"));
    return element;
}

function choiceList(form, title, choices, selected, { searchable = false } = {}) {
    const group = node("fieldset", undefined, "employee-choices");
    group.append(node("legend", title));
    let search;
    if (searchable) {
        const label = node("label", "Поиск технологий", "field");
        search = node("input");
        search.type = "search";
        search.onkeydown = (event) => { if (event.key === "Enter") event.preventDefault(); };
        label.append(search);
        group.append(label);
    }
    const tags = node("div", undefined, "selected-skills");
    const list = node("div", undefined, "choice-list");
    const values = new Set(selected || []);
    // Личные прежние навыки остаются выбранными до явного удаления.
    const entries = [...choices];
    for (const value of values) if (!entries.some((item) => item.value === value)) entries.push({ value, label: value, section: "Ранее указанные" });
    const inputs = [];
    function renderTags() {
        tags.replaceChildren();
        for (const value of values) {
            const item = entries.find((entry) => entry.value === value);
            const remove = node("button", `${item.label} ×`, "chip");
            remove.type = "button";
            remove.setAttribute("aria-label", `Убрать: ${item.label}`);
            remove.onclick = () => { values.delete(value); inputs.find((input) => input.value === value).checked = false; renderTags(); };
            tags.append(remove);
        }
    }
    for (const item of entries) {
        const label = node("label", undefined, "choice");
        const input = node("input");
        input.type = "checkbox";
        input.value = item.value;
        input.checked = values.has(item.value);
        inputs.push(input);
        input.onchange = () => { if (input.checked) values.add(item.value); else values.delete(item.value); renderTags(); };
        label.append(input, node("span", item.section ? `${item.label} · ${item.section}` : item.label));
        list.append(label);
    }
    if (search) search.oninput = () => {
        const query = search.value.toLocaleLowerCase("ru").trim();
        for (const [index, label] of [...list.children].entries()) label.hidden = !`${entries[index].label} ${entries[index].section || ""}`.toLocaleLowerCase("ru").includes(query);
    };
    renderTags();
    group.append(tags, list);
    form.append(group);
    return { values: () => [...values], setDisabled(disabled) {
        for (const input of [...inputs, ...(search ? [search] : [])]) input.disabled = disabled;
        for (const button of tags.querySelectorAll("button")) button.disabled = disabled;
    } };
}

async function prepareAvatar(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error("Выберите JPEG, PNG или WebP до 2 МБ.");
    const bitmap = await createImageBitmap(file);
    try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20_000_000) throw new Error("Изображение должно быть не больше 20 мегапикселей.");
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
        if (!data || data.length > 174764) throw new Error("Не удалось уменьшить изображение до 128 КиБ.");
        return { contentType: "image/jpeg", data };
    } finally { bitmap.close(); }
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

function employeeEditor(employee, onSave, opener) {
    const dialog = node("dialog", undefined, "employee-editor");
    dialog.setAttribute("aria-labelledby", "employee-editor-title");
    const form = node("form");
    const heading = node("h2", employee ? "Редактирование сотрудника" : "Новый сотрудник");
    heading.id = "employee-editor-title";
    form.append(heading);
    const fields = {};
    function field(key, title, tag = "input", hint = "") {
        const label = node("label", title, "field");
        const input = node(tag);
        input.name = key;
        fields[key] = input;
        label.append(input);
        if (hint) label.append(node("small", hint, "note"));
        form.append(label);
        return input;
    }
    const name = field("name", "Имя и фамилия *");
    name.required = true;
    name.maxLength = 120;
    name.autocomplete = "name";
    const role = field("role", "Должность *", "select");
    role.required = true;
    for (const title of ["", ...EmployeeOptions.roles, ...(employee?.role && !EmployeeOptions.roles.includes(employee.role) ? [employee.role] : [])]) {
        const option = node("option", title || "Выберите должность");
        option.value = title;
        role.append(option);
    }
    const grade = field("grade", "Грейд", "select");
    for (const title of ["", ...EmployeeOptions.grades.filter((value) => value !== "Не применимо")]) {
        const option = node("option", title || "Не указан");
        option.value = title;
        grade.append(option);
    }
    const aiGradeOption = node("option", "Не применимо");
    aiGradeOption.value = "Не применимо";
    const groups = choiceList(form, "Группы компетенций", EmployeeOptions.groups.map((group) => ({ value: group.id, label: group.name })), employee?.groups);
    form.append(node("p", "Группы — основа будущего подбора исполнителя. Технологии помогут уточнить выбор; автоматическое распределение пока не подключено.", "note"));
    const stack = choiceList(form, "Технологии и навыки", EmployeeOptions.technologies.flatMap(([section, items]) => items.map((title) => ({ value: title, label: title, section }))), employee?.stack, { searchable: true });
    const capacity = field("capacity", "Доступно часов за спринт", "input", "0 — доступных часов пока нет.");
    capacity.type = "number";
    capacity.min = "0";
    capacity.max = String(Number.MAX_SAFE_INTEGER);
    capacity.step = "1";
    capacity.required = true;
    const avatar = field("avatar_file", "Аватар", "input", "JPEG, PNG или WebP до 2 МБ.");
    avatar.type = "file";
    avatar.accept = "image/jpeg,image/png,image/webp";
    const avatarRow = node("div", undefined, "employee-avatar-preview");
    const avatarPreview = node("img");
    avatarPreview.alt = "Предпросмотр аватара";
    avatarPreview.referrerPolicy = "no-referrer";
    avatarPreview.hidden = !employee?.avatar_url;
    if (employee?.avatar_url) avatarPreview.src = employee.avatar_url;
    const removeAvatar = node("button", "Убрать аватар", "btn light");
    removeAvatar.type = "button";
    removeAvatar.hidden = !employee?.avatar_url;
    avatarRow.append(avatarPreview, removeAvatar);
    form.append(avatarRow);
    name.value = employee?.name || "";
    role.value = employee?.role || "";
    grade.value = employee?.grade || "";
    let humanGrade = grade.value === "Не применимо" ? "" : grade.value;
    let aiGrade = false;
    function syncGrade() {
        const ai = role.value === "ИИ-ассистент";
        if (ai && !aiGrade && grade.value !== "Не применимо") humanGrade = grade.value;
        if (ai && !aiGrade) grade.append(aiGradeOption);
        if (!ai && aiGrade) { aiGradeOption.remove(); grade.value = humanGrade; }
        if (!ai && grade.value === "Не применимо") grade.value = "";
        if (ai) grade.value = "Не применимо";
        grade.disabled = ai;
        aiGrade = ai;
    }
    role.onchange = syncGrade;
    syncGrade();
    capacity.value = String(employee?.capacity ?? 0);
    const error = node("p", "", "employee-error");
    error.setAttribute("role", "alert");
    const actions = node("div", undefined, "employee-actions");
    const cancel = node("button", "Отмена", "btn light");
    cancel.type = "button";
    const save = node("button", employee ? "Сохранить" : "Добавить", "btn primary");
    save.type = "submit";
    actions.append(cancel, save);
    form.append(error, actions);
    dialog.append(form);
    document.body.append(dialog);
    let saving = false;
    let imageBusy = false;
    let imageRevision = 0;
    let pendingAvatar;
    let previewUrl;
    avatar.onchange = async () => {
        const file = avatar.files?.[0];
        if (!file) return;
        const revision = ++imageRevision;
        imageBusy = true;
        save.disabled = true;
        error.textContent = "";
        try {
            const upload = await prepareAvatar(file);
            if (revision !== imageRevision) return;
            pendingAvatar = upload;
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            previewUrl = URL.createObjectURL(file);
            avatarPreview.src = previewUrl;
            avatarPreview.hidden = false;
            removeAvatar.hidden = false;
        } catch (cause) {
            if (revision === imageRevision) error.textContent = cause.message || "Не удалось прочитать изображение.";
        } finally {
            if (revision === imageRevision) { imageBusy = false; save.disabled = false; avatar.value = ""; }
        }
    };
    removeAvatar.onclick = () => {
        imageRevision++;
        imageBusy = false;
        save.disabled = false;
        pendingAvatar = null;
        avatar.value = "";
        avatarPreview.hidden = true;
        removeAvatar.hidden = true;
        if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    };
    function close() { if (!saving) dialog.close(); }
    cancel.onclick = close;
    dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
    dialog.addEventListener("close", () => { imageRevision++; if (previewUrl) URL.revokeObjectURL(previewUrl); dialog.remove(); opener.focus(); });
    form.onsubmit = async (event) => {
        event.preventDefault();
        if (saving || imageBusy || !form.reportValidity()) return;
        error.textContent = "";
        const values = {
            name: name.value.trim(), role: role.value, grade: grade.value,
            executor_type: role.value === "ИИ-ассистент" ? "ai_agent" : (role.value === employee?.role ? employee.executor_type : "human"),
            groups: groups.values(), stack: stack.values(), capacity: Number(capacity.value)
        };
        if (pendingAvatar !== undefined) values.avatar_upload = pendingAvatar;
        if (!values.name || !values.role) { error.textContent = "Укажите имя и должность."; return; }
        if (!Number.isSafeInteger(values.capacity) || values.capacity < 0) { error.textContent = "Укажите целое неотрицательное число часов."; return; }
        if (values.stack.length > 50 || values.stack.some((skill) => skill.length > 100)) { error.textContent = "Допустимо до 50 навыков, каждый — до 100 символов."; return; }
        const body = employee ? Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(employee[key] ?? (["groups", "stack"].includes(key) ? [] : key === "grade" ? "" : undefined)))) : values;
        if (!Object.keys(body).length) { close(); return; }
        saving = true;
        save.disabled = true;
        cancel.disabled = true;
        save.textContent = "Сохранение…";
        for (const input of Object.values(fields)) input.disabled = true;
        groups.setDisabled(true);
        stack.setDisabled(true);
        removeAvatar.disabled = true;
        try {
            const result = await api(employee ? `/api/employees/${encodeURIComponent(employee.id)}` : "/api/employees", {
                method: employee ? "PATCH" : "POST", body: JSON.stringify(body)
            });
            onSave(result.employee);
            saving = false;
            dialog.close();
        } catch (cause) {
            error.textContent = `${cause.message} Данные оставлены в форме. Если связь прервалась, проверьте список перед повторным добавлением.`;
        } finally {
            saving = false;
            save.disabled = false;
            cancel.disabled = false;
            save.textContent = employee ? "Сохранить" : "Добавить";
            for (const input of Object.values(fields)) input.disabled = false;
            groups.setDisabled(false);
            stack.setDisabled(false);
            removeAvatar.disabled = false;
            syncGrade();
        }
    };
    dialog.showModal();
    name.focus();
}

async function team() {
    const employees = await api("/api/employees");
    const tasks = projectId ? (await api(`/api/tasks?projectId=${encodeURIComponent(projectId)}`)).tasks : [];
    const toolbar = node("div", undefined, "team-toolbar");
    const add = node("button", "+ Добавить сотрудника", "btn primary");
    add.type = "button";
    toolbar.append(node("p", "Общая команда · задачи показаны для выбранного проекта", "note"), add);
    const notice = node("p", "", "note");
    notice.setAttribute("role", "status");
    const grid = node("div", undefined, "team");
    function saved(employee) {
        const index = employees.findIndex((item) => item.id === employee.id);
        if (index < 0) employees.push(employee);
        else employees[index] = employee;
        render();
        notice.textContent = index < 0 ? "Сотрудник добавлен." : "Изменения сохранены.";
    }
    function render() {
        grid.replaceChildren();
        for (const employee of [...employees].sort((a, b) => a.name.localeCompare(b.name, "ru"))) {
            const count = tasks.filter((task) => task.assigneeId === employee.id && task.column !== "done" && task.status !== "done").length;
            const card = node("article", undefined, "employee");
            card.append(person(employee), node("span", employee.executor_type === "ai_agent" ? "✦ AI Agent · выполнение пока не подключено" : "● Человек", "badge"), competencies(employee), skills(employee));
            card.append(node("p", `Незавершённых задач: ${count}. Ёмкость: ${employee.capacity} ч. за спринт.`, "note"));
            const edit = node("button", "Редактировать", "btn light employee-edit");
            edit.type = "button";
            edit.setAttribute("aria-label", `Редактировать: ${employee.name}`);
            // Карточка после сохранения заменяется; фокус возвращаем на новую кнопку.
            edit.onclick = () => employeeEditor(employee, saved, { focus: () => {
                const button = [...grid.querySelectorAll("button")].find((item) => item.dataset.employeeId === employee.id);
                (button || add).focus();
            } });
            edit.dataset.employeeId = employee.id;
            card.append(edit);
            grid.append(card);
        }
        if (!employees.length) grid.append(node("p", "Сотрудников пока нет. Добавьте первого участника команды.", "panel"));
    }
    add.onclick = () => employeeEditor(null, saved, add);
    content.append(toolbar, notice, grid);
    render();
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
    card.append(person(employee), competencies(employee), skills(employee), node("p", `Ёмкость: ${employee.capacity} ч. за спринт.`));
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
