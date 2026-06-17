const { MSG, PLATFORM, buildSearchUrl, browser } = require('../shared/constants');

// Prevent double-injection on re-click
if (document.getElementById('feedme-root')) return;

const host = document.createElement('div');
host.id = 'feedme-root';
host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;width:100%;z-index:2147483647;pointer-events:auto;';
document.body.appendChild(host);

const shadow = host.attachShadow({ mode: 'open' });

const styleEl = document.createElement('style');
styleEl.textContent = `
* { box-sizing: border-box; margin: 0; padding: 0; }
#bar { width:100%; max-height:80vh; background:#fff; border-top:1px solid #e5e7eb;
  display:flex; flex-direction:column;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  box-shadow:0 -4px 24px rgba(0,0,0,.12); }
.hd { padding:12px 14px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:10px; flex-shrink:0; }
.logo { font-size:15px; font-weight:800; color:#111; }
.logo .accent { color:#f97316; }
.meta { flex:1; font-size:11px; color:#6b7280; }
.meta .mname { display:block; font-size:12px; font-weight:600; color:#374151; }
.cls { color:#9ca3af; font-size:16px; cursor:pointer; background:none; border:none; padding:2px 6px; }
/* Cards sit side by side, sharing the width; the row scrolls (x if too many to
   fit, y if a single card is taller than the bar) rather than squashing cards. */
.bd { min-height:0; overflow:auto; padding:14px; display:flex; flex-direction:row;
  align-items:flex-start; gap:14px; }
.loading { display:flex; align-items:center; justify-content:center; width:100%; gap:8px;
  color:#9ca3af; font-size:13px; padding:30px; }
.spin { width:24px; height:24px; border:2px solid #e5e7eb; border-top-color:#f97316;
  border-radius:50%; animation:sp .8s linear infinite; }
@keyframes sp { to { transform:rotate(360deg); } }
/* Each card is an equal-width column in the row, with a sensible minimum so they
   stay readable (the row scrolls horizontally if they can't all fit). */
.card { border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;
  flex:1 1 0; min-width:280px; }
.card.win { border:2px solid #22c55e; }
.card.cur { background:#fafafa; }
.ch { padding:10px 12px; display:flex; align-items:center; gap:8px; background:#fafafa;
  border-bottom:1px solid #e5e7eb; }
.card.win .ch { background:#f0fdf4; }
.pname { font-size:14px; font-weight:700; flex:1; display:flex; align-items:center; gap:6px; }
.wb { background:#22c55e; color:#fff; font-size:9px; font-weight:800; padding:2px 6px; border-radius:8px; }
.cb { background:#f3f4f6; color:#6b7280; font-size:9px; font-weight:700; padding:2px 6px; border-radius:8px; }
.ptotal { font-size:22px; font-weight:800; color:#111; }
.card.win .ptotal { color:#16a34a; }
.cbody { padding:10px 14px; display:flex; flex-direction:column; gap:4px; }
.row { display:flex; justify-content:space-between; font-size:13px; color:#6b7280; padding:3px 0; gap:10px; }
.row.b { color:#374151; font-weight:600; border-top:1px solid #e5e7eb; padding-top:4px; margin-top:2px; }
.row.g { color:#16a34a; }
.row.r { color:#ef4444; }
.off { margin:0 14px 10px; background:#f0fdf4; border:1px solid #bbf7d0;
  border-radius:6px; padding:6px 9px; font-size:11px; color:#15803d; }
.off.n { background:#fafafa; border-color:#e5e7eb; color:#9ca3af; }
.obtn { margin:0 12px 12px; background:#f3f4f6; color:#374151; border:none;
  border-radius:7px; padding:9px; font-size:11px; font-weight:700; cursor:pointer;
  width:calc(100% - 24px); }
.obtn:hover { background:#e5e7eb; }
.ft { border-top:2px solid #dcfce7; background:#f0fdf4; padding:10px 14px; font-size:12px; color:#15803d; flex-shrink:0; }
.ft .save { font-weight:700; color:#166534; }
.ft.sw { background:#fff7ed; border-top-color:#fed7aa; color:#c2410c; }
.ft.sw .save { color:#7c2d12; }
.cv { font-size:10px; color:#6b7280; margin-top:3px; }
.errc { border:1px solid #fecaca; border-radius:10px; padding:12px; font-size:12px; color:#ef4444; }
.cols { display:flex; flex-direction:row; gap:10px; padding:12px; align-items:flex-start; width:100%; }
.col { flex:1 1 0; min-width:0; }
.colhd { font-size:12px; font-weight:700; color:#374151; padding:0 2px 6px; display:flex; align-items:center; gap:5px; }
.bc { border:1px solid #e5e7eb; border-radius:8px; margin-bottom:7px; overflow:hidden; background:#fff; }
.bc.win { border:2px solid #22c55e; }
.bc.cur { background:#fafafa; }
.bch { padding:7px 9px; display:flex; align-items:center; justify-content:space-between; gap:6px; }
.bc.win .bch { background:#f0fdf4; }
.bn { font-size:11px; font-weight:600; color:#374151; display:flex; flex-direction:column; gap:1px; }
.bn .sub { font-size:9px; color:#9ca3af; font-weight:500; }
.bt { font-size:15px; font-weight:800; color:#111; white-space:nowrap; }
.bc.win .bt { color:#16a34a; }
.tag { font-size:8px; font-weight:800; padding:1px 5px; border-radius:6px; margin-left:4px; align-self:flex-start; }
.tag.ch { background:#22c55e; color:#fff; }
.tag.cu { background:#eef2ff; color:#4f46e5; }
.det { border-top:1px dashed #e5e7eb; padding:6px 9px; font-size:10px; color:#6b7280; display:flex; flex-direction:column; gap:2px; }
.det .r { display:flex; justify-content:space-between; }
.collrow { padding:6px 9px; display:flex; align-items:center; justify-content:space-between; font-size:10px; color:#6b7280; cursor:pointer; }
.collrow:hover { background:#fafafa; }
`;

const bar = document.createElement('div');
bar.id = 'bar';

const hd = document.createElement('div');
hd.className = 'hd';

const logoEl = document.createElement('div');
logoEl.className = 'logo';
logoEl.textContent = 'feed';
const accentSpan = document.createElement('span');
accentSpan.className = 'accent';
accentSpan.textContent = 'me';
logoEl.appendChild(accentSpan);

const metaEl = document.createElement('div');
metaEl.className = 'meta';
const mname = document.createElement('span');
mname.className = 'mname';
mname.textContent = 'Finding prices...';
metaEl.appendChild(mname);

const clsBtn = document.createElement('button');
clsBtn.className = 'cls';
clsBtn.textContent = '✕';
clsBtn.addEventListener('click', () => host.remove());

hd.appendChild(logoEl);
hd.appendChild(metaEl);
hd.appendChild(clsBtn);

const bd = document.createElement('div');
bd.className = 'bd';
bd.id = 'bd';

const loadingDiv = document.createElement('div');
loadingDiv.className = 'loading';
const spinDiv = document.createElement('div');
spinDiv.className = 'spin';
const loadingText = document.createTextNode('Fetching prices from other platforms...');
loadingDiv.appendChild(spinDiv);
loadingDiv.appendChild(loadingText);
bd.appendChild(loadingDiv);

bar.appendChild(hd);
bar.appendChild(bd);
shadow.appendChild(styleEl);
shadow.appendChild(bar);

const expanded = new Set();
const fmt = (n) => `£${(+n || 0).toFixed(2)}`;

const PLATFORM_LABEL = {
  [PLATFORM.UBER_EATS]: { emoji: '🟠', name: 'Uber Eats' },
  [PLATFORM.DELIVEROO]: { emoji: '🔵', name: 'Deliveroo' },
  [PLATFORM.JUST_EAT]: { emoji: '🟣', name: 'Just Eat' },
};

function branchTotal(branch) {
  return branch.status === 'done' ? branch.result.total.total : null;
}

// Full (expanded) branch card: header + item rows + fee breakdown + offers.
function buildBranchCard(branch, isCheapest) {
  const card = document.createElement('div');
  card.className = `bc${isCheapest ? ' win' : ''}${branch.isCurrent ? ' cur' : ''}`;

  const head = document.createElement('div');
  head.className = 'bch';
  const nameWrap = document.createElement('span');
  nameWrap.className = 'bn';
  const labelLine = document.createElement('span');
  labelLine.textContent = branch.label || branch.result?.restaurantName || '';
  nameWrap.appendChild(labelLine);
  if (branch.isCurrent) appendTag(nameWrap, 'YOUR CART', 'cu');
  if (isCheapest) appendTag(nameWrap, 'CHEAPEST', 'ch');
  if (branch.distance != null) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${branch.distance} mi`;
    nameWrap.appendChild(sub);
  }
  const totalEl = document.createElement('span');
  totalEl.className = 'bt';
  totalEl.textContent = branch.status === 'error' ? '—' : fmt(branchTotal(branch));
  head.appendChild(nameWrap);
  head.appendChild(totalEl);
  card.appendChild(head);

  if (branch.status === 'error') {
    const err = document.createElement('div');
    err.className = 'det';
    err.textContent = `Could not load (${branch.result.error})`;
    card.appendChild(err);
    return card;
  }
  const det = document.createElement('div');
  det.className = 'det';
  const t = branch.result.total;
  appendDetRow(det, 'Subtotal', fmt(t.itemsTotal));
  appendDetRow(det, 'Delivery', fmt(t.deliveryFee));
  appendDetRow(det, `Service${t.serviceFeeEstimated ? ' (est.)' : ''}`, fmt(t.serviceFee));
  if (t.discountTotal > 0) appendDetRow(det, 'Discounts', `-${fmt(t.discountTotal)}`);
  card.appendChild(det);
  return card;
}

// Collapsed one-line row; clicking it expands that branch on the next render.
function buildCollapsedRow(branch) {
  const wrap = document.createElement('div');
  wrap.className = 'bc';
  const row = document.createElement('div');
  row.className = 'collrow';
  const left = document.createElement('span');
  left.textContent = branch.distance != null
    ? `${branch.label || 'Branch'} · ${branch.distance} mi`
    : (branch.label || 'Branch');
  const right = document.createElement('span');
  right.textContent = branch.status === 'error' ? 'error ▾'
    : branch.status === 'pending' ? '… ▾' : `${fmt(branchTotal(branch))} ▾`;
  row.appendChild(left);
  row.appendChild(right);
  row.addEventListener('click', () => { expanded.add(branch.key); render(lastSnapshot, lastOrder); });
  wrap.appendChild(row);
  return wrap;
}

function appendTag(parent, text, cls) {
  const t = document.createElement('span');
  t.className = `tag ${cls}`;
  t.textContent = text;
  parent.appendChild(t);
}
function appendDetRow(parent, label, value) {
  const r = document.createElement('div');
  r.className = 'r';
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('span'); v.textContent = value;
  r.appendChild(l); r.appendChild(v); parent.appendChild(r);
}

let lastSnapshot = null;
let lastOrder = null;

function render(snapshot, order) {
  lastSnapshot = snapshot;
  lastOrder = order;
  if (!snapshot) return;

  mname.textContent = order.restaurantName;
  while (metaEl.childNodes.length > 1) metaEl.removeChild(metaEl.lastChild);
  const subtext = document.createElement('span');
  subtext.textContent = `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;
  metaEl.appendChild(subtext);

  bd.textContent = '';
  const cols = document.createElement('div');
  cols.className = 'cols';

  snapshot.platforms.forEach((col) => {
    const colEl = document.createElement('div');
    colEl.className = 'col';
    const hd = document.createElement('div');
    hd.className = 'colhd';
    const { emoji, name } = PLATFORM_LABEL[col.platform];
    hd.textContent = `${emoji} ${name}`;
    colEl.appendChild(hd);

    // Order branches: cheapest first (expanded), current pinned, then by distance.
    const ordered = [...col.branches].sort((a, b) => {
      if (a.key === col.cheapestKey) return -1;
      if (b.key === col.cheapestKey) return 1;
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return (a.distance ?? Infinity) - (b.distance ?? Infinity);
    });

    ordered.forEach((branch) => {
      const showFull = branch.key === col.cheapestKey || branch.isCurrent || expanded.has(branch.key);
      colEl.appendChild(showFull
        ? buildBranchCard(branch, branch.key === col.cheapestKey)
        : buildCollapsedRow(branch));
    });

    if (col.spinner) {
      const sp = document.createElement('div');
      sp.className = 'loading';
      const s = document.createElement('div'); s.className = 'spin';
      sp.appendChild(s); sp.appendChild(document.createTextNode('Finding branches…'));
      colEl.appendChild(sp);
    } else if (!col.branches.length) {
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'No branches found';
      colEl.appendChild(none);
    }
    cols.appendChild(colEl);
  });
  bd.appendChild(cols);

  renderFooter(snapshot);
}

function renderFooter(snapshot) {
  const existing = bar.querySelector('.ft');
  if (existing) existing.remove();
  const ft = document.createElement('div');
  const f = snapshot.footer;
  if (f.kind === 'switch') {
    ft.className = 'ft sw';
    ft.textContent = 'Switch to ';
    const who = document.createElement('span'); who.className = 'save';
    who.textContent = `${PLATFORM_LABEL[f.platform].name}${f.label ? ` (${f.label})` : ''}`;
    ft.appendChild(who);
    ft.appendChild(document.createTextNode(' to save '));
    const amt = document.createElement('span'); amt.className = 'save';
    amt.textContent = fmt(f.saving);
    ft.appendChild(amt);
  } else if (f.kind === 'best') {
    ft.className = 'ft';
    ft.textContent = "✅ You're already on the cheapest branch";
  } else {
    ft.className = 'ft';
    ft.textContent = 'Comparing branches…';
  }
  bar.appendChild(ft);
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== MSG.COMPARISON_UPDATE) return;
  render(msg.snapshot, msg.order);
});
