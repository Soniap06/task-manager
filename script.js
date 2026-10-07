const taskInput = document.getElementById("taskInput");
const addTaskButton = document.getElementById("addTaskButton");
const todoColumn = document.getElementById("todo");
const progressColumn = document.getElementById("progress");
const reviewColumn = document.getElementById("review");
const columns = ["todo", "progress", "review"];

addTaskButton.addEventListener("click", addTask);

taskInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
        addTask();
    }
});

async function addTask() {
    const text = taskInput.value.trim();

    if (text === "") {
        alert("Введите название задачи");
        return;
    }

    addTaskButton.disabled = true;
    addTaskButton.textContent = "✨ Генерируем...";

    try {
        const specification = await generateTaskSpecification(text);
        createTask(specification, text);
        taskInput.value = "";
        taskInput.focus();
    } catch (error) {
        alert(`Не удалось сгенерировать ТЗ: ${error.message}`);
    } finally {
        addTaskButton.disabled = false;
        addTaskButton.textContent = "✨ Сгенерировать ТЗ";
    }
}

function createTask(specification, fallbackTitle) {
    const task = document.createElement("div");
    task.className = "task";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = specification.title || fallbackTitle;

    const branch = document.createElement("div");
    branch.className = "task-branch";
    branch.textContent = `Ветка: ${specification.branch || "feat/task"}`;

    const details = document.createElement("div");
    details.className = "task-details";
    details.innerHTML = `
        <strong>Критерии приемки:</strong>
        <ul>${toListItems(specification.acceptanceCriteria)}</ul>
        <strong>Шаги реализации:</strong>
        <ol>${toListItems(specification.steps)}</ol>
    `;

    const buttons = document.createElement("div");
    buttons.className = "task-buttons";

    const leftButton = document.createElement("button");
    leftButton.textContent = "←";
    leftButton.title = "Переместить влево";
    leftButton.addEventListener("click", function() {
        moveTask(task, -1);
    });

    const rightButton = document.createElement("button");
    rightButton.textContent = "→";
    rightButton.title = "Переместить вправо";
    rightButton.addEventListener("click", function() {
        moveTask(task, 1);
    });

    buttons.appendChild(leftButton);
    buttons.appendChild(rightButton);

    task.appendChild(title);
    task.appendChild(branch);
    task.appendChild(details);
    task.appendChild(buttons);

    document.getElementById("todo").appendChild(task);
}

function toListItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return "<li>Не указано</li>";
    }

    return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = String(value);
    return element.innerHTML;
}

function moveTask(task, direction) {
    const currentColumn = task.parentElement;
    const currentIndex = columns.indexOf(currentColumn.id);
    const newIndex = currentIndex + direction;

    if (newIndex < 0 || newIndex >= columns.length) {
        return;
    }

    document.getElementById(columns[newIndex]).appendChild(task);
}
