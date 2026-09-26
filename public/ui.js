'use strict';

/* ============================================================
   Caller · 操作台共用交互（教师端 + 管理端）
   图标、提示条、产品内对话框、标签页键盘操作、加载 / 空 / 失败状态。
   页面脚本在它之后加载，直接使用这里的全局函数。
   ============================================================ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

/* ---------- 图标：一套 24 格、2px 描边 ---------- */
const ICONS = {
  check: 'M4 12.5 9.5 18 20 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-3.8-3.8',
  up: 'm6 15 6-6 6 6',
  down: 'm6 9 6 6 6-6',
  back: 'M19 12H5M11 18l-6-6 6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 7.5V12l3 2',
  monitor: 'M3 4.5h18v11.5H3zM8 20h8M12 16v4',
  monitorOff: 'M3 4.5h18v11.5H3zM8 20h8M12 16v4M4 2.5l16 16',
  alert: 'M12 3.5 2.5 20h19L12 3.5zM12 10v4.5M12 17.5v.01',
  megaphone: 'M3 10v4h3l7 5V5l-7 5H3zM17 9a4 4 0 0 1 0 6',
  calendar: 'M4 5.5h16V20H4zM4 10h16M8.5 3v4M15.5 3v4',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 5v14l12-7z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  users: 'M9 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18.5 14.5A6 6 0 0 1 22 21',
  user: 'M12 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  shield: 'M12 3 4.5 6v6c0 4.6 3.2 7.8 7.5 9 4.3-1.2 7.5-4.4 7.5-9V6L12 3zM9 12l2 2 4-4',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 11v6M12 7.5v.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  send: 'M4 12 20 4l-6 16-3-7-7-1z',
  inbox: 'M3 13h5l2 3h4l2-3h5M3 13l3-8h12l3 8v6H3z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  school: 'M3 21h18M5 21V9.5L12 4l7 5.5V21M10 21v-5h4v5',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  signal: 'M5 12.5a7 7 0 0 1 14 0M8.5 12.5a3.5 3.5 0 0 1 7 0M12 12.5V20',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6v.01M4.5 12v.01M4.5 18v.01',
  key: 'M14.5 4a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM10.6 13.4 3 21M6 18l2.5 2.5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name, extra) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i' + (extra ? ' ' + extra : ''));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  svg.append(p);
  return svg;
}
/** 把 HTML 里的 <svg data-icon="x"> 占位替换成真图标 */
function hydrateIcons(root) {
  for (const ph of (root || document).querySelectorAll('[data-icon]')) {
    if (ph.dataset.hydrated) continue;
    ph.dataset.hydrated = '1';
    ph.replaceWith(icon(ph.dataset.icon, ph.getAttribute('class') || ''));
  }
}

/* ---------- 提示条：aria-live；可带「撤销」 ---------- */
function toast(text, opts) {
  const o = typeof opts === 'object' && opts ? opts : { bad: Boolean(opts) };
  const t = document.getElementById('toast');
  t.innerHTML = '';
  t.classList.toggle('bad', Boolean(o.bad));
  t.append(icon(o.bad ? 'alert' : 'check', 't-icon'), el('span', '', text));
  if (o.action) {
    const b = el('button', '', o.action.label);
    b.type = 'button';
    b.onclick = () => { hide(); o.action.fn(); };
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(t._t);
  function hide() { t.classList.remove('show'); }
  t._t = setTimeout(hide, o.duration || (o.action ? 8000 : (o.bad ? 5000 : 2800)));
}

/* ---------- 按钮状态 ---------- */
function setBusy(btn, on) {
  if (!btn) return;
  btn.disabled = Boolean(on);
  if (on) btn.dataset.loading = '1'; else delete btn.dataset.loading;
}

/* ---------- 加载 / 空 / 失败 ---------- */
function skeleton(lines) {
  const s = el('div', 'skel');
  s.setAttribute('aria-label', '载入中');
  s.setAttribute('role', 'status');
  for (let i = 0; i < (lines || 4); i += 1) s.append(el('i'));
  return s;
}
function emptyState(title, text, action, center) {
  const box = el('div', 'empty-state' + (center ? ' center' : ''));
  box.append(el('strong', '', title));
  if (text) box.append(el('p', '', text));
  if (action) {
    const b = el('button', 'btn btn-secondary btn-sm', action.label);
    b.type = 'button';
    b.onclick = action.fn;
    box.append(b);
  }
  return box;
}
function errorState(text, retry) {
  const box = el('div', 'error-state');
  box.setAttribute('role', 'alert');
  box.append(icon('alert'), el('span', '', text));
  if (retry) {
    const b = el('button', 'btn btn-secondary btn-sm', '重新加载');
    b.type = 'button';
    b.onclick = retry;
    box.append(b);
  }
  return box;
}
function fill(box, ...nodes) { box.innerHTML = ''; box.append(...nodes); }

/* ---------- 产品内对话框：替代浏览器原生 confirm / prompt ---------- */
function makeDialog(cls) {
  const d = el('dialog', cls || '');
  document.body.append(d);
  d.addEventListener('close', () => setTimeout(() => d.remove(), 300));
  return d;
}

/**
 * 确认高风险操作：写清影响范围。
 * confirmDialog({ title, text, impact: [..], confirm: '删除', danger: true }) → Promise<boolean>
 */
function confirmDialog(o) {
  return new Promise((resolve) => {
    const d = makeDialog();
    const box = el('form', 'dlg-in' + (o.danger ? ' danger' : ''));
    box.method = 'dialog';
    const h = el('h2');
    h.append(icon(o.icon || (o.danger ? 'alert' : 'info')), o.title);
    box.append(h);
    if (o.text) box.append(el('p', '', o.text));
    if (o.impact && o.impact.length) {
      const ul = el('ul', 'impact');
      for (const line of o.impact) ul.append(el('li', '', line));
      box.append(ul);
    }
    if (o.node) box.append(o.node);
    const foot = el('div', 'dlg-foot');
    const no = el('button', 'btn btn-secondary', o.cancel || '取消'); no.type = 'button'; no.value = 'no';
    const yes = el('button', 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), o.confirm || '确定'); yes.value = 'yes';
    foot.append(no, yes);
    box.append(foot);
    d.append(box);
    let answer = false;
    no.onclick = () => d.close();
    box.onsubmit = (e) => { e.preventDefault(); answer = true; d.close(); };
    d.addEventListener('close', () => resolve(answer));
    d.showModal();
    (o.danger ? no : yes).focus();
  });
}

/** 多选一：choiceDialog({ title, text, choices: [{ value, label, desc, danger }] }) → Promise<value|null> */
function choiceDialog(o) {
  return new Promise((resolve) => {
    const d = makeDialog();
    const box = el('div', 'dlg-in');
    const h = el('h2'); h.append(icon(o.icon || 'info'), o.title); box.append(h);
    if (o.text) box.append(el('p', '', o.text));
    const list = el('div', 'dlg-choices');
    let answer = null;
    for (const c of o.choices) {
      const b = el('button', c.danger ? 'danger' : '');
      b.type = 'button';
      b.append(el('strong', '', c.label));
      if (c.desc) b.append(el('span', '', c.desc));
      b.disabled = Boolean(c.disabled);
      b.onclick = () => { answer = c.value; d.close(); };
      list.append(b);
    }
    box.append(list);
    const foot = el('div', 'dlg-foot');
    const no = el('button', 'btn btn-secondary', '取消'); no.type = 'button'; no.onclick = () => d.close();
    foot.append(no); box.append(foot);
    d.append(box);
    d.addEventListener('close', () => resolve(answer));
    d.showModal();
    no.focus();
  });
}

/** 输入一个值：promptDialog({ title, text, label, value, type, placeholder, maxLength, required, confirm, validate }) → Promise<string|null> */
function promptDialog(o) {
  return new Promise((resolve) => {
    const d = makeDialog();
    const box = el('form', 'dlg-in');
    const h = el('h2'); h.append(icon(o.icon || 'edit'), o.title); box.append(h);
    if (o.text) box.append(el('p', '', o.text));
    const f = el('label', 'field');
    f.append(el('span', '', o.label || ''));
    const input = o.multiline ? el('textarea') : el('input');
    if (!o.multiline) input.type = o.type || 'text';
    if (o.type === 'time') input.step = 60;
    input.value = o.value || '';
    if (o.placeholder) input.placeholder = o.placeholder;
    if (o.maxLength) input.maxLength = o.maxLength;
    input.required = Boolean(o.required);
    f.append(input);
    const err = el('small', '');
    err.style.color = 'var(--alert)';
    f.append(err);
    if (o.hint) f.append(el('small', '', o.hint));
    box.append(f);
    const foot = el('div', 'dlg-foot');
    const no = el('button', 'btn btn-secondary', '取消'); no.type = 'button'; no.onclick = () => d.close();
    const yes = el('button', 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), o.confirm || '保存');
    foot.append(no, yes); box.append(foot);
    d.append(box);
    let answer = null;
    box.onsubmit = (e) => {
      e.preventDefault();
      const problem = o.validate ? o.validate(input.value) : '';
      if (problem) { err.textContent = problem; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      answer = input.value; d.close();
    };
    d.addEventListener('close', () => resolve(answer));
    d.showModal();
    input.focus();
    if (input.select) input.select();
  });
}

/** 右侧抽屉（手机上是底部面板）：放新建、编辑等表单任务 */
function openDrawer({ title, body, submit, onSubmit, danger }) {
  const d = makeDialog('drawer');
  const form = el('form');
  form.style.display = 'contents';
  const head = el('div', 'drawer-head');
  head.append(el('h2', '', title));
  const x = el('button', 'icon-btn'); x.type = 'button'; x.setAttribute('aria-label', '关闭'); x.append(icon('x'));
  x.onclick = () => d.close();
  head.append(x);
  const main = el('div', 'drawer-body');
  main.append(body);
  const foot = el('div', 'drawer-foot');
  const no = el('button', 'btn btn-secondary', '取消'); no.type = 'button'; no.onclick = () => d.close();
  const yes = el('button', 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), submit || '保存');
  foot.append(no, yes);
  form.append(head, main, foot);
  d.append(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    setBusy(yes, true);
    let ok = false;
    try { ok = await onSubmit(form); } finally { setBusy(yes, false); }
    if (ok) d.close();
  };
  d.showModal();
  const first = main.querySelector('input, select, textarea');
  if (first) first.focus();
  return d;
}

/* ---------- 标签页：tablist / tab / tabpanel + 方向键 ---------- */
function wireTabs(list, onSelect) {
  const tabs = () => [...list.querySelectorAll('[role="tab"]')];
  list.addEventListener('click', (e) => {
    const t = e.target.closest('[role="tab"]');
    if (t) onSelect(t.dataset.tab || t.dataset.view || t.dataset.group);
  });
  list.addEventListener('keydown', (e) => {
    const all = tabs().filter((t) => !t.hidden);
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % all.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next < 0) return;
    e.preventDefault();
    all[next].focus();
    const t = all[next];
    onSelect(t.dataset.tab || t.dataset.view || t.dataset.group);
  });
}
function markTabs(list, value, key) {
  for (const t of list.querySelectorAll('[role="tab"]')) {
    const on = t.dataset[key] === value;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
}

/* ---------- 个人菜单 ---------- */
function wireMenu(button, menu) {
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) { const f = menu.querySelector('button:not([hidden]), a:not([hidden])'); if (f) f.focus(); }
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  menu.addEventListener('click', (e) => { if (e.target.closest('button, a')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); button.focus(); } });
  return close;
}

/* ---------- 消息信号轨道 ---------- */
const SIGNAL_STAGES = ['已选择', '已发送', '等待显示', '正在显示', '已收到'];
/**
 * stage：0–4 表示当前所在的站；states 可覆盖单站（如 'skip'）。
 * tone：gold（在途）/ ok（已确认）/ alert（紧急或失败）
 */
function signalTrack(stage, tone, ended) {
  const ol = el('ol', 'signal');
  ol.dataset.tone = tone || 'gold';
  ol.setAttribute('aria-label', stage < 0 ? '消息进度：尚未开始' : '消息进度：' + SIGNAL_STAGES[stage]);
  SIGNAL_STAGES.forEach((label, i) => {
    const li = el('li');
    // ended：内容已下屏，停在的那一站也算走完，后面的站保持空心
    li.dataset.state = i < stage || (ended && i === stage) ? 'done' : (i === stage ? 'now' : 'todo');
    if (li.dataset.state === 'now') li.setAttribute('aria-current', 'step');
    li.append(el('i'), el('span', '', label));
    ol.append(li);
  });
  return ol;
}

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const dateTime = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`; };
const initial = (name) => [...String(name || '?').trim()][0] || '?';
