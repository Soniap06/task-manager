const byId = (id) => document.getElementById(id);
const taskInput = byId("taskInput");
const addTaskButton = byId("addTaskButton");
const connectionStatus = byId("connectionStatus");
const feedback = byId("feedback");
const columns = ["todo", "progress", "review"];
const taskTypeLabels = { feature: "Новая функция", fix: "Исправление", tests: "Тесты", docs: "Документация" };
const draftPrefix = "task-manager.pending-create.v2:";
const stateLabels = { draft_ready: "Черновик — проверьте перед созданием ветки", clarification_required: "Нужны ответы на уточняющие вопросы", generating: "Подготовка черновика не завершена", generation_error: "ИИ недоступен или вернул ошибку — можно заполнить вручную", branch_pending: "Создание ветки не завершено", branch_error: "Ошибка создания ветки", branch_created: "Ветка создана в GitHub" };
let configured = false;
let busy = false;
let projects = [];
let activeProjectId = "";
let boardTasks = [];
let boardVersion = 0;
let openTaskId = null;
let employees = [];
const editorDrafts = new Map();
const taskActionErrors = new Map();

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
    if (byId("taskDialog").open) renderTaskDetails();
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
    byId("taskTypeSelect").disabled = busy || !writable;
    byId("skipAi").disabled = busy || !writable;
    addTaskButton.textContent = busy ? "Подготавливаем карточку…" : "Подготовить карточку";
    byId("projectInfo").textContent = activeProjectId === "legacy" ? "Архив прежних задач без подтверждённой привязки. Внешние операции отключены." : project ? `${project.fullName}${project.archived ? " · проект отключён" : ""}` : "Выберите проект на странице «Проекты», чтобы начать работу.";
    renderBoard();
}

async function selectProject(id) {
    if (activeProjectId !== id) byId("taskDialog").close();
    activeProjectId = id;
    try { sessionStorage.setItem("task-manager.active-project.v1", id); } catch { /* Выбор сохранён только до закрытия вкладки. */ }
    boardTasks = [];
    const pending = getDraft(id);
    taskInput.value = pending?.title || "";
    byId("taskTypeSelect").value = pending?.type || "feature";
    byId("skipAi").checked = pending?.useAi === false;
    updateControls();
    await refreshBoard();
}

async function refreshBoard({ background = false } = {}) {
    const version = ++boardVersion;
    const projectId = activeProjectId;
    if (!projectId) { boardTasks = []; renderBoard(); return; }
    const { tasks } = await api(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
    if (version !== boardVersion || projectId !== activeProjectId || (background && (busy || document.hidden || byId("taskDialog").open))) return;
    if (background && JSON.stringify(boardTasks) === JSON.stringify(tasks)) return;
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
    if (draft && (draft.title !== title || (draft.type || "feature") !== byId("taskTypeSelect").value || (draft.useAi ?? true) !== !byId("skipAi").checked)) {
        feedback.textContent = "Обновите доску или повторите незавершённый запрос с прежним названием.";
        taskInput.value = draft.title;
        byId("taskTypeSelect").value = draft.type || "feature";
        byId("skipAi").checked = draft.useAi === false;
        return;
    }
    draft = draft || { projectId: project.id, requestId: crypto.randomUUID(), title, type: byId("taskTypeSelect").value, useAi: !byId("skipAi").checked, assigneeId: byId("assigneeSelect")?.value || null };
    try { localStorage.setItem(draftKey(project.id), JSON.stringify(draft)); } catch {
        feedback.textContent = "Разрешите локальное хранилище браузера для сохранения requestId.";
        return;
    }
    busy = true;
    boardVersion++;
    feedback.textContent = `Подготавливаем черновик для ${project.fullName}. Ветка появится после подтверждения.`;
    updateControls();
    try {
        const { task } = await api("/api/tasks", { method: "POST", body: JSON.stringify(draft) });
        clearDraft(project.id);
        if (activeProjectId === project.id) {
            taskInput.value = "";
            boardTasks = [...boardTasks.filter((item) => item.id !== task.id), task];
            if (!task.branch) {
                openTaskId = task.id;
                renderTaskDetails();
                if (!byId("taskDialog").open) byId("taskDialog").showModal();
            }
        }
        feedback.textContent = `${project.fullName}: ${task.state === "branch_created" ? "задача и ветка созданы" : "черновик сохранён — откройте карточку для проверки"}.`;
    } catch (error) { showError(error); }
    finally { busy = false; updateControls(); }
}

async function updateTask(task, action, body = {}) {
    if (busy) return;
    busy = true;
    boardVersion++;
    updateControls();
    try {
        const { task: result } = await api(`/api/tasks/${task.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
        taskActionErrors.delete(task.id);
        if (action === "branch/retry" && !result.branch) editorDrafts.delete(task.id);
        if (activeProjectId === task.projectId) boardTasks = boardTasks.map((item) => item.id === task.id ? result : item);
        feedback.textContent = result.error?.message || `${task.repository}: задача обновлена.`;
    } catch (error) { taskActionErrors.set(task.id, error.message); showError(error); }
    finally { busy = false; updateControls(); }
}

function renderBoard() {
    for (const column of columns) byId(column).replaceChildren();
    const query = byId("taskSearch").value.trim().toLocaleLowerCase("ru-RU");
    for (const task of boardTasks.filter((item) => [item.title, item.input, item.description, ...(item.clarifications || []).map((item) => item.answer), item.branch, ...(item.acceptanceCriteria || []), ...(item.steps || [])].join(" ").toLocaleLowerCase("ru-RU").includes(query))) {
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
    for (const column of columns) byId(`${column}Count`).textContent = String(byId(column).children.length);
    if (byId("taskDialog").open) renderTaskDetails();
}

function renderTaskDetails() {
    const task = boardTasks.find((item) => item.id === openTaskId);
    if (!task) { byId("taskDialog").close(); return; }
    byId("taskDialogTitle").textContent = task.title;
    const content = byId("taskDialogContent");
    content.replaceChildren();
    content.appendChild(element("div", "task-status", task.repository));
    content.appendChild(element("p", "", `Тип задачи: ${Object.hasOwn(taskTypeLabels, task.type) ? taskTypeLabels[task.type] : "Не указан"}`));
    content.appendChild(element("p", "", `Исполнитель: ${task.assigneeId ? employees.find((employee) => employee.id === task.assigneeId)?.name || task.assigneeId : "Не назначен"}`));
    const branch = element("div", "task-branch");
    if (task.state === "branch_created" && task.branchUrl?.startsWith("https://github.com/")) {
        const link = element("a", "", task.branch);
        link.href = task.branchUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        branch.appendChild(link);
    } else branch.textContent = task.branch ? `Ветка: ${task.branch}` : "Ветка будет создана после подтверждения карточки";
    content.appendChild(branch);
    content.appendChild(element("div", "task-status", task.legacyUnlinked ? "Нужна подтверждённая привязка к проекту" : stateLabels[task.state] || task.state));
    if (task.error) content.appendChild(element("div", "task-error", task.error.message));
    if (taskActionErrors.has(task.id)) content.appendChild(element("p", "task-error", taskActionErrors.get(task.id)));
    const details = element("div", "task-details");
    if (task.input) {
        details.appendChild(element("strong", "", "Исходные требования:"));
        details.appendChild(element("p", "task-source", task.input));
    }
    if (task.projectId && !task.branch) {
        renderDraftEditor(task, details);
    } else if (task.description) {
        details.appendChild(element("strong", "", "Описание:"));
        details.appendChild(element("p", "task-source", task.description));
        for (const item of task.clarifications || []) {
            details.appendChild(element("strong", "", item.question));
            details.appendChild(element("p", "task-source", item.answer));
        }
    }
    for (const [label, tag, items] of [["Критерии приёмки:", "ul", task.acceptanceCriteria], ["Шаги реализации:", "ol", task.steps]]) {
        if (!items?.length) continue;
        details.appendChild(element("strong", "", label));
        const list = element(tag);
        for (const item of items) list.appendChild(element("li", "", item));
        details.appendChild(list);
    }
    content.appendChild(details);
    if (task.state !== "branch_created" && !task.legacyUnlinked) {
        const retry = element("button", "", task.branch ? "Повторить создание ветки" : "Повторить подготовку с ИИ");
        retry.disabled = busy || currentProject()?.archived;
        retry.addEventListener("click", () => updateTask(task, "branch/retry"));
        content.appendChild(retry);
    }
}

function renderDraftEditor(task, container) {
    const previous = editorDrafts.get(task.id);
    const saved = previous && previous.draftRevision === task.draftRevision ? previous : { draftRevision: task.draftRevision, title: task.title, description: task.description || task.input, answers: (task.questions || []).map(() => "") };
    editorDrafts.set(task.id, saved);
    const fields = [];
    function field(labelText, value, max, key, index) {
        const label = element("label", "draft-field", labelText);
        const input = element(key === "title" ? "input" : "textarea");
        input.value = value;
        input.maxLength = max;
        input.disabled = busy;
        input.dataset.editor = key;
        input.addEventListener("input", () => {
            if (key === "answers") saved.answers[index] = input.value;
            else saved[key] = input.value;
        });
        label.appendChild(input);
        container.appendChild(label);
        fields.push(input);
        return input;
    }
    const titleField = field("Название", saved.title, 300, "title");
    const descriptionField = field("Описание — проверьте и при необходимости измените", saved.description, 1500, "description");
    if (task.questions?.length) container.appendChild(element("p", "", "Если вопрос не относится к задаче, укажите это в ответе."));
    const answers = (task.questions || []).map((question, index) => field(question, saved.answers[index] || "", 1000, "answers", index));
    const error = element("p", "task-error");
    error.setAttribute("role", "alert");
    container.appendChild(error);
    const confirm = element("button", "confirm-task", "Подтвердить карточку и создать ветку");
    confirm.disabled = busy || currentProject()?.archived;
    confirm.addEventListener("click", () => {
        if (fields.some((input) => !input.value.trim())) {
            error.textContent = "Заполните название, описание и ответы на все вопросы.";
            return;
        }
        return updateTask(task, "confirm", { title: titleField.value, description: descriptionField.value, answers: answers.map((input) => input.value), draftRevision: task.draftRevision });
    });
    container.appendChild(confirm);
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

// Общая доска получает изменения другого браузера, не трогая открытый редактор.
let backgroundRefresh = false;
async function syncBoard() {
    if (backgroundRefresh || busy || !activeProjectId || document.hidden || byId("taskDialog").open) return;
    backgroundRefresh = true;
    try {
        await refreshBoard({ background: true });
        if (feedback.textContent === "Нет связи с общей доской. Повторяем подключение…") feedback.textContent = "";
    } catch {
        if (!feedback.textContent) feedback.textContent = "Нет связи с общей доской. Повторяем подключение…";
    } finally { backgroundRefresh = false; }
}
setInterval(syncBoard, 5000);
