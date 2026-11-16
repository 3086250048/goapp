/* 单项编辑回归：只改一个字段、保存后回到个人信息 */
const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const BASE = 'http://127.0.0.1:4321/';

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp_ed_' + Date.now())}`,
    '--no-first-run', 'about:blank'], { stdio: 'ignore' });

  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let seq = 0; const pending = new Map(); const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
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
  const hash = () => ev('location.hash');
  const click = async s => { await ev(`document.querySelector('${s}').click()`); await sleep(350); };
  const waitFor = async (s, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(`!!document.querySelector('${s}')`)) return true; await sleep(100); }
    return false;
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Network.enable'); await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const res = [];
  const check = (n, p, d) => { res.push(p); console.log(`${p ? '✓' : '✗'} ${n}  ${d}`); };

  await cmd('Page.navigate', { url: `${BASE}?demo=1#/home` });
  await sleep(1600);

  // 进个人信息
  await click('.avatar');
  check('进入个人信息', (await hash()) === '#/me', await hash());

  // 职业：只应出现 14 个职业选项，且不应出现爱好/性格选项
  await click('[data-nav="#/edit/occupation"]');
  check('打开职业编辑', (await hash()) === '#/edit/occupation', await hash());
  const occChips = await ev(`document.querySelectorAll('.chip').length`);
  const hasHobbyChip = await ev(`!!document.querySelector('.chip[data-v="food"]')`);
  check('只显示职业选项', occChips === 14 && hasHobbyChip === false, `选项 ${occChips} 个，含爱好的 chip=${hasHobbyChip}`);

  await click('.chip[data-v="student"]');
  await click('#saveField');
  check('保存后回个人信息', (await hash()) === '#/me', await hash());
  const occShown = await ev(`[...document.querySelectorAll('.inforow')].find(r=>r.textContent.includes('职业'))?.textContent.includes('学生')`);
  check('职业已更新', occShown === true, `个人信息页显示「学生」=${occShown}`);

  // 爱好
  await click('[data-nav="#/edit/hobby"]');
  check('打开爱好编辑', (await hash()) === '#/edit/hobby', await hash());
  const hobbyChips = await ev(`document.querySelectorAll('.chip').length`);
  check('只显示爱好选项', hobbyChips === 20, `选项 ${hobbyChips} 个`);
  await click('.chip[data-v="hiking"]');
  await click('#saveField');
  check('爱好保存后回个人信息', (await hash()) === '#/me', await hash());

  // 昵称
  await click('.identity');
  check('打开昵称编辑', (await hash()) === '#/edit/nickname', await hash());
  await ev(`(()=>{const i=document.querySelector('#nickInput');i.value='江南慢行客';return 1})()`);
  await click('#saveNick');
  check('昵称保存后回个人信息', (await hash()) === '#/me', await hash());
  check('昵称已更新', (await ev(`document.querySelector('.identity h2').textContent`)) === '江南慢行客', await ev(`document.querySelector('.identity h2').textContent`));

  // 地址：从个人信息进，确认后应回到个人信息
  await click('[data-nav="#/address?from=me"]');
  check('打开地址', (await hash()).startsWith('#/address'), await hash());
  await click('#confirmAddr');
  await sleep(700);
  check('地址确认后回个人信息', (await hash()) === '#/me', await hash());

  if (errs.length) console.log('\n异常:', [...new Set(errs)].join(' | '));
  console.log(res.every(Boolean) ? '\n全部通过' : '\n有失败项');
  process.exitCode = res.every(Boolean) ? 0 : 1;
  ws.close(); chrome.kill(); await sleep(200);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
