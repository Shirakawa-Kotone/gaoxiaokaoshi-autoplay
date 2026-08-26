/**
 * 学时助手引擎 —— 单账号、多标签页、真实播放至学时达标。
 * 被 CLI(autoplay.mjs)与 Web 服务(server.mjs)复用。
 * 原则不变:不做伪造请求,视频真实播放,服务端记录真实时长。
 */
import { chromium } from 'playwright';

const BASE = 'http://www.gaoxiaokaoshi.com';

const POLL_MS = 15000;      // 轮询间隔
const CHECK_EVERY = 5;      // 每 5 次轮询(≈75s)核对一次已完成学时
const STALL_MS = 45000;     // 计时停滞超过此毫秒数则重载重播
const EXTRA_MIN = 10;       // 单课超时保护:需求时长 + 10 分钟

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

  if (!examUser || !examPass) throw new Error('缺少考试平台账号/密码');

  const browser = await chromium.launch({
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

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const loginPage = await context.newPage();
    const tabPages = [loginPage];
    for (let i = 1; i < TOTAL_SLOTS; i++) tabPages.push(await context.newPage());

    // ---------- 登录 ----------
    log('登录中...');
    await loginPage.goto(BASE + '/Default.aspx', { waitUntil: 'domcontentloaded' });
    try { await loginPage.waitForURL(/Login\.aspx/, { timeout: 15000 }); } catch {}
    await loginPage.fill('#name', examUser);
    await loginPage.fill('#pw', examPass);
    await Promise.all([
      loginPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      loginPage.click('#btnSubmit'),
    ]);
    const clerk = (await context.cookies()).find((c) => c.name === 'Clerk');
    if (!clerk) throw new Error('登录失败:未获得 Clerk cookie(考试平台账号或密码错误?)');
    log('登录成功');

    // ---------- 列表操作(fetch 直发,不依赖页面导航) ----------
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

    async function parseListHtml(page, html) {
      return page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = [];
        for (const tr of doc.querySelectorAll('table.table tr')) {
          const a = tr.querySelector('a[onclick*="showframe"]');
          if (!a) continue;
          const m = (a.getAttribute('onclick') || '').match(/showframe\([^,]*,\s*(\d+)\)/);
          const tds = tr.querySelectorAll('td');
          const num = (s) => parseInt(String(s || '').replace(/[^0-9]/g, '')) || 0;
          rows.push({
            name: (tds[0]?.textContent || '').trim(),
            cat: (tds[1]?.textContent || '').trim(),
            reqMin: num(tds[2]?.textContent),
            doneMin: num(tds[3]?.textContent),
            id: m ? m[1] : null,
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
        await loginPage.goto(BASE + '/Default.aspx', { waitUntil: 'domcontentloaded' });
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
      await page.goto(url, { waitUntil: 'domcontentloaded' });
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
      const url = `${BASE}/Study/LibraryStudy.aspx?Id=${course.id}&PlanId=${course.planId}`;
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
        const ok = await studyCourse(tag, page, c);
        if (ok) doneCount++;
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
