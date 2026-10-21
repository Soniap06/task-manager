const byId = (id) => document.getElementById(id);
const projectSelect = byId("projectSelect");
const connectionStatus = byId("connectionStatus");
const feedback = byId("feedback");
let configured = false;
let busy = false;
let projects = [];
let repositories = [];
let selectedRepository = null;
let activeProjectId = "";
let repositoryVersion = 0;

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
    } catch { throw new Error("Нет ответа сервера. Обновите страницу перед повтором: операция могла завершиться."); }
    let data;
    try { data = await response.json(); } catch { throw new Error("Сервер вернул непонятный ответ. Обновите страницу."); }
    if (response.status === 401) location.assign("/login");
    if (!response.ok) throw new Error(data.error?.message || `Ошибка HTTP ${response.status}`);
    return data;
}

const showError = (error) => { feedback.textContent = error.message; };
const currentProject = () => projects.find((project) => project.id === activeProjectId);
function updateControls() {
    const project = currentProject();
    byId("projectInfo").textContent = activeProjectId === "legacy" ? "Архив прежних задач без подтверждённой привязки." : project ? `${project.fullName} · база: ${project.baseBranch}${project.archived ? " · проект отключён" : ""}` : "Подключите существующий GitHub-репозиторий, чтобы начать работу.";
    byId("saveBaseButton").disabled = busy || !configured || !project || project.archived;
    byId("archiveProjectButton").disabled = busy || !project;
    byId("archiveProjectButton").textContent = project?.archived ? "Подключить снова" : "Отключить проект";
    byId("loadReposButton").disabled = !configured;
    byId("resolveRepoButton").disabled = !configured;
    byId("openBoardLink").href = activeProjectId ? `index.html?projectId=${encodeURIComponent(activeProjectId)}` : "index.html";
}

async function selectProject(id) {
    activeProjectId = id;
    projectSelect.value = id;
    try { sessionStorage.setItem("task-manager.active-project.v1", id); } catch { /* Необязательная настройка. */ }
    byId("projectBaseInput").value = currentProject()?.baseBranch || "";
    updateControls();
}

async function refreshProjects(preferredId) {
    const [status, data] = await Promise.all([api("/api/status"), api("/api/projects")]);
    configured = status.configured;
    projects = data.projects;
    connectionStatus.textContent = configured ? "" : status.error.message;
    if (status.installationUrl) {
        byId("installationLink").href = status.installationUrl;
        byId("installationLink").hidden = false;
    }
    projectSelect.replaceChildren();
    projectSelect.appendChild(element("option", "", "Выберите или подключите проект"));
    projectSelect.children[0].value = "";
    for (const project of projects) {
        const option = element("option", "", `${project.fullName}${project.archived ? " (отключён)" : ""}`);
        option.value = project.id;
        projectSelect.appendChild(option);
    }
    if (status.hasLegacyTasks) {
        const option = element("option", "", "Архив прежних задач");
        option.value = "legacy";
        projectSelect.appendChild(option);
    }
    let saved = "";
    try { saved = sessionStorage.getItem("task-manager.active-project.v1") || ""; } catch { /* Необязательная настройка. */ }
    const requested = preferredId || activeProjectId || saved;
    const id = projects.some((project) => project.id === requested) || (requested === "legacy" && status.hasLegacyTasks) ? requested : projects.find((project) => !project.archived)?.id || "";
    await selectProject(id);
}

function renderRepositoryOptions() {
    const query = byId("repoSearch").value.toLowerCase();
    const visibleRepositories = repositories.filter((item) => item.fullName.toLowerCase().includes(query));
    if (selectedRepository && !visibleRepositories.some((repo) => repo.repositoryId === selectedRepository.repositoryId)) {
        chooseRepository("");
    }
    const select = byId("repositorySelect");
    select.replaceChildren();
    const empty = element("option", "", "Выберите репозиторий");
    empty.value = "";
    select.appendChild(empty);
    for (const repo of visibleRepositories) {
        const option = element("option", "", `${repo.fullName}${repo.private ? " · private" : ""}${repo.archived ? " · архив" : ""}`);
        option.value = String(repo.repositoryId);
        option.disabled = repo.archived;
        select.appendChild(option);
    }
    select.value = selectedRepository ? String(selectedRepository.repositoryId) : "";
}

async function chooseRepository(repositoryId) {
    const version = ++repositoryVersion;
    selectedRepository = repositories.find((repo) => repo.repositoryId === Number(repositoryId)) || null;
    byId("connectRepoButton").disabled = !selectedRepository || selectedRepository.archived;
    byId("baseBranchInput").value = selectedRepository?.defaultBranch || "";
    byId("repositoryBranches").replaceChildren();
    if (!selectedRepository || selectedRepository.archived) return;
    const { branches } = await api(`/api/github/repositories/${selectedRepository.repositoryId}/branches`);
    if (version !== repositoryVersion) return;
    for (const branch of branches) {
        const option = element("option");
        option.value = branch;
        byId("repositoryBranches").appendChild(option);
    }
}

async function loadRepositories() {
    byId("loadReposButton").disabled = true;
    try {
        const data = await api("/api/github/repositories");
        repositories = data.repositories;
        selectedRepository = null;
        repositoryVersion++;
        byId("connectRepoButton").disabled = true;
        renderRepositoryOptions();
        feedback.textContent = repositories.length ? `Доступно репозиториев: ${repositories.length}. Выберите рабочий проект.` : "App не видит репозиториев. Настройте доступ на GitHub и обновите список.";
    } catch (error) { showError(error); }
    finally { byId("loadReposButton").disabled = !configured; }
}

projectSelect.addEventListener("change", () => selectProject(projectSelect.value).catch(showError));
byId("loadReposButton").addEventListener("click", loadRepositories);
byId("repoSearch").addEventListener("input", renderRepositoryOptions);
byId("repositorySelect").addEventListener("change", () => chooseRepository(byId("repositorySelect").value).catch(showError));
byId("resolveRepoButton").addEventListener("click", async () => {
    try {
        const { repository } = await api("/api/github/repositories/resolve", { method: "POST", body: JSON.stringify({ url: byId("repositoryUrl").value.trim() }) });
        if (!repositories.some((repo) => repo.repositoryId === repository.repositoryId)) repositories.push(repository);
        byId("repoSearch").value = "";
        selectedRepository = repository;
        renderRepositoryOptions();
        await chooseRepository(repository.repositoryId);
    } catch (error) { showError(error); }
});
byId("connectRepoButton").addEventListener("click", async () => {
    if (!selectedRepository) return;
    byId("connectRepoButton").disabled = true;
    try {
        const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify({ repositoryId: selectedRepository.repositoryId, baseBranch: byId("baseBranchInput").value }) });
        byId("connectPanel").open = false;
        feedback.textContent = `Подключён ${project.fullName}. Ветки появятся после подтверждения карточек.`;
        await refreshProjects(project.id);
    } catch (error) { showError(error); }
    finally { byId("connectRepoButton").disabled = !selectedRepository || selectedRepository.archived; }
});
async function changeProject(patch) {
    const project = currentProject();
    if (!project || busy) return;
    await api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await refreshProjects(project.id);
}
byId("saveBaseButton").addEventListener("click", () => changeProject({ baseBranch: byId("projectBaseInput").value }).catch(showError));
byId("archiveProjectButton").addEventListener("click", () => changeProject({ archived: !currentProject()?.archived }).catch(showError));
refreshProjects().catch(showError);
