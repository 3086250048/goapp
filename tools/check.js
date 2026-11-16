/* 无浏览器渲染自检：在 Node 里用 DOM 桩加载 app.js，逐页渲染并校验 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'prototype');
const dataSrc = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/* ---------- 万能 DOM 桩 ---------- */
function stub() {
  const t = function () {};
  return new Proxy(t, {
    get(_, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'classList') return { toggle() {}, add() {}, remove() {}, contains: () => false };
      if (p === 'style' || p === 'dataset') return {};
      if (p === 'value') return '';
      if (p === 'checked') return true;
      if (p === 'disabled') return false;
      if (p === 'querySelectorAll') return () => [];
      if (p === 'querySelector') return () => stub();
      if (p === 'appendChild' || p === 'insertAdjacentHTML') return () => {};
      if (p === 'addEventListener' || p === 'removeEventListener') return () => {};
      if (p === 'toString') return () => '';
      return stub();
    },
    set() { return true; },
    apply() { return stub(); }
  });
}

const store = new Map();
const sandbox = {
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  document: {
    querySelector: () => stub(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => stub()
  },
  window: { addEventListener: () => {} },
  location: { hash: '#/register' },
  history: { length: 2, back() {} },
  sessionStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  },
  URLSearchParams
};
sandbox.globalThis = sandbox;

const exportLine = `
;globalThis.__X = { ROUTES, TRIPS, TAXONOMY, S, ensureSeed, createOrder, tripStats, dateKey };`;
vm.createContext(sandbox);
vm.runInContext(dataSrc + '\n' + appSrc + exportLine, sandbox, { filename: 'bundle.js' });

const { ROUTES, TRIPS, S, ensureSeed, createOrder, dateKey, tripStats } = sandbox.__X;

/* ---------- 逐页渲染 ---------- */
ensureSeed();
const orderId = S.orders[0] && S.orders[0].id;

const cases = [
  ['register', () => ROUTES.register.render()],
  ['profile', () => ROUTES.profile.render()],
  ['address', () => ROUTES.address.render()],
  ['home', () => ROUTES.home.render()],
  ['detail', () => ROUTES.detail.render('t1', {})],
  ['checkout', () => ROUTES.checkout.render('t1', { people: '4', date: dateKey(new Date()) })],
  ['success', () => ROUTES.success.render(orderId)],
  ['me', () => ROUTES.me.render()],
  ['orders', () => ROUTES.orders.render(undefined, {})],
  ['order', () => ROUTES.order.render(orderId)]
];

let fail = 0;
const problems = [];

for (const [name, fn] of cases) {
  let html;
  try {
    html = fn();
  } catch (e) {
    problems.push(`[${name}] render 抛错: ${e.message}`);
    fail++; continue;
  }
  if (typeof html !== 'string' || html.length < 50) {
    problems.push(`[${name}] 渲染结果异常（长度 ${html && html.length}）`);
    fail++; continue;
  }
  if (/undefined|NaN/.test(html)) {
    const m = html.match(/.{0,40}(undefined|NaN).{0,40}/);
    problems.push(`[${name}] 出现 undefined/NaN: …${m[0]}…`);
    fail++;
  }

  // mount 里引用的 id 必须存在于该页 HTML
  const mountSrc = (ROUTES[name].mount || '').toString();
  const ids = [...mountSrc.matchAll(/\$\('#([\w-]+)'/g)].map(m => m[1]);
  const missing = [...new Set(ids)].filter(id => !new RegExp(`id="${id}"`).test(html));
  if (missing.length) {
    problems.push(`[${name}] mount 引用了不存在的元素 id: ${missing.join(', ')}`);
    fail++;
  }

  // 所有 data-nav 目标必须是已注册路由
  const navs = [...html.matchAll(/data-nav="#\/([\w-]+)/g)].map(m => m[1]);
  const badNav = [...new Set(navs)].filter(n => !ROUTES[n]);
  if (badNav.length) {
    problems.push(`[${name}] 存在未注册的导航目标: ${badNav.join(', ')}`);
    fail++;
  }

  console.log(`${fail ? '·' : '✓'} ${name.padEnd(10)} html ${String(html.length).padStart(6)} 字符  ids:${ids.length}  navs:${new Set(navs).size}`);
}

/* ---------- 价格模型自检 ---------- */
const t = TRIPS[0];
const p1 = tripStats(t, 1), p2 = tripStats(t, 2), p4 = tripStats(t, 4), p6 = tripStats(t, 6);
if (!(p2.perPerson > 0)) { problems.push('价格模型: 人均价非正数'); fail++; }
if (!(p4.rate < p2.rate)) { problems.push('价格模型: 4 人折扣未生效'); fail++; }
if (!(p6.perPerson < p2.perPerson)) { problems.push('价格模型: 人数增加后人均未下降'); fail++; }
console.log(`\n价格模型  ${t.title}`);
[['1人', p1], ['2人', p2], ['4人', p4], ['6人', p6]].forEach(([k, v]) =>
  console.log(`  ${k}  总价 ¥${v.total}  人均 ¥${v.perPerson}  折扣 ${v.rate}`));

console.log(`\n订单数 ${S.orders.length}，凭证数 ${S.orders.reduce((n, o) => n + o.vouchers.length, 0)}`);

if (problems.length) {
  console.log('\n=== 问题 ===');
  problems.forEach(p => console.log(' ! ' + p));
  process.exit(1);
} else {
  console.log('\n全部通过');
}
