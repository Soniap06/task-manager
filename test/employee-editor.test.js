const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ""; }
    append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.parent.children = this.parent.children.filter((item) => item !== this); }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    reportValidity() { return true; }
    querySelectorAll(tag) { return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    set innerHTML(value) { throw new Error(`Unsafe HTML: ${value}`); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function ui(handler = async () => ({})) {
    const body = new Element("body");
    const ids = Object.fromEntries(["content", "pageTitle", "menuToggle", "navMenu", "logoutLink", "loginLink"].map((id) => [id, new Element("div")]));
    const queries = { ".project-chip": new Element("span"), ".top-user": new Element("span") };
    const calls = [];
    const context = vm.createContext({
        document: { body, getElementById: (id) => ids[id], querySelector: (key) => queries[key], createElement: (tag) => new Element(tag) },
        location: { pathname: "/team", search: "", assign() {} }, URLSearchParams, AbortSignal, URL,
        EmployeeOptions: require("../public/js/employee-options"),
        sessionStorage: { getItem() { return ""; } },
        fetch: async (url, options) => {
            calls.push({ url, ...options });
            let result = url === "/api/auth/status" ? {} : url === "/api/projects" ? { projects: [] } : await handler(url, options);
            return { ok: !result.__status, status: result.__status || 200, json: async () => result };
        }
    });
    vm.runInContext(fs.readFileSync(require.resolve("../public/js/app.js"), "utf8"), context);
    return { context, body, ids, calls, open(employee, saved = () => {}) {
        context.editing = employee;
        context.saved = saved;
        vm.runInContext("employeeEditor(editing, saved, { focus() {} })", context);
        const dialog = body.children.at(-1);
        const form = dialog.children[0];
        return { dialog, form, inputs: Object.fromEntries([...form.querySelectorAll("input"), ...form.querySelectorAll("textarea"), ...form.querySelectorAll("select")].map((input) => [input.name, input])), submit: () => form.onsubmit({ preventDefault() {} }) };
    } };
}
const employee = { id: "karina", name: "Карина", role: "Developer", executor_type: "human", stack: ["Node.js"], capacity: 4, avatar_url: null };

test("employee create normalizes input, prevents duplicate submit and renders safe text", async () => {
    let release;
    const f = ui(async (url, options) => {
        if (!options.method) return [];
        await new Promise((resolve) => { release = resolve; });
        return { employee: { ...JSON.parse(options.body), id: "new-id" } };
    });
    await tick();
    const editor = f.open(null, (value) => { f.saved = value; });
    editor.inputs.name.value = " <img src=x> ";
    editor.inputs.role.value = "Тестировщик";
    for (const title of ["Node.js", "SQLite", "Ручное тестирование", "testing"]) {
        const input = editor.form.querySelectorAll("input").find((input) => input.type === "checkbox" && input.value === title);
        input.checked = true;
        input.onchange();
    }
    editor.inputs.capacity.value = "12";
    const saving = editor.submit();
    await tick();
    await editor.submit();
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(editor.inputs.name.disabled, true);
    let prevented = false;
    editor.dialog.listeners.cancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    release();
    await saving;
    assert.equal(f.saved.name, "<img src=x>");
    assert.deepEqual(Array.from(f.saved.stack), ["Node.js", "SQLite", "Ручное тестирование"]);
    assert.equal(f.saved.capacity, 12);
    assert.equal(editor.dialog.open, false);
    const card = vm.runInContext("person({ name: '<script>bad</script>', role: 'QA' })", f.context);
    assert.equal(card.children[1].children[0].textContent, "<script>bad</script>");
});

test("employee edit patches only changed fields, preserving identity and other edits", async () => {
    const f = ui(async (url, options) => options.method ? { employee: { ...employee, capacity: 8 } } : []);
    await tick();
    const editor = f.open(employee);
    editor.inputs.capacity.value = "8";
    await editor.submit();
    const call = f.calls.find((item) => item.method === "PATCH");
    assert.equal(call.url, "/api/employees/karina");
    assert.deepEqual(JSON.parse(call.body), { capacity: 8 });
    const unchanged = f.open(employee);
    await unchanged.submit();
    assert.equal(f.calls.filter((item) => item.method === "PATCH").length, 1);
});

test("employee failed save retains inputs and enables correction without changing the list", async () => {
    const f = ui(async (url, options) => options.method ? { __status: 400, error: { message: "Ошибка сохранения." } } : []);
    await tick();
    let saved = false;
    const editor = f.open(employee, () => { saved = true; });
    editor.inputs.name.value = "Сохранить ввод";
    await editor.submit();
    assert.equal(editor.dialog.open, true);
    assert.equal(editor.inputs.name.value, "Сохранить ввод");
    assert.equal(editor.inputs.name.disabled, false);
    assert.equal(saved, false);
    assert.match(editor.form.children.find((child) => child.role === "alert").textContent, /Ошибка сохранения/);
});

test("employee form rejects empty text, invalid hours and excessive skills before a request", async () => {
    const f = ui(async () => []);
    await tick();
    const editor = f.open(employee);
    editor.inputs.name.value = "   ";
    await editor.submit();
    editor.inputs.name.value = "Карина";
    editor.inputs.capacity.value = "1.5";
    await editor.submit();
    editor.inputs.capacity.value = "8";
    for (const input of editor.form.querySelectorAll("input").filter((input) => input.type === "checkbox").slice(9)) {
        input.checked = true;
        input.onchange();
    }
    await editor.submit();
    assert.equal(f.calls.some((item) => item.method), false);
});

test("team add and edit actions update cards without replacing task assignments", async () => {
    const f = ui(async () => [employee]);
    await tick();
    const grid = f.ids.content.children.at(-1);
    const edit = grid.querySelectorAll("button")[0];
    assert.equal(edit["aria-label"], "Редактировать: Карина");
    edit.onclick();
    assert.equal(f.body.children.at(-1).open, true);
    const cancel = f.body.children.at(-1).querySelectorAll("button").find((button) => button.textContent === "Отмена");
    cancel.onclick();
    assert.equal(f.body.children.length, 0);
    assert.equal(grid.children.length, 1);
});

test("catalog groups and technologies are independent, searchable, and preserve legacy skills", async () => {
    const f = ui(async () => []);
    await tick();
    const editor = f.open({ ...employee, stack: ["Мой прежний навык"] });
    const inputs = editor.form.querySelectorAll("input");
    const backend = inputs.find((input) => input.type === "checkbox" && input.value === "backend");
    backend.checked = true;
    backend.onchange();
    const search = inputs.find((input) => input.type === "search");
    search.value = "Node.js";
    search.oninput();
    const nodeInput = inputs.find((input) => input.type === "checkbox" && input.value === "Node.js");
    assert.equal(nodeInput.parent.hidden, false);
    assert.equal(inputs.find((input) => input.value === "React").parent.hidden, true);
    assert.equal(inputs.find((input) => input.value === "Мой прежний навык").checked, true);
    assert.equal(nodeInput.checked, false);
    assert.equal(editor.inputs.grade.children.some((option) => option.value === "Не применимо"), false);
    editor.inputs.grade.value = "Middle";
    editor.inputs.role.value = "ИИ-ассистент";
    editor.inputs.role.onchange();
    assert.equal(editor.inputs.grade.value, "Не применимо");
    assert.equal(editor.inputs.grade.disabled, true);
    assert.equal(editor.inputs.grade.children.some((option) => option.value === "Не применимо"), true);
    editor.inputs.role.value = "Backend-разработчик";
    editor.inputs.role.onchange();
    assert.equal(editor.inputs.grade.value, "Middle");
    assert.equal(editor.inputs.grade.disabled, false);
    assert.equal(editor.inputs.grade.children.some((option) => option.value === "Не применимо"), false);
});

test("avatar preparation blocks submit, rejects unsupported files and clears the old avatar explicitly", async () => {
    const f = ui(async (url, options) => options.method ? { employee: { ...employee, avatar_url: null } } : []);
    await tick();
    const editor = f.open({ ...employee, avatar_url: "/api/employees/karina/avatar" });
    editor.inputs.avatar_file.files = [{ type: "image/svg+xml", size: 100 }];
    await editor.inputs.avatar_file.onchange();
    assert.match(editor.form.children.find((child) => child.role === "alert").textContent, /JPEG/);
    const remove = editor.form.querySelectorAll("button").find((button) => button.textContent === "Убрать аватар");
    remove.onclick();
    await editor.submit();
    const patch = f.calls.find((call) => call.method === "PATCH");
    assert.deepEqual(JSON.parse(patch.body), { avatar_upload: null });
});

test("avatar upload is normalized before submit and is not sent until the employee is saved", async () => {
    let release;
    const f = ui(async (url, options) => options.method ? { employee: { ...employee, avatar_url: "/api/employees/karina/avatar" } } : []);
    await tick();
    f.context.createImageBitmap = () => new Promise((resolve) => { release = () => resolve({ width: 512, height: 256, close() {} }); });
    const create = f.context.document.createElement;
    let canvas;
    f.context.document.createElement = (tag) => {
        if (tag !== "canvas") return create(tag);
        canvas = { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => "data:image/jpeg;base64,/9j/4AAC/9k=" };
        return canvas;
    };
    f.context.URL = { createObjectURL: () => "blob:test", revokeObjectURL() {} };
    const editor = f.open(employee);
    editor.inputs.avatar_file.files = [{ type: "image/png", size: 1000 }];
    const preparing = editor.inputs.avatar_file.onchange();
    await editor.submit();
    assert.equal(f.calls.some((call) => call.method), false);
    release();
    await preparing;
    assert.equal(canvas.width, 256);
    assert.equal(canvas.height, 128);
    assert.equal(f.calls.some((call) => call.method), false);
    await editor.submit();
    assert.deepEqual(JSON.parse(f.calls.find((call) => call.method === "PATCH").body), { avatar_upload: { contentType: "image/jpeg", data: "/9j/4AAC/9k=" } });
});
