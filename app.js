// Refund metrics UI: data/refunds.parquet is loaded into DuckDB-WASM and every chart is one SQL query.
// Metric definitions follow demo.ipynb (METRICS / compute()) and refund_metrics.md.
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';

const BREAKDOWNS = {
  general: null,
  product: 'product',
  subscription: 'subscription_plan',
  geo: 'geo_country',
  utm_source: 'utm_source',
  payment_type: 'payment_type',
  mid: 'mid',
  age: 'age',
  gender: 'gender',
};
const FILTERS = ['product', 'payment_type'];
const TOP_N = 7;
const MAX_SEGMENTS = 48; // "All" still folds the tail into Other beyond this, so geo (~235 countries) stays usable
const OTHER = 'Other segments';

// derived columns of the notebook's `d`, as SQL expressions over the raw rows
const COLS = {
  tx_amount: "CASE WHEN type = 'transaction' THEN amount END",
  tx_order: "CASE WHEN type = 'transaction' THEN order_key END",
  refund_amount: "CASE WHEN type = 'refund' THEN amount END",
  refund_order: "CASE WHEN type = 'refund' THEN order_key END",
  // refund_support rows duplicate refunds that have an agent, so the support metrics use type = 'refund' only
  support_amount: "CASE WHEN type = 'refund' AND refund_type = 'support_request' THEN amount END",
  support_pointai_amount: "CASE WHEN type = 'refund' AND refund_type IN ('support_request', 'pointai') THEN amount END",
  support_order: "CASE WHEN type = 'refund' AND refund_type = 'support_request' THEN order_key END",
  agent_order: "CASE WHEN type = 'refund_support' THEN order_key END",
  dispute_amount: "CASE WHEN type = 'refund' AND refund_reason = 'dispute' THEN amount END",
  eu_user_amount: "CASE WHEN type = 'refund' AND refund_reason = 'eu_user' THEN amount END",
  cm_amount: "CASE WHEN type = 'refund' AND refund_reason = 'completed_modules' THEN amount END",
};

// num / den: [column, 'sum' | 'nunique']. segment: fixed breakdown column. total: den = TOTAL over all segments of a date
// agent: how the Support agent filter applies - 'segment' = show only the chosen agents' lines (den stays the
// all-agent total), 'rows' = keep only the chosen agents' refunds. Refund rates ignore it (transactions have no agent).
const METRICS = {
  refund_rate: { label: 'Refund rate (sum)', num: ['refund_amount', 'sum'], den: ['tx_amount', 'sum'] },
  refund_rate_count: { label: 'Refund rate (count)', num: ['refund_order', 'nunique'], den: ['tx_order', 'nunique'] },
  refund_rate_dispute: { label: 'dispute', num: ['dispute_amount', 'sum'], den: ['support_amount', 'sum'], agent: 'rows' },
  refund_rate_eu_user: { label: 'eu_user', num: ['eu_user_amount', 'sum'], den: ['support_amount', 'sum'], agent: 'rows' },
  refund_rate_cm: { label: 'completed_modules', num: ['cm_amount', 'sum'], den: ['support_amount', 'sum'], agent: 'rows' },
  agent_refund_share: { label: 'Agent share', num: ['agent_order', 'nunique'], den: ['support_order', 'nunique'],
                        segment: 'support_agent_email', total: true, agent: 'segment' },
  support_refund_rate_agent: { label: 'Share of support $', num: ['support_pointai_amount', 'sum'],
                               den: ['support_pointai_amount', 'sum'], segment: 'support_agent_email', total: true,
                               agent: 'segment' },
  support_refund_rate_reason: { label: 'Share of support $', num: ['support_pointai_amount', 'sum'],
                                den: ['support_pointai_amount', 'sum'], segment: 'refund_reason_cleaned', total: true,
                                agent: 'rows' },
};

const CHARTS = [
  { id: 'refund-rate', title: 'Refund rate (sum)', metrics: ['refund_rate'],
    desc: 'Refunded $ / transaction $ in the period.' },
  { id: 'refund-rate-count', title: 'Refund rate (count)', metrics: ['refund_rate_count'],
    desc: 'Refunded orders / paid orders in the period.' },
  { id: 'refund-support', title: 'Refund support', metrics: ['refund_rate_dispute', 'refund_rate_eu_user', 'refund_rate_cm'],
    desc: 'Refunded $ with the chosen reason / support_request refund $.' },
  { id: 'refund-support-agent', title: 'Refund support agent', metrics: ['agent_refund_share'],
    desc: "Agent's refunded orders / all support_request refunded orders in the period. Below 100% because some refunds have no agent." },
  { id: 'support-agent', title: 'Support agent', metrics: ['support_refund_rate_agent'],
    desc: "Agent's support_request + pointai refund $ / the period's total. Segments of a date add up to 100%." },
  { id: 'support-reason', title: 'Support by reason', metrics: ['support_refund_rate_reason'], showAll: true, sharedY: false,
    desc: "Reason's support_request + pointai refund $ / the period's total (reason cleaned as in Tableau)." },
];

const $ = (sel, root = document) => root.querySelector(sel);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const fmtPct = (v) => (v * 100).toFixed(v < 0.1 ? 2 : 1) + '%';
const fmtNum = (v) => Math.round(v).toLocaleString('en-US');
const fmtUsd = (v) => '$' + fmtNum(v);
const isUsd = (metric) => METRICS[metric].num[1] === 'sum';

let conn;
const DEFAULT_REFUND_TYPES = ['pointai', 'support_request'];
const state = { step: 'week', start: null, end: null, product: [], payment_type: [], agent: [], refund_type: [] };
let bounds = { min: null, max: null };

// ---------- data ----------

// The published data is AES-GCM encrypted; the key comes from the access link (#k=...), which never reaches the server.
// File layout from export_data.py: 12-byte IV + ciphertext with the tag appended.
async function decrypt(buf) {
  const k = new URLSearchParams(location.hash.slice(1)).get('k');
  if (!k) throw new Error('this page needs the access link (it ends with #k=…). Ask the analytics team for it.');
  if (!crypto.subtle) throw new Error('decryption needs https or localhost.');
  const raw = Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12)));
  } catch {
    throw new Error('the access link is outdated or incomplete. Ask the analytics team for the current one.');
  }
}

async function initDb() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  setLoading('Downloading the refunds dataset…');
  const res = await fetch('data/refunds.parquet.enc', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/refunds.parquet.enc: HTTP ${res.status}. Run ./serve.sh --refresh to export it.`);
  setLoading('Decrypting…');
  await db.registerFileBuffer('refunds.parquet', await decrypt(new Uint8Array(await res.arrayBuffer())));

  setLoading('Preparing…');
  conn = await db.connect();
  await conn.query("CREATE TABLE t AS SELECT * FROM read_parquet('refunds.parquet')");
}

async function rows(sql) {
  const table = await conn.query(sql);
  return table.toArray().map((r) => r.toJSON());
}

function where() {
  const parts = [`date >= DATE ${q(state.start)}`, `date < DATE ${q(state.end)} + INTERVAL 1 DAY`];
  for (const f of FILTERS) {
    if (state[f].length) parts.push(`${f} IN (${state[f].map(q).join(', ')})`);
  }
  // refund_type narrows refund rows only; transactions (refund_type = 'transaction') always stay in the denominator
  if (state.refund_type.length) {
    parts.push(`(type = 'transaction' OR refund_type IN (${state.refund_type.map(q).join(', ')}))`);
  }
  return parts.join(' AND ');
}

const agg = (col, how) =>
  how === 'sum' ? `coalesce(sum(${COLS[col]}), 0)` : `count(DISTINCT ${COLS[col]})::DOUBLE`;

const agentCond = () =>
  state.agent.length ? `support_agent_email IN (${state.agent.map(q).join(', ')})` : null;

// -> [{d, seg, num, den}], same as compute() in the notebook; breakdown2 splits each segment further ("A · B")
async function compute(metric, breakdown, breakdown2, limit = TOP_N) {
  const spec = METRICS[metric];
  const [numCol, numAgg] = spec.num;
  const [denCol, denAgg] = spec.den;
  const cols = [...new Set([spec.segment || BREAKDOWNS[breakdown], BREAKDOWNS[breakdown2]].filter(Boolean))];
  const key = cols.join(" || ' · ' || ");
  const rankCol = spec.total ? numCol : denCol;
  const agents = spec.agent ? agentCond() : null;
  const rowFilter = spec.agent === 'rows' && agents ? ` AND ${agents}` : '';
  // rows outside the chosen agents get no segment: they still count in the period total (den), never as a line
  const inScope = spec.agent === 'segment' && agents ? agents : 'TRUE';

  const seg = cols.length
    ? `CASE WHEN NOT (${inScope}) THEN NULL WHEN ${key} IN (SELECT s FROM top) THEN ${key} ELSE ${q(OTHER)} END`
    : "'all'";
  const top = cols.length
    ? `, top AS (SELECT ${key} AS s FROM f WHERE ${COLS[rankCol]} IS NOT NULL AND ${inScope}
                 GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT ${limit})`
    : '';
  const totals = spec.total
    ? `, n AS (SELECT d, seg, ${agg(numCol, numAgg)} AS num FROM g
               WHERE ${COLS[numCol]} IS NOT NULL AND seg IS NOT NULL GROUP BY d, seg),
       dd AS (SELECT d, ${agg(denCol, denAgg)} AS den FROM g GROUP BY d)`
    : '';
  const body = spec.total
    ? 'SELECT n.d, seg, num, den FROM n JOIN dd USING (d)'
    : `SELECT d, seg, ${agg(numCol, numAgg)} AS num, ${agg(denCol, denAgg)} AS den FROM g GROUP BY d, seg`;

  const sql = `WITH f AS (SELECT * FROM t WHERE ${where()}${rowFilter})${top},
    g AS (SELECT *, date_trunc('${state.step}', date) AS d, ${seg} AS seg FROM f)${totals}
    SELECT strftime(d, '%Y-%m-%d') AS d, seg, num, den FROM (${body}) WHERE den > 0 ORDER BY d, seg`;
  return (await rows(sql)).map((r) => ({ ...r, value: r.num / r.den }));
}

async function kpis() {
  // support tiles follow the agent filter; the agent share keeps all support orders as its denominator
  const a = agentCond() || 'TRUE';
  const [r] = await rows(`SELECT
      ${agg('refund_amount', 'sum')} AS ref_usd, ${agg('tx_amount', 'sum')} AS tx_usd,
      ${agg('refund_order', 'nunique')} AS ref_n, ${agg('tx_order', 'nunique')} AS tx_n,
      coalesce(sum(${COLS.support_amount}) FILTER (WHERE ${a}), 0) AS sup_usd,
      count(DISTINCT ${COLS.support_order}) FILTER (WHERE ${a})::DOUBLE AS sup_agent_n,
      ${agg('support_order', 'nunique')} AS sup_n,
      count(DISTINCT ${COLS.agent_order}) FILTER (WHERE ${a})::DOUBLE AS agent_n
    FROM t WHERE ${where()}`);
  return r;
}

// ---------- rendering ----------

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'];

function renderKpis(k) {
  const typed = state.refund_type.length ? ' · chosen refund types' : '';
  const tiles = [
    [`Refund rate (sum)${typed}`, k.tx_usd ? fmtPct(k.ref_usd / k.tx_usd) : '–', `${fmtUsd(k.ref_usd)} / ${fmtUsd(k.tx_usd)}`],
    [`Refund rate (count)${typed}`, k.tx_n ? fmtPct(k.ref_n / k.tx_n) : '–', `${fmtNum(k.ref_n)} / ${fmtNum(k.tx_n)} orders`],
    [state.agent.length ? 'Support refunds (chosen agents)' : 'Support refunds', fmtUsd(k.sup_usd),
     `${fmtNum(k.sup_agent_n)} orders (support_request)`],
    [state.agent.length ? 'Handled by chosen agents' : 'Handled by an agent',
     k.sup_n ? fmtPct(k.agent_n / k.sup_n) : '–', `${fmtNum(k.agent_n)} / ${fmtNum(k.sup_n)} orders`],
  ];
  $('#kpis').innerHTML = tiles.map(([label, value, sub]) =>
    `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
  ).join('');
}

// start of the period after `d` for the current time step
function nextPeriod(d) {
  const x = new Date(d + 'T00:00:00Z');
  const step = state.step;
  if (step === 'day') x.setUTCDate(x.getUTCDate() + 1);
  else if (step === 'week') x.setUTCDate(x.getUTCDate() + 7);
  else if (step === 'month') x.setUTCMonth(x.getUTCMonth() + 1);
  else if (step === 'quarter') x.setUTCMonth(x.getUTCMonth() + 3);
  else x.setUTCFullYear(x.getUTCFullYear() + 1);
  return x.toISOString().slice(0, 10);
}


// ticks on period starts for coarse steps, so a monthly chart isn't labelled "Aug 9"
function xTicks(n, maxTicks) {
  const months = { month: 1, quarter: 3, year: 12 }[state.step];
  if (!months) return { nticks: maxTicks };
  const every = Math.max(1, Math.ceil(n / maxTicks)) * months;
  return { dtick: `M${every}`, tickformat: state.step === 'year' ? '%Y' : '%b %Y' };
}

// x range padded by half a period, so the first and last points aren't cut by the plot edge
function xRange(first, last) {
  const half = { day: 0.5, week: 3.5, month: 15, quarter: 45, year: 182 }[state.step] * 864e5;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return [iso(Date.parse(first) - half), iso(Date.parse(last) + half)];
}

function nextDay(d) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PLOT_CONFIG = {
  displaylogo: false, responsive: true,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines'],
};

// One page per chart. Each segment gets its own small figure (small multiples) instead of one line in a shared plot.
class Chart {
  constructor(def) {
    this.def = def;
    this.metric = def.metrics[0];
    this.breakdown = 'general';
    this.breakdown2 = 'general';
    this.labels = true;
    this.sharedY = def.sharedY ?? true;
    this.showAll = Boolean(def.showAll);
    this.view = 'chart';
    this.colorSlots = new Map(); // segment -> palette slot, kept across re-renders so colors follow the entity
    this.data = [];
    this.overall = null; // all segments combined, drawn as a reference line in every figure
    this.dirty = true;

    const el = $('#page-tpl').content.firstElementChild.cloneNode(true);
    this.el = el;
    $('.title', el).textContent = def.title;
    $('.desc', el).textContent = def.desc;
    this.figs = $('.figs', el);
    this.tableWrap = $('.table-wrap', el);

    if (def.metrics.length > 1) {
      const sel = $('.metric', el);
      sel.innerHTML = def.metrics.map((m) => `<option value="${m}">${METRICS[m].label}</option>`).join('');
      sel.onchange = () => { this.metric = sel.value; this.update(); };
      $('.metric-field', el).hidden = false;
    }
    if (!METRICS[this.metric].segment) {
      const sel = $('.breakdown', el);
      sel.innerHTML = Object.keys(BREAKDOWNS).map((b) => `<option value="${b}">${b}</option>`).join('');
      sel.onchange = () => { this.breakdown = sel.value; this.update(); };
      $('.breakdown-field', el).hidden = false;
    } else {
      $('.breakdown2-label', el).textContent = 'Breakdown';
    }
    const sel2 = $('.breakdown2', el);
    sel2.innerHTML = Object.keys(BREAKDOWNS)
      .map((b) => `<option value="${b}">${b === 'general' ? 'none' : b}</option>`).join('');
    sel2.onchange = () => { this.breakdown2 = sel2.value; this.update(); };
    const labels = $('.labels', el);
    labels.onchange = () => { this.labels = labels.checked; this.draw(); };
    const shared = $('.shared-y', el);
    shared.checked = this.sharedY;
    shared.onchange = () => { this.sharedY = shared.checked; this.draw(); };
    const topSel = $('.top-n', el);
    topSel.value = this.showAll ? 'all' : 'top';
    topSel.onchange = () => { this.showAll = topSel.value === 'all'; this.update(); };
    el.querySelectorAll('.view').forEach((b) => {
      b.onclick = () => {
        this.view = b.dataset.view;
        el.querySelectorAll('.view').forEach((x) => x.classList.toggle('on', x === b));
        this.draw();
      };
    });
    $('.csv', el).onclick = () => this.downloadCsv();
  }

  hasSegments() {
    return Boolean(METRICS[this.metric].segment) || this.breakdown !== 'general' || this.breakdown2 !== 'general';
  }

  async update() {
    const token = (this.token = {});
    this.el.classList.add('busy');
    try {
      const data = await compute(this.metric, this.breakdown, this.breakdown2, this.showAll ? MAX_SEGMENTS : TOP_N);
      // share-of-period metrics add up to 100% per date, so a combined line means nothing there
      const overall = this.hasSegments() && !METRICS[this.metric].total
        ? await compute(this.metric, 'general', 'general') : null;
      if (token !== this.token) return; // a newer update started
      this.data = data;
      this.overall = overall;
      this.dirty = false;
      this.draw();
    } catch (e) {
      console.error(e);
      this.purge();
      this.figs.innerHTML = `<div class="empty">Query failed: ${esc(e.message)}</div>`;
    } finally {
      if (token === this.token) this.el.classList.remove('busy');
    }
  }

  // segments ordered by Σ numerator, "Other segments" last
  segments() {
    const tot = new Map();
    for (const r of this.data) tot.set(r.seg, (tot.get(r.seg) || 0) + r.num);
    const segs = [...tot.keys()].filter((s) => s !== OTHER).sort((a, b) => tot.get(b) - tot.get(a));
    return tot.has(OTHER) ? [...segs, OTHER] : segs;
  }

  colors(segs) {
    // more segments than palette slots: one color for all figures (each is titled), never generated hues
    if (segs.filter((s) => s !== OTHER).length > SLOTS.length) {
      return Object.fromEntries(segs.map((s) => [s, s === OTHER ? css('--other') : css(SLOTS[0])]));
    }
    const used = new Set();
    const out = {};
    for (const s of segs) {
      const slot = this.colorSlots.get(s);
      if (s !== OTHER && slot !== undefined && !used.has(slot)) { out[s] = slot; used.add(slot); }
    }
    for (const s of segs) {
      if (s === OTHER || s in out) continue;
      const slot = SLOTS.findIndex((_, i) => !used.has(i));
      out[s] = slot; used.add(slot); this.colorSlots.set(s, slot);
    }
    return Object.fromEntries(segs.map((s) => [s, s === OTHER ? css('--other') : css(SLOTS[out[s]])]));
  }

  label(seg) {
    return seg === 'all' ? METRICS[this.metric].label : seg;
  }

  purge() {
    this.figs.querySelectorAll('.fig-plot').forEach((p) => Plotly.purge(p));
  }

  draw() {
    const isTable = this.view === 'table';
    this.figs.hidden = isTable;
    this.tableWrap.hidden = !isTable;
    $('.shared-y-field', this.el).hidden = isTable;
    if (isTable) { this.purge(); this.drawTable(); } else this.drawFigs();
  }

  drawFigs() {
    this.purge();
    const hasRef = Boolean(this.overall?.length);
    $('.ref-note', this.el).hidden = !hasRef;
    if (!this.data.length) {
      this.figs.innerHTML = '<div class="empty">No data for these filters</div>';
      return;
    }

    const segs = this.segments();
    const colors = this.colors(segs);
    const single = segs.length === 1;
    const dates = [...new Set([...this.data, ...(this.overall || [])].map((r) => r.d))].sort();
    const usd = isUsd(this.metric) ? '$' : '';
    const ink2 = css('--ink-2');
    const muted = css('--muted');
    const surface = css('--surface');

    // one y scale for all figures, so heights compare across segments
    let yRange;
    if (this.sharedY && !single) {
      const vals = [...this.data, ...(this.overall || [])].map((r) => r.value);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const pad = (hi - lo) * 0.08 || hi * 0.1 || 0.01;
      yRange = [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad];
    }

    // shade the last period when it isn't complete (data or the Period filter ends mid-period)
    const shapes = [];
    const last = dates[dates.length - 1];
    const lastDay = state.end < bounds.max ? state.end : bounds.max;
    const partial = dates.length > 1 && nextPeriod(last) > nextDay(lastDay);
    $('.partial-note', this.el).hidden = !partial || single;
    if (partial) {
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: dates[dates.length - 2], x1: last, y0: 0, y1: 1,
                    fillcolor: css('--wash'), line: { width: 0 }, layer: 'below' });
    }

    this.figs.classList.toggle('single', single);
    this.figs.innerHTML = segs.map(() =>
      '<section class="fig"><h3><span class="swatch"></span><span class="name"></span><span class="stat muted"></span></h3>' +
      '<div class="fig-plot"></div></section>').join('');

    const ref = hasRef ? {
      type: 'scatter', mode: 'lines', name: 'All segments',
      x: this.overall.map((r) => r.d), y: this.overall.map((r) => r.value),
      customdata: this.overall.map((r) => [r.num, r.den]),
      line: { color: muted, width: 1.5, dash: 'dot' },
      hovertemplate: `All: %{y:.2%} (${usd}%{customdata[0]:,.0f} / ${usd}%{customdata[1]:,.0f})<extra></extra>`,
    } : null;

    [...this.figs.children].forEach((fig, i) => {
      const s = segs[i];
      const pts = this.data.filter((r) => r.seg === s);
      $('.swatch', fig).style.background = colors[s];
      $('.name', fig).textContent = this.label(s);
      const lastPt = pts[pts.length - 1];
      $('.stat', fig).textContent = lastPt ? `latest ${fmtPct(lastPt.value)}` : '';

      const trace = {
        type: 'scatter',
        mode: (dates.length <= 60 ? 'lines+markers' : 'lines') + (this.labels ? '+text' : ''),
        name: this.label(s),
        x: pts.map((r) => r.d),
        y: pts.map((r) => r.value),
        customdata: pts.map((r) => [r.num, r.den]),
        text: this.labels ? pts.map((r) => fmtPct(r.value)) : undefined,
        textposition: 'top center',
        textfont: { size: 10, color: ink2 },
        cliponaxis: false,
        line: { color: colors[s], width: 2 },
        marker: { color: colors[s], size: 7, line: { color: surface, width: 1.5 } },
        hovertemplate: `%{y:.2%} (${usd}%{customdata[0]:,.0f} / ${usd}%{customdata[1]:,.0f})<extra></extra>`,
      };
      const layout = {
        margin: { l: 52, r: 14, t: single ? 24 : this.labels ? 18 : 8, b: 32 },
        paper_bgcolor: surface,
        plot_bgcolor: surface,
        font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 11, color: ink2 },
        hovermode: 'x unified',
        hoverlabel: { bgcolor: surface, bordercolor: css('--border'), font: { color: css('--ink') } },
        xaxis: { type: 'date', range: xRange(dates[0], last), gridcolor: css('--grid'), linecolor: css('--axis'),
                 tickfont: { color: muted }, hoverformat: '%Y-%m-%d', zeroline: false,
                 ...xTicks(dates.length, single ? 12 : 6) },
        // tiny shares (e.g. 0.04%) need two decimals, or ticks repeat as "0.0%, 0.0%, 0.1%"
        yaxis: { tickformat: (yRange ? yRange[1] : Math.max(...pts.map((r) => r.value))) < 0.03 ? '.2%' : '.1%',
                 gridcolor: css('--grid'), linecolor: css('--axis'), tickfont: { color: muted },
                 zeroline: false, nticks: single ? 8 : 5,
                 // rates can't go below 0; a lone point would otherwise get a -50%..100% axis
                 ...(yRange ? { range: yRange }
                   : pts.length === 1 ? { range: [0, pts[0].value * 2 || 0.01] } : { rangemode: 'nonnegative' }) },
        showlegend: false,
        shapes,
        // small figures carry the shading only; the note in the page head names it
        annotations: partial && single ? [{ xref: 'x', yref: 'paper', x: last, y: 1, xanchor: 'right', yanchor: 'bottom',
                                  text: 'incomplete', showarrow: false, font: { size: 10, color: muted } }] : [],
      };
      Plotly.newPlot($('.fig-plot', fig), ref ? [ref, trace] : [trace], layout, PLOT_CONFIG);
    });
  }

  drawTable() {
    if (!this.data.length) {
      this.tableWrap.innerHTML = '<div class="empty" style="height:120px">No data for these filters</div>';
      return;
    }
    const segs = this.segments();
    const byKey = new Map(this.data.map((r) => [`${r.d}|${r.seg}`, r]));
    const ref = new Map((this.overall || []).map((r) => [r.d, r]));
    const dates = [...new Set(this.data.map((r) => r.d))].reverse();
    const f = isUsd(this.metric) ? fmtUsd : fmtNum;
    const cell = (r) => (r ? `<td title="${f(r.num)} / ${f(r.den)}">${fmtPct(r.value)}</td>` : '<td class="muted">–</td>');
    const head = `<tr><th>Date</th>${ref.size ? '<th>All segments</th>' : ''}` +
      `${segs.map((s) => `<th>${esc(this.label(s))}</th>`).join('')}</tr>`;
    const body = dates.map((d) => `<tr><td>${d}</td>${ref.size ? cell(ref.get(d)) : ''}` +
      `${segs.map((s) => cell(byKey.get(`${d}|${s}`))).join('')}</tr>`).join('');
    this.tableWrap.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  downloadCsv() {
    const lines = [['date', 'segment', 'numerator', 'denominator', 'value'].join(',')];
    const rowsOut = [...(this.overall || []).map((r) => ({ ...r, seg: 'All segments' })), ...this.data];
    for (const r of rowsOut) {
      lines.push([r.d, `"${this.label(r.seg).replace(/"/g, '""')}"`, r.num, r.den, r.value].join(','));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const bd = [METRICS[this.metric].segment || this.breakdown, this.breakdown2].filter((b) => b !== 'general');
    a.download = `${[this.metric, ...bd].join('_')}_${state.step}_${state.start}_${state.end}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

// ---------- controls ----------

function setLoading(text) { $('#loading-text').textContent = text; }

// checkbox dropdown; with `search`, a text box narrows the list (Enter toggles the first match)
function buildMulti(name, values, { search = false, noun = 'selected', selected = [] } = {}) {
  const box = $(`#f-${name}`);
  const menu = $('.menu', box);
  menu.innerHTML = (search ? '<input type="search" class="search" placeholder="Type a name…" autocomplete="off">' : '') +
    `<label class="all"><input type="checkbox" value="__all"> All</label>` +
    values.map((v) => `<label><input type="checkbox" value="${esc(v)}"${selected.includes(v) ? ' checked' : ''}> ${esc(v)}</label>`).join('');
  const all = $('input[value="__all"]', menu);
  const items = [...menu.querySelectorAll('input[type="checkbox"]:not([value="__all"])')];
  const read = () => {
    state[name] = items.filter((i) => i.checked).map((i) => i.value);
    all.checked = state[name].length === 0;
    const n = state[name].length;
    $('summary', box).textContent = n === 0 ? 'All' : n <= 2 ? state[name].join(', ') : `${n} ${noun}`;
  };
  read(); // initial selection, no refresh yet
  const sync = () => { read(); refresh(); };
  all.onchange = () => { items.forEach((i) => { i.checked = false; }); sync(); };
  items.forEach((i) => { i.onchange = sync; });

  if (search) {
    const input = $('.search', menu);
    const visible = () => items.filter((i) => !i.parentElement.classList.contains('nomatch'));
    input.oninput = () => {
      const s = input.value.trim().toLowerCase();
      items.forEach((i) => i.parentElement.classList.toggle('nomatch', !!s && !i.value.toLowerCase().includes(s)));
    };
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = visible()[0];
      if (first) { first.checked = !first.checked; sync(); }
    };
    box.addEventListener('toggle', () => { if (box.open) { input.value = ''; input.oninput(); input.focus(); } });
  }
}

function applyPreset(p) {
  const end = new Date(bounds.max + 'T00:00:00Z');
  const start = new Date(end);
  if (p === '28d') start.setUTCDate(start.getUTCDate() - 27);
  else if (p === '3m') start.setUTCMonth(start.getUTCMonth() - 3);
  else if (p === '6m') start.setUTCMonth(start.getUTCMonth() - 6);
  else if (p === 'ytd') { start.setUTCMonth(0); start.setUTCDate(1); }
  const s = p === 'all' ? bounds.min : start.toISOString().slice(0, 10);
  state.start = s < bounds.min ? bounds.min : s;
  state.end = bounds.max;
  $('#start').value = state.start;
  $('#end').value = state.end;
  markPreset(p);
}

function markPreset(p) {
  document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.preset === p));
}

// ---------- pages ----------

let charts = [];
let active = null;

// ?page=<chart id> picks the page (the #fragment holds the data key); only the visible chart is queried,
// the others refresh when opened
function route() {
  const id = new URLSearchParams(location.search).get('page');
  const next = charts.find((c) => c.def.id === id) || charts[0];
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.id === next.def.id));
  if (next === active) return;
  if (active) active.purge();
  active = next;
  $('#page').replaceChildren(next.el);
  document.title = `${next.def.title} · Refund metrics`;
  if (next.dirty) next.update(); else next.draw();
}

let refreshTimer;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    charts.forEach((c) => { c.dirty = true; });
    await kpis().then(renderKpis).catch(console.error);
    active?.update();
  }, 120);
}

async function main() {
  try {
    await initDb();
  } catch (e) {
    console.error(e);
    $('#loading').classList.add('error');
    setLoading(`Could not load data: ${e.message}`);
    return;
  }

  const [b] = await rows(`SELECT strftime(min(date), '%Y-%m-%d') AS min, strftime(max(date), '%Y-%m-%d') AS max FROM t`);
  bounds = b;
  for (const f of FILTERS) {
    const vals = (await rows(`SELECT DISTINCT ${f} AS v FROM t ORDER BY 1`)).map((r) => r.v);
    buildMulti(f, vals);
  }
  const agents = (await rows(`SELECT DISTINCT support_agent_email AS v FROM t
                              WHERE support_agent_email != '(none)' ORDER BY 1`)).map((r) => r.v);
  buildMulti('agent', agents, { search: true, noun: 'agents' });
  const refundTypes = (await rows(`SELECT DISTINCT refund_type AS v FROM t
                                   WHERE type != 'transaction' ORDER BY 1`)).map((r) => r.v);
  buildMulti('refund_type', refundTypes, { search: true, noun: 'types',
                                           selected: DEFAULT_REFUND_TYPES.filter((v) => refundTypes.includes(v)) });
  let meta = '';
  try {
    const m = await (await fetch('data/meta.json', { cache: 'no-cache' })).json();
    meta = ` · exported ${m.exported_at}`;
  } catch { /* meta.json is optional */ }
  $('#asof').textContent = `Data ${bounds.min} – ${bounds.max}${meta}`;

  for (const inp of ['#start', '#end']) {
    $(inp).min = bounds.min;
    $(inp).max = bounds.max;
  }
  applyPreset('6m');

  $('#step').onchange = (e) => { state.step = e.target.value; refresh(); };
  $('#start').onchange = (e) => { if (e.target.value) { state.start = e.target.value; markPreset(null); refresh(); } };
  $('#end').onchange = (e) => { if (e.target.value) { state.end = e.target.value; markPreset(null); refresh(); } };
  document.querySelectorAll('#presets button').forEach((btn) => {
    btn.onclick = () => { applyPreset(btn.dataset.preset); refresh(); };
  });
  // close open multi-selects on outside click
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.multi[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
  // dark / light switch: redraw with the new tokens
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => active?.draw());

  charts = CHARTS.map((def) => new Chart(def));
  $('#tabs').innerHTML = CHARTS.map((c) => `<a href="?page=${c.id}" data-id="${c.id}">${c.title}</a>`).join('');
  // switch pages without reloading (a reload would download and decrypt the data again); keep the key in the URL
  $('#tabs').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    history.pushState(null, '', `?page=${a.dataset.id}${location.hash}`);
    route();
  });
  // a tab opened in a new window needs the key too
  document.querySelectorAll('#tabs a').forEach((a) => { a.href = `?page=${a.dataset.id}${location.hash}`; });
  window.addEventListener('popstate', route);
  $('#loading').hidden = true;
  $('#kpis').hidden = false;
  $('#page').hidden = false;
  kpis().then(renderKpis).catch(console.error);
  route();
}

main();
