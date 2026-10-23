// Expiry outlook: one bar per month for the next year, plus already-expired stock
// as its own red bar. Plain HTML so labels stay readable at phone width.

import { h, icon, fmtMonth, fmtNum, fmtShort, plural } from './ui.js';

function niceStep(rough) {
  const mag = 10 ** Math.floor(Math.log10(rough));
  const n = rough / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

const monthName = (b) => (b.month === 'expired' ? 'Already expired' : fmtMonth(b.month, 'long'));

const axisLabel = (b) => (b.month === 'expired' ? 'Expired' : fmtMonth(b.month));

/** `money` formats a value; `useValue` plots money when costs are known, units otherwise. */
export function expiryChart(outlook, { money, currency, useValue }) {
  const bars = [{ ...outlook.expired, critical: true }, ...outlook.months];
  const amount = (b) => (useValue ? b.value : b.units);
  const top = Math.max(...bars.map(amount));
  if (top === 0) return h('p', { class: 'muted' }, 'Nothing has expired, and nothing expires in the next 12 months.');

  const step = niceStep(top / 4);
  const max = Math.ceil(top / step) * step;
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const plot = h('div', { class: 'chart-plot' });

  const grid = h('div', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (let v = 0; v <= max + step / 2; v += step) {
    const line = h('div', { class: 'grid-line' }, h('span', {}, useValue ? currency + fmtShort(v) : fmtShort(v)));
    line.style.bottom = `${(v / max) * 100}%`;
    grid.append(line);
  }

  const hide = () => { tip.hidden = true; };
  const cols = bars.map((b) => {
    const summary = `${monthName(b)}: ${plural(b.units, 'unit')} in ${plural(b.batches, 'batch', 'batches')}${useValue ? `, worth ${money(b.value)}` : ''}`;
    const bar = h('div', { class: `bar${b.critical ? ' critical' : ''}` });
    bar.style.height = `${(amount(b) / max) * 100}%`;
    if (amount(b) > 0) bar.style.minHeight = '3px';
    const col = h('div', { class: 'bar-col', tabindex: 0, role: 'img', 'aria-label': summary }, bar);
    const show = () => {
      tip.replaceChildren(...[
        h('strong', {}, monthName(b)),
        h('span', {}, `${plural(b.units, 'unit')} · ${plural(b.batches, 'batch', 'batches')}`),
        useValue && h('span', {}, money(b.value)),
      ].filter(Boolean));
      tip.hidden = false;
      const center = col.offsetLeft + col.offsetWidth / 2;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(center, half), plot.clientWidth - half)}px`;
    };
    col.addEventListener('mouseenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('mouseleave', hide);
    col.addEventListener('blur', hide);
    return col;
  });

  plot.append(grid, h('div', { class: 'chart-bars' }, cols), tip);
  // Every other month is labelled; the tooltip and table name them all.
  const axis = h('div', { class: 'chart-x', 'aria-hidden': 'true' },
    bars.map((b) => h('span', { class: b.critical ? 'critical' : '' }, b.critical && icon('alert', 12), axisLabel(b))));

  const tableView = h('details', { class: 'chart-table' },
    h('summary', {}, 'Show as a table'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Month', 'Units', 'Batches', useValue && 'Value'].filter(Boolean).map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, bars.filter((b) => b.units > 0).map((b) => h('tr', {},
        h('td', {}, monthName(b)), h('td', { class: 'num' }, fmtNum(b.units)), h('td', { class: 'num' }, fmtNum(b.batches)),
        useValue && h('td', { class: 'num' }, money(b.value))))))));

  return h('div', { class: 'chart' }, plot, axis, tableView);
}
