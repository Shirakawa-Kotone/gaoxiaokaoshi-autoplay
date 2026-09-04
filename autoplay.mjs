#!/usr/bin/env node
/**
 * 学时助手 CLI(web 分支版)—— 薄包装,核心逻辑在 engine.mjs
 * 本地离线运行,不需要网页/服务器/隧道。
 *
 * 用法:
 *   GX_USER=账号 GX_PASS=密码 node autoplay.mjs          # 默认:刷学时
 *   GX_USER=账号 GX_PASS=密码 GX_MODE=exam node autoplay.mjs     # 自动答题(课后练习,错题自动重考)
 *   GX_USER=账号 GX_PASS=密码 GX_MODE=combined node autoplay.mjs # 先刷学时,再自动答题
 *   node autoplay.mjs 账号 密码                          # 位置参数等价
 *
 * 环境变量:
 *   GX_TABS=N            刷学时并发标签页(默认 1)
 *   GX_DEVICES=M / GX_DEVICE_ID=d  多设备分片
 *   GX_MODE=study|exam|combined   任务类型(默认 study)
 *   SMOKE=1              测试模式:每门课最多播放 3 分钟
 *
 * 题库(仅自动答题模式):本地 bank.json 为初始题库,答题收录的新题自动写回,
 *   完全离线、不上云(与网页版 app.db 互不影响)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStudyTask, runCoursePracticeTask } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, 'run.log');
const BANK_FILE = path.join(__dirname, 'bank.json');
const USER = process.env.GX_USER || process.argv[2];
const PASS = process.env.GX_PASS || process.argv[3];
const TABS = parseInt(process.env.GX_TABS || '1', 10) || 1;
const DEVICES = parseInt(process.env.GX_DEVICES || '1', 10) || 1;
const DEVICE_ID = parseInt(process.env.GX_DEVICE_ID || '0', 10) || 0;
const SMOKE = process.env.SMOKE === '1';
const MODE = String(process.env.GX_MODE || 'study').toLowerCase();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

if (!USER || !PASS) {
  console.error('用法: GX_USER=账号 GX_PASS=密码 node autoplay.mjs   (或 node autoplay.mjs 账号 密码)');
  process.exit(1);
}

const MODE_LABEL = { study: '刷学时', exam: '自动答题(课后练习)', combined: '刷学时+自动答题' };

// ---------- 本地题库(仅答题相关模式) ----------
function loadLocalBank() {
  try {
    if (fs.existsSync(BANK_FILE)) {
      const data = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
      const out = {};
      for (const [q, a] of Object.entries(data || {})) {
        const arr = Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : [String(a).trim()].filter(Boolean);
        if (q && arr.length) out[q] = arr;
      }
      if (Object.keys(out).length) log(`题库: 从 bank.json 载入 ${Object.keys(out).length} 题`);
      return out;
    }
  } catch (e) {
    log(`⚠ bank.json 读取失败: ${e.message}`);
  }
  return {};
}
function saveLocalBank(bank, newList) {
  if (!newList || !newList.length) return 0;
  let added = 0;
  for (const item of newList) {
    if (!item || !item.q || !Array.isArray(item.answers) || !item.answers.length) continue;
    if (!bank[item.q]) { bank[item.q] = [...item.answers]; added++; }
  }
  if (added > 0) {
    fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 2));
    log(`题库: 新增 ${added} 题并写回 bank.json(现共 ${Object.keys(bank).length} 题)`);
  }
  return added;
}

log(`=== 启动: 账号=${USER} 类型=${MODE_LABEL[MODE] || MODE} 标签页=${TABS} 设备=${DEVICE_ID}/${DEVICES} ${SMOKE ? '(测试模式)' : ''} ===`);

try {
  const common = {
    examUser: USER,
    examPass: PASS,
    onLog: log,
  };
  if (MODE === 'exam' || MODE === 'combined') {
    const bank = loadLocalBank();
    if (MODE === 'combined') {
      log('阶段一: 刷学时...');
      const s = await runStudyTask({ ...common, tabs: TABS, deviceId: DEVICE_ID, devices: DEVICES, smoke: SMOKE });
      log(`阶段一完成: ${s.done}/${s.courses} 门`);
      log('阶段二: 自动答题(课后练习)...');
    }
    const r = await runCoursePracticeTask({
      ...common,
      bank,
      retryFull: true,
      onNewBank: (list) => saveLocalBank(bank, list),
    });
    log(`=== 自动答题完毕: 完成 ${r.done}/${r.total} 讲, 失败 ${r.failed}, ${r.rounds} 轮; 题目 ${r.questions}, 命中 ${r.hit}, 填写 ${r.filled} ===`);
    if (r.failed > 0) process.exitCode = 1;
  } else {
    const result = await runStudyTask({
      ...common,
      tabs: TABS,
      deviceId: DEVICE_ID,
      devices: DEVICES,
      smoke: SMOKE,
    });
    log(`=== 处理完毕: ${result.done}/${result.courses} 门完成 ===`);
  }
} catch (err) {
  log('错误: ' + (err.stack || err.message || err));
  process.exitCode = 1;
}
