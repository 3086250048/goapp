/* 功能探针：验证无限加载与人数步进等真实交互（CDP 驱动） */
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const BASE = 'http://127.0.0.1:4321/';

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_probe')}`,
    '--no-first-run', 'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  if (!version) { chrome.kill(); throw new Error('Chrome 启动失败'); }

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
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description || 'eval error');
    return r.result.value;
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Network.enable');
  await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? '✓' : '✗'} ${name}  ${detail}`);
  };

  /* ---- 1. 首页无限加载 ---- */
  await cmd('Page.navigate', { url: `${BASE}?demo=1#/home` });
  await sleep(1800);
  const first = await evalJs(`document.querySelectorAll('.card').length`);
  check('首屏卡片', first === 8, `渲染 ${first} 张（期望 8）`);

  await evalJs(`(()=>{const s=document.querySelector('#feedScroll');s.scrollTop=s.scrollHeight;s.dispatchEvent(new Event('scroll'));return 1})()`);
  await sleep(1100);
  const second = await evalJs(`document.querySelectorAll('.card').length`);
  check('触底加载', second > first, `触底后 ${second} 张（期望 > ${first}）`);

  await evalJs(`(()=>{const s=document.querySelector('#feedScroll');s.scrollTop=s.scrollHeight;s.dispatchEvent(new Event('scroll'));return 1})()`);
  await sleep(1100);
  const third = await evalJs(`document.querySelectorAll('.card').length`);
  const total = await evalJs(`TRIPS.length`);
  check('加载至全量', third === total, `${third} / ${total} 张`);
  const endHint = await evalJs(`!!document.querySelector('.endhint')`);
  check('到底提示', endHint === true, `endhint ${endHint ? '已出现' : '未出现'}`);

  /* ---- 2. 详情页人数步进改价 ---- */
  await cmd('Page.navigate', { url: `${BASE}?demo=1#/detail/t1` });
  await sleep(1200);
  const before = await evalJs(`document.querySelector('#totalPrice').textContent`);
  const beforePeople = await evalJs(`document.querySelector('#peopleNum').textContent`);
  await evalJs(`document.querySelector('#plus').click()`);
  await sleep(200);
  const after = await evalJs(`document.querySelector('#totalPrice').textContent`);
  const afterPeople = await evalJs(`document.querySelector('#peopleNum').textContent`);
  check('人数步进', afterPeople === '3', `${beforePeople} → ${afterPeople} 人`);
  check('价格联动', before !== after, `${before} → ${after}`);

  /* ---- 3. 选中日期后下单跳转 ---- */
  const dateLabel = await evalJs(`document.querySelector('#dateLabel').textContent`);
  check('默认日期', /月/.test(dateLabel), `默认选中「${dateLabel}」`);

  /* ---- 4. 支付流程（点确认支付 → 成功页） ---- */
  const tripHref = await evalJs(`(()=>{
    const p = new URLSearchParams({people:'4'});
    const d = new Date(); d.setDate(d.getDate()+2);
    p.set('date', d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'));
    location.hash = '#/checkout/t1?' + p.toString();
    return location.hash;
  })()`);
  await sleep(800);
  const payReady = await evalJs(`!!document.querySelector('#payBtn')`);
  check('确认页渲染', payReady === true, tripHref);

  await evalJs(`document.querySelector('#payBtn').click()`);
  await sleep(2200);
  const onSuccess = await evalJs(`location.hash.startsWith('#/success')`);
  const voucherCount = await evalJs(`document.querySelectorAll('.vcard').length`);
  check('支付后进入成功页', onSuccess === true, `hash=${await evalJs('location.hash')}`);
  check('凭证数量 = 站数', voucherCount === 3, `${voucherCount} 张（t1 为 3 站）`);

  /* ---- 5. 订单落库 ---- */
  const orderCount = await evalJs(`JSON.parse(sessionStorage.getItem('trip_proto_v1')).orders.length`);
  check('订单写入', orderCount >= 3, `sessionStorage 中 ${orderCount} 单`);

  ws.close();
  chrome.kill();
  await sleep(200);

  const failed = results.filter(r => !r.pass);
  if (failed.length) { console.log(`\n${failed.length} 项未通过`); process.exit(1); }
  console.log('\n全部通过');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
