/* 诊断注册流程：抓控制台异常 + 模拟点击 */
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const PORT = 9335;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080/';

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_diag_' + Date.now())}`,
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
  const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + (d.exception?.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Log.entryAdded') {
      logs.push('log/' + m.params.entry.level + ': ' + m.params.entry.text + ' @' + (m.params.entry.url || ''));
    }
  });
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return '<<eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>';
    return r.result.value;
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Log.enable');
  await cmd('Network.enable');
  await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  console.log('--- 打开 #/register ---');
  await cmd('Page.navigate', { url: `${BASE}#/register` });
  await sleep(1500);
  console.log('hash        :', await evalJs('location.hash'));
  console.log('有注册按钮  :', await evalJs(`!!document.querySelector('#doRegister')`));
  console.log('onclick 已绑:', await evalJs(`typeof document.querySelector('#doRegister').onclick`));
  console.log('storage 可用:', await evalJs(`(()=>{try{sessionStorage.setItem('__t','1');return sessionStorage.getItem('__t')==='1'}catch(e){return 'ERR '+e.name}})()`));

  console.log('\n--- 填入并点击 ---');
  console.log(await evalJs(`(()=>{
    const p=document.querySelector('#phone'); const c=document.querySelector('#code');
    p.value='13800138000'; p.dispatchEvent(new Event('input',{bubbles:true}));
    c.value='123456'; c.dispatchEvent(new Event('input',{bubbles:true}));
    return 'phone='+p.value+' code='+c.value;
  })()`));

  console.log('点击结果    :', await evalJs(`(()=>{try{document.querySelector('#doRegister').click();return 'clicked'}catch(e){return 'ERR '+e.message}})()`));
  await sleep(1200);

  console.log('hash 现在   :', await evalJs('location.hash'));
  console.log('页面标题元素:', await evalJs(`document.querySelector('.h1') ? document.querySelector('.h1').textContent : '(无 .h1)'`));
  console.log('auth 状态   :', await evalJs(`(()=>{try{return JSON.parse(sessionStorage.getItem('trip_proto_v1')).auth}catch(e){return 'ERR '+e.message}})()`));

  console.log('\n--- 继续：画像 → 地址 → 首页 ---');
  console.log('画像页爱好数:', await evalJs(`document.querySelectorAll('.chip[data-k="hobby"]').length`));
  await evalJs(`(()=>{document.querySelector('.chip[data-k="hobby"][data-v="food"]').click();return 1})()`);
  await sleep(150);
  console.log('选了爱好后  :', await evalJs(`document.querySelectorAll('.chip.on').length + ' 个选中'`));
  await evalJs(`document.querySelector('#next').click()`);
  await sleep(900);
  console.log('hash        :', await evalJs('location.hash'));
  console.log('地址页      :', await evalJs(`!!document.querySelector('#confirmAddr')`));
  await evalJs(`document.querySelector('#confirmAddr').click()`);
  await sleep(900);
  console.log('hash        :', await evalJs('location.hash'));
  console.log('首页卡片数  :', await evalJs(`document.querySelectorAll('.card').length`));

  if (logs.length) {
    console.log('\n--- 控制台 ---');
    [...new Set(logs)].forEach(l => console.log(' ' + l));
  } else {
    console.log('\n控制台无异常');
  }

  ws.close(); chrome.kill(); await sleep(200);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
