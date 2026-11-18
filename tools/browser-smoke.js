/* 通过远程 Chrome DevTools Protocol 对真实页面做端到端验收 */
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080/';
const START_PATH = process.env.START_PATH || '?demo=1#/home';
const OUT = process.env.SHOT_DIR || path.join(process.env.TMPDIR || '/tmp', 'goapp-shots');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pageUrl = `${BASE}${START_PATH}`;
  const target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(pageUrl)}`, {
    method: 'PUT'
  })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text || 'runtime exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map(arg => arg.value || arg.description || '').join(' '));
    }
  });

  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expression => {
    const result = await cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return result.result.value;
  };
  const screenshot = async name => {
    const shot = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Network.enable');
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });

  for (let i = 0; i < 40; i++) {
    const ready = await evalJs(`document.querySelectorAll('.card').length`);
    if (ready >= 8) break;
    await sleep(250);
  }
  const home = await evalJs(`({
    version: APP_VER,
    cards: document.querySelectorAll('.card').length,
    title: document.title,
    fatal: !!document.querySelector('#__fatal'),
    error: !!document.querySelector('#__err'),
    nativeStatusHidden: getComputedStyle(document.querySelector('.statusbar')).display === 'none'
  })`);
  if (home.version !== '2.3.1' || home.cards < 8 || home.fatal || home.error) {
    throw new Error(`首页未就绪: ${JSON.stringify(home)}`);
  }
  if (process.env.NATIVE_MODE === '1' && !home.nativeStatusHidden) {
    throw new Error('原生模式未隐藏网页演示状态栏');
  }
  await screenshot('deployed-home.png');
  console.log(`✓ 首页 ${home.cards} 张卡片 · v${home.version}`);

  await evalJs(`document.querySelector('.card').click()`);
  await sleep(700);
  if (!(await evalJs(`location.hash.startsWith('#/detail/t1')`))) {
    throw new Error(`进入详情失败: ${await evalJs('location.hash')}`);
  }
  await evalJs(`document.querySelector('#orderBtn').click()`);
  await sleep(700);
  const checkout = await evalJs(`({
    hash: location.hash,
    total: document.querySelector('.priceblock .t')?.textContent || '',
    pay: !!document.querySelector('#payBtn')
  })`);
  if (!checkout.hash.startsWith('#/checkout/t1') || !checkout.pay) {
    throw new Error(`确认订单页异常: ${JSON.stringify(checkout)}`);
  }
  console.log(`✓ 确认订单 ${checkout.total}`);

  await evalJs(`document.querySelector('#payBtn').click()`);
  for (let i = 0; i < 40; i++) {
    if ((await evalJs(`location.hash.startsWith('#/success/')`))) break;
    await sleep(250);
  }
  await sleep(500);
  const success = await evalJs(`({
    hash: location.hash,
    vouchers: document.querySelectorAll('.vcard').length,
    qrLoaded: Array.from(document.querySelectorAll('.vcard img.qr')).every(img => img.complete && img.naturalWidth > 0),
    redeem: Array.from(document.querySelectorAll('.redeem b')).map(el => el.textContent.trim())
  })`);
  if (!success.hash.startsWith('#/success/') || success.vouchers !== 3 || !success.qrLoaded) {
    throw new Error(`凭证页异常: ${JSON.stringify(success)}`);
  }
  if (!success.redeem.every(code => /^\d{4} \d{4}$/.test(code))) {
    throw new Error(`核销码格式异常: ${JSON.stringify(success.redeem)}`);
  }
  await screenshot('deployed-success.png');
  console.log(`✓ 下单成功 ${success.vouchers} 张凭证 · 二维码均已加载`);

  await evalJs(`location.hash = '#/orders?tab=all'`);
  await sleep(700);
  const orders = await evalJs(`({
    cards: document.querySelectorAll('.ocard').length,
    fatal: !!document.querySelector('#__fatal')
  })`);
  if (orders.cards < 1 || orders.fatal) {
    throw new Error(`订单列表异常: ${JSON.stringify(orders)}`);
  }
  console.log(`✓ 订单列表 ${orders.cards} 条`);

  await evalJs(`location.hash = '#/address?from=home'`);
  await sleep(700);
  const address = await evalJs(`({
    search: !!document.querySelector('#addrSearch'),
    pois: document.querySelectorAll('.poi').length,
    fatal: !!document.querySelector('#__fatal')
  })`);
  if (!address.search || address.pois < 1 || address.fatal) {
    throw new Error(`地址页异常: ${JSON.stringify(address)}`);
  }
  console.log(`✓ 地址页高德降级 ${address.pois} 个备选地点`);

  if (errors.length) throw new Error(`浏览器错误: ${errors.join(' | ')}`);
  console.log(`截图目录 ${OUT}`);
  ws.close();
}

main().catch(async error => {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
