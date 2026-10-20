require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const app = express();
const PORT = process.env.PORT || 3000;
const dir = path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'task-manager.db'));
db.pragma('foreign_keys = ON');
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
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
function seed() {
 if (db.prepare('SELECT COUNT(*) n FROM employees').get().n) return;
 db.transaction(() => {
  const emp = db.prepare('INSERT INTO employees(name,role,executor_type,stack,capacity,avatar_url) VALUES(?,?,?,?,?,?)');
  emp.run('Халикова Карина','Frontend Developer','human',JSON.stringify(['React','Tailwind','UI/UX']),4,'https://api.dicebear.com/9.x/initials/svg?seed=Karina');
  emp.run('Пескова София','Backend Developer','human',JSON.stringify(['Node.js','SQLite','GitHub API']),4,'https://api.dicebear.com/9.x/initials/svg?seed=Sofia');
  emp.run('Qwen Code Agent','AI Assistant','ai_agent',JSON.stringify(['Code Review','Auto-Tests','Refactoring']),null,'https://api.dicebear.com/9.x/bottts/svg?seed=Qwen');
  const task = db.prepare('INSERT INTO tasks(title,description,status,branch,pr_url,assignee_id) VALUES(?,?,?,?,?,?)');
  task.run('Сделать форму логина','Сверстать Email и пароль. Проверить обязательные поля и переход на доску.','todo',null,null,1);
  task.run('Подготовить генератор ТЗ','Форма создания задачи с описанием и критериями приёмки.','todo',null,null,3);
  task.run('Сохранение задач в SQLite','REST API для хранения и обновления статусов.','progress','feat/sqlite-api',null,2);
  task.run('Карточки команды','Показать участников, роли, стек и загрузку.','progress','feat/team-page',null,1);
  task.run('Проверить навигацию','Проверить переходы между страницами приложения.','review','feat/navigation','https://github.com/Soniap06/task-manager/pull/1',3);
  task.run('Подготовить дизайн-токены','Общие цвета, отступы и адаптивная сетка.','review','feat/design-tokens',null,1);
  const ev = db.prepare('INSERT INTO events(event_type,payload_summary,created_at) VALUES(?,?,?)');
  const now = Date.now();
  ev.run('push','Демонстрация: push в ветку feat/auth.',new Date(now-5*60000).toISOString());
  ev.run('pull_request','Демонстрация: Pull Request #1 открыт.',new Date(now-24*60000).toISOString());
  ev.run('pull_request_review','Демонстрация: запрошено ревью у Qwen Code Agent.',new Date(now-70*60000).toISOString());
  ev.run('push','Демонстрация: изменения API задач.',new Date(now-130*60000).toISOString());
 })();
}
seed();
// Repair the old demo placeholder URL in existing local databases too.
db.prepare("UPDATE tasks SET pr_url='https://github.com/Soniap06/task-manager/pull/1' WHERE pr_url='https://github.com/'").run();

const SESSION_SECRET = process.env.SESSION_SECRET;
const DEMO_USERNAME = process.env.DEMO_USERNAME;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET || 'missing-session-secret').update(value).digest('hex'); }
function safeEqual(a,b) { const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function makeSession(username) { const payload=Buffer.from(JSON.stringify({username,exp:Date.now()+8*60*60*1000})).toString('base64url'); return `${payload}.${sign(payload)}`; }
function readSession(token) {
 if (!token || !SESSION_SECRET) return null;
 const i=token.lastIndexOf('.'); if(i<1)return null;
 const payload=token.slice(0,i), sig=token.slice(i+1);
 if(!safeEqual(sig,sign(payload)))return null;
 try { const data=JSON.parse(Buffer.from(payload,'base64url').toString()); return data.exp>Date.now()?data:null; } catch { return null; }
}
function cookie(req,name) { const raw=req.headers.cookie||''; const pair=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'=')); return pair?decodeURIComponent(pair.slice(name.length+1)):''; }
function requireAuth(req,res,next) {
 const session=readSession(cookie(req,'tm_session'));
 if(!session)return res.status(401).json({error:'Требуется вход. Авторизуйтесь на странице входа.'});
 req.user=session.username; next();
}
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');next();});
// GitHub sends the exact raw body; verify its signature before parsing JSON.
app.post('/api/webhooks/github', express.raw({type:'application/json',limit:'1mb'}), (req,res)=>{
 const secret=process.env.GITHUB_WEBHOOK_SECRET;
 if(!secret)return res.status(503).json({error:'GITHUB_WEBHOOK_SECRET не настроен'});
 const signature=req.get('x-hub-signature-256')||'';
 const expected='sha256='+crypto.createHmac('sha256',secret).update(req.body).digest('hex');
 if(!/^sha256=[a-f0-9]{64}$/.test(signature)||!safeEqual(signature,expected))return res.status(401).json({error:'Неверная подпись GitHub'});
 const delivery=req.get('x-github-delivery')||crypto.createHash('sha256').update(req.body).digest('hex');
 if(db.prepare('SELECT 1 FROM webhook_deliveries WHERE delivery_id=?').get(delivery))return res.status(200).json({ok:true,duplicate:true});
 let payload; try { payload=JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({error:'Некорректный JSON'}); }
 const ghEvent=req.get('x-github-event'); let type,summary;
 if(ghEvent==='push') { type='push'; summary=`Push: ${payload.pusher?.name||payload.sender?.login||'unknown'} в ${payload.ref||'ветку'} — ${payload.head_commit?.message||'обновление коммитов'}`; }
 else if(ghEvent==='pull_request') { type='pull_request'; const pr=payload.pull_request||{}; summary=`Pull Request #${pr.number||payload.number||'?'} ${pr.action||'updated'}: ${pr.title||'без названия'} (${pr.user?.login||payload.sender?.login||'unknown'})`; }
 else if(ghEvent==='pull_request_review') { type='pull_request_review'; const pr=payload.pull_request||{}, review=payload.review||{}; summary=`Review для PR #${pr.number||'?'}: ${review.state||'submitted'} от ${review.user?.login||'unknown'}`; }
 else return res.status(202).json({ok:true,ignored:true,event:ghEvent||'unknown'});
 const tx=db.transaction(()=>{db.prepare('INSERT INTO events(event_type,payload_summary) VALUES(?,?)').run(type,summary);db.prepare('INSERT INTO webhook_deliveries(delivery_id) VALUES(?)').run(delivery);});
 try{tx();return res.status(202).json({ok:true});}catch(e){console.error('Webhook persistence failed',e);return res.status(500).json({error:'Не удалось сохранить событие'});}
});
app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/auth/status',(req,res)=>{const s=readSession(cookie(req,'tm_session'));res.json({authenticated:!!s,username:s?.username||null});});
app.post('/api/auth/login',(req,res)=>{
 if(!SESSION_SECRET||!DEMO_USERNAME||!DEMO_PASSWORD)return res.status(503).json({error:'Настройте SESSION_SECRET, DEMO_USERNAME и DEMO_PASSWORD в .env'});
 const {username,password}=req.body||{};
 if(!safeEqual(username||'',DEMO_USERNAME)||!safeEqual(password||'',DEMO_PASSWORD))return res.status(401).json({error:'Неверный логин или пароль'});
 res.setHeader('Set-Cookie',`tm_session=${encodeURIComponent(makeSession(DEMO_USERNAME))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);
 res.json({ok:true,username:DEMO_USERNAME});
});
app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie',`tm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true});});
app.use('/api', (req,res,next)=>['/health','/auth/status','/auth/login','/auth/logout','/webhooks/github'].includes(req.path)?next():requireAuth(req,res,next));
app.get('/api/tasks',(req,res)=>{
 const rows=db.prepare(`SELECT t.*,e.name assignee_name,e.role assignee_role,e.executor_type assignee_type,e.avatar_url assignee_avatar,e.stack assignee_stack FROM tasks t LEFT JOIN employees e ON e.id=t.assignee_id ORDER BY t.id DESC`).all();
 res.json(rows.map(r=>({...r,assignee_stack:r.assignee_stack?JSON.parse(r.assignee_stack):[]})));
});
app.post('/api/tasks',(req,res)=>{
 const {title,description='',status='todo',branch=null,pr_url=null,assignee_id=null}=req.body||{};
 if(!title||!String(title).trim())return res.status(400).json({error:'Название задачи обязательно'});
 if(!['todo','progress','review'].includes(status))return res.status(400).json({error:'Недопустимый статус'});
 try {const r=db.prepare('INSERT INTO tasks(title,description,status,branch,pr_url,assignee_id) VALUES(?,?,?,?,?,?)').run(String(title).trim(),String(description),status,branch,pr_url,assignee_id||null);res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid));}
 catch(e){res.status(400).json({error:'Не удалось создать задачу; проверьте исполнителя'});}
});
app.patch('/api/tasks/:id',(req,res)=>{
 const id=Number(req.params.id), old=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
 if(!old)return res.status(404).json({error:'Задача не найдена'});
 const allowed=['title','description','status','branch','pr_url','assignee_id'], u={};
 for(const k of allowed)if(Object.hasOwn(req.body||{},k))u[k]=req.body[k];
 if(u.status&&!['todo','progress','review'].includes(u.status))return res.status(400).json({error:'Недопустимый статус'});
 const keys=Object.keys(u); if(!keys.length)return res.json(old);
 try {db.prepare(`UPDATE tasks SET ${keys.map(k=>k+'=@'+k).join(',')} WHERE id=@id`).run({...u,id});res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));}
 catch(e){res.status(400).json({error:'Не удалось обновить задачу; проверьте данные'});}
});
app.get('/api/employees',(req,res)=>res.json(db.prepare('SELECT * FROM employees ORDER BY id').all().map(e=>({...e,stack:JSON.parse(e.stack)}))));
app.get('/api/employees/:id',(req,res)=>{const e=db.prepare('SELECT * FROM employees WHERE id=?').get(Number(req.params.id));if(!e)return res.status(404).json({error:'Сотрудник не найден'});res.json({...e,stack:JSON.parse(e.stack)});});
app.get('/api/profile',(req,res)=>{const e=db.prepare('SELECT * FROM employees WHERE id=2').get();const stats=db.prepare("SELECT SUM(CASE WHEN status='progress' AND assignee_id=2 THEN 1 ELSE 0 END) in_progress,SUM(CASE WHEN status='review' AND assignee_id=2 THEN 1 ELSE 0 END) in_review FROM tasks").get();res.json({...e,stack:JSON.parse(e.stack),stats});});
app.get('/api/events',(req,res)=>res.json(db.prepare('SELECT * FROM events ORDER BY datetime(created_at) DESC,id DESC LIMIT 100').all()));
app.post('/api/ai/generate-task',(req,res,next)=>{
 (async()=>{
  const apiKey=process.env.QWEN_API_KEY; if(!apiKey)return res.status(503).json({error:'Добавьте QWEN_API_KEY в .env'});
  const prompt=String(req.body?.prompt||'').trim(); if(prompt.length<5)return res.status(400).json({error:'Опишите задачу подробнее (минимум 5 символов)'});
  const base=(process.env.QWEN_BASE_URL||'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/,'');
  const response=await fetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.QWEN_MODEL||'qwen-plus',temperature:0.3,messages:[{role:'system',content:'Ты опытный технический руководитель. Составь краткое, конкретное ТЗ на русском языке. Верни только JSON с полями description (требования и шаги) и acceptance_criteria (массив критериев приёмки). Не придумывай бизнес-контекст, которого нет в запросе.'},{role:'user',content:prompt}]})});
  const data=await response.json().catch(()=>({})); if(!response.ok){console.error('Qwen API error',response.status,data);return res.status(502).json({error:'Qwen API вернул ошибку. Проверьте ключ, модель и доступ к API.'});}
  let content=data.choices?.[0]?.message?.content||''; content=content.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let result;try{result=JSON.parse(content);}catch{return res.status(502).json({error:'Qwen вернул ответ не в ожидаемом JSON-формате'});}
  if(typeof result.description!=='string'||!Array.isArray(result.acceptance_criteria))return res.status(502).json({error:'Qwen вернул неполное ТЗ'});
  return res.json({description:result.description,acceptance_criteria:result.acceptance_criteria});
 })().catch(next);
});
app.post('/api/events',(req,res)=>{const {event_type,payload_summary}=req.body||{};if(!['push','pull_request','pull_request_review'].includes(event_type)||!payload_summary)return res.status(400).json({error:'Некорректное событие'});const r=db.prepare('INSERT INTO events(event_type,payload_summary) VALUES(?,?)').run(event_type,payload_summary);res.status(201).json(db.prepare('SELECT * FROM events WHERE id=?').get(r.lastInsertRowid));});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Внутренняя ошибка сервера'});});
app.listen(PORT,()=>console.log(`Task Manager: http://localhost:${PORT}`));
