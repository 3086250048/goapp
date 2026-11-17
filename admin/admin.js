const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  admin: null,
  view: 'dashboard',
  tags: [],
  userPage: 1,
  userQuery: '',
  orderPage: 1,
  orderQuery: '',
  orderStatus: '',
  auditPage: 1,
  tagGroup: '',
  tagQuery: '',
  tripPage: 1,
  tripQuery: '',
  tripActive: ''
};

const VIEW_META = {
  dashboard: ['OVERVIEW', '数据概览'],
  trips: ['HOME FEED', '首页项目'],
  users: ['CUSTOMERS', '用户管理'],
  tags: ['TAXONOMY', '标签管理'],
  orders: ['ORDERS', '订单查询'],
  audit: ['AUDIT LOG', '操作日志']
};

const GROUP_LABEL = {
  hobby: '爱好',
  personality: '性格',
  occupation: '职业',
  gender: '性别'
};

const STATUS_LABEL = {
  paid: '待使用',
  partially_used: '使用中',
  completed: '已完成',
  expired: '已过期',
  refunded: '已退款'
};

const ACTION_LABEL = {
  'admin.login': '管理员登录',
  'user.create': '新增用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'tag.create': '新增标签',
  'tag.update': '修改标签',
  'tag.delete': '删除标签',
  'trip.create': '新增首页项目',
  'trip.update': '修改首页项目',
  'trip.delete': '删除首页项目'
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const fmt = value => Number(value || 0).toLocaleString('zh-CN');
const money = value => `¥${fmt(value)}`;
const displayPhone = value => {
  const phone = String(value || '');
  return phone.startsWith('demo-') ? `体验账号 ${phone.slice(5, 11)}` : phone;
};
const shortDate = value => value ? new Date(value).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).replace(/\//g, '-') : '—';
const fullDate = value => value ? new Date(value).toLocaleDateString('zh-CN') : '—';

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', headers: {}, ...options };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(path, opts);
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    if (response.status === 401 && path !== '/api/admin/login') showLogin();
    throw error;
  }
  return data;
}

function showLogin() {
  state.admin = null;
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  closeModal();
}

function showAdmin(admin) {
  state.admin = admin;
  $('#adminName').textContent = admin.username;
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  navigate('dashboard');
}

function setHeading(view) {
  const [eyebrow, title] = VIEW_META[view];
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
}

async function navigate(view) {
  state.view = view;
  setHeading(view);
  $('#view').innerHTML = '<div class="empty-state"><b>◌</b>正在加载数据…</div>';
  try {
    if (view === 'dashboard') await renderDashboard();
    if (view === 'trips') await renderTrips();
    if (view === 'users') await renderUsers();
    if (view === 'tags') await renderTags();
    if (view === 'orders') await renderOrders();
    if (view === 'audit') await renderAudit();
  } catch (error) {
    if (error.status !== 401) {
      $('#view').innerHTML = `<div class="empty-state"><b>!</b>${esc(error.message)}</div>`;
      toast(error.message);
    }
  }
}

async function loadTags(force = false) {
  if (!state.tags.length || force) {
    const data = await api('/api/admin/tags');
    state.tags = data.items;
    state.taxonomy = data.groups;
  }
  return state.tags;
}

function tagLabel(group, code) {
  const tag = state.tags.find(item => item.group === group && item.code === code);
  return tag ? tag.label : code;
}

function metricCard(icon, label, value, detail) {
  return `<article class="metric"><div class="ico">${icon}</div><label>${label}</label><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
}

async function renderDashboard() {
  const data = await api('/api/admin/dashboard');
  $('#envPill').textContent = data.demoMode ? '体验环境' : '线上环境';
  const metrics = data.metrics;
  const recentOrders = data.recentOrders.length
    ? data.recentOrders.map(order => `<div class="activity-row">
        <div class="activity-icon">🎫</div>
        <div class="activity-main"><b>${esc(order.title)}</b><small>${esc(order.user.nickname)} · ${esc(order.travelDate)} · ${order.people} 人</small></div>
        <span class="activity-amount">${money(order.total)}</span>
      </div>`).join('')
    : '<div class="empty-state"><b>◇</b>还没有订单</div>';
  const recentUsers = data.recentUsers.length
    ? data.recentUsers.map(user => `<div class="activity-row">
        <div class="avatar">${esc(user.nickname.slice(0, 1))}</div>
        <div class="activity-main"><b>${esc(user.nickname)}</b><small>${esc(displayPhone(user.phone))} · ${user.orderCount || 0} 笔订单</small></div>
        <span class="activity-amount">${money(user.spend)}</span>
      </div>`).join('')
    : '<div class="empty-state"><b>◇</b>还没有用户</div>';
  $('#view').innerHTML = `
    <div class="metric-grid">
      ${metricCard('◉', '用户总数', fmt(metrics.users), `近 7 天新增 ${metrics.newUsers7d}`)}
      ${metricCard('▤', '订单总数', fmt(metrics.orders), `今日新增 ${metrics.todayOrders}`)}
      ${metricCard('¥', '累计交易', money(metrics.revenue), '按订单实付金额汇总')}
      ${metricCard('◇', '启用标签', `${metrics.enabledTags}/${metrics.tags}`, '停用标签不进入用户画像')}
    </div>
    <div class="content-grid">
      <section class="panel">
        <div class="panel-head"><div><h2>最近订单</h2><p>最新产生的出行方案订单</p></div><button class="link-btn" data-go="orders">查看全部 ›</button></div>
        <div class="panel-body activity">${recentOrders}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>新增用户</h2><p>最近注册的用户</p></div><button class="link-btn" data-go="users">管理用户 ›</button></div>
        <div class="panel-body activity">${recentUsers}</div>
      </section>
    </div>
    <div class="content-grid">
      <section class="panel">
        <div class="panel-head"><div><h2>凭证概况</h2><p>按当前核销状态统计</p></div></div>
        <div class="panel-body metric-grid" style="grid-template-columns:1fr 1fr">
          ${metricCard('○', '待使用凭证', fmt(metrics.vouchersUnused), `共 ${metrics.vouchers} 张`)}
          ${metricCard('✓', '已使用凭证', fmt(metrics.vouchersUsed), '完成核销')}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>快捷操作</h2><p>常用管理入口</p></div></div>
        <div class="panel-body" style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="primary" data-action="add-trip">＋ 新增首页项目</button>
          <button class="secondary" data-action="add-user">新增用户</button>
          <button class="secondary" data-go="tags">管理标签</button>
          <button class="secondary" data-go="orders">查询订单</button>
        </div>
      </section>
    </div>`;
  $$('[data-go]', $('#view')).forEach(button => button.onclick = () => navigate(button.dataset.go));
  $('[data-action="add-user"]', $('#view')).onclick = () => openUserModal();
  $('[data-action="add-trip"]', $('#view')).onclick = () => openTripModal();
}

function tripBadge(tags) {
  return tags.includes('play') && tags.includes('food') ? '玩·吃' : tags.includes('play') ? '玩' : '吃';
}

async function renderTrips() {
  const params = new URLSearchParams({
    q: state.tripQuery, active: state.tripActive, page: state.tripPage, limit: 30
  });
  const data = await api(`/api/admin/trips?${params}`);
  const rows = data.items.length ? data.items.map(trip => `<tr>
    <td><div class="trip-cell"><div class="trip-thumb" style="background:linear-gradient(145deg,${esc(trip.cover.from)},${esc(trip.cover.to)})">${esc(trip.cover.emoji)}</div><div><span class="cell-main">${esc(trip.title)}</span><span class="cell-sub">${esc(trip.id)} · ${esc(trip.city)}</span></div></div></td>
    <td><span class="chip">${tripBadge(trip.tags)}</span><span class="cell-sub">${trip.stopCount} 站 · ${trip.durationHours} 小时</span></td>
    <td><span class="cell-main">${money(trip.perPerson)}/人</span><span class="cell-sub">${(trip.distance / 1000).toFixed(1)} km</span></td>
    <td><span class="cell-main">${trip.sortOrder}</span></td>
    <td><span class="status ${trip.active ? 'completed' : 'expired'}">${trip.active ? '已上线' : '已下线'}</span></td>
    <td>${shortDate(trip.updatedAt)}</td>
    <td><div class="actions">
      <button class="action" data-edit-trip="${trip.id}" title="编辑">✎</button>
      <button class="action" data-preview-trip="${trip.id}" title="预览">↗</button>
      <button class="action delete" data-delete-trip="${trip.id}" title="删除">⌫</button>
    </div></td>
  </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state"><b>▥</b>没有找到首页项目</div></td></tr>';
  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left"><label class="search"><span>⌕</span><input id="tripQuery" placeholder="搜索标题、城市或项目 ID" value="${esc(state.tripQuery)}"></label><button class="secondary" id="tripSearchBtn">搜索</button></div>
      <div class="toolbar-right"><select class="select" id="tripActive"><option value="">全部状态</option><option value="1" ${state.tripActive === '1' ? 'selected' : ''}>已上线</option><option value="0" ${state.tripActive === '0' ? 'selected' : ''}>已下线</option></select><button class="primary" id="addTripBtn">＋ 新增首页项目</button></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>项目</th><th>玩法</th><th>人均 / 距离</th><th>排序</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pager"><span>共 ${data.total} 个首页项目</span><button id="tripPrev" ${state.tripPage <= 1 ? 'disabled' : ''}>上一页</button><span>${state.tripPage}</span><button id="tripNext" ${state.tripPage * data.limit >= data.total ? 'disabled' : ''}>下一页</button></div>`;
  const search = () => {
    state.tripQuery = $('#tripQuery').value.trim();
    state.tripActive = $('#tripActive').value;
    state.tripPage = 1;
    renderTrips();
  };
  $('#tripSearchBtn').onclick = search;
  $('#tripQuery').onkeydown = event => { if (event.key === 'Enter') search(); };
  $('#tripActive').onchange = search;
  $('#addTripBtn').onclick = () => openTripModal();
  $('#tripPrev').onclick = () => { state.tripPage--; renderTrips(); };
  $('#tripNext').onclick = () => { state.tripPage++; renderTrips(); };
  $$('[data-edit-trip]').forEach(button => button.onclick = () => openTripModal(button.dataset.editTrip));
  $$('[data-preview-trip]').forEach(button => button.onclick = () => window.open(`/?demo=1#/detail/${button.dataset.previewTrip}`, '_blank'));
  $$('[data-delete-trip]').forEach(button => button.onclick = () => deleteTrip(button.dataset.deleteTrip));
}

function tripItemEditor(item = { icon: '📍', name: '', price: 0, mode: 'pp' }) {
  return `<div class="item-editor" data-item>
    <input class="mini-input icon-input" data-field="icon" value="${esc(item.icon)}" placeholder="图标" maxlength="12">
    <input class="mini-input" data-field="name" value="${esc(item.name)}" placeholder="消费项名称" maxlength="40">
    <select class="mini-input" data-field="mode"><option value="pp" ${item.mode === 'pp' ? 'selected' : ''}>每人</option><option value="gp" ${item.mode === 'gp' ? 'selected' : ''}>整团</option></select>
    <input class="mini-input price-input" data-field="price" type="number" min="0" value="${Number(item.price || 0)}" placeholder="价格">
    <button type="button" class="mini-remove" data-remove-item title="删除消费项">×</button>
  </div>`;
}

function tripStopEditor(stop = {}) {
  const items = (stop.items || []).length ? stop.items : [{ icon: '📍', name: '', price: 0, mode: 'pp' }];
  return `<section class="stop-editor" data-stop>
    <div class="stop-editor-head"><b class="stop-number">站点</b><button type="button" class="mini-remove" data-remove-stop>移除站点</button></div>
    <div class="form-grid">
      <div class="field"><label>站点名称</label><input data-field="name" maxlength="40" value="${esc(stop.name || '')}" placeholder="例如 城市博物馆" required></div>
      <div class="field"><label>类型</label><select data-field="type"><option value="play" ${stop.type !== 'food' ? 'selected' : ''}>游玩</option><option value="food" ${stop.type === 'food' ? 'selected' : ''}>餐饮</option></select></div>
      <div class="field"><label>到达时间</label><input data-field="time" type="time" value="${esc(stop.time || '10:00')}" required></div>
      <div class="field"><label>停留分钟</label><input data-field="stay" type="number" min="1" max="720" value="${Number(stop.stay || 60)}" required></div>
      <div class="field full"><label>到下一站交通</label><input data-field="leg" maxlength="40" value="${esc(stop.leg || '')}" placeholder="例如 步行 8 分钟"></div>
    </div>
    <div class="item-editor-head"><span>消费项</span><button type="button" data-add-item>＋ 添加消费项</button></div>
    <div class="item-editor-list">${items.map(tripItemEditor).join('')}</div>
  </section>`;
}

function renumberStops(form) {
  $$('.stop-editor', form).forEach((stop, index) => {
    $('.stop-number', stop).textContent = `第 ${index + 1} 站`;
  });
}

async function openTripModal(tripId = null) {
  let trip = null;
  if (tripId) trip = (await api(`/api/admin/trips/${tripId}`)).trip;
  const data = trip || {
    title: '', city: '本地', durationHours: 6, distance: 1000, tags: ['play'],
    cover: { from: '#D79A6A', to: '#8A4B2C', emoji: '🧭' },
    active: true, sortOrder: 0, stops: []
  };
  if (!data.stops.length) data.stops = [{}];
  openModal({
    title: tripId ? '编辑首页项目' : '新增首页项目',
    subtitle: '保存后会进入用户首页候选池；下线项目不会展示',
    wide: true,
    body: `<form id="tripForm" class="trip-form">
      <section class="editor-section">
        <div class="editor-section-head"><h3>基础信息</h3><span>首页卡片只展示标题、站数、时长和人均</span></div>
        <div class="form-grid">
          <div class="field full"><label>标题</label><input data-field="title" maxlength="30" value="${esc(data.title)}" placeholder="例如 周末古镇漫步 + 特色小吃" required><small>建议 12–18 字，并包含玩或食关键词</small></div>
          <div class="field"><label>城市 / 区域</label><input data-field="city" maxlength="20" value="${esc(data.city)}" required></div>
          <div class="field"><label>距离（公里）</label><input data-field="distanceKm" type="number" min="0" max="200" step="0.1" value="${(Number(data.distance || 0) / 1000).toFixed(1)}" required></div>
          <div class="field"><label>时长（小时）</label><input data-field="durationHours" type="number" min="1" max="24" value="${Number(data.durationHours || 6)}" required></div>
          <div class="field"><label>排序</label><input data-field="sortOrder" type="number" min="0" max="9999" value="${Number(data.sortOrder || 0)}"></div>
          <div class="field"><label>发布状态</label><select data-field="active"><option value="1" ${data.active ? 'selected' : ''}>上线</option><option value="0" ${!data.active ? 'selected' : ''}>下线</option></select></div>
          <div class="field"><label>内容标签</label><div class="check-grid"><label class="check-option"><input type="checkbox" name="tripTag" value="play" ${data.tags.includes('play') ? 'checked' : ''}><span>玩</span></label><label class="check-option"><input type="checkbox" name="tripTag" value="food" ${data.tags.includes('food') ? 'checked' : ''}><span>吃</span></label></div></div>
        </div>
      </section>
      <section class="editor-section">
        <div class="editor-section-head"><h3>封面</h3><span>使用品牌渐变与 emoji 占位</span></div>
        <div class="cover-editor">
          <div class="cover-preview" id="coverPreview" style="background:linear-gradient(145deg,${esc(data.cover.from)},${esc(data.cover.to)})"><span>${esc(data.cover.emoji)}</span></div>
          <div class="form-grid">
            <div class="field"><label>起始颜色</label><input data-field="coverFrom" type="color" value="${esc(data.cover.from)}"></div>
            <div class="field"><label>结束颜色</label><input data-field="coverTo" type="color" value="${esc(data.cover.to)}"></div>
            <div class="field"><label>Emoji</label><input data-field="coverEmoji" value="${esc(data.cover.emoji)}" maxlength="12"></div>
          </div>
        </div>
      </section>
      <section class="editor-section">
        <div class="editor-section-head"><h3>站点与消费明细</h3><span>一站点对应一张用户凭证</span></div>
        <div id="stopEditors">${data.stops.map(tripStopEditor).join('')}</div>
        <button type="button" class="add-stop-btn" id="addStopBtn">＋ 添加站点</button>
      </section>
    </form>`,
    footer: '<button class="secondary" data-close>取消</button><button class="primary" id="saveTripBtn">保存首页项目</button>'
  });
  const form = $('#tripForm');
  renumberStops(form);
  const updateCover = () => {
    $('#coverPreview').style.background = `linear-gradient(145deg,${$('[data-field="coverFrom"]', form).value},${$('[data-field="coverTo"]', form).value})`;
    $('#coverPreview span').textContent = $('[data-field="coverEmoji"]', form).value;
  };
  $('[data-field="coverFrom"]', form).oninput = updateCover;
  $('[data-field="coverTo"]', form).oninput = updateCover;
  $('[data-field="coverEmoji"]', form).oninput = updateCover;
  $('#addStopBtn').onclick = () => {
    if ($$('.stop-editor', form).length >= 12) return toast('最多 12 个站点');
    $('#stopEditors').insertAdjacentHTML('beforeend', tripStopEditor({}));
    renumberStops(form);
  };
  form.addEventListener('click', event => {
    const removeStop = event.target.closest('[data-remove-stop]');
    if (removeStop) {
      if ($$('.stop-editor', form).length <= 1) return toast('至少保留一个站点');
      removeStop.closest('.stop-editor').remove();
      renumberStops(form);
      return;
    }
    const addItem = event.target.closest('[data-add-item]');
    if (addItem) {
      const list = $('.item-editor-list', addItem.closest('.stop-editor'));
      if ($$('.item-editor', list).length >= 20) return toast('每站最多 20 个消费项');
      list.insertAdjacentHTML('beforeend', tripItemEditor());
      return;
    }
    const removeItem = event.target.closest('[data-remove-item]');
    if (removeItem) {
      const list = removeItem.closest('.item-editor-list');
      if ($$('.item-editor', list).length <= 1) return toast('每站至少保留一个消费项');
      removeItem.closest('.item-editor').remove();
    }
  });
  $('#saveTripBtn').onclick = async () => {
    const tags = $$('input[name="tripTag"]:checked', form).map(input => input.value);
    if (!tags.length) return toast('至少选择玩或吃标签');
    const stops = $$('.stop-editor', form).map(stop => ({
      name: $('[data-field="name"]', stop).value.trim(),
      type: $('[data-field="type"]', stop).value,
      time: $('[data-field="time"]', stop).value,
      stay: Number($('[data-field="stay"]', stop).value),
      leg: $('[data-field="leg"]', stop).value.trim(),
      items: $$('.item-editor', stop).map(item => ({
        icon: $('[data-field="icon"]', item).value.trim(),
        name: $('[data-field="name"]', item).value.trim(),
        mode: $('[data-field="mode"]', item).value,
        price: Number($('[data-field="price"]', item).value || 0)
      }))
    }));
    const payload = {
      title: $('[data-field="title"]', form).value.trim(),
      city: $('[data-field="city"]', form).value.trim(),
      durationHours: Number($('[data-field="durationHours"]', form).value),
      distance: Math.round(Number($('[data-field="distanceKm"]', form).value) * 1000),
      sortOrder: Number($('[data-field="sortOrder"]', form).value || 0),
      active: $('[data-field="active"]', form).value === '1',
      tags,
      cover: {
        from: $('[data-field="coverFrom"]', form).value,
        to: $('[data-field="coverTo"]', form).value,
        emoji: $('[data-field="coverEmoji"]', form).value.trim()
      },
      stops
    };
    const button = $('#saveTripBtn');
    button.disabled = true;
    try {
      const result = await api(tripId ? `/api/admin/trips/${tripId}` : '/api/admin/trips', {
        method: tripId ? 'PATCH' : 'POST', body: payload
      });
      closeModal();
      toast(result.warnings?.length ? result.warnings[0] : (tripId ? '首页项目已更新' : '首页项目已创建'));
      renderTrips();
      if (state.view === 'dashboard') renderDashboard();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  };
}

function deleteTrip(tripId) {
  openModal({
    title: '删除首页项目',
    subtitle: '此操作不可撤销',
    small: true,
    body: '<div class="confirm-copy">确认删除这个首页项目？<br>已产生的订单和凭证会保留历史快照，不受影响。</div>',
    footer: '<button class="secondary" data-close>取消</button><button class="primary" id="confirmDeleteTrip">确认删除</button>'
  });
  $('#confirmDeleteTrip').onclick = async () => {
    try {
      await api(`/api/admin/trips/${tripId}`, { method: 'DELETE', body: {} });
      closeModal();
      toast('首页项目已删除');
      renderTrips();
    } catch (error) {
      toast(error.message);
    }
  };
}

function profileChips(profile) {
  const values = [
    ...(profile.hobby || []).slice(0, 2).map(code => tagLabel('hobby', code)),
    ...(profile.personality || []).slice(0, 1).map(code => tagLabel('personality', code))
  ];
  if (profile.occupation) values.push(tagLabel('occupation', profile.occupation));
  if (profile.gender) values.push(tagLabel('gender', profile.gender));
  if (!values.length) return '<span class="cell-sub">未设置画像</span>';
  return `<div class="chips">${values.map(value => `<span class="chip">${esc(value)}</span>`).join('')}</div>`;
}

async function renderUsers() {
  const params = new URLSearchParams({ q: state.userQuery, page: state.userPage, limit: 20 });
  const data = await api(`/api/admin/users?${params}`);
  const rows = data.items.length ? data.items.map(user => `<tr>
    <td><div class="user-cell"><div class="avatar">${esc(user.nickname.slice(0, 1))}</div><div><span class="cell-main">${esc(user.nickname)}</span><span class="cell-sub">${esc(displayPhone(user.phone))}</span></div></div></td>
    <td>${profileChips(user.profile)}</td>
    <td>${user.addressCount || 0}</td>
    <td><span class="cell-main">${user.orderCount || 0} 笔</span><span class="cell-sub">${money(user.spend)}</span></td>
    <td>${fullDate(user.createdAt)}</td>
    <td><div class="actions">
      <button class="action" data-edit-user="${user.id}" title="编辑">✎</button>
      <button class="action delete" data-delete-user="${user.id}" title="删除">⌫</button>
    </div></td>
  </tr>`).join('') : '<tr><td colspan="6"><div class="empty-state"><b>◉</b>没有找到用户</div></td></tr>';
  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left"><label class="search"><span>⌕</span><input id="userQuery" placeholder="搜索手机号或昵称" value="${esc(state.userQuery)}"></label><button class="secondary" id="userSearchBtn">搜索</button></div>
      <div class="toolbar-right"><button class="primary" id="addUserBtn">＋ 新增用户</button></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>用户</th><th>画像</th><th>地址</th><th>订单 / 消费</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pager"><span>共 ${data.total} 位用户</span><button id="userPrev" ${state.userPage <= 1 ? 'disabled' : ''}>上一页</button><span>${state.userPage}</span><button id="userNext" ${state.userPage * data.limit >= data.total ? 'disabled' : ''}>下一页</button></div>`;
  const search = () => {
    state.userQuery = $('#userQuery').value.trim();
    state.userPage = 1;
    renderUsers();
  };
  $('#userSearchBtn').onclick = search;
  $('#userQuery').onkeydown = event => { if (event.key === 'Enter') search(); };
  $('#addUserBtn').onclick = () => openUserModal();
  $('#userPrev').onclick = () => { state.userPage--; renderUsers(); };
  $('#userNext').onclick = () => { state.userPage++; renderUsers(); };
  $$('[data-edit-user]').forEach(button => button.onclick = () => openUserModal(button.dataset.editUser));
  $$('[data-delete-user]').forEach(button => button.onclick = () => deleteUser(button.dataset.deleteUser));
}

function checkOptions(group, selected) {
  return state.tags
    .filter(tag => tag.group === group && (tag.enabled || selected.includes(tag.code)))
    .map(tag => `<label class="check-option"><input type="checkbox" name="${group}" value="${esc(tag.code)}" ${selected.includes(tag.code) ? 'checked' : ''}><span>${esc(tag.label)}</span></label>`)
    .join('');
}

async function openUserModal(userId = null) {
  await loadTags();
  let detail = null;
  if (userId) detail = await api(`/api/admin/users/${userId}`);
  const user = detail?.user || {
    phone: '', nickname: '',
    profile: { hobby: [], personality: [], occupation: null, gender: null }
  };
  const profile = user.profile || {};
  const occupationOptions = state.tags
    .filter(tag => tag.group === 'occupation' && (tag.enabled || tag.code === profile.occupation))
    .map(tag => `<option value="${esc(tag.code)}" ${profile.occupation === tag.code ? 'selected' : ''}>${esc(tag.label)}</option>`)
    .join('');
  const genderOptions = state.tags
    .filter(tag => tag.group === 'gender' && (tag.enabled || tag.code === profile.gender))
    .map(tag => `<option value="${esc(tag.code)}" ${profile.gender === tag.code ? 'selected' : ''}>${esc(tag.label)}</option>`)
    .join('');
  openModal({
    title: userId ? '编辑用户' : '新增用户',
    subtitle: '手机号是登录身份，画像标签用于后续推荐',
    body: `<form id="userForm" class="form-grid">
      <div class="field"><label>手机号</label><input name="phone" inputmode="numeric" maxlength="11" value="${esc(user.phone)}" required></div>
      <div class="field"><label>昵称</label><input name="nickname" maxlength="12" value="${esc(user.nickname)}" required></div>
      <div class="field full"><label>爱好（最多 5 个）</label><div class="check-grid">${checkOptions('hobby', profile.hobby || [])}</div></div>
      <div class="field full"><label>性格（最多 3 个）</label><div class="check-grid">${checkOptions('personality', profile.personality || [])}</div></div>
      <div class="field"><label>职业</label><select name="occupation"><option value="">未设置</option>${occupationOptions}</select></div>
      <div class="field"><label>性别</label><select name="gender"><option value="">未设置</option>${genderOptions}</select></div>
    </form>`,
    footer: '<button class="secondary" data-close>取消</button><button class="primary" id="saveUserBtn">保存用户</button>'
  });
  $$('input[name="hobby"]', $('#modalRoot')).forEach(input => input.onchange = () => {
    if ($$('input[name="hobby"]:checked', $('#modalRoot')).length > 5) {
      input.checked = false;
      toast('爱好最多选择 5 个');
    }
  });
  $$('input[name="personality"]', $('#modalRoot')).forEach(input => input.onchange = () => {
    if ($$('input[name="personality"]:checked', $('#modalRoot')).length > 3) {
      input.checked = false;
      toast('性格最多选择 3 个');
    }
  });
  $('#saveUserBtn').onclick = async () => {
    const form = $('#userForm');
    const payload = {
      phone: form.phone.value.trim(),
      nickname: form.nickname.value.trim(),
      profile: {
        hobby: $$('input[name="hobby"]:checked', form).map(input => input.value),
        personality: $$('input[name="personality"]:checked', form).map(input => input.value),
        occupation: form.occupation.value || null,
        gender: form.gender.value || null
      }
    };
    try {
      await api(userId ? `/api/admin/users/${userId}` : '/api/admin/users', {
        method: userId ? 'PATCH' : 'POST', body: payload
      });
      closeModal();
      toast(userId ? '用户已更新' : '用户已创建');
      if (state.view === 'users') renderUsers();
      if (state.view === 'dashboard') renderDashboard();
    } catch (error) {
      toast(error.message);
    }
  };
}

function deleteUser(userId) {
  openModal({
    title: '删除用户',
    subtitle: '此操作不可撤销',
    small: true,
    body: '<div class="confirm-copy">确认删除该用户？<br>其地址、订单、凭证和登录会话会一并删除。</div>',
    footer: '<button class="secondary" data-close>取消</button><button class="primary" id="confirmDeleteUser">确认删除</button>'
  });
  $('#confirmDeleteUser').onclick = async () => {
    try {
      await api(`/api/admin/users/${userId}`, { method: 'DELETE', body: {} });
      closeModal();
      toast('用户已删除');
      renderUsers();
    } catch (error) {
      toast(error.message);
    }
  };
}

async function renderTags() {
  const data = await api('/api/admin/tags');
  state.tags = data.items;
  state.taxonomy = data.groups;
  const visible = data.items.filter(tag =>
    (!state.tagGroup || tag.group === state.tagGroup) &&
    (!state.tagQuery || `${tag.code} ${tag.label}`.toLowerCase().includes(state.tagQuery.toLowerCase()))
  );
  const tabs = [['', '全部'], ...Object.keys(GROUP_LABEL).map(group => [group, GROUP_LABEL[group]])]
    .map(([group, label]) => `<button class="tag-tab ${state.tagGroup === group ? 'active' : ''}" data-group="${group}">${label}</button>`).join('');
  const cards = visible.length ? visible.map(tag => `<article class="tag-card">
    <div class="tag-card-head"><div><h3>${esc(tag.label)}</h3><code>${esc(tag.code)}</code></div><button class="toggle ${tag.enabled ? 'on' : ''}" data-toggle="${tag.id}" title="${tag.enabled ? '停用' : '启用'}"></button></div>
    <div class="tag-meta"><span>${GROUP_LABEL[tag.group]} · 排序 ${tag.sortOrder}</span><span>${tag.usage} 位用户使用</span></div>
    <div class="tag-actions"><button data-edit-tag="${tag.id}">编辑</button><button class="danger" data-delete-tag="${tag.id}">删除</button></div>
  </article>`).join('') : '<div class="empty-state" style="grid-column:1/-1"><b>◇</b>没有匹配的标签</div>';
  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left"><label class="search"><span>⌕</span><input id="tagQuery" placeholder="搜索标签名称或代码" value="${esc(state.tagQuery)}"></label><button class="secondary" id="tagSearchBtn">搜索</button></div>
      <div class="toolbar-right"><button class="primary" id="addTagBtn">＋ 新增标签</button></div>
    </div>
    <div class="tag-group-tabs">${tabs}</div>
    <div class="tag-grid">${cards}</div>`;
  $$('.tag-tab').forEach(button => button.onclick = () => {
    state.tagGroup = button.dataset.group;
    renderTags();
  });
  const searchTags = () => {
    state.tagQuery = $('#tagQuery').value.trim();
    renderTags();
  };
  $('#tagSearchBtn').onclick = searchTags;
  $('#tagQuery').onkeydown = event => { if (event.key === 'Enter') searchTags(); };
  $('#addTagBtn').onclick = () => openTagModal();
  $$('[data-toggle]').forEach(button => button.onclick = () => toggleTag(button.dataset.toggle));
  $$('[data-edit-tag]').forEach(button => button.onclick = () => openTagModal(button.dataset.editTag));
  $$('[data-delete-tag]').forEach(button => button.onclick = () => deleteTag(button.dataset.deleteTag));
}

function openTagModal(tagId = null) {
  const tag = state.tags.find(item => item.id === tagId) || {
    group: state.tagGroup || 'hobby', code: '', label: '', enabled: true, sortOrder: 0, usage: 0
  };
  const groupOptions = Object.entries(GROUP_LABEL).map(([group, label]) =>
    `<option value="${group}" ${tag.group === group ? 'selected' : ''}>${label}</option>`).join('');
  openModal({
    title: tagId ? '编辑标签' : '新增标签',
    subtitle: tag.usage ? `该标签已有 ${tag.usage} 位用户使用，修改代码或分组会使画像引用失效` : '标签停用后不再出现在用户注册和画像编辑页',
    small: true,
    body: `<form id="tagForm" class="form-grid">
      <div class="field"><label>分组</label><select name="group" ${tag.usage ? 'disabled' : ''}>${groupOptions}</select></div>
      <div class="field"><label>标签代码</label><input name="code" value="${esc(tag.code)}" ${tag.usage ? 'readonly' : ''} placeholder="例如 citywalk" required></div>
      <div class="field full"><label>显示名称</label><input name="label" maxlength="16" value="${esc(tag.label)}" placeholder="例如 城市漫步" required></div>
      <div class="field"><label>排序</label><input name="sortOrder" type="number" min="0" max="9999" value="${tag.sortOrder}"></div>
      <div class="field"><label>状态</label><select name="enabled"><option value="1" ${tag.enabled ? 'selected' : ''}>启用</option><option value="0" ${!tag.enabled ? 'selected' : ''}>停用</option></select></div>
    </form>`,
    footer: '<button class="secondary" data-close>取消</button><button class="primary" id="saveTagBtn">保存标签</button>'
  });
  $('#saveTagBtn').onclick = async () => {
    const form = $('#tagForm');
    const payload = {
      group: form.group.value,
      code: form.code.value.trim(),
      label: form.label.value.trim(),
      sortOrder: Number(form.sortOrder.value || 0),
      enabled: form.enabled.value === '1'
    };
    try {
      await api(tagId ? `/api/admin/tags/${tagId}` : '/api/admin/tags', {
        method: tagId ? 'PATCH' : 'POST', body: payload
      });
      closeModal();
      toast(tagId ? '标签已更新' : '标签已创建');
      state.tags = [];
      renderTags();
    } catch (error) {
      toast(error.message);
    }
  };
}

async function toggleTag(tagId) {
  const tag = state.tags.find(item => item.id === tagId);
  if (!tag) return;
  try {
    await api(`/api/admin/tags/${tagId}`, {
      method: 'PATCH',
      body: {
        group: tag.group, code: tag.code, label: tag.label,
        sortOrder: tag.sortOrder, enabled: !tag.enabled
      }
    });
    state.tags = [];
    toast(tag.enabled ? '标签已停用' : '标签已启用');
    renderTags();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteTag(tagId, force = false) {
  const tag = state.tags.find(item => item.id === tagId);
  if (!tag) return;
  if (!force) {
    openModal({
      title: '删除标签',
      subtitle: `${GROUP_LABEL[tag.group]} · ${tag.label}`,
      small: true,
      body: `<div class="confirm-copy">确认删除标签 <b>${esc(tag.label)}</b>？<br>${tag.usage ? `当前有 ${tag.usage} 位用户使用，继续后会同时清理用户画像。` : '该标签当前没有用户引用。'}</div>`,
      footer: '<button class="secondary" data-close>取消</button><button class="primary" id="confirmDeleteTag">确认删除</button>'
    });
    $('#confirmDeleteTag').onclick = async () => {
      try {
        await api(`/api/admin/tags/${tagId}`, { method: 'DELETE', body: {} });
        closeModal();
        state.tags = [];
        toast('标签已删除');
        renderTags();
      } catch (error) {
        if (error.data?.code === 'TAG_IN_USE') {
          closeModal();
          toast(error.message);
          deleteTag(tagId, true);
        } else {
          toast(error.message);
        }
      }
    };
    return;
  }
  openModal({
    title: '确认清理引用',
    subtitle: '此操作不可撤销',
    small: true,
    body: `<div class="confirm-copy">标签 <b>${esc(tag.label)}</b> 正被 <b>${tag.usage}</b> 位用户使用。<br>确认后会把该标签从这些用户画像中移除。</div>`,
    footer: '<button class="secondary" data-close>取消</button><button class="primary" id="forceDeleteTag">确认清理并删除</button>'
  });
  $('#forceDeleteTag').onclick = async () => {
    try {
      await api(`/api/admin/tags/${tagId}?force=1`, { method: 'DELETE', body: {} });
      closeModal();
      state.tags = [];
      toast('标签与用户引用已清理');
      renderTags();
    } catch (error) {
      toast(error.message);
    }
  };
}

async function renderOrders() {
  const params = new URLSearchParams({
    q: state.orderQuery, status: state.orderStatus, page: state.orderPage, limit: 20
  });
  const data = await api(`/api/admin/orders?${params}`);
  const rows = data.items.length ? data.items.map(order => `<tr>
    <td><span class="cell-main">${esc(order.no)}</span><span class="cell-sub">${esc(order.title)}</span></td>
    <td><span class="cell-main">${esc(order.user.nickname)}</span><span class="cell-sub">${esc(displayPhone(order.user.phone))}</span></td>
    <td>${esc(order.travelDate)}<span class="cell-sub">${order.people} 人</span></td>
    <td><span class="status ${order.status}">${STATUS_LABEL[order.status] || order.status}</span></td>
    <td>${order.vouchersUsed}/${order.voucherCount}</td>
    <td><span class="cell-main">${money(order.total)}</span><span class="cell-sub">${esc(order.channel)}</span></td>
    <td><div class="actions"><button class="action" data-view-order="${order.id}" title="查看详情">◎</button></div></td>
  </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state"><b>▤</b>没有找到订单</div></td></tr>';
  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left"><label class="search"><span>⌕</span><input id="orderQuery" placeholder="订单号、行程、手机号或昵称" value="${esc(state.orderQuery)}"></label><button class="secondary" id="orderSearchBtn">搜索</button></div>
      <div class="toolbar-right"><select class="select" id="orderStatus"><option value="">全部状态</option>${Object.entries(STATUS_LABEL).map(([value, label]) => `<option value="${value}" ${state.orderStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>订单 / 行程</th><th>用户</th><th>出行日期</th><th>状态</th><th>凭证</th><th>金额</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pager"><span>共 ${data.total} 笔订单</span><button id="orderPrev" ${state.orderPage <= 1 ? 'disabled' : ''}>上一页</button><span>${state.orderPage}</span><button id="orderNext" ${state.orderPage * data.limit >= data.total ? 'disabled' : ''}>下一页</button></div>`;
  const search = () => {
    state.orderQuery = $('#orderQuery').value.trim();
    state.orderStatus = $('#orderStatus').value;
    state.orderPage = 1;
    renderOrders();
  };
  $('#orderSearchBtn').onclick = search;
  $('#orderQuery').onkeydown = event => { if (event.key === 'Enter') search(); };
  $('#orderStatus').onchange = search;
  $('#orderPrev').onclick = () => { state.orderPage--; renderOrders(); };
  $('#orderNext').onclick = () => { state.orderPage++; renderOrders(); };
  $$('[data-view-order]').forEach(button => button.onclick = () => openOrderModal(button.dataset.viewOrder));
}

async function openOrderModal(orderId) {
  const data = await api(`/api/admin/orders/${orderId}`);
  const order = data.order;
  openModal({
    title: order.no,
    subtitle: `${order.title} · ${order.people} 人`,
    body: `
      <div class="detail-list">
        <div class="detail-row"><span>状态</span><span><b class="status ${order.status}">${STATUS_LABEL[order.status] || order.status}</b></span></div>
        <div class="detail-row"><span>用户</span><span>${esc(order.user.nickname)} · ${esc(displayPhone(order.user.phone))}</span></div>
        <div class="detail-row"><span>出行日期</span><span>${esc(order.travelDate)}</span></div>
        <div class="detail-row"><span>实付金额</span><span><b>${money(order.total)}</b> · 人均 ${money(order.perPerson)}</span></div>
        <div class="detail-row"><span>支付渠道</span><span>${esc(order.channel)}</span></div>
        <div class="detail-row"><span>出发地址</span><span>${esc(order.address?.name || '未记录')}</span></div>
      </div>
      <h3 style="font-size:14px;margin-top:22px">逐站凭证</h3>
      <div class="voucher-list">${data.vouchers.map(voucher => `<div class="voucher-row"><span>${voucher.seq}. ${esc(voucher.name)} · ${esc(voucher.redeem)}</span><b style="color:${voucher.status === 'used' ? 'var(--green)' : 'var(--orange)'}">${voucher.status === 'used' ? '已使用' : '待使用'}</b></div>`).join('')}</div>`,
    footer: '<button class="secondary" data-close>关闭</button>'
  });
}

async function renderAudit() {
  const data = await api(`/api/admin/audit?page=${state.auditPage}&limit=30`);
  const rows = data.items.length ? data.items.map(item => `<tr>
    <td><span class="cell-main">${esc(ACTION_LABEL[item.action] || item.action)}</span><span class="cell-sub">${esc(item.admin)}</span></td>
    <td>${esc(item.targetType)}<span class="cell-sub">${esc(item.targetId || '—')}</span></td>
    <td><span class="cell-main">${esc(item.ip)}</span><span class="cell-sub">${shortDate(item.createdAt)}</span></td>
    <td style="max-width:380px;white-space:normal;color:var(--sub);font-size:11.5px">${esc(JSON.stringify(item.details))}</td>
  </tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><b>◷</b>还没有操作记录</div></td></tr>';
  $('#view').innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>操作</th><th>对象</th><th>来源 / 时间</th><th>变更摘要</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pager"><span>共 ${data.total} 条记录</span><button id="auditPrev" ${state.auditPage <= 1 ? 'disabled' : ''}>上一页</button><span>${state.auditPage}</span><button id="auditNext" ${state.auditPage * data.limit >= data.total ? 'disabled' : ''}>下一页</button></div>`;
  $('#auditPrev').onclick = () => { state.auditPage--; renderAudit(); };
  $('#auditNext').onclick = () => { state.auditPage++; renderAudit(); };
}

function openModal({ title, subtitle = '', body, footer = '', small = false, wide = false }) {
  const root = $('#modalRoot');
  root.hidden = false;
  root.innerHTML = `<section class="modal ${small ? 'small' : ''} ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <header class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button class="modal-close" data-close>×</button></header>
    <div class="modal-body">${body}</div>
    ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
  </section>`;
  $$('[data-close]', root).forEach(button => button.onclick = closeModal);
}

function closeModal() {
  $('#modalRoot').hidden = true;
  $('#modalRoot').innerHTML = '';
}

$('#modalRoot').onclick = event => {
  if (event.target === $('#modalRoot')) closeModal();
};

$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  const errorEl = $('#loginError');
  errorEl.textContent = '';
  const submit = event.submitter || $('#loginForm button[type="submit"]');
  submit.disabled = true;
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: { username: $('#loginUser').value.trim(), password: $('#loginPassword').value }
    });
    showAdmin(data.admin);
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

$('#mainNav').onclick = event => {
  const button = event.target.closest('[data-view]');
  if (button) navigate(button.dataset.view);
};

$('#logoutBtn').onclick = async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch (_) {}
  showLogin();
};

$('#refreshBtn').onclick = () => navigate(state.view);

api('/api/admin/me')
  .then(data => showAdmin(data.admin))
  .catch(() => showLogin());
