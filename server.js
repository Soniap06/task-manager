const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const app = express();
const PORT = process.env.PORT || 3000;
const dir = path.join(__dirname, "data");
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, "task-manager.db"));
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS employees (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL,
 executor_type TEXT NOT NULL CHECK(executor_type IN ('human','ai_agent')),
 stack TEXT NOT NULL DEFAULT '[]', capacity INTEGER, avatar_url TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','progress','review')),
 branch TEXT, pr_url TEXT, assignee_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(assignee_id) REFERENCES employees(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_type TEXT NOT NULL CHECK(event_type IN ('push','pull_request','pull_request_review')),
 payload_summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
function seed() {
 if (db.prepare("SELECT COUNT(*) n FROM employees").get().n) return;
 const tx = db.transaction(() => {
  const emp = db.prepare("INSERT INTO employees(name,role,executor_type,stack,capacity,avatar_url) VALUES(?,?,?,?,?,?)");
  emp.run("Халикова Карина","Frontend Developer","human",JSON.stringify(["React","Tailwind","UI/UX"]),4,"https://api.dicebear.com/9.x/initials/svg?seed=Karina");
  emp.run("Пескова София","Backend Developer","human",JSON.stringify(["Node.js","SQLite","GitHub API"]),4,"https://api.dicebear.com/9.x/initials/svg?seed=Sofia");
  emp.run("Qwen Code Agent","AI Assistant","ai_agent",JSON.stringify(["Code Review","Auto-Tests","Refactoring"]),null,"https://api.dicebear.com/9.x/bottts/svg?seed=Qwen");
  const task = db.prepare("INSERT INTO tasks(title,description,status,branch,pr_url,assignee_id) VALUES(?,?,?,?,?,?)");
  task.run("Сделать форму логина","Сверстать Email и пароль. Проверить обязательные поля и переход на доску.","todo",null,null,1);
  task.run("Подготовить генератор ТЗ","Форма создания задачи с описанием и критериями приёмки.","todo",null,null,3);
  task.run("Сохранение задач в SQLite","REST API для хранения и обновления статусов.","progress","feat/sqlite-api",null,2);
  task.run("Карточки команды","Показать участников, роли, стек и загрузку.","progress","feat/team-page",null,1);
  task.run("Проверить навигацию","Проверить переходы между страницами приложения.","review","feat/navigation","https://github.com/",3);
  task.run("Подготовить дизайн-токены","Общие цвета, отступы и адаптивная сетка.","review","feat/design-tokens",null,1);
  const ev = db.prepare("INSERT INTO events(event_type,payload_summary,created_at) VALUES(?,?,?)");
  const now = Date.now();
  ev.run("push","Push в ветку feat/auth: добавлена базовая форма авторизации.",new Date(now-5*60000).toISOString());
  ev.run("pull_request","Открыт Pull Request #1: проверка навигации.",new Date(now-24*60000).toISOString());
  ev.run("pull_request_review","Qwen Code Agent запросил ревью для feat/navigation.",new Date(now-70*60000).toISOString());
  ev.run("push","Push в ветку feat/sqlite-api: добавлена схема SQLite.",new Date(now-130*60000).toISOString());
 });
 tx();
}
seed();
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));
app.get("/api/health",(req,res)=>res.json({ok:true}));
app.get("/api/tasks",(req,res)=>{
 const rows=db.prepare(`SELECT t.*,e.name assignee_name,e.role assignee_role,e.executor_type assignee_type,e.avatar_url assignee_avatar,e.stack assignee_stack FROM tasks t LEFT JOIN employees e ON e.id=t.assignee_id ORDER BY t.id DESC`).all();
 res.json(rows.map(r=>({...r,assignee_stack:r.assignee_stack?JSON.parse(r.assignee_stack):[]})));
});
app.post("/api/tasks",(req,res)=>{
 const {title,description="",status="todo",branch=null,pr_url=null,assignee_id=null}=req.body||{};
 if(!title||!String(title).trim())return res.status(400).json({error:"Название задачи обязательно"});
 if(!["todo","progress","review"].includes(status))return res.status(400).json({error:"Недопустимый статус"});
 try {const r=db.prepare("INSERT INTO tasks(title,description,status,branch,pr_url,assignee_id) VALUES(?,?,?,?,?,?)").run(String(title).trim(),String(description),status,branch,pr_url,assignee_id||null);res.status(201).json(db.prepare("SELECT * FROM tasks WHERE id=?").get(r.lastInsertRowid));}
 catch(e){res.status(400).json({error:"Не удалось создать задачу; проверьте исполнителя"});}
});
app.patch("/api/tasks/:id",(req,res)=>{
 const id=Number(req.params.id), old=db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
 if(!old)return res.status(404).json({error:"Задача не найдена"});
 const allowed=["title","description","status","branch","pr_url","assignee_id"], u={};
 for(const k of allowed)if(Object.hasOwn(req.body||{},k))u[k]=req.body[k];
 if(u.status&&!["todo","progress","review"].includes(u.status))return res.status(400).json({error:"Недопустимый статус"});
 const keys=Object.keys(u); if(!keys.length)return res.json(old);
 try {db.prepare(`UPDATE tasks SET ${keys.map(k=>k+"=@"+k).join(",")} WHERE id=@id`).run({...u,id});res.json(db.prepare("SELECT * FROM tasks WHERE id=?").get(id));}
 catch(e){res.status(400).json({error:"Не удалось обновить задачу; проверьте данные"});}
});
app.get("/api/employees",(req,res)=>res.json(db.prepare("SELECT * FROM employees ORDER BY id").all().map(e=>({...e,stack:JSON.parse(e.stack)}))));
app.get("/api/employees/:id",(req,res)=>{const e=db.prepare("SELECT * FROM employees WHERE id=?").get(Number(req.params.id));if(!e)return res.status(404).json({error:"Сотрудник не найден"});res.json({...e,stack:JSON.parse(e.stack)});});
app.get("/api/profile",(req,res)=>{const e=db.prepare("SELECT * FROM employees WHERE id=2").get();const stats=db.prepare("SELECT SUM(CASE WHEN status='progress' AND assignee_id=2 THEN 1 ELSE 0 END) in_progress,SUM(CASE WHEN status='review' AND assignee_id=2 THEN 1 ELSE 0 END) in_review FROM tasks").get();res.json({...e,stack:JSON.parse(e.stack),stats});});
app.get("/api/events",(req,res)=>res.json(db.prepare("SELECT * FROM events ORDER BY datetime(created_at) DESC,id DESC LIMIT 100").all()));
app.post("/api/events",(req,res)=>{const {event_type,payload_summary}=req.body||{};if(!["push","pull_request","pull_request_review"].includes(event_type)||!payload_summary)return res.status(400).json({error:"Некорректное событие"});const r=db.prepare("INSERT INTO events(event_type,payload_summary) VALUES(?,?)").run(event_type,payload_summary);res.status(201).json(db.prepare("SELECT * FROM events WHERE id=?").get(r.lastInsertRowid));});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Task Manager: http://localhost:${PORT}`));
