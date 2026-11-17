/* 用真实鼠标事件点击，排查元素拦截 / label 包裹导致点击失效 */
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const PORT = 9336;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080/';

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_mouse_' + Date.now())}`,
    '--no-first-run', 'about:blank'
  ], { stdio: 'ignore' });

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let seq = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.exceptionDetails ? '<<ERR ' + (r.exceptionDetails.exception?.description || '') + '>>' : r.result.value;
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Network.enable'); await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });

  const clickAt = async (sel, label) => {
    const box = await evalJs(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
    if (!box) { console.log(`✗ ${label}: 元素不存在`); return false; }
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    console.log(`· ${label}: 点击 (${box.x.toFixed(0)},${box.y.toFixed(0)}) 尺寸 ${box.w.toFixed(0)}×${box.h.toFixed(0)}`);
    return true;
  };

  await cmd('Page.navigate', { url: `${BASE}#/register` });
  await sleep(1500);

  // 点在了哪个元素上？（排查遮挡）
  const hit = await evalJs(`(()=>{
    const r=document.querySelector('#doRegister').getBoundingClientRect();
    const el=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
    return el ? el.tagName+'.'+el.className+' #'+(el.id||'') : 'null';
  })()`);
  console.log('按钮中心最上层元素:', hit);

  // 真实点击输入框并输入
  await clickAt('#phone', '手机号输入框');
  await cmd('Input.insertText', { text: '13800138000' });
  await sleep(200);
  console.log('  输入后值:', await evalJs(`document.querySelector('#phone').value`));

  // 点「获取验证码」
  await clickAt('#sendCode', '获取验证码');
  await sleep(700);
  console.log('  验证码值:', await evalJs(`document.querySelector('#code').value`));
  console.log('  按钮文案:', await evalJs(`document.querySelector('#sendCode').textContent`));

  // 点「注册 / 登录」
  const before = await evalJs('location.hash');
  await clickAt('#doRegister', '注册/登录');
  await sleep(1000);
  const after = await evalJs('location.hash');
  console.log(`  跳转: ${before} → ${after}`);
  console.log('  页面标题:', await evalJs(`document.querySelector('.h1')?.textContent || '(无)'`));

  if (logs.length) { console.log('\n异常:'); [...new Set(logs)].forEach(l => console.log(' ' + l)); }
  else console.log('\n无异常');

  ws.close(); chrome.kill(); await sleep(200);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
