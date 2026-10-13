// קניות בבית: מה חסר, רשימה אחת לכל הבית (מסתנכרנת בין המכשירים),
// ובלחיצה – חיפוש מחירים ומבצעים עדכניים בשופרסל, רמי לוי, קרפור וחצי חינם, וניתוח של Claude איפה כדאי להזמין.
import { CATS, PRODUCTS, EMOJI_HINTS } from './products.js';

const SERVER = (() => { try { return localStorage.getItem('shop-server') || 'https://shopping.yuvsaadon.workers.dev'; } catch (e) { return 'https://shopping.yuvsaadon.workers.dev'; } })();
const KEY = 'shop-state-v2';
const POLL_MS = 10000;
export const CHAINS = [
  { id: 'shufersal', name: 'שופרסל', color: '#d8232a', url: 'https://www.shufersal.co.il/online/he/search?text=' },
  { id: 'rami', name: 'רמי לוי', color: '#0a58a8', url: 'https://www.rami-levy.co.il/he/online/search?q=' },
  { id: 'carrefour', name: 'קרפור', color: '#1d4f9c', url: 'https://www.carrefour.co.il/search?q=' },
  { id: 'hazi', name: 'חצי חינם', color: '#e07b00', url: 'https://shop.hazi-hinam.co.il/search?q=' }
];
const DEFAULT_FEE = 30;   // דמי משלוח משוערים; אפשר לשנות בהגדרות

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
const money = (n) => '₪' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
const catOf = (id) => CATS.find(c => c.id === id) || CATS[3];
const chainOf = (id) => CHAINS.find(c => c.id === id);
const searchUrl = (c, i) => c.url + encodeURIComponent(i.q || i.name);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* מלא או חסום */ } }
};
function ago(t) {
  const m = Math.round((now() - t) / 60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return m === 1 ? 'לפני דקה' : `לפני ${m} דקות`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : `לפני ${h} שעות`;
  const d = Math.round(h / 24);
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`;
}

// ---------- מצב ----------
const S = store.get(KEY) || {};
S.items = S.items || {};
S.prefs = S.prefs || {};
S.fees = S.fees || {};
S.compare = S.compare || null;
for (const p of PRODUCTS) if (!S.items[p.id]) S.items[p.id] = { ...p, need: false, qty: 1, got: false, at: 0 };
let view = S.view || 'home', filter = '', catFilter = '', comparing = null, syncState = 'idle', installEvt = null;

const live = () => Object.values(S.items).filter(i => !i.deleted);
const needed = () => live().filter(i => i.need);
const fee = (c) => (S.fees[c] && Number.isFinite(S.fees[c].value)) ? S.fees[c].value : DEFAULT_FEE;
function save(sync = true) { store.set(KEY, S); if (sync) scheduleSync(); }
function touch(id, patch) { S.items[id] = { ...S.items[id], ...patch, at: now() }; save(); render(); }

// ---------- סנכרון: השרת ממזג לפי at לכל מוצר; ההשוואה האחרונה נשמרת בנפרד ----------
let syncTimer = null, syncing = false, dirty = false, compareDirty = false;
function merge(remote) {
  let changed = false;
  for (const key of ['items', 'prefs', 'fees']) {
    for (const [id, it] of Object.entries((remote && remote[key]) || {})) {
      if (it && (!S[key][id] || (it.at || 0) > (S[key][id].at || 0))) { S[key][id] = it; changed = true; }
    }
  }
  return changed;
}
function scheduleSync() { dirty = true; clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); }
async function sync() {
  if (syncing) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); return; }
  syncing = true;
  let send = false, sendCompare = false;
  try {
    send = dirty; dirty = false;
    sendCompare = compareDirty; compareDirty = false;
    if (sendCompare && S.compare) await fetch(SERVER + '/compare', { method: 'PUT', body: JSON.stringify(S.compare) }).then(r => { if (!r.ok) throw new Error(r.status); });
    const body = { items: Object.fromEntries(Object.entries(S.items).filter(([, i]) => i.at)), prefs: S.prefs, fees: S.fees };
    const r = send ? await fetch(SERVER + '/list', { method: 'PUT', body: JSON.stringify(body) }) : await fetch(SERVER + '/list');
    if (!r.ok) throw new Error(r.status);
    const remote = await r.json();
    let changed = merge(remote);
    // מכשיר אחר חיפש מחירים: מביאים את ההשוואה שלו
    if ((remote.compareAt || 0) > ((S.compare && S.compare.at) || 0)) {
      const c = await fetch(SERVER + '/compare').then(x => x.ok ? x.json() : null);
      if (c && c.at > ((S.compare && S.compare.at) || 0)) { S.compare = c; changed = true; }
    }
    store.set(KEY, S);
    syncState = 'ok';
    if (changed && !comparing && !document.querySelector('dialog[open]') && document.activeElement?.id !== 'q') render();
  } catch (e) {
    syncState = 'off';
    if (send) dirty = true;
    if (sendCompare) compareDirty = true;
  }
  syncing = false;
  paintSync();
}
function paintSync() { const d = $('#sync'); if (d) { d.dataset.s = syncState; d.title = { ok: 'מסונכרן עם כל המכשירים', off: 'אין חיבור – נשמר בטלפון ויסתנכרן כשיחזור', idle: '' }[syncState]; } }

// ---------- תצוגה ----------
function tileArt(i, small = false) {
  const c = catOf(i.cat);
  const img = i.img ? `<img src="${esc(i.img)}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('img');this.remove()">` : '';
  return `<span class="art${img ? ' img' : ''}${small ? ' sm' : ''}" style="--c:${c.color}">${img}<b>${i.emoji || c.icon}</b></span>`;
}
function render() {
  document.body.dataset.view = view;
  const n = needed().length;
  $('#count').textContent = n ? String(n) : '';
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-current', b.dataset.v === view ? 'page' : 'false');
  $('main').innerHTML = view === 'home' ? homeView() : view === 'list' ? listView() : view === 'compare' ? compareView() : settingsView();
  paintSync();
}

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function installBanner() {
  if (standalone() || store.get('shop-install-dismissed')) return '';
  if (!installEvt && !isIOS()) return '';
  return `<div class="install"><span>📲 להתקין את האפליקציה בטלפון?</span><button class="btn primary sm" data-install>התקנה</button><button class="icon" data-install-x aria-label="לא עכשיו">✕</button></div>`;
}

function homeView() {
  const f = filter.trim();
  const items = live().filter(i => (!catFilter || i.cat === catFilter) && (!f || i.name.includes(f)));
  const groups = CATS.map(c => ({ c, list: items.filter(i => i.cat === c.id).sort((a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name, 'he')) })).filter(g => g.list.length);
  const chips = `<div class="chips">${[{ id: '', name: 'הכול', icon: '🛒' }, ...CATS].map(c => `<button class="chip" data-cat="${c.id}" aria-pressed="${catFilter === c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}</div>`;
  const add = f && !live().some(i => i.name === f) ? `<button class="tile add" data-add="${esc(f)}">${tileArt({ emoji: '➕', cat: 'home' })}<span class="nm">הוספת "${esc(f)}"</span></button>` : '';
  return installBanner() + `<section class="hero"><h1>מה חסר בבית?</h1><p>${needed().length ? `${needed().length} מוצרים ברשימה` : 'לוחצים על מה שנגמר, וזה עובר לרשימה'}</p></section>
    <div class="search"><input id="q" type="search" placeholder="חיפוש או הוספת מוצר…" value="${esc(filter)}" aria-label="חיפוש מוצר" enterkeyhint="done"></div>
    ${chips}
    ${groups.map(g => `<h2 class="cat" style="--c:${g.c.color}">${g.c.icon} ${esc(g.c.name)}</h2><div class="grid">${g.list.map(i => `
      <button class="tile${i.need ? ' on' : ''}" data-toggle="${i.id}" aria-pressed="${!!i.need}">
        ${tileArt(i)}<span class="nm">${esc(i.name)}</span>${i.need ? `<span class="badge">${i.qty > 1 ? '×' + i.qty : '✓'}</span>` : ''}
      </button>`).join('')}</div>`).join('')}
    <div class="grid">${add || `<button class="tile add" data-add="">${tileArt({ emoji: '➕', cat: 'home' })}<span class="nm">מוצר חדש</span></button>`}</div>`;
}

function listView() {
  const list = needed();
  if (!list.length) return `<section class="hero"><h1>הרשימה ריקה</h1><p>בוחרים מוצרים במסך "מה חסר"</p></section><button class="btn primary wide" data-go="home">למסך מה חסר</button>`;
  const got = list.filter(i => i.got).length;
  const groups = CATS.map(c => ({ c, list: list.filter(i => i.cat === c.id) })).filter(g => g.list.length);
  return `<section class="hero"><h1>רשימת קניות</h1><p>${list.length} מוצרים${got ? ` · ${got} כבר בסל` : ''}</p></section>
    <div class="row-btns"><button class="btn" data-share>שליחה בווטסאפ</button><button class="btn" data-go="compare">איפה כדאי להזמין?</button></div>
    ${groups.map(g => `<h2 class="cat" style="--c:${g.c.color}">${g.c.icon} ${esc(g.c.name)}</h2><ul class="list">${g.list.map(i => `
      <li class="${i.got ? 'got' : ''}">
        <label class="check"><input type="checkbox" data-got="${i.id}" ${i.got ? 'checked' : ''}><span>${tileArt(i, true)}<span class="nm">${esc(i.name)}${i.note ? `<small>${esc(i.note)}</small>` : ''}</span></span></label>
        <span class="qty"><button data-qty="${i.id}" data-d="-1" aria-label="פחות">−</button><b>${i.qty || 1}</b><button data-qty="${i.id}" data-d="1" aria-label="יותר">+</button></span>
        <button class="icon" data-edit="${i.id}" aria-label="עריכה">✎</button>
      </li>`).join('')}</ul>`).join('')}
    ${got ? `<button class="btn primary wide" data-done>סיימתי – להוריד ${got} מוצרים שנקנו</button>` : ''}
    <button class="btn ghost wide" data-clear>ניקוי כל הרשימה</button>`;
}

// ---------- השוואת מחירים ----------
const words = (s) => String(s).replace(/[^֐-׿a-zA-Z0-9% ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
// המוצר בכל רשת: מה שנבחר ידנית → מה ש-Claude בחר → התוצאה שמכילה הכי הרבה ממילות החיפוש
export function pickProduct(item, chain, results, prefs = {}, advice = null) {
  if (!results || !results.length) return null;
  const pref = prefs[item.id + '|' + chain];
  if (pref) { const hit = results.find(r => r.name === pref.name); if (hit) return { ...hit, how: 'manual' }; }
  const ai = advice && (advice.picks || []).find(p => p.item === item.id && p.chain === chain);
  if (ai) return ai.index >= 0 && results[ai.index] ? { ...results[ai.index], how: 'ai', note: ai.note || '' } : null;
  const ws = words(item.name + ' ' + (item.q || ''));
  let best = null, bestScore = 0;
  for (const r of results) {
    const score = ws.filter(w => r.name.includes(w)).length;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}
export function basket(items, compare, prefs = {}, fees = {}) {
  const prices = (compare && compare.prices) || {}, advice = compare && compare.advice;
  const rows = items.filter(i => prices[i.id]).map(i => {
    const cells = {};
    for (const c of CHAINS) { const pick = pickProduct(i, c.id, prices[i.id][c.id], prefs, advice); cells[c.id] = pick ? { ...pick, total: pick.price * (i.qty || 1) } : null; }
    const vals = Object.values(cells).filter(Boolean).map(x => x.total);
    return { item: i, cells, min: vals.length ? Math.min(...vals) : 0 };
  });
  // "סל משותף": רק מוצרים שנמצאו בכל הרשתות שענו – כך ההשוואה הוגנת
  const answered = CHAINS.filter(c => rows.some(r => r.cells[c.id]));
  const common = rows.filter(r => answered.every(c => r.cells[c.id]));
  const totals = CHAINS.map(c => {
    const found = rows.filter(r => r.cells[c.id]);
    const f = Number.isFinite(fees[c.id]) ? fees[c.id] : DEFAULT_FEE;
    return { chain: c, found: found.length, sum: found.reduce((s, r) => s + r.cells[c.id].total, 0), common: common.reduce((s, r) => s + r.cells[c.id].total, 0), fee: f };
  }).filter(t => t.found);
  const maxFound = Math.max(0, ...totals.map(t => t.found));
  const ranked = [...totals].sort((a, b) => (a.common + a.fee) - (b.common + b.fee));
  const best = ranked.find(t => t.found >= maxFound - 1) || ranked[0] || null;
  return { rows, totals: ranked, best, commonCount: common.length };
}

// שומרים רק את מה שצריך מכל תוצאה, כדי שההשוואה תעבור מהר לשאר המכשירים
const slim = (list) => (list || []).slice(0, 6).map(p => ({ name: p.name, price: p.price, unit: p.unit || '', image: p.image || '', url: p.url || '', promo: p.promo || '', unitPrice: p.unitPrice || null }));
async function runCompare() {
  const list = needed();
  if (!list.length) return;
  comparing = { stage: 'prices', done: 0, total: list.length, failed: 0 };
  render();
  const prices = {};
  let k = 0;
  const worker = async () => {
    while (k < list.length) {
      const it = list[k++];
      try {
        const r = await fetch(SERVER + '/prices?fresh=1&q=' + encodeURIComponent(it.q || it.name));
        if (!r.ok) throw new Error(r.status);
        const d = await r.json();
        prices[it.id] = Object.fromEntries(CHAINS.map(c => [c.id, slim(d.chains && d.chains[c.id])]));
        // תמונה אמיתית מהחנות, אם עוד אין למוצר
        if (!S.items[it.id].img) {
          const img = CHAINS.map(c => pickProduct(it, c.id, prices[it.id][c.id])).find(x => x && x.image);
          if (img) S.items[it.id] = { ...S.items[it.id], img: img.image, at: now() };
        }
      } catch (e) { comparing.failed++; }
      comparing.done++;
      const bar = $('#progress'); if (bar) { bar.value = comparing.done; $('#progress-t').textContent = `${comparing.done}/${comparing.total}`; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (comparing.failed === list.length) {
    comparing = null; render();
    toast('אין חיבור לשרת המחירים. אפשר לחפש בכל רשת דרך הקישורים');
    return;
  }
  comparing.stage = 'advice'; render();
  let advice = null, adviceError = '';
  try {
    const r = await fetch(SERVER + '/advice', { method: 'POST', body: JSON.stringify({
      items: list.filter(i => prices[i.id]).map(i => ({ id: i.id, name: i.name, qty: i.qty || 1, note: i.note || '' })),
      prices, fees: Object.fromEntries(CHAINS.map(c => [c.id, fee(c.id)])) }) });
    const d = await r.json();
    if (r.ok && !d.error) advice = d; else adviceError = d.error || String(r.status);
  } catch (e) { adviceError = 'network'; }
  S.compare = { at: now(), qty: Object.fromEntries(list.map(i => [i.id, i.qty || 1])), prices, advice, adviceError };
  compareDirty = true;
  comparing = null;
  save();
  render();
}

function compareView() {
  const list = needed();
  const head = `<section class="hero"><h1>איפה כדאי להזמין?</h1><p>שופרסל · רמי לוי · קרפור · חצי חינם · משלוח לירושלים</p></section>`;
  if (comparing) return head + (comparing.stage === 'prices'
    ? `<div class="wait"><b>מחפש מחירים ומבצעים עדכניים…</b><div class="progress"><progress id="progress" max="${comparing.total}" value="${comparing.done}"></progress><span id="progress-t">${comparing.done}/${comparing.total}</span></div></div>`
    : `<div class="wait"><b>Claude משווה בין המוצרים והמבצעים…</b><div class="dots"><i></i><i></i><i></i></div></div>`);
  if (!list.length) return head + `<p class="note">קודם בוחרים מה חסר, ואז מחפשים כאן.</p><button class="btn primary wide" data-go="home">למסך מה חסר</button>`;
  const C = S.compare;
  const btn = `<button class="btn primary wide big" data-compare>🔎 ${C ? 'חיפוש מחדש' : 'חיפוש מחירים'} ל-${list.length} מוצרים</button>`;
  if (!C) return head + btn + `<p class="note">החיפוש רץ רק כשלוחצים, ובודק את המחירים והמבצעים שמופיעים עכשיו באתרים.</p>` + linksTable(list);
  const b = basket(list, C, S.prefs, Object.fromEntries(CHAINS.map(c => [c.id, fee(c.id)])));
  const unchecked = list.filter(i => !C.prices[i.id]);
  const stale = unchecked.length || list.some(i => C.qty && C.qty[i.id] && C.qty[i.id] !== (i.qty || 1));
  const A = C.advice;
  const bestChain = A && A.best_chain ? chainOf(A.best_chain) : b.best && b.best.chain;
  const adviceCard = A ? `<div class="rec">
      <div class="rec-h">🏆 כדאי להזמין ב<b>${esc(bestChain ? bestChain.name : '')}</b></div>
      <p>${esc(A.summary)}</p>
      ${A.split ? `<p class="split">✂️ ${esc(A.split)}</p>` : ''}
      ${A.tips && A.tips.length ? `<ul class="tips">${A.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    </div>` : b.best ? `<div class="rec"><div class="rec-h">🏆 הכי משתלם: <b>${b.best.chain.name}</b></div>
      <p class="note">${C.adviceError === 'no_key' ? 'הניתוח של Claude לא מוגדר בשרת, ' : 'הניתוח של Claude לא הצליח הפעם, '}לכן ההשוואה לפי מחיר בלבד.</p></div>` : '';
  const cards = b.totals.map(t => `
    <div class="chain${bestChain && t.chain.id === bestChain.id ? ' best' : ''}" style="--c:${t.chain.color}">
      <div class="chain-h"><b>${t.chain.name}</b>${bestChain && t.chain.id === bestChain.id ? '<span class="tag">מומלץ</span>' : ''}</div>
      <div class="sum">${money(t.common + t.fee)}</div>
      <div class="sub">סל משותף (${b.commonCount} מוצרים) ${money(t.common)} + משלוח ${money(t.fee)}</div>
      <div class="sub">נמצאו ${t.found} מתוך ${b.rows.length} · כל מה שנמצא: ${money(t.sum)}</div>
      <a class="sub" href="${t.chain.url.replace(/search\?.*$/, '')}" target="_blank" rel="noopener">לאתר ↗</a>
    </div>`).join('');
  const table = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>מוצר</th>${CHAINS.map(c => `<th style="--c:${c.color}">${c.name}</th>`).join('')}</tr></thead><tbody>
    ${b.rows.map(r => `<tr><th>${tileArt(r.item, true)}<span>${esc(r.item.name)}${r.item.qty > 1 ? ` ×${r.item.qty}` : ''}</span></th>${CHAINS.map(c => {
      const x = r.cells[c.id], res = C.prices[r.item.id][c.id] || [];
      if (!x) return `<td class="none"><a href="${searchUrl(c, r.item)}" target="_blank" rel="noopener">לא נמצא ↗</a></td>`;
      return `<td class="${x.total === r.min ? 'min' : ''}"><div class="price">${money(x.total)}</div>
        ${x.unitPrice ? `<div class="pn">${money(x.unitPrice.value)} ${esc(x.unitPrice.per)}</div>` : ''}
        ${x.promo ? `<div class="promo">🏷️ ${esc(x.promo)}</div>` : ''}
        ${x.note ? `<div class="ai-note">${esc(x.note)}</div>` : ''}
        ${res.length > 1 ? `<select data-pref="${r.item.id}|${c.id}" aria-label="מוצר אחר ב${c.name}">${res.map(o => `<option value="${esc(o.name)}"${o.name === x.name ? ' selected' : ''}>${esc(o.name)} – ${money(o.price)}</option>`).join('')}</select>` : `<div class="pn">${esc(x.name)}</div>`}
        <a class="pn" href="${esc(x.url || searchUrl(c, r.item))}" target="_blank" rel="noopener">לאתר ↗</a></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
  return head + `<p class="checked">נבדק ${ago(C.at)}${stale ? ' · <b>הרשימה השתנתה מאז</b>' : ''}</p>` + btn + adviceCard + `<div class="chains">${cards}</div>` +
    (unchecked.length ? `<p class="note">${unchecked.length === 1 ? 'מוצר אחד נוסף' : unchecked.length + ' מוצרים נוספו'} אחרי החיפוש: ${unchecked.map(i => esc(i.name)).join(', ')}</p>` : '') + table +
    `<p class="note">המחירים והמבצעים מאתרי הרשתות בזמן החיפוש. מבצעי מועדון ודמי משלוח מדויקים מופיעים רק בקופה; דמי המשלוח המשוערים נקבעים בהגדרות. אפשר לבחור מוצר אחר בכל תא.</p>`;
}
function linksTable(list) {
  return `<h2 class="cat">חיפוש ידני בכל רשת</h2><ul class="list links">${list.map(i => `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}</span><span class="lk">${CHAINS.map(c => `<a style="--c:${c.color}" href="${searchUrl(c, i)}" target="_blank" rel="noopener">${c.name}</a>`).join('')}</span></li>`).join('')}</ul>`;
}

// ---------- הגדרות ----------
function settingsView() {
  const removed = Object.values(S.items).filter(i => i.deleted);
  const install = standalone() ? '<p>✓ האפליקציה מותקנת במכשיר הזה.</p>'
    : installEvt ? '<button class="btn primary" data-install>התקנה בטלפון</button>'
    : isIOS() ? '<p>באייפון: לוחצים על כפתור השיתוף <b>⎋</b> בספארי ← <b>הוספה למסך הבית</b>.</p>'
    : '<p>בכרום: תפריט ⋮ ← <b>התקנת אפליקציה</b> (או "הוספה למסך הבית").</p>';
  return `<section class="hero"><h1>הגדרות</h1><p>רשימה אחת לכל הבית – כל שינוי מופיע בכל המכשירים</p></section>
    <div class="card"><h3>📲 התקנה בטלפון</h3>${install}
      <p>כדי שעוד מכשיר יראה את אותה רשימה, פשוט פותחים בו את הכתובת הזו:</p>
      <div class="code">${esc(location.origin + location.pathname)}</div>
      <div class="row-btns"><button class="btn" data-sharelink>שליחת הקישור בווטסאפ</button></div>
      <p class="status">סנכרון: <span id="sync-t">${{ ok: 'מחובר ✓', off: 'אין חיבור לשרת', idle: 'בודק…' }[syncState]}</span></p>
    </div>
    <div class="card"><h3>🚚 דמי משלוח משוערים</h3>
      ${CHAINS.map(c => `<label class="field inline">${c.name}<span class="row">₪<input type="number" min="0" step="0.1" inputmode="decimal" data-fee="${c.id}" value="${fee(c.id)}"></span></label>`).join('')}
    </div>
    <div class="card"><h3>🖼️ תמונות</h3><p>תמונות המוצרים נלקחות מאתרי הרשתות כשמחפשים מחירים.</p>
      <button class="btn ghost" data-noimgs>חזרה לאיורים</button></div>
    <div class="card"><h3>🧺 מוצרים</h3><ul class="list compact">${live().sort((a, b) => a.name.localeCompare(b.name, 'he')).map(i => `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}</span><button class="icon" data-edit="${i.id}" aria-label="עריכה">✎</button></li>`).join('')}</ul>
      <button class="btn wide" data-add="">מוצר חדש</button>
      ${removed.length ? `<details><summary>מוצרים שנמחקו (${removed.length})</summary><ul class="list compact">${removed.map(i => `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}</span><button class="btn" data-restore="${i.id}">החזרה</button></li>`).join('')}</ul></details>` : ''}
    </div>
    <p class="note">הרשימה ההתחלתית: ${PRODUCTS.length} מוצרים שהופיעו לפחות 3 פעמים בקבוצה "קניות מקסימות".</p>`;
}

// ---------- עריכה / הוספה ----------
function guessEmoji(name) { const h = EMOJI_HINTS.find(([re]) => re.test(name)); return h ? h[1] : ''; }
function openEditor(id, name = '') {
  const it = id === 'new' ? { id: 'new', name, cat: 'pantry', emoji: guessEmoji(name), q: '', note: '' } : S.items[id];
  const dlg = $('#editor');
  dlg.innerHTML = `<form method="dialog" class="sheet">
    <h3>${id === 'new' ? 'מוצר חדש' : 'עריכת מוצר'}</h3>
    <label class="field">שם<input name="name" required value="${esc(it.name)}" autocomplete="off"></label>
    <label class="field">קטגוריה<select name="cat">${CATS.map(c => `<option value="${c.id}"${c.id === it.cat ? ' selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></label>
    <label class="field">סמל (אימוג'י)<input name="emoji" value="${esc(it.emoji || '')}" maxlength="4" placeholder="${catOf(it.cat).icon}"></label>
    <label class="field">מה לחפש באתרי הרשתות<input name="q" value="${esc(it.q || '')}" placeholder="${esc(it.name || 'למשל: חלב 3% 1 ליטר')}"></label>
    <label class="field">הערה (גם Claude מתחשב בה)<input name="note" value="${esc(it.note || '')}" placeholder="למשל: בלי גלעין, 1 ק״ג"></label>
    <div class="row-btns"><button class="btn primary" value="save">שמירה</button><button class="btn" value="cancel" formnovalidate>ביטול</button>${id !== 'new' ? '<button class="btn danger" value="delete" formnovalidate>מחיקה</button>' : ''}</div>
  </form>`;
  const form = $('form', dlg);
  form.name.addEventListener('input', () => { if (!form.emoji.value) form.emoji.placeholder = guessEmoji(form.name.value) || catOf(form.cat.value).icon; });
  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v === 'delete') { touch(id, { deleted: true, need: false }); toast('נמחק. אפשר להחזיר מההגדרות'); return; }
    if (v !== 'save') return;
    const nm = form.name.value.trim(); if (!nm) return;
    const data = { name: nm, cat: form.cat.value, emoji: form.emoji.value.trim() || guessEmoji(nm), q: form.q.value.trim(), note: form.note.value.trim() };
    if (id === 'new') {
      const nid = 'u' + now().toString(36) + Math.random().toString(36).slice(2, 5);
      S.items[nid] = { id: nid, ...data, count: 0, need: true, qty: 1, got: false, at: now() };
      filter = ''; save(); render(); toast(`"${nm}" נוסף לרשימה`);
    } else touch(id, data);
  };
  dlg.returnValue = '';
  if (!dlg.open) dlg.showModal();
  form.name.focus();
}

let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3200); }

function shareText() {
  const groups = CATS.map(c => ({ c, list: needed().filter(i => i.cat === c.id) })).filter(g => g.list.length);
  return 'רשימת קניות 🛒\n' + groups.map(g => `\n${g.c.icon} ${g.c.name}\n` + g.list.map(i => `• ${i.name}${i.qty > 1 ? ' ×' + i.qty : ''}${i.note ? ' (' + i.note + ')' : ''}`).join('\n')).join('\n');
}
async function share(text) {
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
async function install() {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); installEvt = null; if (r && r.outcome === 'accepted') toast('האפליקציה הותקנה 🎉'); render(); }
  else { view = 'settings'; S.view = view; save(false); render(); }
}

// ---------- אירועים ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.v || d.go) { view = d.v || d.go; S.view = view; save(false); render(); scrollTo(0, 0); }
  else if (d.toggle) { const i = S.items[d.toggle]; touch(d.toggle, { need: !i.need, got: false, qty: i.need ? 1 : (i.qty || 1) }); if (navigator.vibrate) navigator.vibrate(10); }
  else if (d.cat !== undefined && t.classList.contains('chip')) { catFilter = d.cat; render(); }
  else if (d.add !== undefined) openEditor('new', d.add);
  else if (d.edit) openEditor(d.edit);
  else if (d.qty) { const i = S.items[d.qty]; touch(d.qty, { qty: Math.max(1, Math.min(99, (i.qty || 1) + Number(d.d))) }); }
  else if ('done' in d) { for (const i of needed().filter(i => i.got)) S.items[i.id] = { ...i, need: false, got: false, qty: 1, at: now() }; save(); render(); toast('יופי! הרשימה עודכנה'); }
  else if ('clear' in d) { if (confirm('לנקות את כל הרשימה?')) { for (const i of needed()) S.items[i.id] = { ...i, need: false, got: false, qty: 1, at: now() }; save(); render(); } }
  else if ('share' in d) share(shareText());
  else if ('compare' in d) runCompare();
  else if ('sharelink' in d) share('הרשימה המשותפת שלנו לקניות 🛒\n' + location.origin + location.pathname);
  else if (d.restore) touch(d.restore, { deleted: false });
  else if ('noimgs' in d) { for (const i of live()) if (i.img) S.items[i.id] = { ...i, img: '', at: now() }; save(); render(); }
  else if ('install' in d) install();
  else if ('installX' in d) { store.set('shop-install-dismissed', true); render(); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { filter = e.target.value; const pos = e.target.selectionStart; render(); const s = $('#q'); s.focus(); s.setSelectionRange(pos, pos); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.got) touch(t.dataset.got, { got: t.checked });
  else if (t.dataset.pref) { S.prefs[t.dataset.pref] = { name: t.value, at: now() }; save(); render(); }
  else if (t.dataset.fee) { const n = Number(t.value); S.fees[t.dataset.fee] = { value: Number.isFinite(n) && n >= 0 ? n : DEFAULT_FEE, at: now() }; save(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'q' && filter.trim()) {
    const f = filter.trim(), hit = live().find(i => i.name === f);
    if (hit) { filter = ''; touch(hit.id, { need: true }); toast(`"${f}" ברשימה`); } else openEditor('new', f);
  }
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (view === 'home' || view === 'settings') render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden && !syncing) sync(); }, POLL_MS);

render();
sync();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
