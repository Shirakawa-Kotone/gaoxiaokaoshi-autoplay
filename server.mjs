#!/usr/bin/env node
/**
 * 学时助手平台(Web)
 * 注册(学号) → 申请任务(并发数 + 密码 + 备注) → 管理员批准 → 队列执行
 *
 * 启动:
 *   GX_ADMIN_IDS=XXXXXXXX node server.mjs        # 管理员学号(逗号分隔,可多个)
 *
 * 环境变量:
 *   PORT / HOST            监听地址(默认 127.0.0.1:3000)
 *   GX_ADMIN_IDS           管理员学号列表(逗号分隔);不设则首位注册者成为管理员
 *   GX_SECRET              凭证加密密钥(不设则自动生成 secret.key)
 *   GX_MAX_PARALLEL        同时执行的任务数(默认 1)
 *   GX_DEFAULT_TABS        任务默认并发数(默认 4)
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runStudyTask } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'app.db');
const SECRET_FILE = path.join(__dirname, 'secret.key');
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_IDS = (process.env.GX_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PARALLEL = parseInt(process.env.GX_MAX_PARALLEL || '1', 10) || 1;
const DEFAULT_TABS = parseInt(process.env.GX_DEFAULT_TABS || '4', 10) || 4;
const QQ = process.env.GX_QQ || '3651693719'; // 联系 QQ,显示在页面底部

// 学号范围:12610101 - 12613199
const SID_MIN = 12610101;
const SID_MAX = 12613199;
const isValidSid = (s) => /^\d{8}$/.test(s) && Number(s) >= SID_MIN && Number(s) <= SID_MAX;

// ---------- 数据库 ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  exam_user TEXT NOT NULL,
  exam_pass_enc TEXT NOT NULL,
  tabs INTEGER NOT NULL DEFAULT 4,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT NOT NULL DEFAULT '[]',
  log TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();

// ---------- 凭证加密(AES-256-GCM) ----------
function loadSecret() {
  if (process.env.GX_SECRET) return crypto.createHash('sha256').update(process.env.GX_SECRET).digest();
  if (fs.existsSync(SECRET_FILE)) return crypto.createHash('sha256').update(fs.readFileSync(SECRET_FILE)).digest();
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key);
  console.log(`[SECRET] 已生成密钥文件 ${SECRET_FILE}`);
  return key;
}
const SECRET_KEY = loadSecret();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(payload) {
  try {
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ---------- 密码哈希 ----------
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPass(pass, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pass, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
}

// ---------- 会话 ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, userId, now());
  return token;
}
function getUserByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(token) || null;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- 任务日志/进度 ----------
const LOG_CAP = 300000;
function appendTaskLog(taskId, line) {
  const t = db.prepare('SELECT log FROM tasks WHERE id=?').get(taskId);
  if (!t) return;
  let log = `${t.log}\n[${new Date().toISOString().slice(11, 19)}] ${line}`.trim();
  if (log.length > LOG_CAP) log = '...(日志过长已截断)\n' + log.slice(-LOG_CAP);
  db.prepare('UPDATE tasks SET log=?, updated_at=? WHERE id=?').run(log, now(), taskId);
}
function appendTaskProgress(taskId, p) {
  const t = db.prepare('SELECT progress FROM tasks WHERE id=?').get(taskId);
  if (!t) return;
  let arr = [];
  try { arr = JSON.parse(t.progress); } catch {}
  arr.push(p);
  if (arr.length > 800) arr = arr.slice(-800);
  db.prepare('UPDATE tasks SET progress=?, updated_at=? WHERE id=?').run(JSON.stringify(arr), now(), taskId);
}

// ---------- 任务执行 worker ----------
async function runTaskAsync(taskId) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!t) return;
  db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=?").run(now(), taskId);
  appendTaskLog(taskId, `任务开始执行(并发 ${t.tabs})`);
  const examPass = decrypt(t.exam_pass_enc);
  if (!examPass) {
    db.prepare("UPDATE tasks SET status='failed', result='凭证解密失败', updated_at=? WHERE id=?").run(now(), taskId);
    appendTaskLog(taskId, '任务失败: 凭证解密失败');
    return;
  }
  try {
    const result = await runStudyTask({
      examUser: t.exam_user,
      examPass,
      tabs: t.tabs,
      onLog: (line) => appendTaskLog(taskId, line),
      onProgress: (p) => appendTaskProgress(taskId, p),
    });
    db.prepare("UPDATE tasks SET status='done', result=?, updated_at=? WHERE id=?").run(JSON.stringify(result), now(), taskId);
    appendTaskLog(taskId, `任务完成: ${result.done}/${result.courses} 门完成`);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 800);
    db.prepare("UPDATE tasks SET status='failed', result=?, updated_at=? WHERE id=?").run(msg, now(), taskId);
    appendTaskLog(taskId, '任务失败: ' + msg);
  }
}

function workerTick() {
  const { c: running } = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='running'").get();
  const capacity = MAX_PARALLEL - running;
  if (capacity <= 0) return;
  const rows = db.prepare("SELECT id FROM tasks WHERE status='approved' ORDER BY created_at ASC LIMIT ?").all(capacity);
  for (const r of rows) runTaskAsync(r.id);
}

// ---------- Web ----------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS_LABEL = { pending: '待审批', approved: '排队中', rejected: '已拒绝', running: '执行中', done: '已完成', failed: '失败', cancelled: '已取消' };
const STATUS_COLOR = { pending: '#b8860b', approved: '#1e6fd9', rejected: '#a00', running: '#1e9e1e', done: '#0a7a0a', failed: '#c00', cancelled: '#888' };

function layout(title, body, user) {
  const nav = user
    ? `<a href="/dashboard">我的任务</a>${user.role === 'admin' ? ' <a href="/admin">管理</a>' : ''} <a href="/logout">退出 ${esc(user.username)}</a>`
    : '';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f4f6f8;color:#222}
nav{background:#0f2537;color:#fff;padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
nav .brand{font-weight:700;margin-right:auto}
nav a{color:#cfe3f5;text-decoration:none;font-size:14px}
main{max-width:860px;margin:18px auto;padding:0 12px}
.card{background:#fff;border-radius:10px;padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:19px;margin:2px 0 14px}h2{font-size:15px;margin:14px 0 8px}
label{display:block;font-size:13px;color:#555;margin:8px 0 2px}
input,select,textarea{width:100%;padding:10px;margin:2px 0 10px;border:1px solid #cbd5e0;border-radius:8px;font-size:16px}
button,.btn{background:#1e6fd9;color:#fff;border:0;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:15px;text-decoration:none;display:inline-block;margin:2px}
button.green,.btn.green{background:#1e9e1e}button.red,.btn.red{background:#c00}button.gray,.btn.gray{background:#888}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:560px}
th,td{padding:9px 6px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
th{background:#eef3f8;white-space:nowrap}
pre{background:#111;color:#0f0;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:380px;overflow:auto}
.muted{color:#888;font-size:13px}.small{font-size:12px}
.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;color:#fff;white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0}
.stat{background:#fff;border-radius:8px;padding:10px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.stat b{display:block;font-size:20px}
.err{color:#c00;background:#fdeaea;padding:8px 12px;border-radius:8px;margin-bottom:10px}
.ok{color:#0a7a0a;background:#e8f7e8;padding:8px 12px;border-radius:8px;margin-bottom:10px}
@media (max-width:720px){
  main{margin:10px auto;padding:0 8px}
  .card{padding:14px}
  nav{gap:10px;font-size:13px}
  input,select,textarea{font-size:16px}
  button,.btn{padding:12px 16px;font-size:16px;width:100%;margin:3px 0}
  .grid{grid-template-columns:repeat(2,1fr)}
}
footer{max-width:860px;margin:24px auto 30px;padding:0 12px;color:#888;font-size:13px;text-align:center}
</style></head><body>
<nav><span class="brand">学时助手</span>${nav}</nav>
<main>${body}</main>
<footer>问题或建议请加 QQ:<b>${esc(QQ)}</b></footer>
</body></html>`;
}

function tasksTable(rows, showOwner) {
  const trs = rows.map((t) => {
    let prog = '';
    try {
      const arr = JSON.parse(t.progress);
      const done = arr.filter((p) => p.phase === 'done').length;
      const last = arr[arr.length - 1];
      prog = done ? `${done} 门完成` : last ? `${esc(last.course)} ${last.doneMin}/${last.reqMin}分` : '—';
    } catch {}
    return `<tr><td>#${t.id}</td>${showOwner ? `<td>${esc(t.username)}</td>` : ''}<td>${esc(t.exam_user)}</td>
    <td><span class="badge" style="background:${STATUS_COLOR[t.status]}">${STATUS_LABEL[t.status] || t.status}</span></td>
    <td class="small">${esc(t.note) || '—'}</td><td class="small">${prog}</td>
    <td class="small">${esc(t.created_at.slice(5, 16))}</td>
    <td><a href="/task/${t.id}" class="btn gray" style="padding:4px 10px;width:auto">查看</a></td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><tr><th>ID</th>${showOwner ? '<th>学号</th>' : ''}<th>账号</th><th>状态</th><th>备注</th><th>进度</th><th>时间</th><th></th></tr>${trs}</table></div>`;
}

function progressTable(t) {
  let arr = [];
  try { arr = JSON.parse(t.progress); } catch {}
  if (!arr.length) return '<p class="muted">尚未开始。</p>';
  const map = new Map();
  for (const p of arr) map.set(p.course, p);
  const rows = [...map.values()].map((p) => {
    const mark = p.phase === 'done' ? '✔' : p.phase === 'check' ? '进行中' : '';
    return `<tr><td>${esc(p.course)}</td><td>${p.doneMin}/${p.reqMin} 分钟</td><td>${mark}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><tr><th>课程</th><th>进度</th><th></th></tr>${rows}</table></div>`;
}

// ---------- 页面 ----------
app.get('/', (req, res) => {
  const user = getUserByToken(parseCookies(req).sid);
  res.redirect(user ? '/dashboard' : '/login');
});

app.get('/login', (req, res) => {
  if (getUserByToken(parseCookies(req).sid)) return res.redirect('/dashboard');
  res.send(layout('登录', `<div class="card"><h1>登录</h1>
  <form method="post" action="/login"><label>学号</label><input name="username" inputmode="numeric" required>
  <label>密码</label><input type="password" name="password" required>
  <button>登录</button></form>
  <p class="muted">没有账号?<a href="/register">去注册</a></p></div>`, null));
});
app.post('/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.body.username || '');
  if (!u || !verifyPass(req.body.password || '', u.pass_hash)) {
    return res.send(layout('登录', `<div class="card"><div class="err">学号或密码错误</div><a href="/login" class="btn gray">返回</a></div>`, null));
  }
  const token = createSession(u.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 86400}`);
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  if (getUserByToken(parseCookies(req).sid)) return res.redirect('/dashboard');
  res.send(layout('注册', `<div class="card"><h1>注册</h1>
  <form method="post" action="/register"><label>学号(12610101 - 12613199)</label>
  <input name="username" inputmode="numeric" placeholder="12610101" required>
  <label>密码(至少 6 位)</label><input type="password" name="password" minlength="6" required>
  <button>注册</button></form>
  <p class="muted">已有账号?<a href="/login">去登录</a></p></div>`, null));
});
app.post('/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = req.body.password || '';
  if (!isValidSid(username)) {
    return res.send(layout('注册', `<div class="card"><div class="err">学号格式不正确(需为 12610101 - 12613199 范围内的 8 位数字)</div><a href="/register" class="btn gray">返回</a></div>`, null));
  }
  if (password.length < 6) {
    return res.send(layout('注册', `<div class="card"><div class="err">密码至少 6 位</div><a href="/register" class="btn gray">返回</a></div>`, null));
  }
  const { c: userCount } = db.prepare('SELECT COUNT(*) c FROM users').get();
  const role = ADMIN_IDS.includes(username) || userCount === 0 ? 'admin' : 'user';
  try {
    db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?,?,?,?)')
      .run(username, hashPass(password), role, now());
  } catch {
    return res.send(layout('注册', `<div class="card"><div class="err">该学号已注册</div><a href="/register" class="btn gray">返回</a></div>`, null));
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  const token = createSession(u.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 86400}`);
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token=?').run(sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

function requireAuth(req, res, next) {
  req.user = getUserByToken(parseCookies(req).sid);
  if (!req.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).send(layout('无权限', '<div class="card"><div class="err">无权限</div></div>', req.user));
  next();
}

app.get('/dashboard', requireAuth, (req, res) => {
  const mine = db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  const body = `<div class="card"><h1>我的任务</h1>
  <a href="/task/new" class="btn green">申请任务</a>
  ${mine.length ? tasksTable(mine, false) : '<p class="muted">还没有任务。</p>'}</div>`;
  res.send(layout('我的任务', body, req.user));
});

app.get('/task/new', requireAuth, (req, res) => {
  const body = `<div class="card"><h1>申请任务</h1>
  <form method="post" action="/task/new">
  <label>账号</label><input value="${esc(req.user.username)}" disabled>
  <label>密码</label><input type="password" name="exam_pass" required>
  <label>并发数</label><input type="number" name="tabs" value="${DEFAULT_TABS}" min="1" max="36" required>
  <label>备注(选填)</label><textarea name="note" rows="2"></textarea>
  <button>提交</button> <a href="/dashboard" class="btn gray">返回</a>
  </form></div>`;
  res.send(layout('申请任务', body, req.user));
});
app.post('/task/new', requireAuth, (req, res) => {
  const examPass = String(req.body.exam_pass || '');
  if (!examPass) return res.redirect('/task/new');
  const tabs = Math.min(36, Math.max(1, parseInt(req.body.tabs, 10) || 1));
  db.prepare(`INSERT INTO tasks (user_id, exam_user, exam_pass_enc, tabs, note, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.user.id, req.user.username, encrypt(examPass), tabs, String(req.body.note || '').slice(0, 500), 'pending', now(), now());
  res.redirect('/dashboard');
});

app.get('/task/:id', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).send(layout('不存在', '<div class="card">任务不存在</div>', req.user));
  if (t.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).send(layout('无权限', '<div class="card"><div class="err">无权限</div></div>', req.user));
  const canApprove = req.user.role === 'admin' && ['pending', 'rejected'].includes(t.status);
  const canCancel = ['pending', 'approved'].includes(t.status) && (t.user_id === req.user.id || req.user.role === 'admin');
  const body = `<div class="card"><h1>任务 #${t.id} <span class="badge" style="background:${STATUS_COLOR[t.status]}">${STATUS_LABEL[t.status] || t.status}</span></h1>
  <p class="muted">账号: ${esc(t.exam_user)} · 并发: ${t.tabs}${t.note ? ' · 备注: ' + esc(t.note) : ''}</p>
  ${canApprove ? `<form method="post" action="/api/tasks/${t.id}/approve" style="display:inline"><button class="green">批准</button></form>
    <form method="post" action="/api/tasks/${t.id}/reject" style="display:inline"><button class="red">拒绝</button></form>` : ''}
  ${canCancel ? `<form method="post" action="/api/tasks/${t.id}/cancel" style="display:inline"><button class="gray">取消</button></form>` : ''}
  <h2>进度</h2><div id="progress">${progressTable(t)}</div>
  <h2>日志</h2><pre id="log">${esc(t.log) || '(暂无)'}</pre></div>
  <script>
  setInterval(async () => {
    try {
      const d = await (await fetch('/api/tasks/${t.id}')).json();
      document.getElementById('progress').innerHTML = d.progressHtml;
      document.getElementById('log').textContent = d.log || '(暂无)';
    } catch (e) {}
  }, 5000);
  </script>`;
  res.send(layout(`任务 #${t.id}`, body, req.user));
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const stats = {};
  for (const s of ['pending', 'approved', 'running', 'done', 'failed']) {
    stats[s] = db.prepare('SELECT COUNT(*) c FROM tasks WHERE status=?').get(s).c;
  }
  const filter = req.query.f || '';
  const rows = db.prepare(`SELECT t.*, u.username FROM tasks t JOIN users u ON u.id=t.user_id
    WHERE ?='' OR t.status=? ORDER BY t.created_at DESC LIMIT 200`).all(filter, filter);
  const statCards = Object.entries(stats).map(([k, v]) => `<div class="stat"><b>${v}</b><span class="muted">${STATUS_LABEL[k]}</span></div>`).join('');
  const body = `<div class="card"><h1>管理</h1>
  <div class="grid">${statCards}</div>
  <p class="muted">筛选: ${['', 'pending', 'running', 'done', 'failed'].map((s) => (s ? `<a href="/admin?f=${s}">${STATUS_LABEL[s]}</a>` : '<a href="/admin">全部</a>')).join(' | ')}</p>
  ${tasksTable(rows, true)}
  <p><a href="/admin/users" class="btn gray">用户</a></p></div>`;
  res.send(layout('管理', body, req.user));
});

app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.user_id=u.id) task_count FROM users u ORDER BY u.id').all();
  const trs = rows.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'admin' ? '管理员' : '用户'}</td><td>${u.task_count}</td>
    <td class="small">${esc(u.created_at.slice(5, 16))}</td>
    <td>${u.role === 'admin'
      ? (u.username !== req.user.username ? `<form method="post" action="/api/users/${u.id}/demote" style="display:inline"><button class="gray" style="padding:4px 10px;width:auto">取消管理员</button></form>` : '')
      : `<form method="post" action="/api/users/${u.id}/promote" style="display:inline"><button class="green" style="padding:4px 10px;width:auto">设为管理员</button></form>`}</td></tr>`).join('');
  const body = `<div class="card"><h1>用户</h1>
  <div class="table-wrap"><table><tr><th>学号</th><th>角色</th><th>任务数</th><th>注册时间</th><th></th></tr>${trs}</table></div>
  <p><a href="/admin" class="btn gray">返回</a></p></div>`;
  res.send(layout('用户', body, req.user));
});

// ---------- API ----------
app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json({ status: t.status, progressHtml: progressTable(t), log: t.log, result: t.result });
});

app.post('/api/tasks/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !['pending', 'rejected'].includes(t.status)) return res.redirect('/admin');
  db.prepare("UPDATE tasks SET status='approved', updated_at=? WHERE id=?").run(now(), t.id);
  appendTaskLog(t.id, '已批准,进入队列');
  res.redirect(`/task/${t.id}`);
});
app.post('/api/tasks/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !['pending', 'rejected'].includes(t.status)) return res.redirect('/admin');
  db.prepare("UPDATE tasks SET status='rejected', updated_at=? WHERE id=?").run(now(), t.id);
  appendTaskLog(t.id, '已拒绝');
  res.redirect('/admin');
});
app.post('/api/tasks/:id/cancel', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.redirect('/dashboard');
  if (t.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).send('forbidden');
  if (!['pending', 'approved'].includes(t.status)) return res.redirect(`/task/${t.id}`);
  db.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(now(), t.id);
  appendTaskLog(t.id, '已取消');
  res.redirect('/dashboard');
});

app.post('/api/users/:id/promote', requireAuth, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(req.params.id);
  res.redirect('/admin/users');
});
app.post('/api/users/:id/demote', requireAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (u && u.username !== req.user.username) db.prepare("UPDATE users SET role='user' WHERE id=?").run(req.params.id);
  res.redirect('/admin/users');
});

// ---------- 启动 ----------
db.prepare("UPDATE tasks SET status='approved', updated_at=? WHERE status='running'").run(now());

const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
console.log(`[DB] ${DB_FILE} 就绪, 用户 ${totalUsers} 个`);
console.log(`[ADMIN] 管理员学号: ${ADMIN_IDS.length ? ADMIN_IDS.join(', ') : '(首位注册者)'}`);

app.listen(PORT, HOST, () => {
  console.log(`[WEB] http://${HOST}:${PORT}`);
  console.log(`[WEB] 并发任务=${MAX_PARALLEL}; 默认并发数=${DEFAULT_TABS}`);
});

setInterval(workerTick, 5000);
workerTick();
