/**
 * 学时助手引擎 —— 单账号、多标签页、真实播放至学时达标。
 * 被 CLI(autoplay.mjs)与 Web 服务(server.mjs)复用。
 * 原则不变:不做伪造请求,视频真实播放,服务端记录真实时长。
 *
 * 提供三个任务:
 *   runStudyTask  刷课:逐门课程真实播放至学时达标
 *   scanBankTask  采集题库:从「题库练习」页自动解析题目与正确答案
 *   runExamTask   自动答题:进考试页 → 查题库填答案 → 交卷 → 收录新题
 */
import { chromium } from 'playwright';

const BASE = 'http://www.gaoxiaokaoshi.com';
const resolveBase = (opts) => String(opts.baseUrl || BASE).replace(/\/+$/, '');

const POLL_MS = 15000;      // 轮询间隔
const CHECK_EVERY = 5;      // 每 5 次轮询(≈75s)核对一次已完成学时
const STALL_MS = 45000;     // 计时停滞超过此毫秒数则重载重播
const EXTRA_MIN = 10;       // 单课超时保护:需求时长 + 10 分钟

// ---------- 公共:浏览器与登录 ----------

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    channel: 'chromium',
    args: [
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
}

/** 登录考试平台,返回已就绪的页面。失败抛错。带重试(站点登录偶发失败)。 */
async function login(context, { examUser, examPass, log = () => {}, base = BASE }) {
  const loginPage = await context.newPage();
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      log(`登录重试(${attempt}/3)...`);
      await loginPage.waitForTimeout(2000);
    }
    try {
      await loginPage.goto(base + '/Default.aspx', { waitUntil: 'domcontentloaded' });
      try { await loginPage.waitForURL(/Login\.aspx/, { timeout: 15000 }); } catch {}
      await loginPage.waitForTimeout(1200);
      await loginPage.fill('#name', examUser);
      await loginPage.fill('#pw', examPass);
      // 直接调用页面登录函数提交表单(headless 下 click 可能不触发导航)
      await loginPage
        .evaluate(() => {
          try { CkeckNotNull(); } catch (e) { document.getElementById('frmLogin').submit(); }
        })
        .catch(() => {});
      await loginPage.waitForTimeout(3000);
      const clerk = (await context.cookies()).find((c) => c.name === 'Clerk');
      if (clerk) { log('登录成功'); return loginPage; }
      lastErr = '未获得 Clerk cookie';
    } catch (e) {
      lastErr = String(e.message || e).split('\n')[0];
    }
  }
  throw new Error('登录失败:' + lastErr + '(考试平台账号或密码错误?)');
}

/** 页面内 fetch 直发(自带会话 Cookie),返回响应文本 */
async function fetchHtml(page, path, form) {
  return page.evaluate(
    ({ path, form }) => {
      const opts = { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } };
      if (form) {
        opts.method = 'POST';
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(form).toString();
      }
      return fetch(path, opts).then((r) => r.text());
    },
    { path, form }
  );
}

/** 题库练习页:解析当前页题目(题干 + 选项 + 正确答案) */
function parsePracticePageJs() {
  const out = { questions: [], hasNext: false };
  const dts = document.querySelectorAll('.exam_list dt');
  for (const dt of dts) {
    const text = (dt.textContent || '').trim();
    const m = text.match(/\d+\.?(.*)/);
    if (!m) continue;
    const q = m[1].replace(/\s+$/, '').trim();
    if (!q) continue;
    const next = dt.nextElementSibling;
    const choices = next ? [...next.querySelectorAll('div')].map((d) => {
      const cm = (d.textContent || '').match(/[A-Za-z]、(.*)/);
      return cm ? cm[1].trim() : (d.textContent || '').trim();
    }).filter(Boolean) : [];
    // 正确答案文本通常在题目行的后续兄弟元素里,如 "正确答案:ABC / 对 / 错"
    let answers = [];
    const answerEl = dt.parentElement.querySelector('.green') || (dt.nextElementSibling && dt.nextElementSibling.nextElementSibling);
    if (answerEl) {
      const at = (answerEl.textContent || '').trim();
      const am = at.match(/[：:]([A-Za-z对错正确错误]+)/);
      if (am) {
        const letters = am[1].toUpperCase();
        for (const c of letters) {
          if (c === '对' || c === '正确') { answers.push('对'); answers.push('正确'); }
          else if (c === '错' || c === '错误') { answers.push('错'); answers.push('错误'); }
          else {
            const idx = c.charCodeAt(0) - 65;
            if (idx >= 0 && idx < choices.length && choices[idx]) answers.push(choices[idx]);
          }
        }
      }
    }
    out.questions.push({ q, choices, answers });
  }
  const nextBtn = document.querySelector('#PageSplit1_BtnNext');
  out.hasNext = !!nextBtn && !nextBtn.disabled;
  return out;
}

/** 考试页/答卷页:题目容器选择器(helper 与多版脚本通用) */
function examQuestionSelectors() {
  return ['.exam_list dt', '.tb_content dt'];
}

/** 从题目行文本提取题干(与题库 key 同规则;题号支持 "1." 与 "1、" 两种) */
function extractQuestion(text) {
  const m = String(text || '').match(/\d+[\.、](.*)\(/);
  return m ? m[1].replace(/^\s+|\s+$/g, '') : '';
}

/**
 * 执行一次学习任务
 * @param {object} opts
 * @param {string} opts.examUser  考试平台账号
 * @param {string} opts.examPass  考试平台密码
 * @param {number} [opts.tabs=1]  标签页并发数
 * @param {number} [opts.deviceId=0] 多设备分片:本设备编号
 * @param {number} [opts.devices=1]  多设备分片:总设备数
 * @param {string} [opts.planFilter=''] 只处理指定学习计划(id),空则全部
 * @param {boolean} [opts.smoke=false] 测试模式:每门课最多播放 3 分钟
 * @param {(line:string)=>void} [opts.onLog] 日志回调
 * @param {(p:{course:string,doneMin:number,reqMin:number,phase:string})=>void} [opts.onProgress] 进度回调
 * @returns {Promise<{courses:number,done:number,failed:number}>}
 */
export async function runStudyTask(opts = {}) {
  const {
    examUser,
    examPass,
    tabs = 1,
    deviceId = 0,
    devices = 1,
    planFilter = '',
    smoke = false,
    onLog = () => {},
    onProgress = () => {},
  } = opts;

  const TOTAL_SLOTS = Math.max(1, (parseInt(devices, 10) || 1) * (parseInt(tabs, 10) || 1));
  const log = (...args) => onLog(args.join(' '));
  const base = resolveBase(opts);

  if (!examUser || !examPass) throw new Error('缺少考试平台账号/密码');

  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const loginPage = await login(context, { examUser, examPass, log, base });
    const tabPages = [loginPage];
    for (let i = 1; i < TOTAL_SLOTS; i++) tabPages.push(await context.newPage());

    // ---------- 列表操作(fetch 直发,不依赖页面导航) ----------

    async function parseListHtml(page, html) {
      return page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = [];
        for (const tr of doc.querySelectorAll('table.table tr')) {
          const a = tr.querySelector('a[onclick*="showframe"]');
          if (!a) continue;
          const m = (a.getAttribute('onclick') || '').match(/showframe\([^,]*,\s*(\d+)\)/);
          const e = tr.querySelector('a[onclick*="showExam"]');
          const em = e ? (e.getAttribute('onclick') || '').match(/showExam\((\d+)\)/) : null;
          const tds = tr.querySelectorAll('td');
          const num = (s) => parseInt(String(s || '').replace(/[^0-9]/g, '')) || 0;
          rows.push({
            name: (tds[0]?.textContent || '').trim(),
            cat: (tds[1]?.textContent || '').trim(),
            reqMin: num(tds[2]?.textContent),
            doneMin: num(tds[3]?.textContent),
            id: m ? m[1] : null,
            examId: em ? em[1] : null,
            status: (tds[4]?.textContent || '').trim(),
          });
        }
        const g = (name) => {
          const el = doc.getElementById(name);
          return el ? el.value : '';
        };
        const plans = [...doc.querySelectorAll('#ddlClass option')].map((o) => ({
          id: o.value,
          name: o.textContent.trim(),
        }));
        const nextBtn = doc.getElementById('PageSplit1_BtnNext');
        return {
          rows,
          plans,
          hasNext: !!nextBtn && !nextBtn.hasAttribute('disabled'),
          viewstate: g('__VIEWSTATE'),
          viewstateGen: g('__VIEWSTATEGENERATOR'),
          eventValidation: g('__EVENTVALIDATION'),
          isLoginPage: !doc.getElementById('ddlClass'),
        };
      }, html);
    }

    function postbackForm(state, eventTarget, extra) {
      return {
        __EVENTTARGET: eventTarget,
        __EVENTARGUMENT: '',
        __LASTFOCUS: '',
        __VIEWSTATE: state.viewstate,
        __VIEWSTATEGENERATOR: state.viewstateGen,
        __EVENTVALIDATION: state.eventValidation,
        ...extra,
      };
    }

    async function scrapeCourses() {
      log('抓取课程列表...');
      const pg = tabPages[0];
      let html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx');
      let state = await parseListHtml(pg, html);
      if (state.isLoginPage) throw new Error('会话失效:列表页返回登录页');

      const courses = [];
      const seenIds = new Set();
      let planCount = 0;
      for (const plan of state.plans) {
        if (planFilter && String(plan.id) !== String(planFilter)) continue;
        planCount++;
        log(`  学习计划: ${plan.name} (id=${plan.id})`);
        let form = postbackForm(state, '', { ddlClass: plan.id, txtName: '', btnSearch: '搜 索' });
        html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx', form);
        state = await parseListHtml(pg, html);
        let pageNo = 1;
        let guard = 0;
        while (guard++ < 30) {
          for (const r of state.rows) {
            r.planId = plan.id;
            r.planName = plan.name;
            r.page = pageNo;
            if (r.id && seenIds.has(r.id)) continue;
            if (r.id) seenIds.add(r.id);
            courses.push(r);
          }
          if (!state.hasNext) break;
          pageNo++;
          form = postbackForm(state, 'PageSplit1$BtnNext', { ddlClass: plan.id, txtName: '' });
          html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx', form);
          state = await parseListHtml(pg, html);
          if (state.isLoginPage) throw new Error('会话失效:翻页返回登录页');
        }
      }
      if (planCount === 0) throw new Error('未找到匹配的学习计划');
      return courses;
    }

    // ---------- 进度核对(fetch 直发) ----------
    async function currentDoneMin(tag, course) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const done = await currentDoneMinOnce(tag, course);
          if (done >= 0) return done;
        } catch (e) {
          log(tag, `  ⚠ 进度核对出错(第${attempt + 1}次): ${String(e.message || e).split('\n')[0]}`);
        }
      }
      return -1;
    }

    async function currentDoneMinOnce(tag, course) {
      const courseId = course.id;
      const pg = tabPages[0];
      let html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx');
      let state = await parseListHtml(pg, html);
      if (state.isLoginPage) {
        log(tag, '  ⚠ 会话失效,重新登录...');
        await loginPage.goto(base + '/Default.aspx', { waitUntil: 'domcontentloaded' });
        try { await loginPage.waitForURL(/Login\.aspx/, { timeout: 15000 }); } catch {}
        await loginPage.fill('#name', examUser);
        await loginPage.fill('#pw', examPass);
        await Promise.all([
          loginPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          loginPage.click('#btnSubmit'),
        ]);
        html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx');
        state = await parseListHtml(pg, html);
        if (state.isLoginPage) return -1;
      }
      for (const planId of state.plans.map((p) => p.id)) {
        let form = postbackForm(state, '', { ddlClass: planId, txtName: '', btnSearch: '搜 索' });
        if (course.planId === planId && course.page && course.page > 1) {
          form = postbackForm(state, 'PageSplit1$ddlPage', {
            ddlClass: planId, txtName: '', 'PageSplit1$ddlPage': String(course.page),
          });
        }
        html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx', form);
        state = await parseListHtml(pg, html);
        if (state.isLoginPage) return -1;
        let guard = 0;
        while (guard++ < 20) {
          const hit = state.rows.find((r) => r.id === String(courseId));
          if (hit) return hit.doneMin;
          if (!state.hasNext) break;
          form = postbackForm(state, 'PageSplit1$BtnNext', { ddlClass: planId, txtName: '' });
          html = await fetchHtml(pg, '/Study/LibraryStudyList.aspx', form);
          state = await parseListHtml(pg, html);
          if (state.isLoginPage) return -1;
        }
      }
      return -1;
    }

    // ---------- 播放器容错 ----------
    async function clickRetryIfNeeded(tag, page) {
      const info = await page
        .evaluate(() => {
          const v = document.querySelector('video');
          const paused = v ? v.paused : true;
          let ct = -1;
          try { ct = player.getCurrentTime(); } catch (e) {}
          let clicked = false;
          if (paused || ct < 0) {
            for (const el of [...document.querySelectorAll('div, span, a, button')]) {
              if (el.textContent.includes('重试') && el.children.length === 0) {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') {
                  el.click();
                  clicked = true;
                  break;
                }
              }
            }
            if (!clicked) {
              const p = document.querySelector('.prism-player');
              if (p) { p.click(); clicked = true; }
            }
          }
          return { clicked, paused, ct: Math.round(ct) };
        })
        .catch(() => ({ clicked: false, paused: true, ct: -1 }));
      if (info.clicked) {
        log(tag, `  ↻ 点击"重试"(视频未在播放, paused=${info.paused})`);
        await page.evaluate(() => { try { player.play(); } catch (e) {} }).catch(() => {});
      }
      return info.clicked;
    }

    async function openAndPlay(tag, page, url) {
      // 平台偶发 4xx/5xx/网络抖动:最多重试 3 次,每次间隔递增
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const brief = String(e.message || e).split('\n')[0];
          if (attempt < 3) {
            log(tag, `  ⚠ 打开播放页失败(${brief}),${attempt}/3 重试...`);
            await page.waitForTimeout(2000 * attempt);
          }
        }
      }
      if (lastErr) throw lastErr;
      await page
        .waitForFunction(() => typeof window.player !== 'undefined', { timeout: 30000 })
        .catch(() => log(tag, '  ⚠ 播放器未在 30s 内就绪,继续尝试'));
      await page.click('.prism-player').catch(() => {});
      await page.evaluate(() => { try { player.play(); } catch (e) {} }).catch(() => {});
      await page.waitForTimeout(5000);
      await clickRetryIfNeeded(tag, page);
      log(tag, `  播放页已打开并触发播放 (${url})`);
    }

    // ---------- 单门课程 ----------
    async function studyCourse(tag, page, course) {
      const need = course.reqMin - course.doneMin;
      log(tag, `▶ 开始: ${course.name}  [已完成 ${course.doneMin}/${course.reqMin} 分钟, 还需 ${need} 分钟]`);
      onProgress({ course: course.name, doneMin: course.doneMin, reqMin: course.reqMin, phase: 'start' });
      const url = `${base}/Study/LibraryStudy.aspx?Id=${course.id}&PlanId=${course.planId}`;
      const startAt = Date.now();
      const deadline = startAt + (need + EXTRA_MIN) * 60 * 1000;
      let checkCount = 0;
      let lastM = -1, lastTick = Date.now();

      await openAndPlay(tag, page, url);

      while (Date.now() < deadline) {
        await page.waitForTimeout(POLL_MS);

        if (smoke && Date.now() - startAt > 3 * 60 * 1000) {
          log(tag, '  [测试模式] 3 分钟到,停止本课');
          return false;
        }

        const st = await page
          .evaluate(() => {
            let m = -1, ct = -1;
            try { m = window.m_time ?? -1; } catch {}
            try { ct = player.getCurrentTime() ?? -1; } catch {}
            return { m, ct };
          })
          .catch(() => ({ m: -1, ct: -1 }));

        if (st.m !== lastM) { lastM = st.m; lastTick = Date.now(); }

        await clickRetryIfNeeded(tag, page);

        if (Date.now() - lastTick > STALL_MS) {
          log(tag, `  计时停滞(m_time=${st.m}s),尝试恢复播放`);
          const retried = await clickRetryIfNeeded(tag, page);
          if (!retried) {
            log(tag, '  无重试按钮,重载播放页');
            await page
              .evaluate(() => {
                try { delCookie(document.getElementById('hidRefId').value); } catch (e) {}
              })
              .catch(() => {});
            await openAndPlay(tag, page, url);
          }
          lastM = -1;
          lastTick = Date.now();
        }

        checkCount++;
        if (checkCount >= CHECK_EVERY) {
          checkCount = 0;
          const done = await currentDoneMin(tag, course);
          if (done >= 0) {
            course.doneMin = done;
            log(tag, `  ✓ 进度核对: 已完成 ${done}/${course.reqMin} 分钟`);
            onProgress({ course: course.name, doneMin: done, reqMin: course.reqMin, phase: 'check' });
            if (done >= course.reqMin) {
              log(tag, `✔ 完成: ${course.name}`);
              onProgress({ course: course.name, doneMin: done, reqMin: course.reqMin, phase: 'done' });
              return true;
            }
          } else {
            log(tag, '  ⚠ 列表未找到该课程记录(可能需重新登录)');
          }
        }
      }
      log(tag, `⏱ 超时未达标: ${course.name} (可重跑)`);
      return false;
    }

    // ---------- 各标签页分配课程并开跑 ----------
    async function runTabCourses(tabIndex, courses) {
      const tag = `T${tabIndex}/${TOTAL_SLOTS}`;
      const page = tabPages[tabIndex];
      const slot = (parseInt(deviceId, 10) || 0) * (parseInt(tabs, 10) || 1) + tabIndex;

      const todoAll = courses.filter((c) => c.id && c.doneMin < c.reqMin);
      const mine = todoAll.filter((c) => parseInt(c.id, 10) % TOTAL_SLOTS === slot);
      const totalNeed = mine.reduce((s, c) => s + (c.reqMin - c.doneMin), 0);
      log(tag, `待学 ${todoAll.length} 门; 本标签页分到 ${mine.length} 门`);
      if (mine.length > 0) {
        log(tag, `预计还需学习约 ${totalNeed} 分钟 ≈ ${(totalNeed / 60).toFixed(1)} 小时(真实时间)`);
      } else {
        log(tag, '本标签页没有待学课程。');
      }
      let doneCount = 0;
      for (const c of mine) {
        try {
          const ok = await studyCourse(tag, page, c);
          if (ok) doneCount++;
        } catch (e) {
          const brief = String(e.message || e).split('\n')[0];
          log(tag, `✗ 课程失败: ${c.name} (${brief}),跳过继续下一门`);
          onProgress({ course: c.name, doneMin: c.doneMin, reqMin: c.reqMin, phase: 'fail' });
        }
        if (smoke) break;
      }
      log(tag, '=== 本标签页处理完毕 ===');
      return doneCount;
    }

    // ---------- 主流程 ----------
    log(`=== 任务启动: 账号=${examUser} 标签页=${TOTAL_SLOTS} ${smoke ? '(测试模式)' : ''} ===`);
    const courses = await scrapeCourses();
    log(`共 ${courses.length} 门课程`);

    let doneTotal = 0;
    const runners = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      runners.push(runTabCourses(i, courses).then((n) => { doneTotal += n; }));
    }
    await Promise.all(runners);
    log(`=== 任务处理完毕: 完成 ${doneTotal}/${courses.length} 门 ===`);
    return { courses: courses.length, done: doneTotal, failed: courses.length - doneTotal };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ============================================================================
// 任务二:采集题库 —— 从「题库练习」页自动解析题目与正确答案
// ============================================================================

/**
 * @param {object} opts
 * @param {string} opts.examUser / opts.examPass  考试平台账号/密码
 * @param {(line:string)=>void} [opts.onLog] 日志回调
 * @param {(p:{page:number,got:number,total:number})=>void} [opts.onProgress] 进度回调
 * @returns {Promise<{questions:Array<{q:string,choices:string[],answers:string[]}>, pages:number}>}
 */
export async function scanBankTask(opts = {}) {
  const { examUser, examPass, onLog = () => {}, onProgress = () => {} } = opts;
  const log = (...args) => onLog(args.join(' '));
  const base = resolveBase(opts);
  if (!examUser || !examPass) throw new Error('缺少考试平台账号/密码');

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await login(context, { examUser, examPass, log, base });

    log('打开题库练习页...');
    await page.goto(base + '/ExamList/TkTest.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // 可选分类
    const tklx = await page.$$eval('#ddlTklx option', (os) =>
      os.map((o) => ({ v: o.value, t: o.textContent.trim() })).filter((o) => o.v && o.v !== '0&0' && o.t !== '请选择题库')
    );
    if (!tklx.length) {
      throw new Error('题库练习页没有可选题库分类(该账号可能未开通题库练习,或需先在学校后台配置)');
    }
    log(`题库分类: ${tklx.map((x) => x.t).join(' / ')}`);

    const collected = [];
    let pages = 0;

    for (const cat of tklx) {
      log(`开始采集分类「${cat.t}」...`);
      await page.selectOption('#ddlTklx', cat.v);
      await page.waitForTimeout(800);
      // 搜索按钮触发 postback
      await page.click('#btnSearch').catch(() => {});
      await page.waitForTimeout(2500);

      // 若页面出现"无数据/请先搜索"等提示则跳过
      const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      if (/请选择|无数据|没有找到|暂无/.test(bodyText) && !bodyText.includes('正确答案')) {
        log(`  「${cat.t}」无题目数据,跳过`);
        continue;
      }

      let guard = 0;
      while (guard++ < 300) {
        const data = await page.evaluate(parsePracticePageJs);
        if (data.questions.length) {
          for (const q of data.questions) {
            if (!collected.some((c) => c.q === q.q)) collected.push({ ...q, cat: cat.t });
          }
        }
        pages++;
        onProgress({ page: pages, got: data.questions.length, total: collected.length });
        log(`  第 ${pages} 页: 解析 ${data.questions.length} 题, 累计 ${collected.length} 题`);
        if (!data.hasNext) break;
        // 下一页(postback)
        const html = await fetchHtml(page, '/ExamList/TkTest.aspx', {
          __EVENTTARGET: 'PageSplit1$BtnNext',
          __EVENTARGUMENT: '',
          __VIEWSTATE: await page.evaluate(() => { const e = document.getElementById('__VIEWSTATE'); return e ? e.value : ''; }),
          __VIEWSTATEGENERATOR: await page.evaluate(() => { const e = document.getElementById('__VIEWSTATEGENERATOR'); return e ? e.value : ''; }),
          __EVENTVALIDATION: await page.evaluate(() => { const e = document.getElementById('__EVENTVALIDATION'); return e ? e.value : ''; }),
        });
        await page.setContent(html);
        await page.waitForTimeout(1200);
      }
      log(`分类「${cat.t}」采集完成`);
    }

    log(`=== 采集完成: 共 ${collected.length} 题, 翻页 ${pages} 次 ===`);
    return { questions: collected, pages };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ============================================================================
// 任务三:自动答题 —— 进考试页 → 查题库填答案 → 交卷 → 收录新题
// ============================================================================

/**
 * @param {object} opts
 * @param {string} opts.examUser / opts.examPass  考试平台账号/密码
 * @param {string} [opts.examFilter=''] 考试名称关键字,空则取第一场可参加的考试
 * @param {Object} [opts.bank={}] 题库 {题干: [答案文本...]}
 * @param {(line:string)=>void} [opts.onLog] 日志回调
 * @param {(p:{phase:string,msg:string})=>void} [opts.onProgress] 进度回调
 * @param {(newQuestions:Array<{q:string,answers:string[]}>)=>void} [opts.onNewBank] 答卷页收录的新题回调
 * @returns {Promise<{exam:string,total:number,hit:number,filled:number,collected:number,submitted:boolean}>}
 */
export async function runExamTask(opts = {}) {
  const { examUser, examPass, examFilter = '', bank = {}, onLog = () => {}, onProgress = () => {}, onNewBank = () => {} } = opts;
  const log = (...args) => onLog(args.join(' '));
  const progress = (phase, msg) => onProgress({ phase, msg });
  const base = resolveBase(opts);
  if (!examUser || !examPass) throw new Error('缺少考试平台账号/密码');

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));
    const page = await login(context, { examUser, examPass, log, base });

    // ---------- 考试列表 ----------
    progress('list', '打开考试列表...');
    await page.goto(base + '/ExamList/ExamList.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const exams = await page.evaluate(() => {
      const rows = [];
      for (const tr of document.querySelectorAll('table tr')) {
        const tds = [...tr.querySelectorAll('td')];
        const texts = tds.map((td) => (td.textContent || '').trim());
        const joined = texts.join(' ');
        if (joined.length < 5 || !tds.length) continue;
        const anchor = tr.querySelector('a');
        rows.push({
          name: texts[0] || '',
          time: texts[1] || '',
          duration: texts[2] || '',
          times: texts[3] || '',
          actionText: texts[texts.length - 1] || '',
          href: anchor ? anchor.href : '',
          onclick: anchor ? (anchor.getAttribute('onclick') || '') : '',
        });
      }
      return rows;
    });
    // 过滤表头/无操作行
    const usable = exams.filter(
      (e) =>
        e.name &&
        e.name !== '考试名称' &&
        !e.time.startsWith('考试起止') &&
        !/^考试/.test(e.name) &&
        e.actionText !== '' &&
        e.actionText !== e.name
    );
    if (!usable.length) {
      throw new Error(`当前没有可参加的考试${exams.length ? `(列表 ${exams.length} 行,可能已考完或不在考试时段)` : '(考试列表为空)'}`);
    }
    const target = examFilter
      ? usable.find((e) => e.name.includes(examFilter)) || usable[0]
      : usable[0];
    log(`目标考试: ${target.name}  (时间: ${target.time} 时长: ${target.duration} 次数: ${target.times})`);
    progress('enter', `进入考试: ${target.name}`);

    // ---------- 进入答题页(可能开新窗口) ----------
    const popupResult = await Promise.race([
      context.waitForEvent('page', { timeout: 12000 }).then((p) => p).catch(() => null),
      new Promise((resolve) => {
        (async () => {
          await page
            .evaluate((name) => {
              for (const tr of document.querySelectorAll('table tr')) {
                const tds = [...tr.querySelectorAll('td')];
                const first = tds[0] ? (tds[0].textContent || '').trim() : '';
                if (first && (first === name || first.includes(name))) {
                  const el = tr.querySelector('a, input[type=button], button');
                  if (el) { el.click(); return true; }
                }
              }
              return false;
            }, target.name)
            .catch(() => {});
          resolve(null);
        })();
      }),
    ]);
    const examPage = popupResult || page;
    await examPage.waitForLoadState('domcontentloaded').catch(() => {});
    await examPage.waitForTimeout(3000);

    // 答题页可能含 iframe(顶部框架),找实际内容 frame
    async function activeFrame() {
      for (const f of examPage.frames()) {
        const has = await f.evaluate(() => !!document.querySelector('.exam_list, .tb_content, #btnSubmitExam, input[value*="交卷"], a[href*="SubmitExam"]')).catch(() => false);
        if (has) return f;
      }
      return examPage.mainFrame();
    }

    const frame = await activeFrame();
    log(`答题页就绪 (frame=${frame !== examPage.mainFrame() ? 'iframe' : '主窗口'})`);

    // ---------- 读题并填答案 ----------
    const qData = await frame.evaluate((selectors) => {
      const doc = document;
      let dts = [];
      for (const sel of selectors) {
        dts = [...doc.querySelectorAll(sel)];
        if (dts.length) break;
      }
      const list = [];
      dts.forEach((dt, i) => {
        const text = (dt.textContent || '').trim();
        const m = text.match(/\d+[\.、](.*)\(/);
        const q = m ? m[1].replace(/^\s+|\s+$/g, '') : '';
        const inputs = [...doc.querySelectorAll(`input[id^="tm_${i + 1}_"]`)];
        const labels = inputs
          .map((inp) => {
            const lb = doc.querySelector(`label[for="${inp.id}"]`);
            return lb ? { id: inp.id, text: (lb.textContent || '').replace(/^[A-Za-z][、.．]\s*/, '').trim() } : null;
          })
          .filter(Boolean);
        list.push({ q, labels, inputIds: inputs.map((i) => i.id) });
      });
      return list;
    }, examQuestionSelectors());

    const total = qData.length;
    let hit = 0, filled = 0;
    log(`共 ${total} 题,开始查题库填写...`);
    progress('answering', `共 ${total} 题`);

    for (let i = 0; i < qData.length; i++) {
      const item = qData[i];
      const q = item.q;
      if (!q) { log(`第 ${i + 1} 题: 题干解析失败,跳过`); continue; }
      const ans = bank[q];
      if (!ans || !ans.length) { log(`第 ${i + 1} 题: 题库未命中`); continue; }
      hit++;
      let clicked = false;
      for (const a of ans) {
        for (const lb of item.labels) {
          const t = lb.text;
          const match =
            t === a ||
            ((a === '对' || a === '正确') && /对|正确/.test(t)) ||
            ((a === '错' || a === '错误') && /错|错误/.test(t));
          if (match) {
            try { await frame.click(`label[for="${lb.id}"]`, { timeout: 5000 }); clicked = true; } catch {}
          }
        }
      }
      if (clicked) filled++;
      log(`第 ${i + 1} 题: ${hit ? '命中' : '未命中'} (已填 ${filled})`);
    }
    progress('filled', `已填写 ${filled}/${total} 题`);

    // ---------- 交卷 ----------
    const submitted = await frame.evaluate(() => {
      if (typeof window.SubmitExam === 'function') { window.SubmitExam(); return true; }
      const a = document.querySelector('a[href*="SubmitExam"]');
      if (a) { a.click(); return true; }
      const btn = [...document.querySelectorAll('input,button,a')].find((el) => /交卷|提交/.test((el.value || el.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    log(submitted ? '已触发交卷' : '⚠ 未找到交卷按钮,跳过交卷(可能需手动处理)');
    await examPage.waitForTimeout(3000);

    // ---------- 答卷页收录新题 ----------
    let collected = 0;
    const newQuestions = [];
    if (submitted) {
      progress('view', '等待答卷页,收录正确答案...');
      await examPage.waitForTimeout(2500);
      const viewData = await examPage.evaluate(() => {
        const out = [];
        const ddtms = [...document.querySelectorAll('div[id^=ddTm_]')];
        ddtms.forEach((div, i) => {
          const dt = div.querySelector('dt');
          if (!dt) return;
          const text = (dt.textContent || '').trim();
          const m = text.match(/\d[\.、](.*)\(/);
          if (!m) return;
          const q = m[1].replace(/^\s+|\s+$/g, '');
          const green = [...div.querySelectorAll('.green')].pop();
          const gt = green ? (green.textContent || '').trim() : '';
          const answers = [];
          for (const c of gt) {
            if (c === '对') { answers.push('对'); answers.push('正确'); }
            else if (c === '错') { answers.push('错'); answers.push('错误'); }
            else if (c >= 'A' && c <= 'H') {
              const idx = c.charCodeAt(0) - 65;
              const lb = document.querySelector(`label[for="tm_${i + 1}_${idx}"]`);
              if (lb) answers.push((lb.textContent || '').replace(/^[A-Za-z][、.．]\s*/, '').trim());
            }
          }
          if (answers.length) out.push({ q, answers });
        });
        return out;
      }).catch(() => []);
      for (const v of viewData) {
        if (!bank[v.q]) { newQuestions.push(v); collected++; }
      }
      if (collected) {
        onNewBank(newQuestions);
        log(`答卷页收录新题 ${collected} 道`);
      } else {
        log('答卷页无新题(可能全部已在题库,或答卷页未就绪)');
      }
    }

    log(`=== 答题完成: 共 ${total} 题, 命中 ${hit}, 填写 ${filled}, 新收录 ${collected}, 已交卷 ${submitted ? '是' : '否'} ===`);
    return { exam: target.name, total, hit, filled, collected, submitted };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ============================================================================
// 任务四:课后练习(自动答题)—— 遍历每讲参加练习并答题交卷,错题自动重考
// ============================================================================

/** 课程名转成绩页键名:"1.1 国防概述" -> "1.01" */
function courseToScoreKey(name) {
  const m = String(name || '').match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.0${m[2]}` : String(name || '');
}

/**
 * @param {object} opts
 * @param {string} opts.examUser / opts.examPass  考试平台账号/密码
 * @param {Object} [opts.bank={}] 题库 {题干: [答案文本...]}
 * @param {string} [opts.planFilter=''] 只处理指定学习计划(id),空则全部
 * @param {string} [opts.courseFilter=''] 课程名关键字,空则全部
 * @param {number} [opts.maxCourses=0] 最多处理几门(0=不限)
 * @param {boolean} [opts.retryFull=true] 错题自动重考(查成绩,未满分重考)
 * @param {number} [opts.maxRounds=3] 最大轮次
 * @param {(line:string)=>void} [opts.onLog] 日志回调
 * @param {(p:{course:string,phase:string,msg:string})=>void} [opts.onProgress] 进度回调
 * @param {(newQuestions:Array<{q:string,answers:string[]}>)=>void} [opts.onNewBank] 收录的新题回调
 * @returns {Promise<{total:number,done:number,failed:number,rounds:number,questions:number,hit:number,filled:number,collected:number}>}
 */
export async function runCoursePracticeTask(opts = {}) {
  const { examUser, examPass, bank = {}, planFilter = '', courseFilter = '', maxCourses = 0, retryFull = true, maxRounds = 3, onLog = () => {}, onProgress = () => {}, onNewBank = () => {} } = opts;
  const log = (...args) => onLog(args.join(' '));
  const base = resolveBase(opts);
  if (!examUser || !examPass) throw new Error('缺少考试平台账号/密码');

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));
    const page = await login(context, { examUser, examPass, log, base });

    // ---------- 抓课程列表(全部页,含练习 ID) ----------
    async function listCourses() {
      const out = [];
      let html = await fetchHtml(page, '/Study/LibraryStudyList.aspx');
      let state = await page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = [];
        for (const tr of doc.querySelectorAll('table.table tr')) {
          const a = tr.querySelector('a[onclick*="showframe"]');
          if (!a) continue;
          const m = (a.getAttribute('onclick') || '').match(/showframe\([^,]*,\s*(\d+)\)/);
          const e = tr.querySelector('a[onclick*="showExam"]');
          const em = e ? (e.getAttribute('onclick') || '').match(/showExam\((\d+)\)/) : null;
          const tds = tr.querySelectorAll('td');
          rows.push({
            name: (tds[0]?.textContent || '').trim(),
            planId: (() => { const o = doc.getElementById('ddlClass'); return o ? o.value : ''; })(),
            id: m ? m[1] : null,
            examId: em ? em[1] : null,
          });
        }
        const nextBtn = doc.getElementById('PageSplit1_BtnNext');
        const g = (id) => { const el = doc.getElementById(id); return el ? el.value : ''; };
        return {
          rows,
          hasNext: !!nextBtn && !nextBtn.hasAttribute('disabled'),
          plans: [...doc.querySelectorAll('#ddlClass option')].map((o) => ({ id: o.value, name: o.textContent.trim() })),
          vs: g('__VIEWSTATE'), vsg: g('__VIEWSTATEGENERATOR'), ev: g('__EVENTVALIDATION'),
          isLoginPage: !doc.getElementById('ddlClass'),
        };
      }, html);
      if (state.isLoginPage) throw new Error('会话失效:课程列表返回登录页');

      for (const plan of state.plans) {
        if (planFilter && String(plan.id) !== String(planFilter)) continue;
        let form = {
          __EVENTTARGET: '', __EVENTARGUMENT: '', __LASTFOCUS: '',
          __VIEWSTATE: state.vs, __VIEWSTATEGENERATOR: state.vsg, __EVENTVALIDATION: state.ev,
          ddlClass: plan.id, txtName: '', btnSearch: '搜 索',
        };
        html = await fetchHtml(page, '/Study/LibraryStudyList.aspx', form);
        state = await page.evaluate((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const rows = [];
          for (const tr of doc.querySelectorAll('table.table tr')) {
            const a = tr.querySelector('a[onclick*="showframe"]');
            if (!a) continue;
            const m = (a.getAttribute('onclick') || '').match(/showframe\([^,]*,\s*(\d+)\)/);
            const e = tr.querySelector('a[onclick*="showExam"]');
            const em = e ? (e.getAttribute('onclick') || '').match(/showExam\((\d+)\)/) : null;
            const tds = tr.querySelectorAll('td');
            rows.push({
              name: (tds[0]?.textContent || '').trim(),
              planId: (() => { const o = doc.getElementById('ddlClass'); return o ? o.value : ''; })(),
              id: m ? m[1] : null,
              examId: em ? em[1] : null,
            });
          }
          const nextBtn = doc.getElementById('PageSplit1_BtnNext');
          const g = (id) => { const el = doc.getElementById(id); return el ? el.value : ''; };
          return {
            rows,
            hasNext: !!nextBtn && !nextBtn.hasAttribute('disabled'),
            vs: g('__VIEWSTATE'), vsg: g('__VIEWSTATEGENERATOR'), ev: g('__EVENTVALIDATION'),
            isLoginPage: !doc.getElementById('ddlClass'),
          };
        }, html);
        let guard = 0;
        while (guard++ < 50) {
          for (const r of state.rows) {
            if (r.examId && !out.some((x) => x.name === r.name)) out.push(r);
          }
          if (!state.hasNext) break;
          form = {
            __EVENTTARGET: 'PageSplit1$BtnNext', __EVENTARGUMENT: '', __LASTFOCUS: '',
            __VIEWSTATE: state.vs, __VIEWSTATEGENERATOR: state.vsg, __EVENTVALIDATION: state.ev,
            ddlClass: plan.id, txtName: '',
          };
          html = await fetchHtml(page, '/Study/LibraryStudyList.aspx', form);
          state = await page.evaluate((html) => {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const rows = [];
            for (const tr of doc.querySelectorAll('table.table tr')) {
              const a = tr.querySelector('a[onclick*="showframe"]');
              if (!a) continue;
              const m = (a.getAttribute('onclick') || '').match(/showframe\([^,]*,\s*(\d+)\)/);
              const e = tr.querySelector('a[onclick*="showExam"]');
              const em = e ? (e.getAttribute('onclick') || '').match(/showExam\((\d+)\)/) : null;
              const tds = tr.querySelectorAll('td');
              rows.push({
                name: (tds[0]?.textContent || '').trim(),
                planId: (() => { const o = doc.getElementById('ddlClass'); return o ? o.value : ''; })(),
                id: m ? m[1] : null,
                examId: em ? em[1] : null,
              });
            }
            const nextBtn = doc.getElementById('PageSplit1_BtnNext');
            const g = (id) => { const el = doc.getElementById(id); return el ? el.value : ''; };
            return {
              rows,
              hasNext: !!nextBtn && !nextBtn.hasAttribute('disabled'),
              vs: g('__VIEWSTATE'), vsg: g('__VIEWSTATEGENERATOR'), ev: g('__EVENTVALIDATION'),
              isLoginPage: !doc.getElementById('ddlClass'),
            };
          }, html);
        }
      }
      return out;
    }

    // ---------- 查询课后练习成绩(MyCj 课后练习分类,全量翻页) ----------
    async function fetchPracticeScores() {
      const scores = {};
      await page.goto(base + '/ExamList/MyCj.aspx', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.selectOption('#ddlCertificateId', '1').catch(() => {});
      await page.click('#btnSearch').catch(() => {});
      await page.waitForTimeout(2500);
      for (let guard = 0; guard < 12; guard++) {
        const rows = await page
          .evaluate(() => {
            const out = [];
            for (const tr of document.querySelectorAll('table tr')) {
              const tds = [...tr.querySelectorAll('td')];
              const nm = (tds[0]?.textContent || '').trim();
              if (tds.length >= 4 && nm && nm !== '考试名称') {
                const score = parseInt(String(tds[2]?.textContent || '').replace(/[^0-9]/g, ''), 10);
                out.push({ name: nm.replace(/[（(]新[)）]/g, '').trim(), score: isNaN(score) ? -1 : score });
              }
            }
            return out;
          })
          .catch(() => []);
        for (const r of rows) if (!(r.name in scores)) scores[r.name] = r.score;
        const hasNext = await page
          .evaluate(() => {
            const next = [...document.querySelectorAll('a')].find((a) => (a.textContent || '').trim() === '下一页');
            if (next && !next.hasAttribute('disabled')) { next.click(); return true; }
            return false;
          })
          .catch(() => false);
        if (!hasNext) break;
        await page.waitForTimeout(1200);
      }
      return scores;
    }

    // ---------- 单讲答题并交卷 ----------
    async function practiceOne(c, tag) {
      const examMainUrl = await page.evaluate(async (examId) => {
        const r = await fetch(`/ExamList/chkExam.aspx?ExamID=${examId}&SiteType=2&IsContinue=0`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const text = await r.text();
        if (r.url.includes('chkExam')) {
          const m = text.match(/alert\([^)]*\)/);
          return { url: '', msg: m ? m[0] : text.replace(/\s+/g, ' ').slice(0, 80) };
        }
        return { url: r.url, msg: '' };
      }, c.examId);
      if (!examMainUrl.url) return { ok: false, answered: 0, hit: 0, filled: 0, reason: '启动失败:' + examMainUrl.msg };
      await page.goto(examMainUrl.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);

      const mainFrame = page.frames().find((f) => /ExamDo\.aspx|ExamTmStepDo\.aspx/.test(f.url()));
      const headerFrame = page.frames().find((f) => /ExamHeader\.aspx|ExamTmStepHeader\.aspx/.test(f.url()));
      if (!mainFrame) return { ok: false, answered: 0, hit: 0, filled: 0, reason: '未找到答题 frame' };

      let hit = 0, filled = 0;
      const answered = new Set();
      for (let step = 0; step < 60; step++) {
        const pageData = await mainFrame
          .evaluate(() => {
            const dts = [...document.querySelectorAll('.exam_list dt, .tb_content dt')].filter((d) => d.offsetParent !== null);
            const nextBtn = document.querySelector('input[value="下一题"]') || document.querySelector('.btn_4');
            const list = [];
            for (const dt of dts) {
              const text = (dt.textContent || '').replace(/\s+/g, ' ').trim();
              const m = text.match(/\d+[\.、](.*)\(/);
              if (!m) continue;
              const q = m[1].replace(/^\s+|\s+$/g, '');
              const scope = dt.nextElementSibling || dt.parentElement || document;
              const labels = [...scope.querySelectorAll('label[for^="tm_"]')]
                .map((lb) => ({
                  id: lb.getAttribute('for'),
                  text: (lb.textContent || '').replace(/^[A-Za-z][、.．]\s*/, '').trim(),
                }))
                .filter((x) => x.id && x.text);
              list.push({ q, labels });
            }
            return { list, hasNext: !!nextBtn && !nextBtn.disabled };
          })
          .catch(() => ({ list: [], hasNext: false }));
        if (!pageData.list.length) break;
        for (const item of pageData.list) {
          if (answered.has(item.q)) continue;
          answered.add(item.q);
          const ans = bank[item.q];
          if (!ans || !ans.length) continue;
          hit++;
          let clickedOne = false;
          for (const a of ans) {
            if (clickedOne) break;
            for (const lb of item.labels) {
              const t = lb.text;
              const match =
                t === a ||
                ((a === '对' || a === '正确') && /对|正确/.test(t)) ||
                ((a === '错' || a === '错误') && /错|错误/.test(t));
              if (match) {
                try { await mainFrame.click(`label[for="${lb.id}"]`, { timeout: 4000 }); filled++; } catch {}
                clickedOne = true;
                break;
              }
            }
          }
        }
        if (!pageData.hasNext) break;
        await mainFrame
          .evaluate(() => {
            const b = document.querySelector('input[value="下一题"]') || document.querySelector('.btn_4');
            if (b && !b.disabled) b.click();
          })
          .catch(() => {});
        await page.waitForTimeout(1200);
      }

      let submitted = false;
      if (headerFrame) {
        submitted = await headerFrame
          .evaluate(() => {
            if (typeof window.SubmitExam === 'function') { window.SubmitExam(); return true; }
            const a = document.querySelector('a[href*="SubmitExam"]');
            if (a) { a.click(); return true; }
            return false;
          })
          .catch(() => false);
      }
      await page.waitForTimeout(3000);
      return { ok: submitted, answered: answered.size, hit, filled, reason: submitted ? '' : '未找到交卷按钮' };
    }

    // ---------- 主流程(多轮,错题自动重考) ----------
    log('抓取课程列表...');
    let courses = await listCourses();
    courses = courses.filter((c) => c.examId && (!courseFilter || c.name.includes(courseFilter)));
    if (maxCourses > 0) courses = courses.slice(0, maxCourses);
    if (!courses.length) throw new Error('没有找到带课后练习的课程');
    log(`共 ${courses.length} 门课带课后练习`);

    let done = 0, failed = 0, totalQ = 0, hitTotal = 0, filledTotal = 0, collectedTotal = 0;
    let round = 0;
    let targets = courses;

    while (round < maxRounds && targets.length) {
      round++;
      log(`=== 第 ${round} 轮: 处理 ${targets.length} 讲 ===`);
      onProgress({ course: '', phase: 'round', msg: `第 ${round} 轮: ${targets.length} 讲` });
      for (let ci = 0; ci < targets.length; ci++) {
        const c = targets[ci];
        const tag = `[第${round}轮 ${ci + 1}/${targets.length}] ${c.name}`;
        onProgress({ course: c.name, phase: 'start', msg: `第${round}轮: ${c.name}` });
        try {
          const r = await practiceOne(c, tag);
          totalQ += r.answered || 0; hitTotal += r.hit || 0; filledTotal += r.filled || 0;
          log(`${tag} 题目 ${r.answered || 0} 命中 ${r.hit || 0} 填写 ${r.filled || 0} ${r.ok ? '已交卷' : '⚠ ' + r.reason}`);
          if (r.ok) {
            done++;
            onProgress({ course: c.name, phase: 'done', msg: `第${round}轮完成: 命中${r.hit} 填写${r.filled}` });
          } else {
            failed++;
            onProgress({ course: c.name, phase: 'fail', msg: `第${round}轮失败: ${r.reason}` });
          }
        } catch (e) {
          const msg = String(e.message || e).split('\n')[0];
          log(`${tag} ✗ 失败: ${msg}`);
          failed++;
        }
        await page.waitForTimeout(1500);
      }
      if (!retryFull) break;
      log('查询课后练习成绩...');
      const scores = await fetchPracticeScores().catch(() => ({}));
      const notFull = courses.filter((c) => {
        const s = scores[courseToScoreKey(c.name)];
        return s !== undefined && s >= 0 && s < 100;
      });
      log(`本轮后未满分: ${notFull.length} 讲${notFull.length ? ' (自动重考)' : ''}`);
      targets = notFull;
    }

    log(`=== 课后练习完毕: 完成 ${done}/${courses.length}, 失败 ${failed}; 累计题目 ${totalQ}, 命中 ${hitTotal}, 填写 ${filledTotal}, 收录 ${collectedTotal} ===`);
    return { total: courses.length, done, failed, rounds: round, questions: totalQ, hit: hitTotal, filled: filledTotal, collected: collectedTotal };
  } finally {
    await browser.close().catch(() => {});
  }
}
