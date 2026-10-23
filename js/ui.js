// Small DOM helpers shared by the screens. Everything builds elements with text
// nodes, never innerHTML, so names from the shop's data or the AI cannot inject markup.

import { ICONS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

export function icon(name, size = 20) {
  const el = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon',
  })) el.setAttribute(k, v);
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    el.append(path);
  }
  return el;
}

/* ---------- formatting ---------- */

export function fmtDate(iso, { weekday = false } = {}) {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: weekday ? 'long' : undefined, day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function fmtMonth(yyyymm, style = 'short') {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: style, year: style === 'short' ? undefined : 'numeric', timeZone: 'UTC' });
}

export const fmtNum = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function fmtMoney(n, currency) {
  return currency + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtShort(n) {
  if (n >= 1e6) return `${fmtNum(n / 1e6)}M`;
  if (n >= 1e3) return `${fmtNum(n / 1e3)}k`;
  return fmtNum(n);
}

export const plural = (n, word, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`;

export function daysText(days) {
  if (days < 0) return `expired ${plural(-days, 'day')} ago`;
  if (days === 0) return 'last day today';
  return `in ${plural(days, 'day')}`;
}

/* ---------- feedback ---------- */

const toastBox = () => document.getElementById('toast');

export function toast(message, kind = 'ok') {
  const item = h('div', { class: `toast ${kind}` }, icon(kind === 'bad' ? 'alert' : 'check', 18), h('span', {}, message));
  toastBox().append(item);
  setTimeout(() => item.remove(), kind === 'bad' ? 6500 : 3500);
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- markdown for AI replies ---------- */

function inline(text) {
  const out = document.createDocumentFragment();
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.append(text.slice(last, m.index));
    out.append(m[1] != null ? h('strong', {}, m[1]) : h('code', {}, m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.append(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)/;
const HEADING = /^\s*#{1,6}\s+(.*)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;
const isBlockStart = (l) => BULLET.test(l) || NUMBERED.test(l) || HEADING.test(l) || TABLE_ROW.test(l);
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

const itemText = (l) => {
  const b = l.match(BULLET);
  return b ? b[1] : l.match(NUMBERED)?.[2];
};
const isItem = (l) => BULLET.test(l) || NUMBERED.test(l);

/**
 * One list starting at lines[start], with indented items nested one level under
 * the item above. Blank lines between items do not end the list, and a numbered
 * list keeps its numbering. Returns the index of the first line after the list.
 */
function renderList(lines, start, root) {
  const numbered = !BULLET.test(lines[start]);
  const list = h(numbered ? 'ol' : 'ul');
  const first = Number(lines[start].match(NUMBERED)?.[1]);
  if (numbered && first > 1) list.start = first;
  let i = start;
  let lastItem = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (next < lines.length && isItem(lines[next]) && (/^\s{2,}/.test(lines[next]) || BULLET.test(lines[next]) !== numbered)) {
        i = next;
        continue;
      }
      break;
    }
    if (!isItem(line)) break;
    if (/^\s{2,}/.test(line) && lastItem) {
      const tag = BULLET.test(line) ? 'ul' : 'ol';
      let sub = [...lastItem.children].find((c) => c.tagName === tag.toUpperCase());
      if (!sub) {
        sub = h(tag);
        lastItem.append(sub);
      }
      sub.append(h('li', {}, inline(itemText(line))));
    } else {
      if (BULLET.test(line) === numbered) break;
      lastItem = h('li', {}, inline(itemText(line)));
      list.append(lastItem);
    }
    i++;
  }
  root.append(list);
  return i;
}

/** Renders the small subset of Markdown the AI uses: headings, lists, tables, bold and code. */
export function renderMarkdown(text) {
  const root = h('div', { class: 'md' });
  const lines = String(text).replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if ((m = line.match(HEADING))) {
      root.append(h('h4', {}, inline(m[1])));
      i++;
    } else if (TABLE_ROW.test(line)) {
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        if (!TABLE_RULE.test(lines[i])) rows.push(cells(lines[i]));
        i++;
      }
      if (!rows.length) continue;
      const [head, ...body] = rows;
      root.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))),
        h('tbody', {}, body.map((r) => h('tr', {}, r.map((c) => h('td', {}, inline(c)))))))));
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      i = renderList(lines, i, root);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
      root.append(h('p', {}, inline(para.join(' '))));
    }
  }
  return root;
}
