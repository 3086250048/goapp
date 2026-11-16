/* ============================================================
   出行 App · 交互原型主逻辑
   - 单页 hash 路由
   - 完整链路：注册 → 画像 → 地址 → 首页 → 详情 → 确认 → 支付 → 凭证 → 个人中心 → 订单
   ============================================================ */

/* ---------------- 运行时错误可见化 ---------------- */
const APP_VER = '1.1.3';
console.log('[出行原型] v' + APP_VER);

window.addEventListener('error', e => {
  try {
    let bar = document.getElementById('__err');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__err';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#F53F3F;color:#fff;'
        + 'font:12px/1.6 ui-monospace,Consolas,monospace;padding:10px 14px;white-space:pre-wrap;max-height:40vh;overflow:auto';
      document.body.appendChild(bar);
    }
    const file = (e.filename || '').split('/').pop();
    bar.textContent = `运行出错（v${APP_VER}）：${e.message}\n${file}:${e.lineno}:${e.colno}\n请把这段文字反馈给我`;
  } catch (_) {}
});

/* ---------------- 基础工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const appEl = $('#app');
const deviceEl = $('#device');

const fmt = n => Math.round(Number(n)).toLocaleString('zh-CN');
const yuan = n => '¥' + fmt(n);
const pad2 = n => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer = null;
function toast(msg) {
  let t = $('.toast', deviceEl);
  if (!t) { t = document.createElement('div'); t.className = 'toast'; deviceEl.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

/* ---------------- 状态 ---------------- */
const STORE_KEY = 'trip_proto_v1';

function blankState() {
  return {
    auth: false,
    seeded: false,
    nickname: '出行者8823',
    profile: { hobby: [], personality: [], occupation: null, gender: null },
    addresses: [],
    defaultId: null,
    orders: [],
    lastChannel: 'wechat'
  };
}

let S = (() => {
  try { return Object.assign(blankState(), JSON.parse(sessionStorage.getItem(STORE_KEY)) || {}); }
  catch (e) { return blankState(); }
})();

function save() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {} }

/* ---------------- 业务计算 ---------------- */
function tripStats(trip, people) {
  let pp = 0, gp = 0;
  trip.stops.forEach(s => s.items.forEach(it => {
    if (it.mode === 'gp') gp += it.price; else pp += it.price;
  }));
  const rate = people >= 5 ? 0.85 : people >= 4 ? 0.9 : 1;
  const total = Math.round(pp * people * rate) + gp;
  return { pp, gp, rate, total, perPerson: Math.round(total / people) };
}

function stopSubtotal(stop, people) {
  return stop.items.reduce((sum, it) => sum + (it.mode === 'gp' ? it.price : it.price * people), 0);
}

const badge = tags => (tags.length > 1 ? '玩·吃' : tags[0] === 'play' ? '玩' : '吃');
const durLabel = h => (h <= 5 ? '半日' : h <= 10 ? '一日' : '一日 · 长线');
const distLabel = m => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`);
const labelOf = (k, v) => {
  const g = TAXONOMY[k]; if (!g) return v;
  const it = g.options.find(o => o[0] === v); return it ? it[1] : v;
};

const dateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dateLabel = k => { const d = new Date(k + 'T00:00:00'); return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`; };
const dateShort = k => { const d = new Date(k + 'T00:00:00'); return `${d.getMonth() + 1}/${d.getDate()}`; };

function defaultAddress() {
  return S.addresses.find(a => a.id === S.defaultId) || S.addresses[0] || null;
}
function addrShort() {
  const a = defaultAddress();
  return a ? `${a.tag} · ${a.name}` : '设置地址';
}
function addrFull() {
  const a = defaultAddress();
  return a ? `${a.tag} · ${a.name}` : '未设置';
}

/* ---------------- 订单 ---------------- */
function genOrderNo() {
  const d = new Date();
  return 'TT' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + String(Math.floor(Math.random() * 900) + 100);
}
function randCode(n) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => cs[Math.floor(Math.random() * cs.length)]).join('');
}
function randNum(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
}

function createOrder(trip, people, dateK) {
  const st = tripStats(trip, people);
  const d = new Date(dateK + 'T00:00:00');
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const total = st.total + (weekend ? 50 * people : 0);

  const order = {
    id: 'o' + Date.now(),
    no: genOrderNo(),
    status: 'paid',
    createdAt: new Date().toISOString(),
    travelDate: dateK,
    people,
    tripId: trip.id,
    title: trip.title,
    tags: trip.tags,
    cover: trip.cover,
    stopCount: trip.stops.length,
    durationHours: trip.durationHours,
    total,
    perPerson: Math.round(total / people),
    address: defaultAddress(),
    channel: S.lastChannel,
    vouchers: trip.stops.map((s, i) => ({
      id: 'v' + i + '_' + Date.now(),
      seq: i + 1,
      name: s.name,
      type: s.type,
      code: randCode(16),
      redeem: randNum(8),
      status: 'unused',
      note: `到「${s.name}」核销台出示`
    }))
  };
  S.orders.unshift(order);
  save();
  return order;
}

/* 预置一条历史已完成订单，让订单列表/凭证状态有参照 */
function ensureSeed() {
  if (S.seeded) return;
  S.seeded = true;
  const trip = (typeof TRIPS !== 'undefined' && TRIPS[5]) || null;
  if (!trip) { save(); return; }
  const d = new Date(); d.setDate(d.getDate() - 12);
  const st = tripStats(trip, 2);
  S.orders.push({
    id: 'o_seed_1',
    no: 'TT' + '202611041835' + '207',
    status: 'completed',
    createdAt: new Date(d.getTime() - 86400000).toISOString(),
    travelDate: dateKey(d),
    people: 2,
    tripId: trip.id,
    title: trip.title,
    tags: trip.tags,
    cover: trip.cover,
    stopCount: trip.stops.length,
    durationHours: trip.durationHours,
    total: st.total,
    perPerson: st.perPerson,
    address: defaultAddress(),
    channel: 'wechat',
    vouchers: trip.stops.map((s, i) => ({
      id: 'vs' + i,
      seq: i + 1,
      name: s.name,
      type: s.type,
      code: randCode(16),
      redeem: randNum(8),
      status: 'used',
      usedAt: '11月4日 11:12',
      note: `到「${s.name}」核销台出示`
    }))
  });
  save();
}

/* ---------------- 二维码占位（不可扫描，仅演示排版） ---------------- */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function randGen(seed) {
  let s = seed || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function qrGrid(seed, n) {
  const rnd = randGen(hashStr(seed));
  const g = Array.from({ length: n }, () => Array(n).fill(0));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g[y][x] = rnd() > 0.5 ? 1 : 0;

  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const on = (x === 0 || x === 6 || y === 0 || y === 6) || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      g[oy + y][ox + x] = on ? 1 : 0;
    }
    for (let y = -1; y < 8; y++) for (let x = -1; x < 8; x++) {
      if (y < 0 || y > 6 || x < 0 || x > 6) {
        const yy = oy + y, xx = ox + x;
        if (g[yy] && g[yy][xx] !== undefined) g[yy][xx] = 0;
      }
    }
  };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  for (let i = 8; i < n - 8; i++) { g[6][i] = i % 2 === 0 ? 1 : 0; g[i][6] = i % 2 === 0 ? 1 : 0; }
  return g;
}
function qrSvg(seed, px) {
  const n = 25, cell = 100 / n, g = qrGrid(seed, n);
  /* 按行合并连续色块，用单条 path 绘制（比逐格 rect 小一个数量级，且边缘更锐利） */
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (g[y][x]) {
        let w = 1;
        while (x + w < n && g[y][x + w]) w++;
        const sx = (x * cell).toFixed(2), sy = (y * cell).toFixed(2);
        const sw = (w * cell).toFixed(2), sh = cell.toFixed(2);
        d += `M${sx} ${sy}h${sw}v${sh}h-${sw}z`;
        x += w;
      } else x++;
    }
  }
  return `<svg class="qr" width="${px}" height="${px}" viewBox="0 0 100 100" shape-rendering="crispEdges" role="img" aria-label="凭证二维码">
    <rect width="100" height="100" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/* ---------------- 通用片段 ---------------- */
const skeletonCard = () => `<div class="sk-card">
  <div class="sk sk-cover"></div>
  <div class="sk-body">
    <div class="sk sk-line" style="width:92%"></div>
    <div class="sk sk-line" style="width:58%"></div>
    <div style="display:flex;justify-content:space-between;margin-top:2px">
      <div class="sk sk-line" style="width:54px;height:10px"></div>
      <div class="sk sk-line" style="width:40px;height:12px"></div>
    </div>
  </div>
</div>`;

function feedCardHtml(trip) {
  const st = tripStats(trip, 2);
  return `<article class="card" data-nav="#/detail/${trip.id}">
    <div class="cover" style="--from:${trip.cover.from};--to:${trip.cover.to}">
      <div class="glow"></div>
      <span class="emoji">${trip.cover.emoji}</span>
      <span class="tag">${badge(trip.tags)}</span>
      <span class="dist">${distLabel(trip.distance)}</span>
    </div>
    <div class="cbody">
      <h3>${esc(trip.title)}</h3>
      <div class="cmeta">
        <span class="m">${trip.stops.length}站 · ${durLabel(trip.durationHours)}</span>
        <span class="p">¥${fmt(st.perPerson)}<small>/人</small></span>
      </div>
    </div>
  </article>`;
}

function statusMeta(o) {
  const map = {
    paid: { text: '待使用', cls: 'orange', action: '查看凭证' },
    partially_used: { text: '使用中', cls: 'blue', action: '查看凭证' },
    completed: { text: '已完成', cls: 'gray', action: '再次下单' },
    expired: { text: '已过期', cls: 'gray', action: '重新下单' }
  };
  return map[o.status] || map.paid;
}

function voucherSummary(o) {
  if (o.status === 'completed') return '已全部使用';
  const total = o.vouchers.length;
  const used = o.vouchers.filter(v => v.status === 'used').length;
  return `待使用 ${total - used}/${total} 张`;
}

/* ---------------- ① 注册 ---------------- */
const RegisterScreen = {
  theme: 'light',
  render() {
    return `<div class="screen">
      <div class="stepper"><i class="on"></i><i></i><i></i><em>1/3</em></div>
      <div class="scroll pad">
        <div class="brand">
          <div class="logo">🧭</div>
          <h1>开始你的下一趟</h1>
          <p>3 步完成，像点外卖一样规划出行</p>
        </div>

        <label class="field" id="fPhone">
          <span class="cc">+86</span>
          <input id="phone" inputmode="numeric" maxlength="11" placeholder="请输入手机号" autocomplete="tel">
        </label>
        <div class="field-error" id="errPhone"></div>

        <label class="field" id="fCode">
          <input id="code" inputmode="numeric" maxlength="6" placeholder="请输入 6 位验证码">
          <button class="codebtn" id="sendCode" type="button">获取验证码</button>
        </label>
        <div class="field-error" id="errCode"></div>

        <label class="agree">
          <input type="checkbox" id="agreed" checked>
          <span>我已阅读并同意<b>《用户协议》</b>和<b>《隐私政策》</b></span>
        </label>

        <button class="btn-primary" id="doRegister">注册 / 登录</button>

        <div class="divider"><span>其他方式登录</span></div>
        <div class="oauth">
          <button class="oauth-btn wx" id="wx">微信</button>
          <button class="oauth-btn qq" id="qq">QQ</button>
        </div>

        <button class="skip-demo" id="skip" type="button">先随便看看（跳过注册）</button>
        <div style="text-align:center;font-size:11px;color:#C9CDD4;margin-top:10px">v${APP_VER}</div>
      </div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    const phoneEl = $('#phone'), codeEl = $('#code'), sendBtn = $('#sendCode');
    let timer = null, cd = 0;

    const validPhone = () => /^1[3-9]\d{9}$/.test(phoneEl.value.trim());

    function startCd() {
      cd = 60;
      sendBtn.disabled = true;
      const tick = () => {
        if (cd <= 0) { sendBtn.textContent = '获取验证码'; sendBtn.disabled = false; clearInterval(timer); return; }
        sendBtn.textContent = cd + 's 后重发';
        cd--;
      };
      tick();
      timer = setInterval(tick, 1000);
    }

    sendBtn.onclick = () => {
      if (!validPhone()) {
        $('#fPhone').classList.add('err');
        $('#errPhone').textContent = '请输入正确的 11 位手机号';
        toast('请输入正确的 11 位手机号');
        return;
      }
      $('#fPhone').classList.remove('err');
      $('#errPhone').textContent = '';
      codeEl.value = '123456';
      startCd();
      toast('验证码已发送（演示：自动填入 123456）');
    };

    phoneEl.oninput = () => {
      phoneEl.value = phoneEl.value.replace(/\D/g, '').slice(0, 11);
      if (validPhone()) { $('#fPhone').classList.remove('err'); $('#errPhone').textContent = ''; }
    };

    codeEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#doRegister').click();
    });

    function finish() {
      S.auth = true;
      if (!S.nickname) S.nickname = '出行者' + (phoneEl.value.slice(-4) || '8823');
      try { ensureSeed(); } catch (e) { console.error('ensureSeed', e); }
      save();
      location.hash = '#/profile';
    }

    $('#doRegister').onclick = () => {
      if (!validPhone()) {
        $('#fPhone').classList.add('err');
        $('#errPhone').textContent = '请输入正确的 11 位手机号';
        toast('请输入正确的 11 位手机号');
        phoneEl.focus();
        return;
      }
      if (!/^\d{6}$/.test(codeEl.value.trim())) {
        $('#fCode').classList.add('err');
        $('#errCode').textContent = '请输入 6 位验证码';
        toast('请先获取并填写 6 位验证码');
        codeEl.focus();
        return;
      }
      if (!$('#agreed').checked) { toast('请先阅读并同意用户协议'); return; }
      finish();
    };

    const oauth = (label) => () => {
      toast(`已授权${label} · 继续绑定手机号`);
      phoneEl.value = '13800138000';
      codeEl.value = '123456';
      setTimeout(finish, 500);
    };
    $('#wx').onclick = oauth('微信');
    $('#qq').onclick = oauth('QQ');

    $('#skip').onclick = () => {
      S.auth = true;
      if (!S.addresses.length) {
        S.addresses.push({ id: 'a1', tag: '家', name: '阳光里小区 3 号楼', address: '朝阳区望京街道阜通东大街 6 号', detail: '2 单元 1801', isDefault: true });
        S.defaultId = 'a1';
      }
      ensureSeed();
      save();
      location.hash = '#/home';
    };
  }
};

/* ---------------- ② 画像 ---------------- */
const ProfileScreen = {
  theme: 'light',
  render() {
    const groups = Object.entries(TAXONOMY).map(([k, g]) => `
      <div class="group" data-group="${k}">
        <div class="ghead">
          <h2>${g.title}</h2>
          <span data-count="${k}">${g.mode === 'multi' ? `已选 0/${g.max}` : '单选'}</span>
        </div>
        <div class="chips">
          ${g.options.map(([id, label]) => `<button class="chip" data-k="${k}" data-v="${id}" type="button">${label}</button>`).join('')}
        </div>
      </div>`).join('');

    return `<div class="screen">
      <div class="nav">
        <button class="back" data-nav="#/register">‹</button>
        <div class="stepper sm"><i class="on"></i><i class="on"></i><i></i><em>2/3</em></div>
        <button class="textbtn" id="skipProfile" style="margin-left:auto">跳过</button>
      </div>
      <div class="scroll pad">
        <h1 class="h1">让我们更懂你</h1>
        <p class="sub">选得越准，首页越对味（可随时修改）</p>

        <div class="field-col">
          <label class="lbl">昵称（选填）<em id="dice">换一个 ⟳</em></label>
          <input class="input" id="nickname" maxlength="12" value="${esc(S.nickname)}" placeholder="起个名字吧">
        </div>

        ${groups}
        <p class="privacy">以上信息仅用于行程推荐，不会对外展示</p>
      </div>
      <div class="footer-fixed"><button class="btn-primary" id="next">下一步</button></div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    const draft = JSON.parse(JSON.stringify(S.profile));

    function paint() {
      Object.entries(TAXONOMY).forEach(([k, g]) => {
        const val = draft[k];
        const arr = Array.isArray(val) ? val : (val ? [val] : []);
        $$(`.chip[data-k="${k}"]`, root).forEach(c => {
          const on = arr.includes(c.dataset.v);
          c.classList.toggle('on', on);
          c.classList.toggle('dim', g.mode === 'multi' && arr.length >= g.max && !on);
        });
        const cnt = $(`[data-count="${k}"]`, root);
        if (g.mode === 'multi') {
          cnt.textContent = `已选 ${arr.length}/${g.max}`;
          cnt.classList.toggle('full', arr.length >= g.max);
        } else {
          cnt.textContent = val ? '已选 1' : '单选';
        }
      });
    }
    paint();

    root.addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if (!c) return;
      const k = c.dataset.k, v = c.dataset.v, g = TAXONOMY[k];
      if (g.mode === 'single') {
        draft[k] = draft[k] === v ? null : v;
      } else {
        const arr = draft[k] || [];
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
        else if (arr.length >= g.max) { toast(`最多选择 ${g.max} 个`); return; }
        else arr.push(v);
        draft[k] = arr;
      }
      paint();
    });

    const POOL = ['山野旅人', '慢行客', '周末出逃', '背着包就走', '半糖去冰', '阿罗', '小满'];
    $('#dice', root).onclick = () => {
      $('#nickname', root).value = POOL[Math.floor(Math.random() * POOL.length)] + Math.floor(Math.random() * 90 + 10);
    };

    $('#next', root).onclick = () => {
      if (!(draft.hobby || []).length) { toast('至少选择 1 个爱好'); return; }
      S.profile = draft;
      const nn = $('#nickname', root).value.trim();
      if (nn) S.nickname = nn;
      save();
      location.hash = '#/address?from=onboarding';
    };

    $('#skipProfile', root).onclick = () => { location.hash = '#/address'; };
  }
};

/* ---------------- ③ 地址（高德选点占位） ---------------- */
const POIS = [
  { name: '阳光里小区 3 号楼', line: '朝阳区望京街道阜通东大街 6 号 · 距中心 12m', tag: '家' },
  { name: '星巴克（望京SOHO店）', line: '朝阳区望京街 10 号 SOHO T1 · 120m', tag: '其他' },
  { name: '望京SOHO', line: '朝阳区望京街 10 号 · 260m', tag: '公司' },
  { name: '地铁14号线 望京站', line: '朝阳区广顺北大街 · 480m', tag: '其他' }
];

const AddressScreen = {
  theme: 'light',
  render() {
    return `<div class="screen immersive" style="background:#F1F2EE">
      <div class="map-wrap">
        <div class="map">
          <div class="road r1"></div><div class="road r2"></div><div class="road r3"></div>
          <div class="blk b1"></div><div class="blk b2"></div><div class="blk b3"></div><div class="blk b4"></div>
        </div>
        <div class="pin-shadow"></div>
        <div class="pin-center"></div>
      </div>

      <div class="searchbar">
        <button class="back" id="backAddr">‹</button>
        <div class="searchpill">🔍 搜索小区 / 写字楼 / 学校</div>
      </div>

      <button class="locate-btn" id="locateBtn">◎</button>

      <div class="sheet">
        <div class="grab"></div>
        <h2 id="addrName">${POIS[0].name}</h2>
        <p class="addrline" id="addrLine">${POIS[0].line}</p>
        <div class="poi-list">
          ${POIS.map((p, i) => `<div class="poi ${i === 0 ? 'on' : ''}" data-i="${i}">
            <span class="nm">${p.name}</span><span class="ds">${p.line.split('·').pop().trim()}</span>
          </div>`).join('')}
        </div>
        <button class="btn-primary" id="confirmAddr">确认使用该地址</button>
      </div>
    </div>`;
  },
  mount(id, params) {
    const root = $('.screen', appEl);
    const from = (params && params.from) || (S.auth && S.addresses.length ? 'me' : 'onboarding');
    let picked = 0;

    root.addEventListener('click', e => {
      const p = e.target.closest('.poi');
      if (!p) return;
      picked = Number(p.dataset.i);
      $$('.poi', root).forEach(x => x.classList.toggle('on', x === p));
      $('#addrName', root).textContent = POIS[picked].name;
      $('#addrLine', root).textContent = POIS[picked].line;
    });

    $('#backAddr', root).onclick = () => {
      goBack(from === 'onboarding' ? '#/profile' : (from === 'me' ? '#/me' : '#/home'));
    };
    $('#locateBtn', root).onclick = () => toast('已定位到当前位置');

    $('#confirmAddr', root).onclick = () => {
      const p = POIS[picked];
      if (!S.addresses.length) {
        const a = { id: 'a1', tag: p.tag, name: p.name, address: p.line.split('·')[0].trim(), detail: '', isDefault: true };
        S.addresses.push(a);
        S.defaultId = a.id;
      }
      save();
      toast('已设置为你的生活地址');
      setTimeout(() => {
        if (from === 'onboarding') location.hash = '#/home';
        else goBack(from === 'me' ? '#/me' : '#/home');
      }, 420);
    };
  }
};

/* ---------------- 首页 ---------------- */
const HomeScreen = {
  theme: 'light',
  render() {
    return `<div class="screen">
      <div class="topbar" id="topbar">
        <button class="addr-btn" data-nav="#/address?from=home">
          <span>📍 ${esc(addrShort())}</span><span class="caret">▼</span>
        </button>
        <div class="searchpill sm">🔍 搜玩法 / 美食</div>
        <button class="avatar" data-nav="#/me">${esc((S.nickname || '出')[0])}</button>
      </div>
      <div class="scroll" id="feedScroll">
        <div class="feed" id="feed"></div>
        <div id="feedFoot"></div>
      </div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    const scroll = $('#feedScroll', root);
    const feed = $('#feed', root);
    const foot = $('#feedFoot', root);
    const BATCH = 8;
    let rendered = 0, loading = false;

    /* 首屏骨架 */
    feed.innerHTML = Array.from({ length: 6 }, skeletonCard).join('');

    function appendBatch() {
      if (loading || rendered >= TRIPS.length) return;
      loading = true;
      foot.innerHTML = `<div class="loadmore"><span class="dots"><i></i><i></i><i></i></span>正在为你找更多玩法</div>`;

      setTimeout(() => {
        const next = TRIPS.slice(rendered, rendered + BATCH);
        feed.insertAdjacentHTML('beforeend', next.map(feedCardHtml).join(''));
        rendered += next.length;
        loading = false;
        foot.innerHTML = rendered >= TRIPS.length
          ? `<div class="endhint">已经到底啦 · 共 ${TRIPS.length} 个方案</div>`
          : '';
        checkFill();
      }, 320);
    }

    function checkFill() {
      if (!loading && rendered < TRIPS.length && scroll.scrollHeight <= scroll.clientHeight + 60) appendBatch();
    }

    setTimeout(() => { feed.innerHTML = ''; appendBatch(); }, 360);

    scroll.addEventListener('scroll', () => {
      $('#topbar', root).classList.toggle('stuck', scroll.scrollTop > 4);
      if (scroll.scrollTop + scroll.clientHeight > scroll.scrollHeight - 420) appendBatch();
    });
  }
};

/* ---------------- 详情 ---------------- */
function stopHtml(stop, i, total, people) {
  const last = i === total - 1;
  const typeLabel = stop.type === 'play' ? '游玩' : '餐饮';
  return `<div class="tl-row">
    <div class="tl-rail">
      <div class="tl-seg top ${i === 0 ? 'hide' : ''}"></div>
      <div class="tl-dot">${i + 1}</div>
      <div class="tl-seg bottom ${last ? 'hide' : ''}"></div>
    </div>
    <div class="tl-card">
      <div class="tl-head">
        <span>${stop.time || '—'}</span>
        <span class="pill ${stop.type === 'play' ? 'blue' : ''}">${typeLabel}</span>
        <span style="margin-left:auto">停留 ${stop.stay} 分钟</span>
      </div>
      <h3>${esc(stop.name)}</h3>
      <div class="items">
        ${stop.items.map(it => `<div class="item">
          <span class="ic">${it.icon}</span>
          <span class="nm">${esc(it.name)}</span>
          <span class="pr ${it.price ? '' : 'free'}">${it.price ? (it.mode === 'gp' ? `¥${fmt(it.price)}/团` : `¥${fmt(it.price)}/人`) : '免费'}</span>
        </div>`).join('')}
      </div>
      <div class="tl-foot">
        <span>小计 <b>${yuan(stopSubtotal(stop, people))}</b></span>
        ${stop.leg ? `<span class="leg">↓ ${stop.leg}至下一站</span>` : ''}
      </div>
    </div>
  </div>`;
}

const DetailScreen = {
  theme: 'dark',
  render(id, params) {
    const trip = TRIPS.find(t => t.id === id) || TRIPS[0];
    const people = Math.min(6, Math.max(1, Number(params.people) || 2));
    return `<div class="screen immersive">
      <div class="hero" style="--from:${trip.cover.from};--to:${trip.cover.to}">
        <div class="emoji">${trip.cover.emoji}</div>
        <div class="mask"></div>
        <div class="nav-float"><button class="back" data-back="#/home">‹</button></div>
        <div class="htext">
          <h1>${esc(trip.title)}</h1>
          <div class="hmeta">${badge(trip.tags)} · ${trip.stops.length}站 · ${durLabel(trip.durationHours)} · ${distLabel(trip.distance)}</div>
        </div>
      </div>

      <div class="scroll" id="detailScroll">
        <div class="settings">
          <div class="setrow">
            <span class="k">出行日期</span>
            <span class="v" id="dateLabel">—</span>
            <span style="font-size:12px;color:#8F959E">日历 ›</span>
          </div>
          <div class="datestrip" id="dateStrip"></div>

          <div class="setrow" style="margin-top:16px">
            <span class="k">出行人数</span>
            <div class="stepper-ui">
              <button id="minus" type="button">−</button>
              <b id="peopleNum">${people}</b>
              <button id="plus" type="button">+</button>
            </div>
            <span class="save-hint" id="saveHint"></span>
          </div>

          <div class="setrow" style="margin-bottom:16px">
            <span class="k">出发地</span>
            <span class="v">${esc(addrFull())}</span>
            <span style="font-size:9px;color:#8F959E">▼</span>
          </div>
        </div>

        <div class="section-title">行程安排 · ${trip.stops.length} 站<em>查看地图 ›</em></div>
        <div class="timeline">${trip.stops.map((s, i) => stopHtml(s, i, trip.stops.length, people)).join('')}</div>
        <div style="height:12px"></div>
      </div>

      <div class="bottombar">
        <button class="bar-icon" data-nav="#/home"><span class="ic">🏠</span>首页</button>
        <button class="bar-icon" data-nav="#/orders"><span class="ic">🎫</span>订单</button>
        <div class="priceblock">
          <div class="t" id="totalPrice">—</div>
          <div class="s" id="priceSub">—</div>
        </div>
        <button class="cta" id="orderBtn">立即下单</button>
      </div>
    </div>`;
  },
  mount(id, params) {
    const trip = TRIPS.find(t => t.id === id) || TRIPS[0];
    const root = $('.screen', appEl);
    let people = Math.min(6, Math.max(1, Number(params.people) || 2));

    /* 未来 14 天档期 */
    const dates = [];
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const dow = d.getDay();
      dates.push({
        key: dateKey(d), date: d, i,
        weekend: dow === 0 || dow === 6,
        full: i === 6 || i === 7,
        remain: i === 2 ? 3 : (i % 5 === 0 ? 12 : null)
      });
    }
    let selected = (dates.find(d => !d.full) || dates[0]).key;

    function renderStrip() {
      const st = tripStats(trip, people);
      $('#dateStrip', root).innerHTML = dates.map(d => {
        const add = d.weekend ? 50 : 0;
        return `<button class="dcell ${d.full ? 'full' : ''} ${selected === d.key ? 'on' : ''}" data-key="${d.key}" type="button">
          <span class="d1">${pad2(d.date.getMonth() + 1)}/${pad2(d.date.getDate())}</span>
          <span class="d2">${d.i === 0 ? '今天' : d.i === 1 ? '明天' : WEEK[d.date.getDay()]}</span>
          <span class="d3">¥${fmt(st.perPerson + add)}</span>
          <span class="d4">${d.full ? '已满' : d.remain ? `余${d.remain}` : ''}</span>
        </button>`;
      }).join('');
    }

    function update() {
      const st = tripStats(trip, people);
      const cur = dates.find(d => d.key === selected);
      const extra = cur && cur.weekend ? 50 * people : 0;
      const total = st.total + extra;

      $('#totalPrice', root).textContent = yuan(total);
      $('#priceSub', root).textContent = `${dateShort(selected)} · ${people}人 · 人均 ${yuan(total / people)}`;
      $('#peopleNum', root).textContent = people;
      $('#minus', root).disabled = people <= 1;
      $('#plus', root).disabled = people >= 6;
      $('#saveHint', root).textContent = st.rate < 1 ? `${people}人同行 ${(st.rate * 10).toFixed(1).replace('.0', '')} 折` : '';
      $('#dateLabel', root).textContent = dateLabel(selected);
      renderStrip();
    }

    root.addEventListener('click', e => {
      const c = e.target.closest('.dcell');
      if (!c || c.classList.contains('full')) return;
      selected = c.dataset.key;
      update();
    });

    $('#minus', root).onclick = () => { if (people > 1) { people--; update(); } };
    $('#plus', root).onclick = () => {
      if (people >= 6) { toast('最多支持 6 人，10 人以上可联系我们定制'); return; }
      people++; update();
    };

    $('#orderBtn', root).onclick = () => {
      location.hash = `#/checkout/${trip.id}?people=${people}&date=${selected}`;
    };

    update();
  }
};

/* ---------------- 确认订单 ---------------- */
const CheckoutScreen = {
  theme: 'light',
  render(id, params) {
    const trip = TRIPS.find(t => t.id === id) || TRIPS[0];
    const people = Math.min(6, Math.max(1, Number(params.people) || 2));
    const dateK = params.date || dateKey(new Date());
    const st = tripStats(trip, people);
    const d = new Date(dateK + 'T00:00:00');
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const extra = weekend ? 50 * people : 0;
    const total = st.total + extra;
    const gross = trip.stops.reduce((n, s) => n + stopSubtotal(s, people), 0);
    const discount = gross - st.total;

    const rows = trip.stops.map(s => `
      <div class="row"><span class="k">${esc(s.name)}</span><span class="v">${yuan(stopSubtotal(s, people))}</span></div>`).join('');

    return `<div class="screen">
      <div class="nav"><button class="back" data-back="#/detail/${trip.id}">‹</button><div class="title">确认订单</div></div>
      <div class="scroll">
        <div class="panel">
          <div class="row"><span class="k">出行日期</span><span class="v">${dateLabel(dateK)}</span></div>
          <div class="row"><span class="k">出行人数</span><span class="v">${people} 人</span></div>
          <div class="row"><span class="k">出发地</span><span class="v">${esc(addrFull())}</span></div>
        </div>

        <div class="panel">
          <div class="trip-brief">
            <div class="thumb" style="--from:${trip.cover.from};--to:${trip.cover.to};background:linear-gradient(145deg,${trip.cover.from},${trip.cover.to})">${trip.cover.emoji}</div>
            <div style="min-width:0">
              <h3>${esc(trip.title)}</h3>
              <p>${trip.stops.length} 站 · ${durLabel(trip.durationHours)} · ${distLabel(trip.distance)}</p>
            </div>
          </div>
        </div>

        <div class="panel">
          ${rows}
          ${discount > 0 ? `<div class="row"><span class="k">${people} 人同行折扣</span><span class="v" style="color:var(--orange)">−${yuan(discount)}</span></div>` : ''}
          ${extra > 0 ? `<div class="row"><span class="k">周末档期溢价</span><span class="v">+${yuan(extra)}</span></div>` : ''}
          <div class="row"><span class="k">服务费</span><span class="v">¥0</span></div>
          <div class="row total"><span class="k">合计</span><span class="v">${yuan(total)}</span></div>
        </div>

        <div class="panel">
          <div class="paylist">
            <div class="payopt on" data-ch="wechat">
              <span class="ic wx">💬</span><span class="nm">微信支付</span><span class="radio"></span>
            </div>
            <div class="payopt" data-ch="alipay">
              <span class="ic ali">🅐</span><span class="nm">支付宝</span><span class="radio"></span>
            </div>
          </div>
        </div>

        <label class="agree-line">
          <input type="checkbox" id="agree" checked>
          <span>我已阅读并同意<b style="color:var(--orange)">《预订须知》</b>和<b style="color:var(--orange)">《退款政策》</b></span>
        </label>
        <div style="height:20px"></div>
      </div>

      <div class="bottombar">
        <div class="priceblock" style="text-align:left">
          <div class="t">${yuan(total)}</div>
          <div class="s">${people}人 · 人均 ${yuan(total / people)}</div>
        </div>
        <button class="cta" id="payBtn">确认支付</button>
      </div>
    </div>`;
  },
  mount(id, params) {
    const trip = TRIPS.find(t => t.id === id) || TRIPS[0];
    const people = Math.min(6, Math.max(1, Number(params.people) || 2));
    const dateK = params.date || dateKey(new Date());
    const root = $('.screen', appEl);

    root.addEventListener('click', e => {
      const o = e.target.closest('.payopt');
      if (!o) return;
      $$('.payopt', root).forEach(x => x.classList.toggle('on', x === o));
      S.lastChannel = o.dataset.ch;
    });

    $('#payBtn', root).onclick = () => {
      if (!$('#agree', root).checked) { toast('请先阅读并同意预订须知'); return; }
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `<div class="box"><div class="spinner"></div><p>正在支付…</p><small>请勿关闭页面</small></div>`;
      root.appendChild(ov);

      setTimeout(() => {
        const order = createOrder(trip, people, dateK);
        location.hash = `#/success/${order.id}`;
      }, 1400);
    };
  }
};

/* ---------------- 凭证卡（成功页 / 订单详情共用） ---------------- */
function voucherCardHtml(v, opts = {}) {
  const used = v.status === 'used';
  return `<div class="vcard">
    <div class="vhead">
      <span class="vseq">${v.seq}</span>
      <h3>${esc(v.name)}</h3>
      <span class="vstatus ${used ? 'used' : ''}">${used ? '已使用' : '待使用'}</span>
    </div>

    <div class="qr-wrap">
      ${qrSvg(v.code, 168)}
      ${used ? '<div class="qr-stamp">已使用</div>' : ''}
    </div>

    <div class="redeem">
      <span>核销码</span><b>${v.redeem.slice(0, 4)} ${v.redeem.slice(4)}</b>
      <button type="button" data-act="copy" data-code="${v.redeem}">复制</button>
    </div>

    <div class="dashed"></div>

    <div class="vins">
      <p>${esc(v.note)}</p>
      <p>有效期至 ${esc(dateLabel(opts.date || dateKey(new Date())))} 23:59</p>
      ${used ? `<p>已于 ${esc(v.usedAt || '')} 核销</p>` : ''}
      ${opts.hideTip ? '' : '<p>请勿遮挡二维码，屏幕调至最亮</p>'}
    </div>
  </div>`;
}

function noticeCardHtml() {
  return `<div class="notice-card">
    <h4>核销须知</h4>
    <ul>
      <li>每张凭证对应一个目的地，到达后向工作人员出示</li>
      <li>二维码无法识别时，可向店员口述 8 位核销码</li>
      <li>建议截图保存，景区信号不佳时也能打开</li>
      <li>出行前 1 天可全额退款，当天不可退改</li>
    </ul>
  </div>`;
}

/* ---------------- 下单成功 ---------------- */
const SuccessScreen = {
  theme: 'light',
  render(id) {
    const o = S.orders.find(x => x.id === id) || S.orders[0];
    if (!o) return `<div class="screen"><div class="empty"><div class="ic">🧾</div><p>订单不存在</p></div></div>`;
    const pending = o.vouchers.filter(v => v.status === 'unused').length;

    return `<div class="screen">
      <div class="scroll">
        <div class="success-head">
          <div class="check-wrap">
            <svg viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="32" fill="#FFF3ED"/>
              <circle class="circle" cx="36" cy="36" r="26" fill="none" stroke="#FF6B2C" stroke-width="3" stroke-linecap="round" transform="rotate(-90 36 36)"/>
              <path class="tick" d="M24 37 L33 46 L49 28" fill="none" stroke="#FF6B2C" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <h1>下单成功</h1>
          <div class="amount"><small>¥</small>${fmt(o.total)}</div>
          <div class="meta">已支付 · ${o.people}人 · 人均 ${yuan(o.perPerson)} · ${dateLabel(o.travelDate)}</div>
          <div class="orderno">订单号 ${o.no}<b data-act="copy" data-code="${o.no}">复制</b></div>
          <p class="hint">凭证已发放，出行当天出示二维码核销</p>
        </div>

        <div class="vsec-head">
          <h2>${o.vouchers.length} 张凭证 · <span>${pending ? pending + ' 张待使用' : '已全部使用'}</span></h2>
          <button type="button" data-act="saveall">保存全部</button>
        </div>

        ${o.vouchers.map(v => voucherCardHtml(v, { date: o.travelDate })).join('')}
        ${noticeCardHtml()}
        <div style="height:8px"></div>
      </div>

      <div class="bottombar" style="gap:10px">
        <button class="btn-ghost" style="width:132px;height:44px" data-nav="#/order/${o.id}">查看订单详情</button>
        <button class="cta" style="flex:1;width:auto" data-nav="#/home">返回首页</button>
      </div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'copy') { toast('已复制 ' + b.dataset.code); }
      if (b.dataset.act === 'saveall') { toast('已保存到相册（演示）'); }
    });
  }
};

/* ---------------- 个人中心 ---------------- */
const MeScreen = {
  theme: 'light',
  render() {
    const pending = S.orders.filter(o => o.status === 'paid' || o.status === 'partially_used');
    const done = S.orders.filter(o => o.status === 'completed');
    const expired = S.orders.filter(o => o.status === 'expired');
    const recent = pending[0] || S.orders[0];
    const p = S.profile;
    const addr = defaultAddress();

    const chipList = (k) => {
      const v = p[k];
      const arr = Array.isArray(v) ? v : (v ? [v] : []);
      if (!arr.length) return '<span style="color:#C0C4CC">未设置</span>';
      return arr.slice(0, 3).map(x => `<span class="ch">${esc(labelOf(k, x))}</span>`).join('') +
        (arr.length > 3 ? `<span class="ch gray">+${arr.length - 3}</span>` : '');
    };

    return `<div class="screen">
      <div class="nav">
        <button class="back" data-back="#/home" aria-label="返回首页">‹</button>
        <div class="title">个人信息</div>
        <div style="width:36px"></div>
      </div>
      <div class="scroll">
        <div class="identity" data-nav="#/edit/nickname">
          <div class="big-avatar">${esc((S.nickname || '出')[0])}</div>
          <div style="min-width:0">
            <h2>${esc(S.nickname || '出行用户')}</h2>
            <p>138****8000<br>微信已绑定 · QQ 未绑定</p>
          </div>
          <span class="arrow">›</span>
        </div>

        <div class="gap"></div>

        <div class="panel" style="margin:0;border-radius:0;box-shadow:none;padding:14px 16px 6px">
          <div class="section-title" style="padding:0 0 6px">我的订单<em data-nav="#/orders">全部 ›</em></div>
          <div class="trip-counts">
            <div data-nav="#/orders?tab=unused"><b class="${pending.length ? '' : 'zero'}">${pending.length}</b><span>待使用</span></div>
            <div data-nav="#/orders?tab=done"><b class="${done.length ? '' : 'zero'}">${done.length}</b><span>已使用</span></div>
            <div data-nav="#/orders?tab=done"><b class="${expired.length ? '' : 'zero'}">${expired.length}</b><span>已过期</span></div>
          </div>
          ${recent ? `<div class="recent" data-nav="#/order/${recent.id}">
            <div class="thumb" style="background:linear-gradient(145deg,${recent.cover.from},${recent.cover.to})">${recent.cover.emoji}</div>
            <div style="min-width:0">
              <h4>${esc(recent.title)}</h4>
              <p>${dateLabel(recent.travelDate)} · ${voucherSummary(recent)}</p>
            </div>
            <span class="amt">${yuan(recent.total)}</span>
          </div>` : ''}
        </div>

        <div class="gap"></div>

        <div class="section-title" style="padding:12px 16px 6px">我的画像</div>
        <div class="inforow" data-nav="#/edit/hobby"><span class="k">爱好</span><span class="v">${chipList('hobby')}</span><span class="a">›</span></div>
        <div class="inforow" data-nav="#/edit/personality"><span class="k">性格</span><span class="v">${chipList('personality')}</span><span class="a">›</span></div>
        <div class="inforow" data-nav="#/edit/occupation"><span class="k">职业</span><span class="v">${chipList('occupation')}</span><span class="a">›</span></div>
        <div class="inforow" data-nav="#/edit/gender"><span class="k">性别</span><span class="v">${chipList('gender')}</span><span class="a">›</span></div>

        <div class="gap"></div>

        <div class="inforow" data-nav="#/address?from=me">
          <span class="k">我的地址</span>
          <span class="v">${addr ? `${esc(addr.tag)} · ${esc(addr.name)}` : '<span style="color:#C0C4CC">未设置</span>'}</span>
          <span class="a">${S.addresses.length} 个 ›</span>
        </div>

        <div class="gap"></div>

        <div class="inforow"><span class="k">手机号</span><span class="v">138****8000</span><span class="a orange">换绑</span></div>
        <div class="inforow"><span class="k">微信</span><span class="v">已绑定</span><span class="a">解绑</span></div>
        <div class="inforow"><span class="k">QQ</span><span class="v" style="color:#C0C4CC">未绑定</span><span class="a orange">绑定</span></div>

        <div class="gap"></div>

        <div class="inforow"><span class="k">通知设置</span><span class="v"></span><span class="a">›</span></div>
        <div class="inforow"><span class="k">隐私政策</span><span class="v"></span><span class="a">›</span></div>
        <div class="inforow"><span class="k">注销账号</span><span class="v"></span><span class="a">›</span></div>

        <button class="logout" id="resetBtn">退出登录 / 重置演示</button>
        <div class="version">出行 App · 原型 v${APP_VER}</div>
      </div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    $('#resetBtn', root).onclick = () => {
      sessionStorage.removeItem(STORE_KEY);
      S = blankState();
      location.hash = '#/register';
    };
  }
};

/* ---------------- 订单列表 ---------------- */
const OrdersScreen = {
  theme: 'light',
  render(id, params) {
    const tab = params.tab || 'all';
    const all = S.orders;
    const groups = {
      all: all,
      unused: all.filter(o => o.status === 'paid' || o.status === 'partially_used'),
      done: all.filter(o => o.status === 'completed' || o.status === 'expired'),
      refund: all.filter(o => o.status === 'refunded')
    };

    const tabsHtml = [
      ['all', '全部', all.length],
      ['unused', '待使用', groups.unused.length],
      ['done', '已完成', groups.done.length],
      ['refund', '退款', groups.refund.length]
    ].map(([k, label, n]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${label}<span class="cnt">${n}</span></button>`).join('');

    const list = groups[tab] || [];
    let body = '';

    if (!list.length) {
      body = `<div class="empty"><div class="ic">🧳</div><p>${tab === 'unused' ? '还没有待使用的行程' : '这里还没有记录'}</p><button data-nav="#/home">去逛逛 ›</button></div>`;
    } else if (tab === 'unused') {
      const today = list.filter(o => o.travelDate === dateKey(new Date()));
      const soon = list.filter(o => o.travelDate !== dateKey(new Date()));
      if (today.length) body += `<div class="section-head">今天出行</div>` + today.map(o => orderCardHtml(o, { hideTodayBar: true })).join('');
      if (soon.length) body += `<div class="section-head">更晚</div>` + soon.map(orderCardHtml).join('');
    } else {
      body = list.map(orderCardHtml).join('');
    }

    return `<div class="screen">
      <div class="nav"><button class="back" data-back="#/me">‹</button><div class="title">我的订单</div></div>
      <div class="tabs">${tabsHtml}</div>
      <div class="scroll" style="background:var(--bg);padding-bottom:20px">${body}</div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    root.addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (t) location.hash = `#/orders?tab=${t.dataset.tab}`;
    });
  }
};

function orderCardHtml(o, opts = {}) {
  const sm = statusMeta(o);
  const isToday = !opts.hideTodayBar && o.travelDate === dateKey(new Date());
  const d = new Date(o.travelDate + 'T00:00:00');
  return `<div class="ocard" data-nav="#/order/${o.id}">
    ${isToday ? '<div class="today-bar">今天出行</div>' : ''}
    <div class="obody">
      <div class="orow">
        <div class="thumb" style="background:linear-gradient(145deg,${o.cover.from},${o.cover.to})">${o.cover.emoji}</div>
        <div style="flex:1;min-width:0">
          <h4>${esc(o.title)}</h4>
          <div class="odate">${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} · ${o.people}人</div>
          <div class="ono">订单号 ${o.no}</div>
        </div>
        <span class="badge ${sm.cls}">${sm.text}</span>
      </div>
      <div class="oline">
        <span class="osum">${voucherSummary(o)}</span>
        <span class="oamt">${yuan(o.total)}</span>
        <span class="oact">${sm.action}</span>
      </div>
    </div>
  </div>`;
}

/* ---------------- 订单详情 ---------------- */
const OrderDetailScreen = {
  theme: 'light',
  render(id) {
    const o = S.orders.find(x => x.id === id) || S.orders[0];
    if (!o) return `<div class="screen"><div class="empty"><div class="ic">🧾</div><p>订单不存在</p></div></div>`;
    const pending = o.vouchers.filter(v => v.status === 'unused').length;
    const isDone = o.status === 'completed';

    return `<div class="screen">
      <div class="nav"><button class="back" data-back="#/orders">‹</button><div class="title">订单详情</div></div>
      <div class="scroll">
        <div class="status-head">
          <div class="st"><span class="dotx" style="background:${isDone ? '#C9CDD4' : 'var(--orange)'}"></span>${isDone ? '已完成' : '待使用'}</div>
          <p>${isDone ? '本次行程已全部核销，感谢你的出行' : `${pending} 张凭证待使用 · 有效期至 ${dateLabel(o.travelDate)} 23:59`}</p>
        </div>

        <div class="panel" style="margin-top:0">
          <div class="trip-brief">
            <div class="thumb" style="background:linear-gradient(145deg,${o.cover.from},${o.cover.to})">${o.cover.emoji}</div>
            <div style="min-width:0">
              <h3>${esc(o.title)}</h3>
              <p>${o.vouchers.length} 站 · ${dateLabel(o.travelDate)} · ${o.people} 人</p>
            </div>
          </div>
        </div>

        <div class="vsec-head">
          <h2>${o.vouchers.length} 张凭证 · <span>${pending ? pending + ' 张待使用' : '已全部使用'}</span></h2>
          ${pending ? '<button type="button" data-act="saveall">保存全部</button>' : ''}
        </div>

        ${o.vouchers.map(v => voucherCardHtml(v, { date: o.travelDate, hideTip: isDone })).join('')}

        <div class="panel">
          <div class="row"><span class="k">订单号</span><span class="v" style="font-size:12.5px">${o.no}</span></div>
          <div class="row"><span class="k">下单时间</span><span class="v" style="font-size:12.5px">${new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}</span></div>
          <div class="row"><span class="k">出行人数</span><span class="v">${o.people} 人</span></div>
          <div class="row"><span class="k">出发地址</span><span class="v" style="font-size:12.5px">${esc(o.address ? o.address.name : '未记录')}</span></div>
          <div class="row total"><span class="k">实付金额</span><span class="v">${yuan(o.total)}</span></div>
        </div>
        <div style="height:20px"></div>
      </div>

      <div class="bottombar" style="gap:10px">
        <button class="btn-ghost" style="flex:1;height:44px">联系客服</button>
        <button class="cta" style="flex:1;width:auto" data-nav="#/home">${isDone ? '再次下单' : '继续逛逛'}</button>
      </div>
    </div>`;
  },
  mount() {
    const root = $('.screen', appEl);
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'saveall') toast('已保存到相册（演示）');
      if (b.dataset.act === 'copy') toast('已复制 ' + b.dataset.code);
    });
  }
};

/* ---------------- ?demo=1 直达（跳过注册，方便快速预览） ---------------- */
(function demoBootstrap() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('demo') !== '1') return;
    if (typeof TRIPS === 'undefined' || !TRIPS.length) return;
    S.auth = true;
    if (!S.addresses.length) {
      S.addresses.push({
        id: 'a1', tag: '家', name: '阳光里小区 3 号楼',
        address: '朝阳区望京街道阜通东大街 6 号', detail: '2 单元 1801', isDefault: true
      });
      S.defaultId = 'a1';
    }
    ensureSeed();
    if (!S.profile.hobby.length) {
      S.profile = {
        hobby: ['food', 'citywalk', 'cafe'],
        personality: ['planner', 'introverted'],
        occupation: 'tech',
        gender: 'female'
      };
    }
    if (!S.orders.some(o => o.status === 'paid')) {
      createOrder(TRIPS[0], 4, dateKey(new Date()));
    }
    save();
  } catch (e) {
    console.error('demoBootstrap', e);
  }
})();

/* ---------------- 单项编辑页（只改一个字段，保存后回到个人信息） ---------------- */
const FIELD_TITLE = { hobby: '爱好', personality: '性格', occupation: '职业', gender: '性别' };
const FIELD_HINT = {
  hobby: '至少选 1 个、最多 5 个。选得越准，首页推荐越对味',
  personality: '最多选 3 个，可以不选',
  occupation: '单选，可以不选',
  gender: '单选，可以不选'
};

const EditFieldScreen = {
  theme: 'light',
  render(field) {
    if (field === 'nickname') return EditFieldScreen.renderNickname();
    const g = TAXONOMY[field];
    if (!g) return `<div class="screen"><div class="empty"><div class="ic">🤔</div><p>未知字段</p></div></div>`;

    const cur = S.profile[field];
    const arr = Array.isArray(cur) ? cur : (cur ? [cur] : []);

    return `<div class="screen">
      <div class="nav">
        <button class="back" data-back="#/me" aria-label="返回">‹</button>
        <div class="title">编辑${FIELD_TITLE[field]}</div>
        <div style="width:36px"></div>
      </div>
      <div class="scroll pad">
        <p class="sub">${FIELD_HINT[field]}</p>
        <div class="chips">
          ${g.options.map(([id, label]) => `<button class="chip ${arr.includes(id) ? 'on' : ''}" data-v="${id}" type="button">${label}</button>`).join('')}
        </div>
        <div style="text-align:center;font-size:12px;color:#8F959E;margin-top:16px" id="fieldCount">
          ${g.mode === 'multi' ? `已选 ${arr.length}/${g.max}` : (arr.length ? '已选 1' : '未选择')}
        </div>
      </div>
      <div class="footer-fixed"><button class="btn-primary" id="saveField">保存</button></div>
    </div>`;
  },

  renderNickname() {
    return `<div class="screen">
      <div class="nav">
        <button class="back" data-back="#/me" aria-label="返回">‹</button>
        <div class="title">编辑昵称</div>
        <div style="width:36px"></div>
      </div>
      <div class="scroll pad">
        <p class="sub">2–12 个字，支持中英文和 emoji；仅用于展示，不影响登录</p>
        <input class="input" id="nickInput" maxlength="12" value="${esc(S.nickname || '')}" placeholder="起个名字吧">
        <div id="nickErr" style="font-size:12px;color:var(--danger);margin-top:8px"></div>
        <button class="textbtn" id="diceNick" style="color:var(--orange);margin-top:16px;font-size:13px">换一个灵感 ⟳</button>
      </div>
      <div class="footer-fixed"><button class="btn-primary" id="saveNick">保存</button></div>
    </div>`;
  },

  mount(field) {
    const root = $('.screen', appEl);

    if (field === 'nickname') {
      const input = $('#nickInput', root);
      const err = $('#nickErr', root);
      const POOL = ['山野旅人', '慢行客', '周末出逃', '背着包就走', '半糖去冰', '阿罗', '小满', '一只橘子'];

      $('#diceNick', root).onclick = () => {
        input.value = POOL[Math.floor(Math.random() * POOL.length)] + Math.floor(Math.random() * 90 + 10);
        err.textContent = '';
      };

      $('#saveNick', root).onclick = () => {
        const v = input.value.trim().replace(/\s{2,}/g, ' ');
        const len = [...v].length;
        if (len < 2 || len > 12) { err.textContent = '昵称需 2–12 个字'; toast('昵称需 2–12 个字'); return; }
        S.nickname = v;
        save();
        toast('昵称已更新');
        goBack('#/me');
      };
      return;
    }

    const g = TAXONOMY[field];
    if (!g) return;

    const cur = S.profile[field];
    let val = Array.isArray(cur) ? [...cur] : (cur ? [cur] : []);
    const chips = $$('.chip', root);
    const counter = $('#fieldCount', root);

    function paint() {
      chips.forEach(c => {
        const on = val.includes(c.dataset.v);
        c.classList.toggle('on', on);
        c.classList.toggle('dim', g.mode === 'multi' && val.length >= g.max && !on);
      });
      counter.textContent = g.mode === 'multi'
        ? `已选 ${val.length}/${g.max}`
        : (val.length ? '已选 1' : '未选择');
    }

    root.addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if (!c) return;
      const v = c.dataset.v;
      if (g.mode === 'single') {
        val = val[0] === v ? [] : [v];
      } else {
        const i = val.indexOf(v);
        if (i >= 0) val.splice(i, 1);
        else if (val.length >= g.max) { toast(`最多选择 ${g.max} 个`); return; }
        else val.push(v);
      }
      paint();
    });

    $('#saveField', root).onclick = () => {
      if (field === 'hobby' && val.length === 0) {
        toast('爱好至少保留 1 个');
        return;
      }
      S.profile[field] = g.mode === 'multi' ? val : (val[0] || null);
      save();
      toast('已保存');
      goBack('#/me');
    };

    paint();
  }
};

/* ---------------- 路由 ---------------- */const ROUTES = {
  register: RegisterScreen,
  profile: ProfileScreen,
  address: AddressScreen,
  home: HomeScreen,
  detail: DetailScreen,
  checkout: CheckoutScreen,
  success: SuccessScreen,
  me: MeScreen,
  edit: EditFieldScreen,
  orders: OrdersScreen,
  order: OrderDetailScreen
};

function parseHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const seg = pathPart.split('/').filter(Boolean);
  return {
    name: seg[0] || 'register',
    id: seg[1],
    params: Object.fromEntries(new URLSearchParams(queryPart || ''))
  };
}

let renderedHash = '__init__';
let bootFailed = false;

/* 简易返回栈：记录走过的页面，返回时回上一页而不是写死 */
const navStack = [];
function trackHash(h) {
  if (!h) return;
  if (navStack[navStack.length - 1] !== h) navStack.push(h);
  if (navStack.length > 30) navStack.shift();
}
function goBack(fallback) {
  if (navStack[navStack.length - 1] === location.hash) navStack.pop();
  let prev = navStack[navStack.length - 1];
  if (!prev || prev === location.hash) prev = fallback || '#/home';
  location.hash = prev;
}

function render() {
  if (bootFailed) return;
  try {
    const { name, id, params } = parseHash();

    if (!S.auth && name !== 'register') {
      location.hash = '#/register';
      return;
    }

    trackHash(location.hash);
    const route = ROUTES[name] || ROUTES.register;
    deviceEl.classList.toggle('theme-dark', route.theme === 'dark');
    appEl.innerHTML = route.render(id, params);
    if (route.mount) route.mount(id, params);
    renderedHash = location.hash;
  } catch (e) {
    console.error('[render]', e);
    showFatal(e);
  }
}

function showFatal(e) {
  let bar = document.getElementById('__fatal');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = '__fatal';
    bar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:99999;background:#F53F3F;color:#fff;'
      + 'font:12px/1.6 ui-monospace,Consolas,monospace;padding:10px 14px;white-space:pre-wrap';
    deviceEl.appendChild(bar);
  }
  bar.textContent = `页面渲染出错（v${APP_VER}）：${(e && e.message) || e}\n请把这段文字反馈给我`;
}

/* 全局菜单跳转（含动态插入的卡片） */
document.addEventListener('click', e => {
  if (e.target.closest('[data-act]')) return;

  const b = e.target.closest('[data-back]');
  if (b) {
    e.preventDefault();
    goBack(b.dataset.back);
    return;
  }

  const n = e.target.closest('[data-nav]');
  if (!n) return;
  e.preventDefault();
  if (location.hash === n.dataset.nav) return;
  location.hash = n.dataset.nav;
});

window.addEventListener('hashchange', render);

/* 某些内嵌 WebView / 预览器不派发 hashchange，用轮询兜底，保证点击一定有反应 */
setInterval(() => {
  if (location.hash !== renderedHash) render();
}, 250);

/* 时钟 */
(function clock() {
  const el = $('#clock');
  const tick = () => { const d = new Date(); el.textContent = `${d.getHours()}:${pad2(d.getMinutes())}`; };
  tick();
  setInterval(tick, 30000);
})();

/* ---------------- 启动自检：data.js 未加载时给出明确提示 ---------------- */
function bootGuard() {
  const ok = typeof TRIPS !== 'undefined' && Array.isArray(TRIPS) && TRIPS.length > 0
    && typeof TAXONOMY !== 'undefined';
  if (ok && !window.__dataFailed) return true;

  bootFailed = true;
  renderedHash = location.hash;
  appEl.innerHTML = `<div class="screen" style="justify-content:center;align-items:center;padding:0 28px;text-align:center">
    <div style="font-size:52px;margin-bottom:16px">🧯</div>
    <h1 style="font-size:20px;margin-bottom:10px">数据没加载出来</h1>
    <p style="font-size:13px;line-height:1.75;color:#646A73">
      页面依赖的 <code>data.js</code> 没有成功加载，<br>所以点「注册」会没反应。
    </p>
    <p style="font-size:12px;line-height:1.75;color:#8F959E;margin:14px 0 22px">
      请刷新（Ctrl+Shift+R）。<br>若一直这样，说明当前地址加载静态资源被拦截了。
    </p>
    <button class="btn-primary" onclick="location.reload()">重新加载</button>
    <p style="font-size:11px;color:#C0C4CC;margin-top:18px">v${APP_VER}</p>
  </div>`;
  return false;
}

/* 启动 */
if (!location.hash) location.hash = S.auth ? '#/home' : '#/register';
if (bootGuard()) render();
