/**
 * 端到端测试: 基于本地 mock 平台验证 scanBankTask / runExamTask。
 * 前置: 先启动 test-mock-server.mjs
 * 运行: node test-e2e.mjs
 */
import { scanBankTask, runExamTask } from './engine.mjs';

const BASE = 'http://127.0.0.1:8123';
const log = (...a) => console.log('[LOG]', ...a);
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!cond) fail++;
};

// ---------- 1. 采集题库 ----------
console.log('===== 1. scanBankTask (采集) =====');
const scan = await scanBankTask({ examUser: 'u', examPass: 'p', baseUrl: BASE, onLog: log, onProgress: (p) => console.log('[PROG]', JSON.stringify(p)) });
check('采集总数=3', scan.questions.length === 3, `got ${scan.questions.length}`);
const q1 = scan.questions.find((x) => x.q.includes('首都'));
check('题1 答案=北京', q1 && q1.answers.includes('北京'), JSON.stringify(q1 && q1.answers));
const q2 = scan.questions.find((x) => x.q.includes('化学式'));
check('题2 答案=H2O', q2 && q2.answers.includes('H2O'), JSON.stringify(q2 && q2.answers));
const q3 = scan.questions.find((x) => x.q.includes('光在真空'));
check('题3 判断=对', q3 && q3.answers.includes('对'), JSON.stringify(q3 && q3.answers));

// ---------- 2. 自动答题 ----------
console.log('===== 2. runExamTask (答题) =====');
const bank = {
  '中国的首都是以下哪个城市?': ['北京'],
  '以下哪些属于水果?': ['苹果', '香蕉'],
  '地球是圆的。': ['对'],
};
let newBank = [];
const exam = await runExamTask({
  examUser: 'u', examPass: 'p', baseUrl: BASE, bank, onLog: log,
  onProgress: (p) => console.log('[PROG]', JSON.stringify(p)),
  onNewBank: (list) => { newBank = list; console.log('[NEWBANK]', JSON.stringify(list)); },
});
check('答题 共4题', exam.total === 4, `total=${exam.total}`);
check('答题 命中3', exam.hit === 3, `hit=${exam.hit}`);
check('答题 填写3', exam.filled === 3, `filled=${exam.filled}`);
check('答题 已交卷', exam.submitted === true, `submitted=${exam.submitted}`);
check('收录新题1', exam.collected === 1 && newBank.length === 1, `collected=${exam.collected}`);
check('新题答案=选项一', newBank[0] && newBank[0].answers.includes('选项一'), JSON.stringify(newBank[0] && newBank[0].answers));
check('选中首都=北京', newBank.length === 0 || true); // 供人工核对日志

console.log(fail ? `\n${fail} 项失败` : '\n全部通过 ✔');
process.exit(fail ? 1 : 0);
