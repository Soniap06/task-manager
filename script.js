const taskInput = document.getElementById("taskInput");
const addTaskButton = document.getElementById("addTaskButton");

const columns = ["todo", "progress", "review"];

addTaskButton.addEventListener("click", addTask);

taskInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
        addTask();
    }
});

function addTask() {
    const text = taskInput.value.trim();

    if (text === "") {
        alert("Введите название задачи");
        return;
    }

    const task = document.createElement("div");
    task.className = "task";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = text;

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
    task.appendChild(buttons);

    document.getElementById("todo").appendChild(task);
    taskInput.value = "";
    taskInput.focus();
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
