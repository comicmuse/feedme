const {
  MSG, PLATFORM, buildSearchUrl, browser,
  JUST_EAT_STAMP_CARD_PERCENT, JUST_EAT_STAMP_CARD_SIZE,
} = require('../shared/constants');

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
.errc { border:1px solid #fecaca; border-radius:10px; padding:12px; font-size:12px; color:#ef4444;
  display:flex; flex-direction:column; gap:6px; align-items:flex-start; }
.retrybtn { background:#f3f4f6; color:#374151; border:none; border-radius:6px;
  padding:6px 10px; font-size:10px; font-weight:700; cursor:pointer; }
.retrybtn:hover { background:#e5e7eb; }
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
.det .r .approx { text-decoration:underline dotted; text-underline-offset:2px; cursor:help; }
.collrow { padding:6px 9px; display:flex; align-items:center; justify-content:space-between; font-size:10px; color:#6b7280; cursor:pointer; }
.collrow:hover { background:#fafafa; }
/* Switch CTA on a branch card: opens that branch and fills its basket. */
.swbtn { margin:6px 9px 9px; background:#f97316; color:#fff; border:none; border-radius:7px;
  padding:8px; font-size:11px; font-weight:700; cursor:pointer; width:calc(100% - 18px); }
.swbtn:hover { background:#ea580c; }
.swbtn.plain { background:#f3f4f6; color:#374151; }
.swbtn.plain:hover { background:#e5e7eb; }
.ft.sw.clk { cursor:pointer; }
.ft.sw.clk:hover { background:#ffedd5; }
.ft .arr { margin-left:4px; }
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

// Ask the worker to open this branch in a foreground tab and build its basket.
function switchToBranch(branchKey) {
  browser.runtime.sendMessage({ type: MSG.SWITCH_TO_BRANCH, branchKey });
}

// Ask the worker to retry a single branch's menu scrape after a failure.
function retryBranch(branchKey) {
  browser.runtime.sendMessage({ type: MSG.RETRY_BRANCH, branchKey });
}

// Ask the worker to retry a platform's enumeration after a timeout.
function retryPlatform(platform) {
  browser.runtime.sendMessage({ type: MSG.RETRY_PLATFORM, platform });
}

// Label for a branch's switch button, reflecting how much of the basket can be
// pre-filled (vs. opened for manual add). Returns null when there's no usable URL.
function switchButtonLabel(branch) {
  if (!branch.switchUrl) return null;
  const plan = branch.result?.basketPlan ?? [];
  const fillable = plan.filter((l) => l.prefillable).length;
  // A line with a matched item id is worth attempting even when its options
  // only carry names (#51 — Uber targets expose no option data, so nothing
  // there is ever fully "prefillable"): the builder selects options by name
  // text and review-flags what it can't complete. Only a plan with no matched
  // items at all falls back to the plain menu link.
  const attemptable = plan.filter((l) => l.id != null).length;
  if (!plan.length || attemptable === 0) return { text: 'Open menu ↗', plain: true };
  if (fillable === plan.length) return { text: 'Switch & fill basket ↗', plain: false };
  return { text: `Switch & fill ${attemptable} of ${plan.length} ↗`, plain: false };
}

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
  totalEl.textContent = (branch.status === 'error' || branch.status === 'pending') ? '—' : fmt(branchTotal(branch));
  head.appendChild(nameWrap);
  head.appendChild(totalEl);
  card.appendChild(head);

  if (branch.status === 'error') {
    const err = document.createElement('div');
    err.className = 'det';
    err.textContent = `Could not load (${branch.result.error})`;
    card.appendChild(err);
    // 'bad-url' is a permanent origin-validation failure — retrying it fails the
    // same way every time, so no button for it.
    if (branch.result.error !== 'bad-url') {
      const retry = document.createElement('button');
      retry.className = 'retrybtn';
      retry.textContent = 'Retry ↻';
      retry.addEventListener('click', (e) => { e.stopPropagation(); retryBranch(branch.key); });
      card.appendChild(retry);
    }
    return card;
  }
  // A branch a user expanded while it was 'error' stays in the `expanded` Set;
  // a retry flips it back to 'pending', so this card renders again before the
  // scrape resolves. branch.result is null in this state.
  if (branch.status === 'pending') {
    const pending = document.createElement('div');
    pending.className = 'det';
    pending.textContent = 'Retrying…';
    card.appendChild(pending);
    return card;
  }
  const det = document.createElement('div');
  det.className = 'det';
  const t = branch.result.total;
  appendDetRow(det, 'Subtotal', fmt(t.itemsTotal));
  // Just Eat's delivery fee varies with demand (busy surge) and by basket band, so
  // the value we snapshot at comparison time can differ at checkout — flag it.
  // An Uber sibling's fee is exact when its own store page published it, and a copy
  // of your cart's fee when it didn't — mark only the copy, so the exact case stops
  // being labelled like a guess (#63).
  const deliveryNote = branch.platform === PLATFORM.JUST_EAT
    ? { marker: 'approx.', tooltip: "Just Eat's delivery fee varies with demand, so it may differ at checkout." }
    : t.deliveryFeeEstimated
      ? { marker: 'approx.', tooltip: "This branch didn't publish a delivery fee, so your current cart's is used." }
      : null;
  appendDetRow(det, 'Delivery', fmt(t.deliveryFee), deliveryNote);
  appendDetRow(det, `Service${t.serviceFeeEstimated ? ' (est.)' : ''}`, fmt(t.serviceFee));
  if (t.bagFee > 0) appendDetRow(det, 'Bag fee', fmt(t.bagFee));
  // The subtotal threshold below which Just Eat charges this is per-restaurant
  // and unpublished; we apply the common £10, so near the boundary it may not
  // match checkout.
  if (t.smallOrderFee > 0) {
    appendDetRow(det, 'Small order', fmt(t.smallOrderFee), {
      marker: 'approx.',
      tooltip: 'Just Eat adds a small-order fee below a spend threshold that varies by restaurant, so this may not apply at checkout.',
    });
  }
  if (t.discountTotal > 0) appendDetRow(det, 'Discounts', `-${fmt(t.discountTotal)}`);
  // A StampCard is deferred value, not a discount: the branch accrues a share of
  // this order toward a voucher released on the Nth order, redeemable only there.
  // So it is deliberately NOT in the total and cannot reorder the comparison —
  // it renders as a note, below the money, with no amount (#72).
  if (branch.earnsStampCard) {
    appendNoteRow(
      det,
      'StampCard',
      `earns ${JUST_EAT_STAMP_CARD_PERCENT}%`,
      `Earns a stamp worth ${JUST_EAT_STAMP_CARD_PERCENT}% of this order toward a voucher on your `
        + `${JUST_EAT_STAMP_CARD_SIZE}th order from this branch. It doesn't reduce this order.`,
    );
  }
  // Some of the cart's items may not exist on this branch's menu. We can't price
  // them, so they're excluded from the total — which makes a poor-coverage branch
  // look cheaper than the equivalent full basket. Surface the coverage and mark
  // the total as understated so it's visible before switching (#50).
  if (t.totalCount > t.matchedCount) {
    const missing = t.totalCount - t.matchedCount;
    const itemWord = missing === 1 ? "item isn't" : "items aren't";
    appendDetRow(det, 'Items matched', `${t.matchedCount} of ${t.totalCount}`, {
      marker: 'approx.',
      tooltip: `${missing} ${itemWord} on this menu, so this total is lower than your full basket.`,
    });
    const mark = document.createElement('span');
    mark.className = 'approx';
    mark.textContent = ' *';
    mark.title = `Total excludes ${missing} item${missing === 1 ? '' : 's'} not on this menu.`;
    totalEl.appendChild(mark);
  }
  card.appendChild(det);

  // Non-current branches get a CTA to open them and fill the basket.
  if (!branch.isCurrent) {
    const label = switchButtonLabel(branch);
    if (label) {
      const btn = document.createElement('button');
      btn.className = `swbtn${label.plain ? ' plain' : ''}`;
      btn.textContent = label.text;
      btn.addEventListener('click', (e) => { e.stopPropagation(); switchToBranch(branch.key); });
      card.appendChild(btn);
    }
  }
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
// `note`, when given, appends an "(approx.)"-style marker after the label carrying
// a hover tooltip — used where a fee we show is not the exact amount at checkout.
function appendDetRow(parent, label, value, note) {
  const r = document.createElement('div');
  r.className = 'r';
  const l = document.createElement('span'); l.textContent = label;
  if (note) {
    const marker = document.createElement('span');
    marker.className = 'approx';
    marker.textContent = ` (${note.marker})`;
    marker.title = note.tooltip;
    l.appendChild(marker);
  }
  const v = document.createElement('span'); v.textContent = value;
  r.appendChild(l); r.appendChild(v); parent.appendChild(r);
}

// A det row whose value is a note rather than an amount. Distinct from
// appendDetRow's `note`, which qualifies a number we are showing: here there is
// no number, and the hover explains why the row doesn't move the total.
function appendNoteRow(parent, label, value, tooltip) {
  const r = document.createElement('div');
  r.className = 'r';
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('span');
  v.className = 'approx';
  v.textContent = value;
  v.title = tooltip;
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

  // Only the single overall-cheapest branch is highlighted (no per-column winner).
  const cheapestKey = snapshot.cheapestKey;

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
      if (a.key === cheapestKey) return -1;
      if (b.key === cheapestKey) return 1;
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return (a.distance ?? Infinity) - (b.distance ?? Infinity);
    });

    ordered.forEach((branch) => {
      const showFull = branch.key === cheapestKey || branch.isCurrent || expanded.has(branch.key);
      colEl.appendChild(showFull
        ? buildBranchCard(branch, branch.key === cheapestKey)
        : buildCollapsedRow(branch));
    });

    if (col.spinner) {
      const sp = document.createElement('div');
      sp.className = 'loading';
      const s = document.createElement('div'); s.className = 'spin';
      sp.appendChild(s); sp.appendChild(document.createTextNode('Finding branches…'));
      colEl.appendChild(sp);
    } else if (col.enumFailed) {
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'Could not load branches (timeout)';
      const retry = document.createElement('button');
      retry.className = 'retrybtn';
      retry.textContent = 'Retry ↻';
      retry.addEventListener('click', () => retryPlatform(col.platform));
      none.appendChild(retry);
      colEl.appendChild(none);
    } else if (!col.branches.length) {
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'No branches found';
      colEl.appendChild(none);
    } else if (col.branches.every((b) => b.isCurrent)) {
      // Enumeration found nothing beyond the user's own branch (live 2026-07-12:
      // Uber's brand search returns only the nearest store, which is the source
      // store itself) — say so rather than showing a column that silently does
      // nothing (#38).
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'No other branches found';
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
    // Clickable only when the cheapest branch has a validated URL to open.
    ft.className = `ft sw${f.switchUrl ? ' clk' : ''}`;
    ft.textContent = 'Switch to ';
    const who = document.createElement('span'); who.className = 'save';
    who.textContent = `${PLATFORM_LABEL[f.platform].name}${f.label ? ` (${f.label})` : ''}`;
    ft.appendChild(who);
    ft.appendChild(document.createTextNode(' to save '));
    const amt = document.createElement('span'); amt.className = 'save';
    amt.textContent = fmt(f.saving);
    ft.appendChild(amt);
    if (f.switchUrl) {
      const arr = document.createElement('span'); arr.className = 'arr'; arr.textContent = '↗';
      ft.appendChild(arr);
      ft.addEventListener('click', () => switchToBranch(f.key));
    }
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
