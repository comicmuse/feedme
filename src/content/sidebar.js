const { MSG, PLATFORM, buildSearchUrl, browser } = require('../shared/constants');

// Prevent double-injection on re-click
if (document.getElementById('feedme-root')) return;

const LABEL = {
  [PLATFORM.UBER_EATS]: { emoji: '🟠', name: 'Uber Eats' },
  [PLATFORM.DELIVEROO]: { emoji: '🔵', name: 'Deliveroo' },
  [PLATFORM.JUST_EAT]: { emoji: '🟣', name: 'Just Eat' },
};

const host = document.createElement('div');
host.id = 'feedme-root';
host.style.cssText = 'position:fixed;top:0;right:0;width:400px;height:100vh;z-index:2147483647;pointer-events:auto;';
document.body.appendChild(host);

const shadow = host.attachShadow({ mode: 'open' });

const styleEl = document.createElement('style');
styleEl.textContent = `
* { box-sizing: border-box; margin: 0; padding: 0; }
#bar { width:400px; height:100vh; background:#fff; border-left:1px solid #e5e7eb;
  display:flex; flex-direction:column;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  box-shadow:-4px 0 20px rgba(0,0,0,.08); }
.hd { padding:12px 14px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:10px; }
.logo { font-size:15px; font-weight:800; color:#111; }
.logo .accent { color:#f97316; }
.meta { flex:1; font-size:11px; color:#6b7280; }
.meta .mname { display:block; font-size:12px; font-weight:600; color:#374151; }
.cls { color:#9ca3af; font-size:16px; cursor:pointer; background:none; border:none; padding:2px 6px; }
.bd { flex:1; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
.loading { display:flex; align-items:center; justify-content:center; flex:1; gap:8px;
  color:#9ca3af; font-size:13px; flex-direction:column; }
.spin { width:24px; height:24px; border:2px solid #e5e7eb; border-top-color:#f97316;
  border-radius:50%; animation:sp .8s linear infinite; }
@keyframes sp { to { transform:rotate(360deg); } }
.card { border:1px solid #e5e7eb; border-radius:10px; overflow:hidden; }
.card.win { border:2px solid #22c55e; }
.card.cur { background:#fafafa; }
.ch { padding:10px 12px; display:flex; align-items:center; gap:8px; background:#fafafa;
  border-bottom:1px solid #e5e7eb; }
.card.win .ch { background:#f0fdf4; }
.pname { font-size:12px; font-weight:700; flex:1; display:flex; align-items:center; gap:6px; }
.wb { background:#22c55e; color:#fff; font-size:8px; font-weight:800; padding:2px 6px; border-radius:8px; }
.cb { background:#f3f4f6; color:#6b7280; font-size:8px; font-weight:700; padding:2px 6px; border-radius:8px; }
.ptotal { font-size:18px; font-weight:800; color:#111; }
.card.win .ptotal { color:#16a34a; }
.cbody { padding:8px 12px; display:flex; flex-direction:column; gap:3px; }
.row { display:flex; justify-content:space-between; font-size:11px; color:#6b7280; padding:2px 0; }
.row.b { color:#374151; font-weight:600; border-top:1px solid #e5e7eb; padding-top:4px; margin-top:2px; }
.row.g { color:#16a34a; }
.row.r { color:#ef4444; }
.off { margin:0 12px 10px; background:#f0fdf4; border:1px solid #bbf7d0;
  border-radius:6px; padding:5px 8px; font-size:10px; color:#15803d; }
.off.n { background:#fafafa; border-color:#e5e7eb; color:#9ca3af; }
.obtn { margin:0 12px 12px; background:#f3f4f6; color:#374151; border:none;
  border-radius:7px; padding:9px; font-size:11px; font-weight:700; cursor:pointer;
  width:calc(100% - 24px); }
.obtn:hover { background:#e5e7eb; }
.ft { border-top:2px solid #dcfce7; background:#f0fdf4; padding:10px 14px; font-size:12px; color:#15803d; }
.ft .save { font-weight:700; color:#166534; }
.ft.sw { background:#fff7ed; border-top-color:#fed7aa; color:#c2410c; }
.ft.sw .save { color:#7c2d12; }
.cv { font-size:10px; color:#6b7280; margin-top:3px; }
.errc { border:1px solid #fecaca; border-radius:10px; padding:12px; font-size:12px; color:#ef4444; }
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

const fmt = (n) => `£${(+n || 0).toFixed(2)}`;

function buildCard(platform, result, order, isCurrent, isWinner) {
  const { emoji, name } = LABEL[platform];
  const card = document.createElement('div');
  card.className = `card${isWinner ? ' win' : ''}${isCurrent ? ' cur' : ''}`;

  if (result.error) {
    const ch = document.createElement('div');
    ch.className = 'ch';
    const pname = document.createElement('div');
    pname.className = 'pname';
    pname.textContent = `${emoji} ${name}`;
    ch.appendChild(pname);
    const errc = document.createElement('div');
    errc.className = 'errc';
    errc.textContent = `Could not load (${result.error})`;
    card.appendChild(ch);
    card.appendChild(errc);
    return card;
  }

  const { matches, total, offers } = result;
  const caveated = total.matchedCount < total.totalCount;

  // Card header
  const ch = document.createElement('div');
  ch.className = 'ch';
  const pname = document.createElement('div');
  pname.className = 'pname';
  pname.textContent = `${emoji} ${name} `;
  if (isWinner) {
    const wb = document.createElement('span');
    wb.className = 'wb';
    wb.textContent = 'CHEAPEST';
    pname.appendChild(wb);
  }
  if (isCurrent) {
    const cb = document.createElement('span');
    cb.className = 'cb';
    cb.textContent = 'current';
    pname.appendChild(cb);
  }
  const ptotal = document.createElement('span');
  ptotal.className = 'ptotal';
  ptotal.textContent = fmt(total.total);
  ch.appendChild(pname);
  ch.appendChild(ptotal);
  card.appendChild(ch);

  // Card body — item rows
  const cbody = document.createElement('div');
  cbody.className = 'cbody';

  matches.forEach((m) => {
    const row = document.createElement('div');
    row.className = `row${m.matched ? '' : ' r'}`;
    const nameSpan = document.createElement('span');
    const priceSpan = document.createElement('span');
    if (m.matched) {
      nameSpan.textContent = `${m.referenceItem.name} ×${m.referenceItem.quantity}`;
      priceSpan.textContent = fmt(m.platformItem.unitPrice * m.referenceItem.quantity);
    } else {
      nameSpan.textContent = `⚠ ${m.referenceItem.name} — not found`;
      priceSpan.textContent = '—';
    }
    row.appendChild(nameSpan);
    row.appendChild(priceSpan);
    cbody.appendChild(row);
  });

  const addRow = (label, value, cls = '') => {
    const row = document.createElement('div');
    row.className = `row b${cls ? ' ' + cls : ''}`;
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    cbody.appendChild(row);
  };

  addRow('Subtotal', fmt(total.itemsTotal));
  addRow('Delivery', fmt(total.deliveryFee), '');
  addRow('Service fee', fmt(total.serviceFee), '');
  if (total.discountTotal > 0) {
    const drow = document.createElement('div');
    drow.className = 'row g';
    const dl = document.createElement('span');
    dl.textContent = 'Discounts';
    const dv = document.createElement('span');
    dv.textContent = `-${fmt(total.discountTotal)}`;
    drow.appendChild(dl);
    drow.appendChild(dv);
    cbody.appendChild(drow);
  }
  addRow(`Total${caveated ? ` (${total.matchedCount}/${total.totalCount})` : ''}`, fmt(total.total));
  card.appendChild(cbody);

  // Offer tags — text from platform API, use textContent
  if (offers.length > 0) {
    offers.forEach((o) => {
      const offEl = document.createElement('div');
      offEl.className = 'off';
      offEl.textContent = `🏷 ${o.description}`;
      card.appendChild(offEl);
    });
  } else {
    const noOff = document.createElement('div');
    noOff.className = 'off n';
    noOff.textContent = '— No current offers';
    card.appendChild(noOff);
  }

  // Open in X button
  if (!isCurrent) {
    const btn = document.createElement('button');
    btn.className = 'obtn';
    btn.textContent = `Open in ${name} →`;
    btn.addEventListener('click', () => {
      const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
      if (url) window.open(url, '_blank');
    });
    card.appendChild(btn);
  }

  return card;
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== MSG.COMPARISON_RESULT) return;
  const { order, results } = msg;

  // Update header — textContent for user-controlled data
  mname.textContent = order.restaurantName;
  // Remove any previously appended subtext
  while (metaEl.childNodes.length > 1) metaEl.removeChild(metaEl.lastChild);
  const subtext = document.createElement('span');
  subtext.textContent = `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;
  metaEl.appendChild(subtext);

  const currentTotal =
    order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0) +
    order.deliveryFee +
    order.serviceFee -
    order.discounts.reduce((s, d) => s + d.amount, 0);

  const compPlatforms = Object.keys(results).filter((p) => p !== order.platform);
  compPlatforms.sort((a, b) => {
    const aErr = !!results[a].error;
    const bErr = !!results[b].error;
    if (aErr !== bErr) return aErr ? 1 : -1;
    if (aErr) return 0;
    return results[a].total.total - results[b].total.total;
  });

  const cheapest = compPlatforms.find((p) => !results[p].error);
  const winner = cheapest && results[cheapest].total.total < currentTotal ? cheapest : order.platform;

  bd.textContent = '';

  compPlatforms.forEach((p) => {
    bd.appendChild(buildCard(p, results[p], order, false, winner === p));
  });

  // Synthesise a card for the current platform
  const currentResult = {
    matches: order.items.map((i) => ({ referenceItem: i, platformItem: i, matched: true })),
    total: {
      itemsTotal: order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
      deliveryFee: order.deliveryFee,
      serviceFee: order.serviceFee,
      discountTotal: order.discounts.reduce((s, d) => s + d.amount, 0),
      total: currentTotal,
      matchedCount: order.items.length,
      totalCount: order.items.length,
    },
    offers: order.discounts.map((d) => ({ description: d.label })),
  };
  bd.appendChild(buildCard(order.platform, currentResult, order, true, winner === order.platform));

  // Footer
  const ft = document.createElement('div');
  const caveated = compPlatforms.some(
    (p) => !results[p].error && results[p].total.matchedCount < results[p].total.totalCount
  );

  if (winner !== order.platform && cheapest) {
    ft.className = 'ft sw';
    ft.textContent = 'Switch to ';
    const saveSpan = document.createElement('span');
    saveSpan.className = 'save';
    saveSpan.textContent = LABEL[cheapest].name;
    const saving = (currentTotal - results[cheapest].total.total).toFixed(2);
    ft.appendChild(saveSpan);
    ft.appendChild(document.createTextNode(` to save `));
    const saveAmt = document.createElement('span');
    saveAmt.className = 'save';
    saveAmt.textContent = `£${saving}`;
    ft.appendChild(saveAmt);
  } else {
    ft.className = 'ft';
    ft.textContent = '✅ You\'re already on the cheapest platform';
  }

  if (caveated) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.textContent = '* Some items could not be matched — totals may be incomplete';
    ft.appendChild(cv);
  }

  bar.appendChild(ft);
});
