/**
 * 本地模拟考试平台(仅测试用)—— 结构与真实站点一致,用于端到端验证引擎逻辑。
 * 启动: node test-mock-server.mjs   (默认 127.0.0.1:8123)
 */
import http from 'node:http';

const PORT = 8123;
const page = (title, body, extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>${extra}</head>
<body><h1>${title}</h1>${body}</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const path = url.pathname;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = new URLSearchParams(body);
    const send = (html, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };

    // 登录流
    if (path === '/Default.aspx') {
      return send(page('redirect', 'redirect'), 302, { Location: '/Login.aspx' });
    }
    if (path === '/Login.aspx') {
      return send(page('考试平台--登录', `
        <form id="frmLogin" method="post" action="/HidLogin.aspx">
          <input id="name" name="name" value=""><input id="pw" name="pw" type="password">
          <input id="btnSubmit" type="button" value="登录" onclick="return CkeckNotNull();">
        </form>
        <script>
        function CkeckNotNull() {
          if (document.getElementById('name').value === '' || document.getElementById('pw').value === '') return false;
          document.getElementById('frmLogin').submit();
        }
        </script>`));
    }
    if (path === '/HidLogin.aspx') {
      return send(page('ok', 'ok'), 302, { Location: '/Homes/MainPage.aspx?menu=3&subMenu=4', 'Set-Cookie': 'Clerk=mock-cookie; Path=/' });
    }
    if (path === '/Homes/MainPage.aspx') {
      return send(page('主页', '<a href="/ExamList/ExamList.aspx">我的考试</a><a href="/ExamList/TkTest.aspx">题库练习</a>'));
    }

    // 考试列表
    if (path === '/ExamList/ExamList.aspx') {
      return send(page('我的考试', `
        <table border="1">
          <tr><th>考试名称</th><th>考试起止时间</th><th>考试时长</th><th>考试次数</th><th>参加考试</th></tr>
          <tr>
            <td>模拟考试一</td><td>2026-01-01 ~ 2026-12-31</td><td>60分钟</td><td>2次</td>
            <td><a href="/ExamList/ExamPage/ExamTmStepDo.aspx?examId=1">参加考试</a></td>
          </tr>
          <tr>
            <td>模拟考试二(已结束)</td><td>2025-01-01 ~ 2025-12-31</td><td>30分钟</td><td>0次</td>
            <td><a href="/ExamList/ExamPage/ExamTmStepDo.aspx?examId=2">参加考试</a></td>
          </tr>
        </table>`));
    }

    // 答题页(ExamTmStepDo / ExamDo)
    if (path === '/ExamList/ExamPage/ExamTmStepDo.aspx' || path === '/ExamList/ExamPage/ExamDo.aspx') {
      return send(page('答题', `
        <div class="exam_list">
          <dl><dt>1、中国的首都是以下哪个城市?(单选)</dt>
            <dd><input type="radio" id="tm_1_0" name="tm_1"><label for="tm_1_0">A、北京</label>
                <input type="radio" id="tm_1_1" name="tm_1"><label for="tm_1_1">B、上海</label>
                <input type="radio" id="tm_1_2" name="tm_1"><label for="tm_1_2">C、广州</label></dd></dl>
          <dl><dt>2、以下哪些属于水果?(多选)</dt>
            <dd><input type="checkbox" id="tm_2_0" name="tm_2"><label for="tm_2_0">A、苹果</label>
                <input type="checkbox" id="tm_2_1" name="tm_2"><label for="tm_2_1">B、香蕉</label>
                <input type="checkbox" id="tm_2_2" name="tm_2"><label for="tm_2_2">C、白菜</label>
                <input type="checkbox" id="tm_2_3" name="tm_2"><label for="tm_2_3">D、萝卜</label></dd></dl>
          <dl><dt>3、地球是圆的。(判断)</dt>
            <dd><input type="radio" id="tm_3_0" name="tm_3"><label for="tm_3_0">对</label>
                <input type="radio" id="tm_3_1" name="tm_3"><label for="tm_3_1">错</label></dd></dl>
          <dl><dt>4、题库未命中的题目示例(单选)</dt>
            <dd><input type="radio" id="tm_4_0" name="tm_4"><label for="tm_4_0">A、选项一</label>
                <input type="radio" id="tm_4_1" name="tm_4"><label for="tm_4_1">B、选项二</label></dd></dl>
        </div>
        <button onclick="SubmitExam()">交卷</button>
        <script>
        function SubmitExam() {
          var checked = document.querySelectorAll('input:checked').length;
          if (confirm('确认交卷?已选 ' + checked + ' 题')) location.href = '/ExamList/ExamPage/viewExam.aspx';
        }
        </script>`));
    }

    // 答卷页(viewExam)
    if (path === '/ExamList/ExamPage/viewExam.aspx' || path === '/ExamList/ExamPage/ViewExam.aspx') {
      return send(page('答卷', `
        <div id="ddTm_1"><dt>1、中国的首都是以下哪个城市?(单选)</dt>
          <div class="green">A</div>
          <label for="tm_1_0">A、北京</label><label for="tm_1_1">B、上海</label><label for="tm_1_2">C、广州</label></div>
        <div id="ddTm_2"><dt>2、以下哪些属于水果?(多选)</dt>
          <div class="green">BC</div>
          <label for="tm_2_0">A、苹果</label><label for="tm_2_1">B、香蕉</label><label for="tm_2_2">C、白菜</label><label for="tm_2_3">D、萝卜</label></div>
        <div id="ddTm_3"><dt>3、地球是圆的。(判断)</dt>
          <div class="green">对</div>
          <label for="tm_3_0">对</label><label for="tm_3_1">错</label></div>
        <div id="ddTm_4"><dt>4、题库未命中的题目示例(单选)</dt>
          <div class="green">A</div>
          <label for="tm_4_0">A、选项一</label><label for="tm_4_1">B、选项二</label></div>`));
    }

    // 题库练习页(TkTest)—— 翻页 POST 返回第二页
    if (path === '/ExamList/TkTest.aspx') {
      const isPost = req.method === 'POST';
      const isNext = isPost && params.get('__EVENTTARGET') === 'PageSplit1$BtnNext';
      const page2 = isNext;
      const q1 = page2
        ? '<dl><dt>2、水的化学式是?</dt><dd><div>A、H2O</div><div>B、CO2</div><div>C、NaCl</div></dd><dd>正确答案:A</dd></dl>' +
          '<dl><dt>3、光在真空中传播速度最快。(判断)</dt><dd><div>对</div><div>错</div></dd><dd>正确答案:对</dd></dl>'
        : '<dl><dt>1、中国的首都是以下哪个城市?</dt><dd><div>A、北京</div><div>B、上海</div><div>C、广州</div></dd><dd>正确答案:A</dd></dl>';
      const nextBtn = page2
        ? '<button id="PageSplit1_BtnNext" disabled>下一页</button>'
        : '<button id="PageSplit1_BtnNext">下一页</button>';
      return send(page('题库练习', `
        <select id="ddlTklx" name="ddlTklx"><option value="0&amp;0">请选择题库</option><option value="1&amp;1">测试分类一</option><option value="2&amp;2">测试分类二</option></select>
        <button id="btnSearch" onclick="this.form.submit()">搜 索</button>
        <div class="exam_list">${q1}</div>
        ${nextBtn}
        <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="mockVS">
        <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="mockGen">
        <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="mockEV">
        <form method="post"></form>`));
    }

    send(page('404', 'not found'), 404);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock platform: http://127.0.0.1:${PORT}`));
