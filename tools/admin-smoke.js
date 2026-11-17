/* 管理后台真实浏览器验收，需要 CDP Chrome 与 ADMIN_PASSWORD 环境变量 */
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080/';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const OUT = process.env.SHOT_DIR || path.join(process.env.TMPDIR || '/tmp', 'goapp-admin-shots');

async function main() {
  if (!PASSWORD) throw new Error('缺少 ADMIN_PASSWORD');
  fs.mkdirSync(OUT, { recursive: true });
  const target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`${BASE}admin/`)}`, {
    method: 'PUT'
  })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text || 'runtime exception');
    }
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expression => {
    const value = await cmd('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || 'eval failed');
    return value.result.value;
  };
  const waitFor = async (expression, label) => {
    for (let index = 0; index < 50; index++) {
      if (await evalJs(expression)) return;
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  };
  const shot = async name => {
    const result = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, 'base64'));
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false
  });
  await waitFor(`document.readyState === 'complete'`, '页面加载');
  await waitFor(
    `!document.querySelector('#loginView').hidden || !document.querySelector('#appView').hidden`,
    '登录页或已登录后台'
  );
  const needsLogin = await evalJs(`!document.querySelector('#loginView').hidden`);
  if (needsLogin) {
    await evalJs(`(() => {
      document.querySelector('#loginUser').value = ${JSON.stringify(USERNAME)};
      document.querySelector('#loginPassword').value = ${JSON.stringify(PASSWORD)};
      document.querySelector('#loginForm').requestSubmit();
      return true;
    })()`);
  }
  await waitFor(`!document.querySelector('#appView').hidden`, '后台登录');
  await waitFor(`document.querySelectorAll('.metric').length >= 4`, '仪表盘');
  const dashboard = await evalJs(`({
    title: document.querySelector('#pageTitle').textContent,
    metrics: document.querySelectorAll('.metric').length,
    admin: document.querySelector('#adminName').textContent
  })`);
  if (dashboard.title !== '数据概览' || dashboard.metrics < 4) {
    throw new Error(`仪表盘异常：${JSON.stringify(dashboard)}`);
  }
  await shot('dashboard.png');
  console.log(`✓ 仪表盘 ${dashboard.metrics} 个指标 · ${dashboard.admin}`);

  await evalJs(`document.querySelector('[data-view="trips"]').click()`);
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, '首页项目列表');
  await evalJs(`document.querySelector('#addTripBtn').click()`);
  await waitFor(`!document.querySelector('#modalRoot').hidden && !!document.querySelector('#tripForm')`, '首页项目编辑器');
  const stops = await evalJs(`document.querySelectorAll('.stop-editor').length`);
  if (stops < 1) throw new Error('首页项目编辑器缺少站点');
  await evalJs(`document.querySelector('[data-close]').click()`);
  console.log('✓ 首页项目列表与结构化编辑器');

  await evalJs(`document.querySelector('[data-view="users"]').click()`);
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, '用户列表');
  await evalJs(`document.querySelector('#addUserBtn').click()`);
  await waitFor(`!document.querySelector('#modalRoot').hidden`, '新增用户弹窗');
  await evalJs(`document.querySelector('[data-close]').click()`);
  console.log('✓ 用户列表与新增弹窗');

  await evalJs(`document.querySelector('[data-view="tags"]').click()`);
  await waitFor(`document.querySelectorAll('.tag-card').length > 0`, '标签列表');
  const tags = await evalJs(`document.querySelectorAll('.tag-card').length`);
  console.log(`✓ 标签管理 ${tags} 个标签`);

  await evalJs(`document.querySelector('[data-view="orders"]').click()`);
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, '订单列表');
  console.log('✓ 订单查询');

  await evalJs(`document.querySelector('[data-view="audit"]').click()`);
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, '操作日志');
  console.log('✓ 操作日志');

  if (errors.length) throw new Error(`浏览器错误：${errors.join(' | ')}`);
  console.log(`截图目录 ${OUT}`);
  ws.close();
}

main().catch(error => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
