/* 导航回归：验证返回按钮能逐级回退 */
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const BASE = 'http://127.0.0.1:4321/';

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_nav_' + Date.now())}`,
    '--no-first-run', 'about:blank'], { stdio: 'ignore' });

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let seq = 0; const pending = new Map(); const errs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
  });
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async e => {
    const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.exceptionDetails ? '<<ERR ' + (r.exceptionDetails.exception?.description || '').split('\n')[0] + '>>' : r.result.value;
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Network.enable'); await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const results = [];
  const check = (name, pass, detail) => { results.push(pass); console.log(`${pass ? '✓' : '✗'} ${name}  ${detail}`); };

  await cmd('Page.navigate', { url: `${BASE}?demo=1#/home` });
  await sleep(1800);

  const click = async sel => { await ev(`document.querySelector('${sel}').click()`); await sleep(400); };
  const hash = () => ev('location.hash');
  const waitFor = async (sel, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(`!!document.querySelector('${sel}')`)) return true;
      await sleep(120);
    }
    return false;
  };

  check('首页', (await hash()) === '#/home', await hash());

  await click('.avatar');
  check('进个人信息', (await hash()) === '#/me', await hash());
  check('有返回按钮', (await ev(`!!document.querySelector('#meBack') || !!document.querySelector('.nav [data-back]')`)) === true, '存在 data-back');

  await click('.nav [data-back]');
  check('个人信息 → 返回首页', (await hash()) === '#/home', await hash());

  await click('.avatar');
  await click('[data-nav="#/orders"]');
  check('个人信息 → 订单列表', (await hash()) === '#/orders', await hash());
  await click('.nav [data-back]');
  check('订单列表 → 返回', (await hash()) === '#/me', await hash());
  await click('.nav [data-back]');
  check('个人信息 → 返回首页', (await hash()) === '#/home', await hash());

  await waitFor('.card');
  await click('.card');
  check('进入详情', (await hash()).startsWith('#/detail/'), await hash());
  await waitFor('.nav-float [data-back]');
  await click('.nav-float [data-back]');
  check('详情 → 返回首页', (await hash()) === '#/home', await hash());

  if (errs.length) { console.log('\n异常:', [...new Set(errs)].join(' | ')); }
  console.log(results.every(Boolean) ? '\n全部通过' : '\n有失败项');
  process.exitCode = results.every(Boolean) ? 0 : 1;
  ws.close(); chrome.kill(); await sleep(200);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
