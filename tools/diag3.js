/* 复现"点了没反应"：分别模拟 data.js 加载失败 / sessionStorage 不可用 */
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const PORT = 9337;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080/';

async function runScenario(name, setup) {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_sc_' + Date.now())}`,
    '--no-first-run', 'about:blank'
  ], { stdio: 'ignore' });

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let seq = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.exceptionDetails ? '<<ERR ' + (r.exceptionDetails.exception?.description || '').split('\n')[0] + '>>' : r.result.value;
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Network.enable'); await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  if (setup) await setup(cmd);

  await cmd('Page.navigate', { url: `${BASE}#/register` });
  await sleep(1500);

  console.log(`\n=== ${name} ===`);
  console.log('TRIPS 存在   :', await evalJs(`typeof TRIPS !== 'undefined' && TRIPS.length`));
  console.log('TAXONOMY     :', await evalJs(`typeof TAXONOMY`));
  console.log('__dataFailed :', await evalJs(`String(window.__dataFailed)`));
  console.log('首屏标题     :', await evalJs(`document.querySelector('.screen h1')?.textContent || '(无)'`));
  console.log('致命错误条   :', await evalJs(`document.getElementById('__fatal')?.textContent?.split('\\n')[0] || '(无)'`));
  console.log('注册按钮     :', await evalJs(`!!document.querySelector('#doRegister')`));

  await evalJs(`(()=>{const p=document.querySelector('#phone');p.value='13800138000';const c=document.querySelector('#code');c.value='123456';return 1})()`);
  await evalJs(`document.querySelector('#doRegister').click()`);
  await sleep(900);

  console.log('点击后 hash  :', await evalJs('location.hash'));
  console.log('底部错误条   :', await evalJs(`document.getElementById('__err')?.textContent || '(无)'`));

  ws.close(); chrome.kill(); await sleep(250);
}

(async () => {
  // 场景 1：data.js 被阻断
  await runScenario('data.js 加载失败', async cmd => {
    await cmd('Network.setBlockedURLs', { urls: ['*data.js*'] });
  });

  // 场景 2：sessionStorage 抛异常
  await runScenario('sessionStorage 不可用', async cmd => {
    await cmd('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('blocked','SecurityError')}})`
    });
  });

  // 场景 3：hashchange 事件不派发（验证轮询兜底）
  await runScenario('hashchange 不派发', async cmd => {
    await cmd('Page.addScriptToEvaluateOnNewDocument', {
      source: `(()=>{const o=window.addEventListener.bind(window);
        window.addEventListener=function(t,f,opt){ if(t==='hashchange') return; return o(t,f,opt); };})()`
    });
  });
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
