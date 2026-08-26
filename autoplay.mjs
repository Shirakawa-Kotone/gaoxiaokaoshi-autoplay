#!/usr/bin/env node
/**
 * 学时助手 CLI —— 薄包装,核心逻辑在 engine.mjs
 *
 * 用法:
 *   GX_USER=账号 GX_PASS=密码 node autoplay.mjs
 *   node autoplay.mjs 账号 密码
 *
 * 环境变量:
 *   GX_TABS=N            同一个浏览器开 N 个标签页并发(默认 1)
 *   GX_DEVICES=M / GX_DEVICE_ID=d  多设备分片
 *   GX_STATUS_PORT=N     只读状态页端口(默认关闭;配 cloudflared 隧道可公网查看)
 *   SMOKE=1              测试模式:每门课最多播放 3 分钟
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStudyTask } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, 'run.log');
const USER = process.env.GX_USER || process.argv[2];
const PASS = process.env.GX_PASS || process.argv[3];
const TABS = parseInt(process.env.GX_TABS || '1', 10) || 1;
const DEVICES = parseInt(process.env.GX_DEVICES || '1', 10) || 1;
const DEVICE_ID = parseInt(process.env.GX_DEVICE_ID || '0', 10) || 0;
const SMOKE = process.env.SMOKE === '1';
const STATUS_PORT = parseInt(process.env.GX_STATUS_PORT || '0', 10) || 0;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

if (!USER || !PASS) {
  console.error('用法: GX_USER=账号 GX_PASS=密码 node autoplay.mjs   (或 node autoplay.mjs 账号 密码)');
  process.exit(1);
}

// 实时进度(供状态页展示)
const progress = [];

if (STATUS_PORT > 0) {
  http
    .createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      res.setHeader('Cache-Control', 'no-store');
      if (url === '/courses') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ running: true, progress }, null, 2));
      } else if (url === '/log') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        const lines = fs.existsSync(LOG)
          ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-300)
          : ['(暂无日志)'];
        res.end(lines.join('\n'));
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const done = progress.filter((p) => p.phase === 'done').length;
        const logTail = fs.existsSync(LOG)
          ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-200).join('\n')
          : '(暂无日志)';
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>学习状态</title>
<meta http-equiv="refresh" content="10"></head>
<body style="font-family:monospace;background:#111;color:#0f0;padding:12px;word-break:break-all;">
<h3>高校考试网 · 学时助手 <span style="color:#888">(每 10 秒自动刷新)</span></h3>
<p>已完成 ${done}/${progress.length} 门</p>
<a href="/log" style="color:#0af">原始日志</a> | <a href="/courses" style="color:#0af">进度 JSON</a>
<hr><pre style="white-space:pre-wrap;">${logTail}</pre>
</body></html>`);
      }
    })
    .listen(STATUS_PORT, '127.0.0.1', () => {
      log(`状态页: http://127.0.0.1:${STATUS_PORT}/ (公网访问需 cloudflared 隧道)`);
    });
}

log(`=== 启动: 账号=${USER} 标签页=${TABS} 设备=${DEVICE_ID}/${DEVICES} ${SMOKE ? '(测试模式)' : ''} ===`);
try {
  const result = await runStudyTask({
    examUser: USER,
    examPass: PASS,
    tabs: TABS,
    deviceId: DEVICE_ID,
    devices: DEVICES,
    smoke: SMOKE,
    onLog: log,
    onProgress: (p) => {
      progress.push(p);
      if (progress.length > 500) progress.splice(0, progress.length - 500);
    },
  });
  log(`=== 处理完毕: ${result.done}/${result.courses} 门完成 ===`);
} catch (err) {
  log('错误: ' + (err.stack || err.message || err));
  process.exitCode = 1;
}
