// MedShelf UI. Views render from in-memory state; every change is saved to
// IndexedDB first and only then applied in memory.

import * as core from './core.js';
import * as db from './db.js';
import * as ai from './ai.js';
import { sampleData } from './sample.js';
import { expiryChart } from './chart.js';
import { h, icon, bot, setBotState, fmtDate, fmtMonth, fmtNum, fmtMoney, plural, daysText, toast, download, renderMarkdown } from './ui.js';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const topbarTitle = document.getElementById('topbar-title');
const topbarStatus = document.getElementById('topbar-status');
const nav = document.getElementById('nav');
const sidebarFoot = document.getElementById('sidebar-foot');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('medshelf') : null;

let state = { medicines: [], batches: [], movements: [], settings: { ...core.DEFAULT_SETTINGS } };
let aiConfig = ai.cleanAiConfig();
let askedToPersist = false;

// AI work in progress lives here so it survives moving between screens.
let briefing = null; // { day, text, busy, error }
let briefingOut = null;
let briefingBot = null;
const chat = { messages: [], busy: false, controller: null };
let scan = null; // { status: 'reading' | 'review' | 'error', ... }
let todoExpanded = false;

/* ---------- helpers ---------- */

const today = () => core.todayISO();
const ctx = () => ({ today: today(), now: new Date().toISOString(), newId });
const findMed = (id) => state.medicines.find((m) => m.id === id);
const label = (m) => core.medicineLabel(m);
const byName = (a, b) => label(a).localeCompare(label(b));
const money = (n) => fmtMoney(n, state.settings.currency);
const medSub = (m) => [m.strength, m.form].filter(Boolean).join(' · ');

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    toast(err.message || 'Something went wrong.', 'bad');
  }
}

async function commit(put, options) {
  await db.save(put, options);
  state = core.applyChanges(state, put);
  channel?.postMessage('changed');
  if (!askedToPersist) {
    askedToPersist = true;
    navigator.storage?.persist?.();
  }
}

async function saveSettings(changes) {
  const settings = core.cleanSettings({ ...state.settings, ...changes });
  await db.saveSettings(settings);
  state = { ...state, settings };
  channel?.postMessage('changed');
}

/* ---------- building blocks ---------- */

function btn(text, { icon: iconName, kind = '', size = '', href, onclick, type = 'button', disabled, title } = {}) {
  const cls = ['btn', kind, size].filter(Boolean).join(' ');
  const content = [iconName && icon(iconName, size === 'sm' ? 16 : 18), text && h('span', {}, text)];
  if (href) return h('a', { class: cls, href, title }, content);
  return h('button', { class: cls, type, onclick, disabled, title, 'aria-label': text ? null : title }, content);
}

const pageHead = (title, sub, actions = []) => h('header', { class: 'page-head' },
  h('div', {}, h('h1', {}, title), sub && h('p', { class: 'sub' }, sub)),
  actions.filter(Boolean).length > 0 && h('div', { class: 'page-actions' }, actions));

const card = (cls, ...children) => h('section', { class: `card ${cls}`.trim() }, ...children);

const cardHead = (title, { sub, iconName, botNode, actions = [] } = {}) => h('div', { class: 'card-head' },
  h('div', { class: 'card-title' },
    botNode ? h('span', { class: 'card-icon bot-icon' }, botNode) : iconName && h('span', { class: 'card-icon' }, icon(iconName, 18)),
    h('div', {}, h('h2', {}, title), sub && h('p', { class: 'muted small' }, sub))),
  actions.filter(Boolean).length > 0 && h('div', { class: 'card-actions' }, actions));

const field = (text, control, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, text), control, hint && h('small', { class: 'hint' }, hint));
const badge = (tone, text) => h('span', { class: `badge ${tone}` }, text);
const notice = (tone, iconName, ...content) => h('div', { class: `notice ${tone}` }, icon(iconName, 18), h('div', {}, ...content));

const emptyState = (iconName, title, text, ...actions) => h('div', { class: 'empty' },
  h('span', { class: 'empty-icon' }, icon(iconName, 24)), h('strong', {}, title), text && h('p', { class: 'muted' }, text),
  actions.length > 0 && h('div', { class: 'actions center' }, actions));

// On phones these tables turn into cards; each cell carries its column name as a label.
function table(heads, rows, cls = '') {
  const labels = heads.map((x) => (typeof x === 'string' ? x : x.text));
  for (const row of rows) [...row.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; });
  return h('div', { class: 'table-wrap' }, h('table', { class: `table as-cards ${cls}`.trim() },
    h('thead', {}, h('tr', {}, heads.map((x) => (typeof x === 'string' ? h('th', { scope: 'col' }, x) : h('th', { scope: 'col', class: x.cls }, x.text))))),
    h('tbody', {}, rows)));
}

function medicineBadges(row) {
  const out = [];
  if (row.expiredUnits) out.push(badge('bad', 'Expired stock'));
  if (row.onHand === 0) out.push(badge('bad', 'Out of stock'));
  else if (row.low) out.push(badge('warn', 'Low'));
  if (row.expiringUnits) out.push(badge('warn', 'Expiring'));
  if (row.riskUnits) out.push(badge('warn', 'Waste risk'));
  return out.length ? out : [badge('ok', 'OK')];
}

function connectCard(text) {
  return card('connect-card',
    bot(60),
    h('h2', {}, 'Connect AI'),
    h('p', { class: 'muted' }, text),
    btn('Connect a key', { icon: 'key', kind: 'primary', href: '#/data?section=ai' }));
}

/* ---------- navigation chrome ---------- */

const NAV = [
  { view: 'dashboard', text: 'Today', icon: 'today' },
  { view: 'stock', text: 'Stock', icon: 'stock' },
  { view: 'receive', text: 'Receive', icon: 'receive' },
  { view: 'dispense', text: 'Dispense', icon: 'dispense' },
  { view: 'assistant', text: 'Assistant', icon: 'assistant' },
  { view: 'data', text: 'Data', icon: 'data' },
];

function renderChrome(active) {
  const item = (n) => h('a', { href: `#/${n.view}`, class: `nav-item nav-${n.view}`, 'aria-current': n.view === active ? 'page' : null },
    icon(n.icon, 22), h('span', {}, n.text));
  // On phones, Receive and Dispense move behind one raised + button.
  const quick = h('button', {
    type: 'button', class: `nav-quick${active === 'receive' || active === 'dispense' ? ' active' : ''}`,
    'aria-label': 'Dispense or receive stock', onclick: openQuickSheet,
  }, h('span', { class: 'nav-quick-circle' }, icon('plus', 24)));
  nav.replaceChildren(...NAV.slice(0, 4).map(item), quick, ...NAV.slice(4).map(item));
  topbarStatus.replaceChildren(...[!navigator.onLine && h('span', { class: 'status-pill' }, icon('wifiOff', 14), 'Offline')].filter(Boolean));
  sidebarFoot.replaceChildren(...[
    h('div', { class: 'foot-item' }, icon('shield', 16), h('span', {}, 'Stock stays on this device')),
    h('a', { class: `foot-item${aiConfig.provider ? ' on' : ''}`, href: '#/data?section=ai' }, icon('assistant', 16),
      h('span', {}, aiConfig.provider ? `AI on · ${aiConfig.model}` : 'AI off · connect a key')),
    !navigator.onLine && h('div', { class: 'foot-item' }, icon('wifiOff', 16), h('span', {}, 'Offline · AI paused')),
  ].filter(Boolean));
}

/** A sheet that slides up from the bottom of the screen on phones. */
function openSheet(title, ...content) {
  const sheet = h('dialog', { class: 'dialog sheet', 'aria-label': title });
  const close = () => sheet.close();
  sheet.append(h('h2', {}, title), ...content.filter(Boolean).map((c) => (typeof c === 'function' ? c(close) : c)), btn('Cancel', { kind: 'ghost', onclick: close }));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  sheet.addEventListener('close', () => sheet.remove());
  document.body.append(sheet);
  sheet.showModal();
}

function openQuickSheet() {
  const option = (href, iconName, title, text, after) => (close) => h('a', {
    class: 'sheet-option', href,
    onclick: () => {
      close();
      if (after) setTimeout(after, 80);
    },
  }, h('span', { class: 'sheet-icon' }, icon(iconName, 20)), h('span', { class: 'sheet-text' }, h('strong', {}, title), h('small', {}, text)), icon('next', 16));
  openSheet('What would you like to do?', (close) => h('div', { class: 'sheet-options' },
    option('#/dispense', 'dispense', 'Dispense', 'Take stock off the shelf, oldest batch first')(close),
    option('#/receive', 'receive', 'Receive stock', 'Add a delivery, batch by batch')(close),
    aiConfig.provider && option('#/receive', 'camera', 'Scan an invoice', 'Photograph the paperwork and let AI read it',
      () => document.querySelector('.scan-card input[capture]')?.click())(close)));
}

/* ---------- Today ---------- */

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function viewToday() {
  if (!state.medicines.length) return viewWelcome();
  const t = today();
  const s = core.summarize(state, t, state.settings);
  const { totals } = s;
  const kpi = (iconName, tone, title, big, sub, href) => h('a', { class: `kpi ${tone}`, href },
    h('span', { class: 'kpi-icon' }, icon(iconName, 20)),
    h('span', { class: 'kpi-title' }, title),
    h('strong', { class: 'kpi-value' }, big),
    h('span', { class: 'kpi-sub' }, sub));

  return h('div', { class: 'page' },
    pageHead(greeting(), `${fmtDate(t, { weekday: true })} · ${plural(state.medicines.length, 'medicine')} · ${money(totals.stockValue)} of in-date stock`),
    backupNudge(),
    h('div', { class: 'kpis' },
      kpi('alert', totals.expiredUnits ? 'bad' : 'ok', 'Expired on the shelf', plural(totals.expiredUnits, 'unit'),
        totals.expiredUnits ? `${money(totals.expiredValue)} to write off` : 'Nothing to remove', '#/stock?filter=expired'),
      kpi('clock', totals.expiringUnits ? 'warn' : 'ok', `Expiring in ${state.settings.warnDays} days`, plural(totals.expiringUnits, 'unit'),
        `${money(totals.expiringValue)} to sell first`, '#/stock?filter=expiring'),
      kpi('waste', totals.riskUnits ? 'warn' : 'ok', 'Likely to expire unsold', plural(totals.riskUnits, 'unit'),
        `${money(totals.riskValue)} at risk`, '#/stock?filter=risk'),
      kpi('cart', totals.lowCount ? 'info' : 'ok', 'Need reordering', plural(totals.lowCount, 'medicine'), 'low or out of stock', '#/stock?filter=low')),
    h('div', { class: 'grid-2' },
      todoCard(s),
      h('div', { class: 'stack' }, briefingCard(), outlookCard(t))),
    reorderCard(s));
}

function todoItems(s) {
  const items = [];
  const view = (m) => btn('View', { href: `#/stock/${m.id}`, size: 'sm', kind: 'ghost' });
  for (const { medicine, batch } of s.expired) {
    items.push({
      tone: 'bad', icon: 'alert', title: `Remove ${fmtNum(batch.qty)} × ${label(medicine)}`,
      detail: `Batch ${batch.batchNo || '(no number)'} expired ${fmtDate(batch.expiry)} · worth ${money(batch.qty * (batch.unitCost ?? 0))}`,
      action: btn('Write off', { size: 'sm', onclick: () => openWriteOff(batch) }),
    });
  }
  const low = s.rows.filter((r) => r.low).sort((a, b) => a.onHand - b.onHand || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
  for (const r of low) {
    const out = r.onHand === 0;
    items.push({
      tone: out ? 'bad' : 'warn', icon: 'cart', title: out ? `${label(r.medicine)} is out of stock` : `Reorder ${label(r.medicine)}`,
      detail: [
        !out && `${fmtNum(r.onHand)} left`,
        !out && r.daysLeft !== null && `about ${plural(Math.floor(r.daysLeft), 'day')} of stock`,
        r.orderQty ? `suggested order ${fmtNum(r.orderQty)}` : 'set a reorder level to get a suggested order',
      ].filter(Boolean).join(' · '),
      action: view(r.medicine),
    });
  }
  const riskBatches = new Set();
  const risky = s.rows.flatMap((r) => r.risks.map((risk) => ({ r, risk })))
    .sort((a, b) => b.risk.atRisk * b.risk.unitCost - a.risk.atRisk * a.risk.unitCost);
  for (const { r, risk } of risky) {
    riskBatches.add(risk.batchId);
    items.push({
      tone: 'warn', icon: 'waste', title: `About ${fmtNum(risk.atRisk)} × ${label(r.medicine)} won't sell in time`,
      detail: `Batch ${risk.batchNo || '(no number)'} expires ${fmtDate(risk.expiry)}. Put it at the front, return it, or send it to a branch that uses more.`,
      action: view(r.medicine),
    });
  }
  for (const { medicine, batch, daysLeft } of s.expiring) {
    if (daysLeft > 30 || riskBatches.has(batch.id)) continue;
    items.push({
      tone: 'info', icon: 'clock', title: `Sell first: ${label(medicine)}`,
      detail: `Batch ${batch.batchNo || '(no number)'} expires ${daysText(daysLeft)} · ${plural(batch.qty, 'unit')} left`,
      action: view(medicine),
    });
  }
  return items;
}

function todoCard(s) {
  const items = todoItems(s);
  const shown = todoExpanded ? items : items.slice(0, 6);
  return card('todo-card',
    cardHead('To do', { sub: items.length ? `${plural(items.length, 'thing')} ${items.length === 1 ? 'needs' : 'need'} attention` : 'Nothing needs attention' }),
    items.length
      ? h('ul', { class: 'todo' }, shown.map((it) => h('li', { class: `todo-item ${it.tone}` },
        h('span', { class: 'todo-icon' }, icon(it.icon, 18)),
        h('div', { class: 'todo-text' }, h('strong', {}, it.title), h('span', {}, it.detail)),
        it.action)))
      : emptyState('check', 'All clear', 'Nothing has expired, nothing is low, and no waste is predicted.'),
    items.length > 6 && h('div', { class: 'card-foot' }, btn(todoExpanded ? 'Show fewer' : `Show all ${items.length}`, {
      kind: 'ghost', size: 'sm', onclick: () => { todoExpanded = !todoExpanded; render(); },
    })));
}

function briefingCard() {
  if (!aiConfig.provider) {
    return card('ai-card',
      cardHead('Daily briefing', { botNode: bot(36) }),
      h('p', { class: 'muted' }, 'Connect your OpenAI or Claude key to get a plain-English plan for the day, scan invoices with your camera, and ask questions about your stock.'),
      btn('Connect AI', { icon: 'key', kind: 'primary', size: 'sm', href: '#/data?section=ai' }));
  }
  if (briefing && briefing.day !== today()) briefing = null;
  const out = h('div', { class: 'ai-output' });
  briefingOut = out;
  paintBriefing(out);
  const busy = briefing?.busy;
  briefingBot = bot(36, busy ? (briefing.text ? 'talking' : 'thinking') : 'idle');
  return card('ai-card',
    cardHead('Daily briefing', {
      botNode: briefingBot,
      sub: `${ai.PROVIDERS[aiConfig.provider].name} · ${aiConfig.model}`,
      actions: [btn(briefing?.text ? 'Refresh' : "Write today's plan", {
        icon: briefing?.text ? 'refresh' : 'assistant', kind: briefing?.text ? 'ghost' : 'primary', size: 'sm', disabled: busy,
        onclick: () => act(runBriefing),
      })],
    }),
    out,
    briefing?.text && !busy && h('div', { class: 'card-foot' }, btn('Ask a follow-up', { icon: 'next', kind: 'ghost', size: 'sm', onclick: continueBriefing })));
}

function paintBriefing(out = briefingOut) {
  if (!out) return;
  if (briefing?.error) out.replaceChildren(notice('bad', 'alert', briefing.error));
  else if (briefing?.text) out.replaceChildren(renderMarkdown(briefing.text));
  else if (briefing?.busy) out.replaceChildren(h('div', { class: 'thinking' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i')), 'Reading your stock…'));
  else out.replaceChildren(h('p', { class: 'muted' }, 'Get the most important things to do today, worked out from your stock.'));
}

async function runBriefing() {
  briefing = { day: today(), text: '', busy: true };
  render();
  const current = briefing;
  try {
    await ai.streamChat(aiConfig, {
      system: ai.assistantSystem(core.aiStockContext(state, today(), state.settings)),
      messages: [{ role: 'user', content: ai.BRIEFING_PROMPT }],
    }, (text) => {
      current.text = text;
      if (briefingOut?.isConnected) {
        setBotState(briefingBot, 'talking');
        paintBriefing();
      }
    });
  } catch (err) {
    current.error = err.message;
  } finally {
    current.busy = false;
    if (currentRoute().name === 'dashboard') render();
  }
}

function continueBriefing() {
  chat.messages = [
    { role: 'user', content: ai.BRIEFING_PROMPT, display: "Today's briefing" },
    { role: 'assistant', content: briefing.text },
  ];
  location.hash = '#/assistant';
}

function outlookCard(t) {
  const outlook = core.expiryOutlook(state, t, 12);
  const useValue = state.batches.some((b) => b.qty > 0 && (b.unitCost ?? 0) > 0);
  const range = `${fmtMonth(outlook.months[0].month, 'long')} to ${fmtMonth(outlook.months.at(-1).month, 'long')}`;
  return card('',
    cardHead('Expiry outlook', { sub: `${useValue ? 'Value of stock' : 'Units'} by the month it expires, ${range}` }),
    expiryChart(outlook, { money, currency: state.settings.currency, useValue }));
}

function reorderCard(s) {
  const low = s.rows.filter((r) => r.low).sort((a, b) => a.onHand - b.onHand);
  if (!low.length) return null;
  return card('',
    cardHead('Order list', {
      sub: 'Enough to cover the delivery wait plus your order period, based on the last 30 days of sales',
      actions: [btn('Download CSV', { icon: 'download', size: 'sm', onclick: () => downloadReorder(low) })],
    }),
    table(['Medicine', { text: 'In stock', cls: 'num' }, { text: 'Sells per day', cls: 'num hide-sm' }, 'Runs out', { text: 'Order', cls: 'num' }],
      low.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/stock/${r.medicine.id}`, class: 'med-name' }, r.medicine.name), h('span', { class: 'med-sub' }, medSub(r.medicine))),
        h('td', { class: 'num' }, fmtNum(r.onHand)),
        h('td', { class: 'num hide-sm' }, r.avgDaily ? fmtNum(r.avgDaily) : '—'),
        h('td', {}, r.onHand === 0 ? badge('bad', 'Out now') : r.daysLeft === null ? '—' : `in ~${plural(Math.floor(r.daysLeft), 'day')}`),
        h('td', { class: 'num' }, r.orderQty ? h('strong', {}, fmtNum(r.orderQty)) : h('span', { class: 'muted small' }, 'Set a reorder level'))))));
}

function downloadReorder(rows) {
  const lines = [['medicine', 'strength', 'form', 'in_stock', 'sells_per_day', 'suggested_order']];
  for (const r of rows) lines.push([r.medicine.name, r.medicine.strength, r.medicine.form, r.onHand, Math.round(r.avgDaily * 10) / 10, r.orderQty]);
  download(`medshelf-order-${today()}.csv`, core.toCSV(lines), 'text/csv');
}

function backupNudge() {
  const last = state.settings.lastBackup;
  const days = last ? core.daysBetween(last.slice(0, 10), today()) : null;
  if (days !== null && days < 7) return null;
  return notice('warn', 'shield',
    h('span', {}, last ? `Your last backup was ${plural(days, 'day')} ago. ` : 'Your stock is saved only in this browser on this device. '),
    h('a', { href: '#/data?section=backup' }, 'Download a backup'));
}

function viewWelcome() {
  const feature = (iconName, title, text) => h('div', { class: 'feature' },
    h('span', { class: 'feature-icon' }, icon(iconName, 22)), h('strong', {}, title), h('p', {}, text));
  return h('div', { class: 'page welcome' },
    h('div', { class: 'hero' },
      h('span', { class: 'eyebrow' }, icon('shield', 16), 'Free and open source · Works offline · Data stays on your device'),
      h('h1', {}, 'Stop losing money to expired medicine'),
      h('p', { class: 'lead' }, 'MedShelf tracks every batch and its expiry date, sells the oldest stock first, warns you before medicine expires or runs out, and tells you exactly what to order.'),
      h('div', { class: 'actions' },
        btn('Add your first delivery', { icon: 'plus', kind: 'primary', href: '#/receive' }),
        btn('Try it with sample data', { icon: 'next', onclick: () => act(loadSample) }),
        btn('Import a spreadsheet', { kind: 'ghost', href: '#/data?section=import' }))),
    h('div', { class: 'features' },
      feature('alert', 'Catch expired stock', 'See what to take off the shelf today, and what it cost you.'),
      feature('waste', 'Predict waste', 'Find batches that will expire before they sell, while there is still time to act.'),
      feature('cart', 'Order the right amount', 'Reorder suggestions from your real sales, ready to send to your supplier.'),
      feature('assistant', 'AI built in', 'Scan invoices with your camera and ask questions about your stock, using your own OpenAI or Claude key.')));
}

async function loadSample() {
  await commit(sampleData(today(), newId));
  toast('Sample data loaded. You can erase it on the Data page.');
  render();
}

/* ---------- Stock ---------- */

const FILTERS = [
  ['all', 'All', () => true],
  ['low', 'Low or out', (r) => r.low],
  ['expiring', 'Expiring', (r) => r.expiringUnits > 0],
  ['expired', 'Expired', (r) => r.expiredUnits > 0],
  ['risk', 'Waste risk', (r) => r.riskUnits > 0],
];

function viewStock(id, params) {
  if (id) return viewMedicine(id);
  const t = today();
  const { rows } = core.summarize(state, t, state.settings);
  rows.sort((a, b) => byName(a.medicine, b.medicine));
  let filter = FILTERS.some(([k]) => k === params.get('filter')) ? params.get('filter') : 'all';
  let query = '';
  const coverTarget = state.settings.leadDays + state.settings.coverDays;
  const tbody = h('tbody');
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show' });

  const paint = () => {
    const test = FILTERS.find(([k]) => k === filter)[2];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = rows.filter((r) => test(r) && words.every((w) => label(r.medicine).toLowerCase().includes(w)));
    chips.replaceChildren(...FILTERS.map(([k, text, fn]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(k === filter),
      onclick: () => {
        filter = k;
        history.replaceState(null, '', k === 'all' ? '#/stock' : `#/stock?filter=${k}`);
        paint();
      },
    }, text, h('span', { class: 'chip-count' }, rows.filter(fn).length))));
    tbody.replaceChildren(...shown.map((r) => stockRow(r, t, coverTarget)));
    if (!shown.length) tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'empty-row' }, rows.length ? 'No medicine matches.' : 'No stock yet.')));
  };
  paint();

  return h('div', { class: 'page' },
    pageHead('Stock', `${plural(rows.length, 'medicine')} · ${plural(state.batches.filter((b) => b.qty > 0).length, 'batch', 'batches')} on the shelf`,
      [btn('Receive stock', { icon: 'plus', kind: 'primary', href: '#/receive' })]),
    card('table-card',
      h('div', { class: 'toolbar' },
        h('label', { class: 'search' }, icon('search', 18),
          h('input', { type: 'search', placeholder: 'Search medicines', 'aria-label': 'Search medicines', oninput: (e) => { query = e.target.value; paint(); } })),
        chips),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table clickable stock-table' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Medicine'), h('th', { scope: 'col' }, 'In stock'), h('th', { scope: 'col', class: 'hide-sm' }, 'Next expiry'),
          h('th', { scope: 'col', class: 'num hide-sm' }, 'Days of stock'), h('th', { scope: 'col' }, 'Status'))),
        tbody))));
}

function stockRow(r, t, coverTarget) {
  const cover = h('span', { class: `cover${r.low ? ' low' : ''}` }, h('span', {}));
  cover.firstChild.style.width = `${r.daysLeft === null ? (r.onHand ? 100 : 0) : Math.min(100, (r.daysLeft / coverTarget) * 100)}%`;
  return h('tr', { onclick: (e) => { if (!e.target.closest('a')) location.hash = `#/stock/${r.medicine.id}`; } },
    h('td', {}, h('a', { href: `#/stock/${r.medicine.id}`, class: 'med-name' }, r.medicine.name), h('span', { class: 'med-sub' }, medSub(r.medicine))),
    h('td', {}, h('div', { class: 'qty-cell' }, h('strong', {}, fmtNum(r.onHand)), cover)),
    h('td', { class: 'hide-sm' }, r.nextExpiry ? [fmtDate(r.nextExpiry), h('span', { class: 'med-sub' }, daysText(core.daysBetween(t, r.nextExpiry)))] : '—'),
    h('td', { class: 'num hide-sm' }, r.daysLeft === null ? '—' : fmtNum(Math.floor(r.daysLeft))),
    h('td', {}, h('div', { class: 'badges' }, medicineBadges(r))));
}

function viewMedicine(id) {
  const med = findMed(id);
  if (!med) {
    return h('div', { class: 'page' }, pageHead('Not found', 'This medicine is not in your stock.'), btn('Back to stock', { icon: 'back', href: '#/stock' }));
  }
  const t = today();
  const row = core.summarize({ ...state, medicines: [med] }, t, state.settings).rows[0];
  const batches = state.batches.filter((b) => b.medicineId === id && b.qty > 0).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const history = state.movements.filter((m) => m.medicineId === id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  const batchNo = (bid) => state.batches.find((b) => b.id === bid)?.batchNo || '—';
  const kinds = { receive: ['Received', 'ok'], dispense: ['Dispensed', 'info'], writeoff: ['Written off', 'bad'] };
  const value = batches.filter((b) => b.expiry >= t).reduce((sum, b) => sum + b.qty * (b.unitCost ?? 0), 0);
  const stat = (name, big, small) => h('div', { class: 'stat' }, h('span', {}, name), h('strong', {}, big), small && h('small', {}, small));

  const levelForm = h('form', {
    class: 'inline-form',
    onsubmit: (e) => {
      e.preventDefault();
      act(async () => {
        const level = Number(e.target.elements.level.value);
        if (!Number.isInteger(level) || level < 0) throw new RangeError('Reorder level must be a whole number, zero or more.');
        await commit({ medicines: [{ ...med, reorderLevel: level }] });
        toast('Reorder level saved.');
        render();
      });
    },
  }, field('Units', h('input', { name: 'level', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: med.reorderLevel ?? 0 })),
  btn('Save', { type: 'submit' }));

  return h('div', { class: 'page' },
    h('a', { class: 'back-link', href: '#/stock' }, icon('back', 16), 'All stock'),
    pageHead(med.name, medSub(med) || null, [
      btn('Dispense', { icon: 'dispense', kind: 'primary', href: `#/dispense/${id}` }),
      btn('Receive more', { icon: 'receive', href: `#/receive/${id}` }),
    ]),
    h('div', { class: 'badges spaced' }, medicineBadges(row)),
    h('div', { class: 'stats' },
      stat('In stock', fmtNum(row.onHand), 'in-date units'),
      stat('Sells per day', row.avgDaily ? fmtNum(row.avgDaily) : '—', 'last 30 days'),
      stat('Runs out', row.daysLeft === null ? '—' : `~${plural(Math.floor(row.daysLeft), 'day')}`),
      stat('Suggested order', row.orderQty ? fmtNum(row.orderQty) : '—'),
      stat('Stock value', money(value))),
    h('div', { class: 'grid-2 wide-left' },
      card('',
        cardHead('Batches on the shelf', { sub: 'Earliest expiry first. Expired batches are never dispensed.' }),
        batches.length
          ? table(['Batch', 'Expiry', { text: 'Units', cls: 'num' }, { text: 'Cost', cls: 'num hide-sm' }, 'Status', ''], batches.map((b) => {
            const status = core.expiryStatus(b.expiry, t, state.settings.warnDays);
            const [text, tone] = { expired: ['Expired', 'bad'], expiring: ['Expiring', 'warn'], ok: ['OK', 'ok'] }[status];
            return h('tr', {},
              h('td', {}, h('strong', {}, b.batchNo || '—')),
              h('td', {}, fmtDate(b.expiry), h('span', { class: 'med-sub' }, daysText(core.daysBetween(t, b.expiry)))),
              h('td', { class: 'num' }, fmtNum(b.qty)),
              h('td', { class: 'num hide-sm' }, money(b.unitCost ?? 0)),
              h('td', {}, badge(tone, text)),
              h('td', { class: 'num' }, btn('Write off', { size: 'sm', kind: 'ghost', onclick: () => openWriteOff(b) })));
          }))
          : emptyState('stock', 'Nothing on the shelf', 'Receive a delivery to add a batch.')),
      card('',
        cardHead('Reorder level'),
        h('p', { class: 'muted small' }, 'MedShelf flags this medicine when in-date stock falls to this many units.'),
        levelForm)),
    card('',
      cardHead('History', { sub: history.length === 100 ? 'Latest 100 movements' : null }),
      history.length
        ? table(['Date', 'What happened', 'Batch', { text: 'Units', cls: 'num' }, { text: 'Note', cls: 'hide-sm' }], history.map((m) => h('tr', {},
          h('td', {}, fmtDate(m.date)),
          h('td', {}, badge(kinds[m.type][1], kinds[m.type][0])),
          h('td', {}, batchNo(m.batchId)),
          h('td', { class: 'num' }, fmtNum(m.qty)),
          h('td', { class: 'hide-sm muted' }, m.note || ''))))
        : h('p', { class: 'muted' }, 'Nothing yet.')));
}

function openWriteOff(batch) {
  const med = findMed(batch.medicineId);
  const expired = core.expiryStatus(batch.expiry, today(), state.settings.warnDays) === 'expired';
  const reasons = ['Expired', 'Damaged', 'Recalled', 'Returned to supplier', 'Stock count correction'];
  const dialog = h('dialog', { class: 'dialog' });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      act(async () => {
        const qty = Number(form.elements.qty.value);
        await commit(core.writeOff(state, batch.id, qty, form.elements.reason.value, ctx()));
        dialog.close();
        toast(`Wrote off ${fmtNum(qty)} × ${label(med)}.`);
        render();
      });
    },
  },
  h('div', { class: 'dialog-head' }, h('span', { class: 'todo-icon bad' }, icon('trash', 18)), h('h2', {}, 'Write off stock')),
  h('p', { class: 'muted' }, `${label(med)}, batch ${batch.batchNo || '(no number)'}, expiry ${fmtDate(batch.expiry)}. ${plural(batch.qty, 'unit')} on the shelf.`),
  field('Units to remove', h('input', { name: 'qty', type: 'number', min: 1, max: batch.qty, step: 1, inputmode: 'numeric', required: true, value: batch.qty })),
  field('Reason', h('select', { name: 'reason', value: expired ? 'Expired' : 'Damaged' }, reasons.map((r) => h('option', {}, r)))),
  h('div', { class: 'actions end' },
    btn('Cancel', { kind: 'ghost', onclick: () => dialog.close() }),
    btn('Write off', { kind: 'danger', type: 'submit', icon: 'trash' })));
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/* ---------- Receive ---------- */

const FORMS = ['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Inhaler', 'Cream', 'Ointment', 'Drops', 'Sachet', 'Pen', 'Suppository'];

function viewReceive(prefillId) {
  return h('div', { class: 'page' },
    pageHead('Receive stock', aiConfig.provider ? 'Scan the paperwork with AI, or enter each batch by hand.' : 'Enter each batch from the delivery.'),
    scanCard(),
    card('',
      cardHead(aiConfig.provider ? 'Or enter a batch by hand' : 'Add a batch', { sub: 'One line per batch number and expiry date.' }),
      receiveForm(prefillId)));
}

function scanCard() {
  if (!aiConfig.provider) {
    return card('scan-card locked',
      h('div', { class: 'scan-intro' },
        h('span', { class: 'scan-icon' }, icon('camera', 24)),
        h('div', {},
          h('h2', {}, 'Scan a delivery with AI'),
          h('p', { class: 'muted' }, 'Photograph the invoice or the packs, and MedShelf fills in every line for you to check. Connect an OpenAI or Claude key to turn this on.'))),
      btn('Connect AI', { icon: 'key', href: '#/data?section=ai' }));
  }
  if (scan?.status === 'reading') {
    return card('scan-card',
      h('div', { class: 'scan-reading' },
        bot(56, 'thinking'),
        h('div', {}, h('strong', {}, `Reading ${plural(scan.files.length, 'file')}…`), h('span', { class: 'muted small' }, 'This usually takes 10 to 40 seconds.'))),
      scan.previews.length > 0 && h('div', { class: 'thumbs' }, scan.previews.map((src) => h('img', { src, alt: 'Scanned page' }))),
      btn('Cancel', { kind: 'ghost', size: 'sm', onclick: () => scan.controller.abort() }));
  }
  if (scan?.status === 'review') return reviewCard();

  const start = (input) => act(() => startScan([...input.files], input));
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => start(e.target) });
  const upload = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true, onchange: (e) => start(e.target) });
  const zone = h('div', {
    class: 'dropzone',
    ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    ondragleave: () => zone.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      act(() => startScan([...e.dataTransfer.files]));
    },
  },
  h('span', { class: 'scan-icon' }, icon('camera', 24)),
  h('h2', {}, 'Scan a delivery with AI'),
  h('p', { class: 'muted' }, 'Take a photo of the invoice or the packs, or drop in a PDF. You check every line before anything is added.'),
  h('div', { class: 'actions center' },
    btn('Take photo', { icon: 'camera', kind: 'primary', onclick: () => camera.click() }),
    btn('Upload photo or PDF', { icon: 'upload', onclick: () => upload.click() })),
  scan?.status === 'error' && notice('bad', 'alert', scan.error),
  camera, upload);
  return card('scan-card', zone);
}

async function startScan(files, input) {
  if (input) input.value = '';
  if (!files.length) return;
  if (files.length > 5) throw new RangeError('Scan up to 5 files at a time.');
  const prepared = await Promise.all(files.map(ai.prepareFile));
  const previews = prepared.map((f) => f.preview).filter(Boolean);
  scan = { status: 'reading', files: prepared, previews, controller: new AbortController() };
  render();
  try {
    const known = state.medicines.map((m) => `${m.name} | ${m.strength || '-'} | ${m.form || '-'}`);
    const result = await ai.scanDelivery(aiConfig, { files: prepared, known }, { signal: scan.controller.signal });
    if (!result.items.length) throw new ai.AiError('No medicine lines were found. Try a sharper photo, taken closer to the page.');
    scan = {
      status: 'review', supplier: result.supplier, warnings: result.warnings,
      rows: result.items.map((it) => {
        // Use the shop's own spelling for medicines it already stocks, so no duplicates appear.
        const match = core.matchMedicine(state.medicines, it);
        const names = match ? { name: match.name, strength: match.strength, form: match.form } : {};
        return { ...it, ...names, qty: it.qty ?? '', unitCost: it.unitCost ?? '' };
      }),
    };
  } catch (err) {
    scan = err.name === 'AbortError' ? null : { status: 'error', error: err.message };
  } finally {
    for (const src of previews) URL.revokeObjectURL(src);
  }
  if (currentRoute().name === 'receive') render();
}

function scannedItem(row) {
  const num = (v) => (String(v).trim() === '' ? 0 : Number(v));
  return {
    name: row.name, strength: row.strength, form: row.form, batchNo: row.batchNo,
    expiry: core.normalizeExpiry(row.expiry), qty: num(row.qty), unitCost: num(row.unitCost), reorderLevel: null,
    note: scan?.supplier ? `Scanned delivery from ${scan.supplier}` : 'Scanned delivery',
  };
}

function scannedProblem(row) {
  const item = scannedItem(row);
  return core.checkReceipt(item) ?? (item.expiry < today() ? 'This batch has already expired.' : null);
}

function reviewCard() {
  const addLabel = h('span');
  const addBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => act(addScanned) }, icon('check', 18), addLabel);
  const summary = h('span', { class: 'muted small' });
  const refresh = () => {
    const ready = scan.rows.filter((r) => !scannedProblem(r)).length;
    const fixes = scan.rows.length - ready;
    addLabel.textContent = `Add ${plural(ready, 'line')} to stock`;
    addBtn.disabled = ready === 0;
    summary.textContent = fixes
      ? `${plural(fixes, 'line')} ${fixes === 1 ? 'needs' : 'need'} fixing first. The others can be added now.`
      : 'Check the numbers against the paperwork, then add them.';
  };
  const fields = [['name', 'Medicine', 'wide'], ['strength', 'Strength'], ['form', 'Form'], ['batchNo', 'Batch'], ['expiry', 'Expiry'], ['qty', 'Units', 'num'], ['unitCost', 'Cost', 'num']];
  const rows = scan.rows.map((row) => {
    const status = h('td', { class: 'row-status' });
    const tr = h('tr');
    const check = () => {
      const problem = scannedProblem(row);
      tr.classList.toggle('has-problem', Boolean(problem));
      status.replaceChildren(problem
        ? h('span', { class: 'problem' }, icon('alert', 16), h('span', {}, problem))
        : h('span', { class: 'ready' }, icon('check', 16), h('span', {}, row.packs ? `Ready · ${row.packs}` : 'Ready')));
      refresh();
    };
    tr.append(
      ...fields.map(([key, text, cls]) => h('td', { class: `${cls ?? ''} f-${key}`.trim(), 'data-label': text }, h('input', {
        value: String(row[key] ?? ''), 'aria-label': text, inputmode: key === 'qty' ? 'numeric' : key === 'unitCost' ? 'decimal' : null,
        oninput: (e) => { row[key] = e.target.value; check(); },
      }))),
      status,
      h('td', { class: 'row-remove' }, btn('', {
        icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove this line',
        onclick: () => {
          scan.rows = scan.rows.filter((r) => r !== row);
          if (!scan.rows.length) scan = null;
          render();
        },
      })));
    check();
    return tr;
  });

  return card('scan-card review',
    cardHead('Check the scanned lines', {
      botNode: bot(38),
      sub: scan.supplier ? `Delivery from ${scan.supplier}. Fix anything the AI misread.` : 'Fix anything the AI misread, then add the lines to stock.',
      actions: [btn('Discard', { kind: 'ghost', size: 'sm', icon: 'trash', onclick: () => { scan = null; render(); } })],
    }),
    scan.warnings.length > 0 && notice('warn', 'alert', h('strong', {}, 'The AI noted: '), h('ul', {}, scan.warnings.map((w) => h('li', {}, w)))),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table review-table' },
      h('thead', {}, h('tr', {}, fields.map(([, text, cls]) => h('th', { scope: 'col', class: cls }, text)), h('th', { scope: 'col' }, 'Check'), h('th', {}))),
      h('tbody', {}, rows))),
    h('div', { class: 'review-foot' }, summary, addBtn));
}

async function addScanned() {
  const ready = scan.rows.filter((r) => !scannedProblem(r));
  if (!ready.length) return;
  await commit(core.receiveMany(state, ready.map(scannedItem), ctx()));
  toast(`Added ${plural(ready.length, 'line')} to stock.`);
  scan.rows = scan.rows.filter((r) => !ready.includes(r));
  if (!scan.rows.length) scan = null;
  render();
}

function receiveForm(prefillId) {
  const pre = findMed(prefillId);
  const names = [...new Set(state.medicines.map((m) => m.name))].sort();
  const defaultHint = 'As printed on the pack, for example 03/2027 or 2027-03-31.';
  const expiryHint = h('small', { class: 'hint' }, defaultHint);
  const input = (key) => form.elements.namedItem(key);

  const showExpiry = () => {
    const raw = input('expiry').value.trim();
    const iso = core.normalizeExpiry(raw);
    expiryHint.textContent = !raw ? defaultHint
      : iso ? `Last day it can be sold: ${fmtDate(iso)}${iso < today() ? '. This is already expired.' : ''}`
        : 'Not a date MedShelf can read. Try 03/2027 or 2027-03-31.';
    expiryHint.className = `hint${raw && (!iso || iso < today()) ? ' error' : ''}`;
  };

  const fillFromName = () => {
    const matches = state.medicines.filter((m) => m.name.toLowerCase() === input('name').value.trim().toLowerCase());
    if (matches.length !== 1) return;
    const [m] = matches;
    if (!input('strength').value) input('strength').value = m.strength;
    if (!input('form').value) input('form').value = m.form;
    input('reorderLevel').placeholder = `Now ${m.reorderLevel ?? 0}`;
  };

  const form = h('form', {
    class: 'form',
    onsubmit: (e) => {
      e.preventDefault();
      act(async () => {
        const f = new FormData(form);
        const num = (k, blank) => (String(f.get(k)).trim() === '' ? blank : Number(f.get(k)));
        const item = {
          name: f.get('name'), strength: f.get('strength'), form: f.get('form'), batchNo: f.get('batchNo'),
          expiry: core.normalizeExpiry(f.get('expiry')), qty: num('qty', 0), unitCost: num('unitCost', 0), reorderLevel: num('reorderLevel', null),
        };
        const put = core.receive(state, item, ctx());
        await commit(put);
        toast(`Added ${fmtNum(item.qty)} × ${label(findMed(put.batches[0].medicineId))}.`);
        render();
        main.querySelector('input[name=name]')?.focus();
      });
    },
  },
  h('datalist', { id: 'med-names' }, names.map((n) => h('option', { value: n }))),
  h('datalist', { id: 'med-forms' }, FORMS.map((n) => h('option', { value: n }))),
  field('Medicine name', h('input', { name: 'name', required: true, list: 'med-names', autocomplete: 'off', value: pre?.name, onchange: fillFromName })),
  h('div', { class: 'row' },
    field('Strength', h('input', { name: 'strength', placeholder: '500 mg', autocomplete: 'off', value: pre?.strength })),
    field('Form', h('input', { name: 'form', placeholder: 'Tablet', list: 'med-forms', autocomplete: 'off', value: pre?.form }))),
  h('div', { class: 'row' },
    field('Batch number', h('input', { name: 'batchNo', autocomplete: 'off' })),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'expiry' }, 'Expiry'),
      h('input', { id: 'expiry', name: 'expiry', required: true, autocomplete: 'off', placeholder: 'MM/YYYY', oninput: showExpiry }),
      expiryHint)),
  h('div', { class: 'row' },
    field('Units received', h('input', { name: 'qty', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true })),
    field('Cost per unit', h('input', { name: 'unitCost', type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: '0.00' }))),
  field('Reorder level', h('input', { name: 'reorderLevel', type: 'number', min: 0, step: 1, inputmode: 'numeric', placeholder: pre ? `Now ${pre.reorderLevel ?? 0}` : '0' }),
    'Warn me when stock falls to this many units. Leave blank to keep the current level.'),
  h('div', { class: 'actions' }, btn('Add to stock', { icon: 'plus', kind: 'primary', type: 'submit' })));
  return form;
}

/* ---------- Dispense ---------- */

function viewDispense(prefillId) {
  const t = today();
  const meds = [...state.medicines].sort(byName);
  const head = pageHead('Dispense', 'MedShelf takes the earliest-expiring in-date batch first, and never expired stock.');
  if (!meds.length) {
    return h('div', { class: 'page' }, head,
      card('', emptyState('dispense', 'No stock yet', 'Receive a delivery first.', btn('Receive stock', { icon: 'plus', kind: 'primary', href: '#/receive' }))));
  }
  const batchesOf = (id) => state.batches.filter((b) => b.medicineId === id);
  const onHand = (m) => core.stockOnHand(batchesOf(m.id), t);
  const plan = h('div', { class: 'plan', 'aria-live': 'polite' });
  const select = h('select', { name: 'medicine', required: true, onchange: () => update() },
    h('option', { value: '' }, 'Choose a medicine'),
    meds.map((m) => {
      const n = onHand(m);
      return h('option', { value: m.id, disabled: n === 0 }, `${label(m)}: ${n ? `${fmtNum(n)} in stock` : 'none in date'}`);
    }));
  const pre = findMed(prefillId);
  if (pre && onHand(pre) > 0) select.value = pre.id;
  const qty = h('input', { name: 'qty', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true, placeholder: '0', oninput: () => update() });
  const nudge = (delta) => {
    qty.value = Math.max(0, (Number(qty.value) || 0) + delta) || '';
    update();
  };
  const stepper = h('div', { class: 'stepper' },
    btn('', { icon: 'minus', title: 'One fewer', onclick: () => nudge(-1) }),
    qty,
    btn('', { icon: 'plus', title: 'One more', onclick: () => nudge(1) }));
  const note = h('input', { name: 'note', autocomplete: 'off', placeholder: 'Prescription number or ward' });

  function update() {
    plan.replaceChildren();
    if (!select.value || !qty.value) return;
    try {
      const steps = core.planDispense(batchesOf(select.value), Number(qty.value), t);
      plan.append(h('span', { class: 'plan-title' }, 'Take from'), h('ol', {}, steps.map((p) => h('li', {},
        h('strong', {}, fmtNum(p.qty)), ` from batch ${p.batchNo || '(no number)'}`, h('span', { class: 'muted' }, ` · expires ${fmtDate(p.expiry)}`)))));
    } catch (err) {
      plan.append(notice('bad', 'alert', err.message));
    }
  }

  const form = h('form', {
    class: 'form',
    onsubmit: (e) => {
      e.preventDefault();
      act(async () => {
        const med = findMed(select.value);
        const { put } = core.dispense(state, select.value, Number(qty.value), note.value, ctx());
        await commit(put);
        toast(`Dispensed ${fmtNum(Number(qty.value))} × ${label(med)}.`);
        render();
      });
    },
  },
  field('Medicine', select),
  h('div', { class: 'row' }, field('Units', stepper), field('Note (optional)', note, 'Stays on this device. Never sent to the AI.')),
  plan,
  h('div', { class: 'actions' }, btn('Dispense', { icon: 'check', kind: 'primary', type: 'submit' })));
  queueMicrotask(update);

  const recent = state.movements.filter((m) => m.type === 'dispense').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  return h('div', { class: 'page' }, head,
    h('div', { class: 'grid-2 wide-left' },
      card('', form),
      card('',
        cardHead('Recently dispensed'),
        recent.length
          ? h('ul', { class: 'recent' }, recent.map((m) => {
            const med = findMed(m.medicineId);
            return h('li', {},
              h('div', {}, h('strong', {}, med ? label(med) : 'Unknown medicine'), h('span', { class: 'muted small' }, `${fmtDate(m.date)}${m.note ? ` · ${m.note}` : ''}`)),
              h('span', { class: 'qty-out' }, `−${fmtNum(m.qty)}`));
          }))
          : h('p', { class: 'muted' }, 'Nothing dispensed yet.'))));
}

/* ---------- Assistant ---------- */

const SUGGESTIONS = [
  'What needs my attention today?',
  "Make this week's order list. My budget is 500.",
  'Which medicines are costing me the most in waste?',
  'What expires in the next 60 days, and what should I do about it?',
];

function viewAssistant() {
  const head = pageHead('Assistant',
    aiConfig.provider ? `Ask about your stock in plain English. Answers use your stock data and your ${ai.PROVIDERS[aiConfig.provider].name} key.` : 'Ask about your stock in plain English.',
    [chat.messages.length > 0 && btn('New chat', { icon: 'plus', size: 'sm', onclick: () => { chat.controller?.abort(); chat.messages = []; render(); } })]);
  if (!aiConfig.provider) return h('div', { class: 'page' }, head, connectCard('Connect an OpenAI or Claude key to ask questions about your stock.'));
  if (!state.medicines.length) {
    return h('div', { class: 'page' }, head, card('', emptyState('stock', 'Add some stock first', 'The assistant answers from your stock data.', btn('Receive stock', { icon: 'plus', kind: 'primary', href: '#/receive' }))));
  }

  const thread = h('div', { class: 'thread' }, chat.messages.length ? chat.messages.map(bubble) : suggestions());
  const input = h('textarea', {
    rows: 1, placeholder: 'Ask about your stock…', 'aria-label': 'Your question',
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    },
    oninput: (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
    },
  });
  const form = h('form', {
    class: 'composer',
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || chat.busy) return;
      act(() => ask(text));
    },
  }, input, chat.busy
    ? btn('', { icon: 'stop', title: 'Stop', onclick: () => chat.controller?.abort() })
    : btn('', { icon: 'send', kind: 'primary', type: 'submit', title: 'Send' }));
  queueMicrotask(() => { if (!chat.busy) input.focus(); });

  return h('div', { class: 'page chat-page' }, head, thread, form,
    h('p', { class: 'fineprint' }, 'AI can make mistakes. Check important numbers on the Stock screen. It does not give medical advice.'));
}

function suggestions() {
  return h('div', { class: 'suggest' },
    bot(72),
    h('h2', {}, 'Ask about your stock'),
    h('p', { class: 'muted' }, 'The assistant can see your stock levels, expiry dates and sales from the last 30 days.'),
    h('div', { class: 'suggest-list' }, SUGGESTIONS.map((q) => h('button', { type: 'button', class: 'suggest-item', onclick: () => act(() => ask(q)) },
      h('span', {}, q), icon('next', 16)))));
}

function bubble(m) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'msg-body' }, m.display ?? m.content));
  const body = h('div', { class: 'msg-body' });
  m.node = body;
  m.avatar = bot(38, replyState(m));
  fillReply(body, m);
  return h('div', { class: 'msg ai' }, m.avatar, body);
}

const replyState = (m) => (m.pending ? (m.content ? 'talking' : 'thinking') : 'idle');

function fillReply(body, m) {
  if (m.error) body.replaceChildren(notice('bad', 'alert', m.error));
  else if (!m.content) body.replaceChildren(h('span', { class: 'typing', 'aria-label': 'Thinking' }, h('i'), h('i'), h('i')));
  else body.replaceChildren(...[renderMarkdown(m.content), m.stopped && h('p', { class: 'muted small' }, 'Stopped.')].filter(Boolean));
}

function scrollToEnd() {
  window.scrollTo(0, document.documentElement.scrollHeight);
}

async function ask(text) {
  chat.messages.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '', pending: true };
  chat.messages.push(reply);
  chat.busy = true;
  chat.controller = new AbortController();
  render();
  scrollToEnd();
  const history = chat.messages.filter((m) => !m.pending && !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
  let queued = false;
  try {
    await ai.streamChat(aiConfig, { system: ai.assistantSystem(core.aiStockContext(state, today(), state.settings)), messages: history }, (t) => {
      reply.content = t;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!reply.node?.isConnected) return;
        const nearEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
        setBotState(reply.avatar, replyState(reply));
        fillReply(reply.node, reply);
        if (nearEnd) scrollToEnd();
      });
    }, { signal: chat.controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') reply.stopped = true;
    else reply.error = err.message;
  } finally {
    reply.pending = false;
    chat.busy = false;
    chat.controller = null;
    if (currentRoute().name === 'assistant') {
      render();
      scrollToEnd();
    }
  }
}

/* ---------- Data ---------- */

function aiSettingsCard() {
  const keyInput = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your API key', value: aiConfig.apiKey, 'aria-label': 'API key' });
  const toggle = btn('', { icon: 'eye', kind: 'ghost', title: 'Show or hide the key', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } });
  const detected = h('small', { class: 'hint' });
  const modelInput = h('input', { list: 'ai-models', autocomplete: 'off', spellcheck: 'false', value: aiConfig.model, 'aria-label': 'Model' });
  const models = h('datalist', { id: 'ai-models' });
  const status = h('div', { 'aria-live': 'polite' });

  const sync = () => {
    const raw = keyInput.value.trim();
    const p = ai.detectProvider(raw);
    detected.textContent = p ? `${ai.PROVIDERS[p].name} key.` : raw ? 'This does not look like an OpenAI key (sk-…) or a Claude key (sk-ant-…).' : 'Works with OpenAI and Claude keys.';
    detected.className = `hint${raw && !p ? ' error' : ''}`;
    models.replaceChildren(...(p ? ai.PROVIDERS[p].models : []).map((m) => h('option', { value: m })));
    if (p && (!modelInput.value.trim() || !ai.modelFits(p, modelInput.value))) modelInput.value = ai.PROVIDERS[p].defaultModel;
  };
  keyInput.addEventListener('input', sync);
  sync();

  const read = () => {
    if (!ai.detectProvider(keyInput.value)) throw new RangeError('Paste an OpenAI key (it starts with sk-) or a Claude key (it starts with sk-ant-).');
    return ai.cleanAiConfig({ apiKey: keyInput.value, model: modelInput.value });
  };
  const save = () => act(async () => {
    const cfg = read();
    await db.saveAi(cfg);
    aiConfig = cfg;
    channel?.postMessage('changed');
    toast('AI connected. The key is saved only in this browser.');
    render();
  });
  const test = () => act(async () => {
    const cfg = read();
    status.replaceChildren(h('div', { class: 'notice' }, h('span', { class: 'spinner sm' }), h('div', {}, `Testing ${cfg.model}…`)));
    try {
      await ai.testConnection(cfg);
      status.replaceChildren(notice('ok', 'check', `Connected to ${ai.PROVIDERS[cfg.provider].name} (${cfg.model}). Save to use it.`));
    } catch (err) {
      status.replaceChildren(notice('bad', 'alert', err.message));
    }
  });
  const remove = () => act(async () => {
    await db.saveAi({});
    aiConfig = ai.cleanAiConfig();
    briefing = null;
    chat.messages = [];
    channel?.postMessage('changed');
    toast('AI key removed from this browser.');
    render();
  });

  const el = card('ai-settings',
    cardHead('Assistant', { botNode: bot(36), sub: aiConfig.provider ? `On · ${ai.PROVIDERS[aiConfig.provider].name} · ${aiConfig.model}` : 'Off' }),
    h('div', { class: 'form plain' },
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'API key'),
        h('div', { class: 'input-group' }, keyInput, toggle),
        detected),
      field('Model', modelInput, 'The default is a good choice. Change it only if your account uses a different model.'),
      models,
      h('div', { class: 'actions' },
        btn('Save', { icon: 'check', kind: 'primary', onclick: save }),
        btn('Test connection', { icon: 'refresh', onclick: test }),
        aiConfig.provider && btn('Remove key', { icon: 'trash', kind: 'ghost', onclick: remove })),
      status),
    h('div', { class: 'privacy' },
      h('strong', {}, 'How it works'),
      h('ul', {},
        h('li', {}, 'Your key is saved only in this browser. It is never put in backups and never sent anywhere except your AI provider.'),
        h('li', {}, 'When you use an AI feature, MedShelf sends your stock list (medicine names, quantities, expiry dates and costs), or the photo you scanned, straight to your provider. Usage is billed to your account.'),
        h('li', {}, 'Notes you type when dispensing are never sent.')),
      h('p', { class: 'small' }, 'Get a key: ',
        h('a', { href: ai.PROVIDERS.openai.keysUrl, target: '_blank', rel: 'noopener noreferrer' }, 'OpenAI'), ' or ',
        h('a', { href: ai.PROVIDERS.anthropic.keysUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Claude'), '.')));
  el.id = 'ai';
  return el;
}

function viewData() {
  const s = state.settings;
  const restoreInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => act(() => restore(e.target)) });
  const csvInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: (e) => act(() => previewImport(e.target)) });
  const importResult = h('div', { 'aria-live': 'polite' });

  async function previewImport(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const { items, errors } = core.readStockCSV(await file.text());
    importResult.replaceChildren(...[
      notice(errors.length ? 'warn' : 'ok', errors.length ? 'alert' : 'check',
        h('strong', {}, file.name), `: ${plural(items.length, 'row')} ready${errors.length ? `, ${plural(errors.length, 'row')} with problems` : ''}.`,
        errors.length > 0 && h('ul', {}, errors.slice(0, 20).map((e) => h('li', {}, `Row ${e.row}: ${e.message}`)))),
      items.length > 0 && btn(`Add ${plural(items.length, 'row')} to stock`, {
        icon: 'plus', kind: 'primary',
        onclick: () => act(async () => {
          await commit(core.receiveMany(state, items, ctx()));
          toast(`Imported ${plural(items.length, 'row')}.`);
          location.hash = '#/stock';
        }),
      }),
    ].filter(Boolean));
  }

  async function restore(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const data = core.readBackup(await file.text());
    const ok = confirm(`Replace everything on this device with this backup?\n\n${plural(data.medicines.length, 'medicine')}, ${plural(data.batches.length, 'batch', 'batches')}.\n\nWhat is on this device now will be lost.`);
    if (!ok) return;
    const { settings, ...records } = data;
    await db.save({ ...records, meta: [{ id: 'settings', ...settings }, { id: 'ai', ...aiConfig }] }, { replace: true });
    state = { ...records, settings };
    channel?.postMessage('changed');
    toast('Backup restored.');
    location.hash = '#/dashboard';
  }

  const settingsForm = h('form', {
    class: 'form plain',
    onsubmit: (e) => {
      e.preventDefault();
      act(async () => {
        const f = e.target.elements;
        const ints = { warnDays: [1, 730, 'Warning days'], leadDays: [0, 365, 'Delivery days'], coverDays: [1, 365, 'Order cover days'] };
        const changes = { currency: f.currency.value };
        for (const [k, [min, max, name]] of Object.entries(ints)) {
          const v = Number(f[k].value);
          if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} must be a whole number from ${min} to ${max}.`);
          changes[k] = v;
        }
        await saveSettings(changes);
        toast('Settings saved.');
        render();
      });
    },
  },
  h('div', { class: 'row' },
    field('Warn about expiry (days ahead)', h('input', { name: 'warnDays', type: 'number', min: 1, max: 730, step: 1, value: s.warnDays })),
    field('Days a delivery takes', h('input', { name: 'leadDays', type: 'number', min: 0, max: 365, step: 1, value: s.leadDays }))),
  h('div', { class: 'row' },
    field('Order enough for (days)', h('input', { name: 'coverDays', type: 'number', min: 1, max: 365, step: 1, value: s.coverDays })),
    field('Currency symbol', h('input', { name: 'currency', maxlength: 5, placeholder: '£, $, Rs, ₦…', value: s.currency }))),
  h('div', { class: 'actions' }, btn('Save settings', { icon: 'check', kind: 'primary', type: 'submit' })));

  const stockCSV = () => {
    const lines = [core.STOCK_COLUMNS];
    for (const b of state.batches.filter((x) => x.qty > 0)) {
      const m = findMed(b.medicineId);
      lines.push([m.name, m.strength, m.form, b.batchNo, b.expiry, b.qty, b.unitCost ?? 0, m.reorderLevel ?? 0]);
    }
    download(`medshelf-stock-${today()}.csv`, core.toCSV(lines), 'text/csv');
  };
  const historyCSV = () => {
    const lines = [['date', 'type', 'medicine', 'strength', 'form', 'batch', 'qty', 'note']];
    for (const mv of [...state.movements].sort((a, b) => a.at.localeCompare(b.at))) {
      const m = findMed(mv.medicineId);
      const b = state.batches.find((x) => x.id === mv.batchId);
      lines.push([mv.date, mv.type, m?.name, m?.strength, m?.form, b?.batchNo, mv.qty, mv.note]);
    }
    download(`medshelf-history-${today()}.csv`, core.toCSV(lines), 'text/csv');
  };
  const backup = () => act(async () => {
    const now = new Date().toISOString();
    download(`medshelf-backup-${today()}.json`, JSON.stringify(core.makeBackup(state, now), null, 1), 'application/json');
    await saveSettings({ lastBackup: now });
    render();
  });
  const erase = () => act(async () => {
    if (!confirm('Erase all MedShelf data on this device, including your AI key? This cannot be undone.\n\nDownload a backup first if you might need it.')) return;
    await db.save({}, { replace: true });
    state = { medicines: [], batches: [], movements: [], settings: { ...core.DEFAULT_SETTINGS } };
    aiConfig = ai.cleanAiConfig();
    briefing = null;
    chat.messages = [];
    channel?.postMessage('changed');
    toast('All data erased.');
    location.hash = '#/dashboard';
  });

  const section = (id, cls, ...children) => {
    const el = card(cls, ...children);
    el.id = id;
    return el;
  };

  return h('div', { class: 'page' },
    pageHead('Data and settings', 'Everything is stored in this browser. Nothing is uploaded unless you use an AI feature.'),
    h('div', { class: 'grid-2' },
      aiSettingsCard(),
      h('div', { class: 'stack' },
        section('backup', '',
          cardHead('Backup', { iconName: 'shield', sub: s.lastBackup ? `Last backup ${fmtDate(s.lastBackup.slice(0, 10))}` : 'No backup yet' }),
          h('p', { class: 'muted' }, 'If the browser data is cleared or the device is lost, your stock goes with it. Download a backup every week and keep it somewhere safe.'),
          h('div', { class: 'actions' },
            btn('Download backup', { icon: 'download', kind: 'primary', onclick: backup }),
            btn('Restore from backup', { icon: 'upload', onclick: () => restoreInput.click() }),
            restoreInput)),
        section('import', '',
          cardHead('Import from a spreadsheet', { iconName: 'file' }),
          h('p', { class: 'muted' }, 'Save your stock list as CSV with the columns ', h('code', {}, core.STOCK_COLUMNS.join(', ')),
            '. Only name, expiry and qty are required. Each row is added as a delivery.'),
          h('div', { class: 'actions' },
            btn('Choose CSV file', { icon: 'upload', onclick: () => csvInput.click() }),
            btn('Download template', {
              icon: 'download', kind: 'ghost',
              onclick: () => download('medshelf-template.csv', core.toCSV([core.STOCK_COLUMNS, ['Paracetamol', '500 mg', 'Tablet', 'PCM2401', '03/2027', 500, 0.02, 200]]), 'text/csv'),
            }),
            csvInput),
          importResult))),
    h('div', { class: 'grid-2' },
      section('settings', '', cardHead('Preferences'), settingsForm),
      h('div', { class: 'stack' },
        section('export', '',
          cardHead('Export', { iconName: 'download' }),
          h('div', { class: 'actions' },
            btn('Stock list (CSV)', { icon: 'download', onclick: stockCSV }),
            btn('Full history (CSV)', { icon: 'download', onclick: historyCSV }))),
        section('erase', 'danger-zone',
          cardHead('Erase everything', { iconName: 'trash' }),
          h('p', { class: 'muted' }, 'Removes all medicines, batches, history and your AI key from this device.'),
          btn('Erase all data', { icon: 'trash', kind: 'danger', onclick: erase })))));
}

/* ---------- routing ---------- */

const VIEWS = { dashboard: viewToday, stock: viewStock, receive: viewReceive, dispense: viewDispense, assistant: viewAssistant, data: viewData };
const TITLES = { dashboard: 'Today', stock: 'Stock', receive: 'Receive stock', dispense: 'Dispense', assistant: 'Assistant', data: 'Data and settings' };

function currentRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, arg = ''] = path.split('/');
  let decoded = '';
  try {
    decoded = decodeURIComponent(arg);
  } catch {
    // A mangled link just shows the list.
  }
  return VIEWS[name] ? { name, arg: decoded, params: new URLSearchParams(query) } : { name: 'dashboard', arg: '', params: new URLSearchParams() };
}

let titleWatcher = null;

function render() {
  const { name, arg, params } = currentRoute();
  if (name !== 'dashboard') briefingOut = null;
  renderChrome(name);
  document.title = `${TITLES[name]} · MedShelf`;
  main.replaceChildren(VIEWS[name](arg, params));
  // Phones: the page title slides into the top bar once the big heading scrolls away.
  topbarTitle.textContent = name === 'dashboard' ? TITLES[name] : main.querySelector('h1')?.textContent ?? TITLES[name];
  titleWatcher?.disconnect();
  const heading = main.querySelector('h1');
  topbar.classList.toggle('show-title', false);
  if (heading && 'IntersectionObserver' in window) {
    titleWatcher = new IntersectionObserver(([entry]) => topbar.classList.toggle('show-title', !entry.isIntersecting), { rootMargin: '-56px 0px 0px 0px' });
    titleWatcher.observe(heading);
  }
}

function afterNavigate() {
  render();
  main.classList.remove('enter');
  void main.offsetWidth; // restart the entrance animation
  main.classList.add('enter');
  const { name, params } = currentRoute();
  const section = params.get('section');
  if (section) requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  else if (name === 'assistant' && chat.messages.length) requestAnimationFrame(scrollToEnd);
  else window.scrollTo(0, 0);
}

window.addEventListener('hashchange', afterNavigate);
window.addEventListener('online', () => renderChrome(currentRoute().name));
window.addEventListener('offline', () => renderChrome(currentRoute().name));

// Another tab saved something: reload so this tab never works from stale stock.
channel?.addEventListener('message', () => act(async () => {
  state = await loadState();
  const { name } = currentRoute();
  if (name === 'dashboard' || name === 'stock') render();
  else renderChrome(name);
}));

async function loadState() {
  const data = await db.loadAll();
  aiConfig = ai.cleanAiConfig(data.ai);
  return { medicines: data.medicines, batches: data.batches, movements: data.movements, settings: core.cleanSettings(data.settings) };
}

async function start() {
  try {
    state = await loadState();
  } catch (err) {
    main.replaceChildren(notice('bad', 'alert',
      h('strong', {}, 'MedShelf cannot open its storage. '),
      'Private browsing or blocked site data can cause this. Open MedShelf in a normal window. ',
      h('small', {}, `(${err.message})`)));
    return;
  }
  if (!location.hash.startsWith('#/')) history.replaceState(null, '', '#/dashboard');
  afterNavigate();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline mode unavailable:', err));
  }
}

start();
