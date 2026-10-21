const byId = (id) => document.getElementById(id);
const taskInput = byId("taskInput");
const addTaskButton = byId("addTaskButton");
const connectionStatus = byId("connectionStatus");
const feedback = byId("feedback");
const columns = ["todo", "progress", "review"];
const draftPrefix = "task-manager.pending-create.v2:";
const stateLabels = { generating: "Генерация ТЗ не завершена", generation_error: "Ошибка генерации ТЗ", branch_pending: "Создание ветки не завершено", branch_error: "Ошибка создания ветки", branch_created: "Ветка создана в GitHub" };
let configured = false;
let busy = false;
let projects = [];
let activeProjectId = "";
let boardTasks = [];
let boardVersion = 0;
let openTaskId = null;
let employees = [];

async function loadEmployees() {
    const result = await api("/api/employees");
    if (!Array.isArray(result)) return;
    employees = result;
    const select = byId("assigneeSelect");
    for (const employee of employees) {
        const option = element("option", "", `${employee.name} — ${employee.role}`);
        option.value = employee.id;
        select.appendChild(option);
    }
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function api(url, options = {}) {
    let response;
    try {
        response = await fetch(url, { ...options, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(240_000) });
    } catch { throw new Error("Нет ответа сервера. Обновите доску перед повтором: операция могла завершиться."); }
    let data;
    try { data = await response.json(); } catch { throw new Error("Сервер вернул непонятный ответ. Обновите доску."); }
    if (response.status === 401) location.assign("/login");
    if (!response.ok) throw new Error(data.error?.message || `Ошибка HTTP ${response.status}`);
    return data;
}

const showError = (error) => { feedback.textContent = error.message; };
const currentProject = () => projects.find((project) => project.id === activeProjectId);
const draftKey = (id) => draftPrefix + id;
function getDraft(id) {
    try {
        const value = JSON.parse(localStorage.getItem(draftKey(id)));
        return value && typeof value.requestId === "string" && typeof value.title === "string" && value.projectId === id ? value : null;
    } catch { return null; }
}
function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch { /* Повтор с тем же ID безопасен. */ } }

function updateControls() {
    const project = currentProject();
    const writable = Boolean(configured && project && !project.archived);
    taskInput.disabled = busy || !writable;
    addTaskButton.disabled = busy || !writable;
    if (byId("assigneeSelect")) byId("assigneeSelect").disabled = busy || !writable;
    addTaskButton.textContent = busy ? "✨ Генерируем ТЗ и создаём ветку…" : "✨ Создать задачу и ветку";
    byId("projectInfo").textContent = activeProjectId === "legacy" ? "Архив прежних задач без подтверждённой привязки. Внешние операции отключены." : project ? `${project.fullName}${project.archived ? " · проект отключён" : ""}` : "Выберите проект на странице «Проекты», чтобы начать работу.";
    renderBoard();
}

async function selectProject(id) {
    if (activeProjectId !== id) byId("taskDialog").close();
    activeProjectId = id;
    try { sessionStorage.setItem("task-manager.active-project.v1", id); } catch { /* Выбор сохранён только до закрытия вкладки. */ }
    boardTasks = [];
    taskInput.value = getDraft(id)?.title || "";
    updateControls();
    await refreshBoard();
}

async function refreshBoard() {
    const version = ++boardVersion;
    const projectId = activeProjectId;
    if (!projectId) { boardTasks = []; renderBoard(); return; }
    const { tasks } = await api(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
    if (version !== boardVersion || projectId !== activeProjectId) return;
    boardTasks = tasks;
    const draft = getDraft(projectId);
    if (draft && tasks.some((task) => task.requestId === draft.requestId)) {
        clearDraft(projectId);
        if (taskInput.value.trim() === draft.title) taskInput.value = "";
    }
    updateControls();
}

async function refreshProjects(preferredId) {
    const [status, data] = await Promise.all([api("/api/status"), api("/api/projects")]);
    configured = status.configured;
    projects = data.projects;
    connectionStatus.textContent = configured ? "" : "Создание задач недоступно. Проверьте подключение на странице «Проекты».";
    let saved = "";
    try { saved = sessionStorage.getItem("task-manager.active-project.v1") || ""; } catch { /* Необязательная настройка. */ }
    const requested = preferredId || activeProjectId || new URLSearchParams(location.search).get("projectId") || saved;
    const id = projects.some((project) => project.id === requested) || (requested === "legacy" && status.hasLegacyTasks) ? requested : projects.find((project) => !project.archived)?.id || "";
    await selectProject(id);
}

async function addTask() {
    const project = currentProject();
    if (busy || !configured || !project || project.archived) return;
    const title = taskInput.value.trim();
    if (!title) { feedback.textContent = "Введите название задачи."; taskInput.focus(); return; }
    let draft = getDraft(project.id);
    if (draft && draft.title !== title) {
        feedback.textContent = "Обновите доску или повторите незавершённый запрос с прежним названием.";
        taskInput.value = draft.title;
        return;
    }
    draft = draft || { projectId: project.id, requestId: crypto.randomUUID(), title, assigneeId: byId("assigneeSelect")?.value || null };
    try { localStorage.setItem(draftKey(project.id), JSON.stringify(draft)); } catch {
        feedback.textContent = "Разрешите локальное хранилище браузера для сохранения requestId.";
        return;
    }
    busy = true;
    feedback.textContent = `Генерируем ТЗ и создаём ветку в ${project.fullName}.`;
    updateControls();
    try {
        const { task } = await api("/api/tasks", { method: "POST", body: JSON.stringify(draft) });
        clearDraft(project.id);
        if (activeProjectId === project.id) {
            taskInput.value = "";
            boardTasks = [...boardTasks.filter((item) => item.id !== task.id), task];
        }
        feedback.textContent = `${project.fullName}: ${task.state === "branch_created" ? "задача и ветка созданы" : "задача сохранена; результат операции показан в карточке"}.`;
    } catch (error) { showError(error); }
    finally { busy = false; updateControls(); }
}

async function updateTask(task, action, body = {}) {
    if (busy) return;
    busy = true;
    updateControls();
    try {
        const { task: result } = await api(`/api/tasks/${task.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
        if (activeProjectId === task.projectId) boardTasks = boardTasks.map((item) => item.id === task.id ? result : item);
        feedback.textContent = result.error?.message || `${task.repository}: задача обновлена.`;
    } catch (error) { showError(error); }
    finally { busy = false; updateControls(); }
}

function renderBoard() {
    for (const column of columns) byId(column).replaceChildren();
    const query = byId("taskSearch").value.trim().toLocaleLowerCase("ru-RU");
    for (const task of boardTasks.filter((item) => [item.title, item.input, item.branch, ...(item.acceptanceCriteria || []), ...(item.steps || [])].join(" ").toLocaleLowerCase("ru-RU").includes(query))) {
        const card = element("div", "task");
        card.dataset.taskId = task.id;
        card.draggable = !busy;
        card.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", task.id));
        const openButton = element("button", "task-title task-open", task.title);
        openButton.type = "button";
        openButton.setAttribute("aria-label", `Открыть задачу: ${task.title}`);
        openButton.addEventListener("click", () => {
            openTaskId = task.id;
            renderTaskDetails();
            byId("taskDialog").showModal();
        });
        card.appendChild(openButton);
        const buttons = element("div", "task-buttons");
        const index = columns.indexOf(task.column);
        for (const [text, direction, label] of [["←", -1, "Переместить влево"], ["→", 1, "Переместить вправо"]]) {
            const button = element("button", "", text);
            button.title = label;
            button.setAttribute("aria-label", label);
            button.disabled = busy || index + direction < 0 || index + direction >= columns.length;
            button.addEventListener("click", () => updateTask(task, "column", { column: columns[index + direction] }));
            buttons.appendChild(button);
        }
        card.appendChild(buttons);
        byId(columns.includes(task.column) ? task.column : "todo").appendChild(card);
    }
    if (byId("taskDialog").open) renderTaskDetails();
}

function renderTaskDetails() {
    const task = boardTasks.find((item) => item.id === openTaskId);
    if (!task) { byId("taskDialog").close(); return; }
    byId("taskDialogTitle").textContent = task.title;
    const content = byId("taskDialogContent");
    content.replaceChildren();
    content.appendChild(element("div", "task-status", task.repository));
    const branch = element("div", "task-branch");
    if (task.state === "branch_created" && task.branchUrl?.startsWith("https://github.com/")) {
        const link = element("a", "", task.branch);
        link.href = task.branchUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        branch.appendChild(link);
    } else branch.textContent = task.branch ? `Ветка: ${task.branch}` : "Имя ветки ещё не получено";
    content.appendChild(branch);
    content.appendChild(element("div", "task-status", task.legacyUnlinked ? "Нужна подтверждённая привязка к проекту" : stateLabels[task.state] || task.state));
    if (task.assigneeId) content.appendChild(element("p", "", `Исполнитель: ${employees.find((employee) => employee.id === task.assigneeId)?.name || task.assigneeId}`));
    if (task.error) content.appendChild(element("div", "task-error", task.error.message));
    const details = element("div", "task-details");
    for (const [label, tag, items] of [["Критерии приёмки:", "ul", task.acceptanceCriteria], ["Шаги реализации:", "ol", task.steps]]) {
        if (!items?.length) continue;
        details.appendChild(element("strong", "", label));
        const list = element(tag);
        for (const item of items) list.appendChild(element("li", "", item));
        details.appendChild(list);
    }
    content.appendChild(details);
    if (task.state !== "branch_created" && !task.legacyUnlinked) {
        const retry = element("button", "", "Повторить");
        retry.disabled = busy || currentProject()?.archived;
        retry.addEventListener("click", () => updateTask(task, "branch/retry"));
        content.appendChild(retry);
    }
}

byId("closeTaskDialog").addEventListener("click", () => byId("taskDialog").close());

addTaskButton.addEventListener("click", addTask);
taskInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addTask(); } });
byId("refreshButton").addEventListener("click", () => refreshProjects().catch(showError));
byId("taskSearch").addEventListener("input", renderBoard);
for (const column of columns) {
    byId(column).addEventListener("dragover", (event) => event.preventDefault());
    byId(column).addEventListener("drop", (event) => {
        event.preventDefault();
        const task = boardTasks.find((item) => item.id === event.dataTransfer.getData("text/plain"));
        if (task && task.column !== column) updateTask(task, "column", { column });
    });
}
refreshProjects().catch(showError);
loadEmployees().catch(showError);
