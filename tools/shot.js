/* 用 CDP 精确控制视口（390×844 @2x）批量截取原型页面 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:4321/';
const OUT = path.join(__dirname, '..', '.shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const d = new Date(); d.setDate(d.getDate() + 3);
const dateK = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const SHOTS = [
  ['register', `${BASE}?demo=0#/register`, 1200],
  ['home', `${BASE}?demo=1#/home`, 1800],
  ['detail', `${BASE}?demo=1#/detail/t1`, 1400],
  ['checkout', `${BASE}?demo=1#/checkout/t1?people=4&date=${dateK}`, 1200],
  ['success', `${BASE}?demo=1#/success/x`, 1400],
  ['me', `${BASE}?demo=1#/me`, 1200],
  ['edit', `${BASE}?demo=1#/edit/occupation`, 1200],
  ['orders', `${BASE}?demo=1#/orders?tab=unused`, 1200],
  ['orderdone', `${BASE}?demo=1#/order/o_seed_1`, 1400]
];

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_proto')}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  if (!version) { chrome.kill(); throw new Error('Chrome 未能启动 CDP'); }

  let target = null;
  try {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
  } catch {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`)).json();
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await cmd('Page.enable');
  await cmd('Network.enable');
  await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    screenWidth: 390, screenHeight: 844
  });

  for (const [name, url, wait] of SHOTS) {
    await cmd('Page.navigate', { url });
    await sleep(wait);
    const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
    const size = fs.statSync(path.join(OUT, name + '.png')).size;
    console.log(`✓ ${name.padEnd(10)} ${size} bytes`);
  }

  ws.close();
  chrome.kill();
  await sleep(300);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
