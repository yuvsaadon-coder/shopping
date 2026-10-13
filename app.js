// קניות בבית: מה חסר, רשימה אחת לכל הבית (מסתנכרנת בין המכשירים), מצב קניות עם אישור בקופה,
// משלוחים עם תזכורת לבדיקה, "כנראה נגמר" לפי הקצב שבו קונים כל מוצר,
// ובלחיצה – חיפוש מחירים ומבצעים עדכניים בשופרסל, רמי לוי, קרפור וחצי חינם, והמלצה איפה כדאי להזמין.
import { CATS, PRODUCTS, EMOJI_HINTS, STORES, storeOf, SEEN } from './products.js';

const SERVER = (() => { try { return localStorage.getItem('shop-server') || 'https://shopping.yuvsaadon.workers.dev'; } catch (e) { return 'https://shopping.yuvsaadon.workers.dev'; } })();
const KEY = 'shop-state-v2';
const POLL_MS = 10000;
const USE_AI = false;   // הניתוח של Claude (/advice) כבוי בינתיים; ההמלצה לפי מחיר, סל משותף ומשלוח
const DAY = 86400000;
const REMIND_HOUR = 20;   // ביום המשלוח, ב-20:00: לבדוק שהגיע כל מה שהוזמן
export const CHAINS = [
  { id: 'shufersal', name: 'שופרסל', color: '#d8232a', url: 'https://www.shufersal.co.il/online/he/search?text=' },
  { id: 'rami', name: 'רמי לוי', color: '#0a58a8', url: 'https://www.rami-levy.co.il/he/online/search?q=' },
  { id: 'carrefour', name: 'קרפור', color: '#1d4f9c', url: 'https://www.carrefour.co.il/search?q=' },
  { id: 'hazi', name: 'חצי חינם', color: '#e07b00', url: 'https://shop.hazi-hinam.co.il/search?q=' }
];
const DEFAULT_FEE = 30;   // דמי משלוח משוערים; אפשר לשנות בהגדרות

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// עולה תמיד, גם בשתי פעולות באותה אלפית שנייה – כדי שהשינוי האחרון ינצח במיזוג
let lastNow = 0;
const now = () => (lastNow = Math.max(Date.now(), lastNow + 1));
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
const pad = (n) => String(n).padStart(2, '0');
const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function whenText(t) {
  const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / DAY);
  const day = diff === 0 ? 'היום' : diff === 1 ? 'מחר' : diff === -1 ? 'אתמול' : `יום ${DAYS_HE[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
  return `${day} ב-${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const dateOnly = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ---------- מצב ----------
const S = store.get(KEY) || {};
for (const k of ['items', 'prefs', 'fees', 'orders', 'meta']) S[k] = S[k] || {};
S.compare = S.compare || null;
// היסטוריית הקנייה מתחילה מהימים שבהם המוצר הופיע בקבוצה (בצהריים, שעון מקומי)
const seenHist = (id) => (SEEN[id] || []).map(d => new Date(d + 'T12:00:00').getTime());
for (const p of PRODUCTS) {
  if (!S.items[p.id]) S.items[p.id] = { ...p, kind: 'fixed', need: false, qty: 1, got: false, hist: seenHist(p.id), at: 0 };
  else if (!S.items[p.id].hist) S.items[p.id].hist = seenHist(p.id);
}
let view = S.view || 'home', filter = '', catFilter = '', comparing = null, syncState = 'idle', installEvt = null;

const live = () => Object.values(S.items).filter(i => !i.deleted);
const isOrdered = (i) => !!(i.ordered && S.orders[i.ordered] && S.orders[i.ordered].status === 'pending');
// מה צריך לקנות עכשיו (בלי מה שכבר בדרך במשלוח)
const needed = () => live().filter(i => i.need && !isOrdered(i));
const superNeeded = () => needed().filter(i => storeOf(i.cat) === 'super');
const pendingOrders = () => Object.values(S.orders).filter(o => o.status === 'pending').sort((a, b) => a.when - b.when);
const fee = (c) => (S.fees[c] && Number.isFinite(S.fees[c].value)) ? S.fees[c].value : DEFAULT_FEE;
const me = () => store.get('shop-me') || '';
function save(sync = true) { store.set(KEY, S); if (sync) scheduleSync(); }
function touch(id, patch) { S.items[id] = { ...S.items[id], ...patch, at: now() }; save(); render(); }
// נקנה: יורד מהרשימה ונרשם בהיסטוריה. מוצר חד-פעמי נמחק אחרי שנקנה.
function bought(id, when = now()) {
  const i = S.items[id];
  const hist = [...(i.hist || []), when].slice(-30);
  S.items[id] = { ...i, need: false, got: false, qty: 1, ordered: '', hist, snooze: 0, deleted: i.kind === 'once' ? true : i.deleted, at: now() };
}

// ---------- כל כמה זמן קונים (מההיסטוריה) ----------
// קניות שקרובות זו לזו (עד 3 ימים) נחשבות סבב אחד; הקצב = החציון של הפערים בין הסבבים
export function cycleOf(hist, snooze = 0, at = now()) {
  const ev = [];
  for (const t of [...(hist || [])].sort((a, b) => a - b)) if (!ev.length || t - ev[ev.length - 1] > 3 * DAY) ev.push(t); else ev[ev.length - 1] = t;
  if (ev.length < 2) return null;
  const gaps = ev.slice(1).map((t, k) => (t - ev[k]) / DAY).sort((a, b) => a - b);
  const every = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  const last = Math.max(ev[ev.length - 1], snooze || 0);
  return { every: Math.max(1, Math.round(every)), since: Math.floor((at - last) / DAY) };
}
// "כנראה נגמר": מוצר קבוע שעבר כמעט כל הזמן שבדרך כלל עובר בין קנייה לקנייה
function runningOut() {
  return live().filter(i => !i.need && i.kind !== 'once')
    .map(i => ({ i, c: cycleOf(i.hist, i.snooze) }))
    // מה שעבר הרבה יותר מהרגיל כנראה נקנה בלי שנרשם – לא מציקים עליו
    .filter(x => x.c && x.c.every >= 3 && x.c.since >= x.c.every * 0.85 && x.c.since <= x.c.every * 2.5 + 7)
    .sort((a, b) => b.c.since / b.c.every - a.c.since / a.c.every).slice(0, 6);
}

// ---------- סנכרון: השרת ממזג לפי at לכל רשומה; ההשוואה האחרונה נשמרת בנפרד ----------
let syncTimer = null, syncing = false, dirty = false, compareDirty = false;
const SYNC_KEYS = ['items', 'prefs', 'fees', 'orders', 'meta'];
function merge(remote) {
  let changed = false;
  for (const key of SYNC_KEYS) {
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
    const body = { items: Object.fromEntries(Object.entries(S.items).filter(([, i]) => i.at)), prefs: S.prefs, fees: S.fees, orders: S.orders, meta: S.meta };
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
  document.body.dataset.shopping = S.mode === 'shop' ? '1' : '';
  const n = needed().length;
  $('#count').textContent = n ? String(n) : '';
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-current', b.dataset.v === view ? 'page' : 'false');
  $('main').innerHTML = banners() + (view === 'home' ? homeView() : view === 'list' ? listView() : view === 'compare' ? compareView() : settingsView());
  paintSync();
}

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function installBanner() {
  if (standalone() || store.get('shop-install-dismissed')) return '';
  if (!installEvt && !isIOS()) return '';
  return `<div class="install"><span>📲 להתקין את האפליקציה בטלפון?</span><button class="btn primary sm" data-install>התקנה</button><button class="icon" data-install-x aria-label="לא עכשיו">✕</button></div>`;
}
const remindAt = (o) => { const d = new Date(o.when); d.setHours(REMIND_HOUR, 0, 0, 0); return Math.max(d.getTime(), o.when + 3600000); };
function banners() {
  let out = '';
  // משלוח שהגיע זמן לבדוק אותו
  for (const o of pendingOrders().filter(o => now() >= remindAt(o))) {
    out += `<div class="banner warn"><span>📦 המשלוח מ${esc(o.chainName)} (${whenText(o.when)}) הגיע כמו שהוזמן?</span><button class="btn primary sm" data-verify="${o.id}">בדיקה</button></div>`;
  }
  // מישהו אחר בקניות עכשיו
  const sh = S.meta.shopping;
  if (sh && sh.active && sh.by !== me() && now() - sh.at < 3 * 3600000) {
    out += `<div class="banner"><span>🛒 ${esc(sh.by || 'מישהו')} ${sh.kind === 'delivery' ? 'מזמין/ה משלוח' : 'בקניות'} עכשיו – מה שתוסיפו יופיע אצלו/ה ברשימה</span></div>`;
  }
  return out;
}

function homeView() {
  const f = filter.trim();
  const items = live().filter(i => (!catFilter || i.cat === catFilter) && (!f || i.name.includes(f)));
  const groups = CATS.map(c => ({ c, list: items.filter(i => i.cat === c.id).sort((a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name, 'he')) })).filter(g => g.list.length);
  const chips = `<div class="chips">${[{ id: '', name: 'הכול', icon: '🛒' }, ...CATS].map(c => `<button class="chip" data-cat="${c.id}" aria-pressed="${catFilter === c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}</div>`;
  const add = f && !live().some(i => i.name === f) ? `<button class="tile add" data-add="${esc(f)}">${tileArt({ emoji: '➕', cat: 'home' })}<span class="nm">הוספת "${esc(f)}"</span></button>` : '';
  const out = !f && !catFilter ? runningOut() : [];
  const soon = out.length ? `<section class="soon"><div class="soon-h"><b>⏳ כנראה נגמר בקרוב</b><button class="btn sm" data-addsoon>הוספת הכול</button></div>
    <ul class="soon-list">${out.map(({ i, c }) => `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}<small>בדרך כלל כל ${c.every} ימים · לפני ${c.since} ימים</small></span>
      <button class="btn sm primary" data-soon-add="${i.id}">חסר</button><button class="btn sm ghost" data-snooze="${i.id}">עוד יש</button></li>`).join('')}</ul></section>` : '';
  const badge = (i) => isOrdered(i) ? '<span class="badge truck" title="בדרך במשלוח">🚚</span>'
    : i.need ? `<span class="badge">${i.qty > 1 ? '×' + i.qty : '✓'}</span>` : '';
  return installBanner() + `<section class="hero"><h1>מה חסר בבית?</h1><p>${needed().length ? `${needed().length} מוצרים ברשימה` : 'לוחצים על מה שנגמר, וזה עובר לרשימה'}</p></section>
    <div class="search"><input id="q" type="search" placeholder="חיפוש או הוספת מוצר…" value="${esc(filter)}" aria-label="חיפוש מוצר" enterkeyhint="done"></div>
    ${chips}${soon}
    ${groups.map(g => `<h2 class="cat" style="--c:${g.c.color}">${g.c.icon} ${esc(g.c.name)}</h2><div class="grid">${g.list.map(i => `
      <button class="tile${i.need ? ' on' : ''}${isOrdered(i) ? ' ordered' : ''}" data-toggle="${i.id}" aria-pressed="${!!i.need}">
        ${tileArt(i)}<span class="nm">${esc(i.name)}</span>${i.kind === 'once' ? '<span class="once">חד פעמי</span>' : ''}${badge(i)}
      </button>`).join('')}</div>`).join('')}
    <div class="grid">${add || `<button class="tile add" data-add="">${tileArt({ emoji: '➕', cat: 'home' })}<span class="nm">מוצר חדש</span></button>`}</div>`;
}

// ---------- הרשימה: רגיל / מצב קניות ----------
function groupByStore(list, row) {
  const stores = STORES.map(s => ({ s, list: list.filter(i => storeOf(i.cat) === s.id) })).filter(g => g.list.length);
  return stores.map(({ s, list }) => (stores.length > 1 ? `<h2 class="store">${s.icon} ${s.name}</h2>` : '') +
    CATS.map(c => ({ c, l: list.filter(i => i.cat === c.id) })).filter(g => g.l.length)
      .map(g => `<h2 class="cat" style="--c:${g.c.color}">${g.c.icon} ${esc(g.c.name)}</h2><ul class="list">${g.l.map(row).join('')}</ul>`).join('')).join('');
}
function listView() {
  const list = needed(), orders = pendingOrders();
  const ordersHtml = orders.map(o => {
    const its = Object.keys(o.items).map(id => S.items[id]).filter(Boolean);
    return `<div class="card order"><div class="order-h"><b>🚚 משלוח מ${esc(o.chainName)}</b><span>${whenText(o.when)}</span></div>
      <p class="note">${its.map(i => esc(i.name)).join(' · ')}</p>
      <div class="row-btns"><button class="btn sm primary" data-verify="${o.id}">הגיע – בדיקה</button><button class="btn sm" data-remind="${o.id}">📅 תזכורת ביומן</button><button class="btn sm ghost" data-cancel-order="${o.id}">ביטול המשלוח</button></div></div>`;
  }).join('');
  if (S.mode === 'shop') return shopView(list) + ordersHtml;
  if (!list.length) return `<section class="hero"><h1>הרשימה ריקה</h1><p>בוחרים מוצרים במסך "מה חסר"</p></section>${ordersHtml}<button class="btn primary wide" data-go="home">למסך מה חסר</button>`;
  const row = (i) => `<li>
      ${tileArt(i, true)}<span class="nm">${esc(i.name)}${i.note || i.by || i.kind === 'once' ? `<small>${[i.kind === 'once' ? 'חד פעמי' : '', i.note, i.by ? 'הוסיף/ה: ' + i.by : ''].filter(Boolean).map(esc).join(' · ')}</small>` : ''}</span>
      <span class="qty"><button data-qty="${i.id}" data-d="-1" aria-label="פחות">−</button><b>${i.qty || 1}</b><button data-qty="${i.id}" data-d="1" aria-label="יותר">+</button></span>
      <button class="icon" data-edit="${i.id}" aria-label="עריכה">✎</button>
    </li>`;
  return `<section class="hero"><h1>רשימת קניות</h1><p>${list.length} מוצרים</p></section>
    <div class="modes"><button class="mode" data-start-shop><span>🛒</span>אני בקניות</button><button class="mode" data-start-delivery><span>🚚</span>הזמנתי משלוח</button></div>
    <div class="row-btns"><button class="btn sm" data-share>שליחה בווטסאפ</button><button class="btn sm" data-go="compare">איפה כדאי להזמין?</button></div>
    ${ordersHtml}${groupByStore(list, row)}
    <button class="btn ghost wide" data-clear>ניקוי כל הרשימה</button>`;
}
// מצב קניות: נגיעה בשורה = נכנס לסל. בסוף מאשרים מה נקנה.
function shopView(list) {
  const todo = list.filter(i => !i.got), cart = list.filter(i => i.got);
  const row = (i) => `<li class="${i.got ? 'got' : ''}"><button class="shop-row" data-cart="${i.id}" aria-pressed="${!!i.got}">
      <span class="tick">${i.got ? '✓' : ''}</span>${tileArt(i, true)}<span class="nm">${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}${i.note ? `<small>${esc(i.note)}</small>` : ''}</span></button></li>`;
  return `<section class="hero shop-hero"><h1>🛒 בקניות</h1><p>${cart.length} בסל · ${todo.length} נשארו</p></section>
    ${todo.length ? groupByStore(todo, row) : '<p class="note done-note">הכול בסל! 🎉</p>'}
    ${cart.length ? `<h2 class="cat">בסל (${cart.length})</h2><ul class="list">${cart.map(row).join('')}</ul>` : ''}
    <div class="checkout"><button class="btn primary wide big" data-checkout>סיום קניות${cart.length ? ` (${cart.length})` : ''}</button><button class="btn ghost" data-stop-shop>יציאה בלי לסיים</button></div>`;
}

// ---------- חלונות: אישור בקופה, משלוח, בדיקת משלוח ----------
function sheet(html, onClose) {
  const dlg = $('#sheet');
  dlg.innerHTML = `<form method="dialog" class="sheet">${html}</form>`;
  dlg.returnValue = '';
  dlg.onclose = () => { const f = $('form', dlg); onClose(dlg.returnValue, f); if ($('form', dlg) === f) dlg.innerHTML = ''; };
  dlg.showModal();
  return $('form', dlg);
}
function checkout() {
  const list = needed(), cart = list.filter(i => i.got), rest = list.filter(i => !i.got);
  if (!cart.length) { if (confirm('הסל ריק. לצאת ממצב קניות?')) stopShop(); return; }
  sheet(`<h3>לאשר שקנית?</h3>
    <p class="note">מה שמסומן יורד מהרשימה ונרשם כנקנה. אפשר להוריד סימון ממה שבסוף לא נקנה.</p>
    <ul class="list compact">${cart.map(i => `<li><label class="check"><input type="checkbox" name="b" value="${i.id}" checked><span>${tileArt(i, true)}<span class="nm">${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</span></span></label></li>`).join('')}</ul>
    ${rest.length ? `<p class="note">נשארים ברשימה: ${rest.map(i => esc(i.name)).join(', ')}</p>` : ''}
    <div class="row-btns"><button class="btn primary" value="ok">אישור – קניתי</button><button class="btn" value="back">חזרה לקניות</button></div>`,
  (v, form) => {
    if (v !== 'ok') return;
    const ids = [...form.querySelectorAll('input[name=b]:checked')].map(x => x.value);
    for (const id of ids) bought(id);
    for (const i of cart) if (!ids.includes(i.id)) S.items[i.id] = { ...S.items[i.id], got: false, at: now() };
    stopShop(false);
    toast(ids.length === 1 ? 'מוצר אחד נרשם כנקנה' : `${ids.length} מוצרים נרשמו כנקנו`);
  });
}
function startShop() {
  S.mode = 'shop';
  S.meta.shopping = { by: me(), active: true, kind: 'shop', at: now() };
  view = 'list'; S.view = view; save(); render(); scrollTo(0, 0);
}
function stopShop(keepCart = true) {
  S.mode = '';
  if (!keepCart) { /* הסל כבר טופל */ } else for (const i of needed()) if (i.got) S.items[i.id] = { ...i, got: false, at: now() };
  S.meta.shopping = { by: me(), active: false, at: now() };
  save(); render();
}
function startDelivery() {
  const list = needed();
  if (!list.length) { toast('הרשימה ריקה'); return; }
  const best = S.compare && S.compare.prices ? basket(superNeeded(), S.compare, S.prefs, {}).best : null;
  const t = new Date(now() + DAY); t.setHours(10, 0, 0, 0);
  const form = sheet(`<h3>🚚 הזמנתי משלוח</h3>
    <label class="field">מאיפה<select name="chain">${CHAINS.map(c => `<option value="${c.id}"${best && best.chain.id === c.id ? ' selected' : ''}>${c.name}</option>`).join('')}<option value="other">אחר</option></select></label>
    <div class="row2"><label class="field">מתי מגיע<input type="date" name="date" required value="${dateOnly(t)}"></label><label class="field">שעה<input type="time" name="time" required value="10:00"></label></div>
    <p class="note">מה בהזמנה (אפשר להוריד סימון ממה שלא הוזמן):</p>
    <ul class="list compact">${list.map(i => `<li><label class="check"><input type="checkbox" name="o" value="${i.id}" checked><span>${tileArt(i, true)}<span class="nm">${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</span></span></label></li>`).join('')}</ul>
    <p class="note">ביום המשלוח ב-20:00 תופיע תזכורת לבדוק שהגיע הכול.</p>
    <div class="row-btns"><button class="btn primary" value="ok">שמירה</button><button class="btn" value="cancel" formnovalidate>ביטול</button></div>`,
  (v, f) => {
    if (v !== 'ok') return;
    const ids = [...f.querySelectorAll('input[name=o]:checked')].map(x => x.value);
    const when = new Date(f.date.value + 'T' + (f.time.value || '10:00')).getTime();
    if (!ids.length || !Number.isFinite(when)) return;
    const chain = chainOf(f.chain.value);
    const id = 'o' + now().toString(36);
    S.orders[id] = { id, chain: f.chain.value, chainName: chain ? chain.name : 'משלוח', when, items: Object.fromEntries(ids.map(x => [x, S.items[x].qty || 1])), status: 'pending', by: me(), at: now() };
    for (const x of ids) S.items[x] = { ...S.items[x], ordered: id, got: false, at: now() };
    S.meta.shopping = { by: me(), active: false, at: now() };
    save(); render();
    askNotify();
    reminderSheet(id, true);
  });
  form.chain.focus();
}
// תזכורת: ביומן (Google או קובץ ics לאייפון), ובנוסף התראה מהאפליקציה כשהיא פתוחה
function calTimes(o) { const s = remindAt(o), e = s + 15 * 60000; const z = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); return [z(s), z(e)]; }
const appUrl = (o) => location.origin + location.pathname + '?verify=' + o.id;
function googleCalUrl(o) {
  const [s, e] = calTimes(o);
  const its = Object.keys(o.items).map(id => S.items[id] && S.items[id].name).filter(Boolean).join(', ');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(`בדיקת המשלוח מ${o.chainName}`) +
    '&dates=' + s + '/' + e + '&details=' + encodeURIComponent(`לבדוק שהגיע כל מה שהוזמן: ${its}\n${appUrl(o)}`);
}
export function icsText(o, names = []) {
  const [s, e] = calTimes(o);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const summary = `בדיקת המשלוח מ${o.chainName}`;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//kniyot-babayit//he', 'BEGIN:VEVENT', `UID:${o.id}@kniyot-babayit`, `DTSTAMP:${stamp}`,
    `DTSTART:${s}`, `DTEND:${e}`, `SUMMARY:${summary}`, `DESCRIPTION:${('לבדוק שהגיע: ' + names.join(', ')).replace(/[,;]/g, '\\$&')}`, `URL:${appUrl(o)}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${summary}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function downloadIcs(o) {
  const names = Object.keys(o.items).map(id => S.items[id] && S.items[id].name).filter(Boolean);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([icsText(o, names)], { type: 'text/calendar' }));
  a.download = 'tizkoret-mishloach.ics';
  document.body.appendChild(a); a.click(); a.remove();
}
function reminderSheet(id, fresh = false) {
  const o = S.orders[id]; if (!o) return;
  const r = new Date(remindAt(o));
  sheet(`<h3>${fresh ? '✓ המשלוח נשמר' : '📅 תזכורת'}</h3>
    <p>${esc(o.chainName)} · ${whenText(o.when)}</p>
    <p class="note">התזכורת לבדוק את המשלוח: ${whenText(r.getTime())}. כדי לקבל אותה גם כשהאפליקציה סגורה, כדאי להוסיף אותה ליומן:</p>
    <div class="row-btns"><a class="btn primary" href="${esc(googleCalUrl(o))}" target="_blank" rel="noopener">יומן Google</a><button class="btn" value="ics">יומן באייפון (ics)</button><button class="btn ghost" value="close">סגירה</button></div>`,
  (v) => { if (v === 'ics') downloadIcs(o); });
}
function verifyOrder(id) {
  const o = S.orders[id]; if (!o || o.status !== 'pending') return;
  const its = Object.keys(o.items).map(x => S.items[x]).filter(Boolean);
  sheet(`<h3>📦 המשלוח מ${esc(o.chainName)}</h3>
    <p class="note">מה הגיע כמו שהוזמן? מה שלא מסומן חוזר לרשימה.</p>
    <ul class="list compact">${its.map(i => `<li><label class="check"><input type="checkbox" name="v" value="${i.id}" checked><span>${tileArt(i, true)}<span class="nm">${esc(i.name)}${o.items[i.id] > 1 ? ` ×${o.items[i.id]}` : ''}</span></span></label></li>`).join('')}</ul>
    <label class="field">היו החלפות או שינויים? (רשות)<input name="changes" placeholder="למשל: הביאו טופו של מותג אחר"></label>
    <div class="row-btns"><button class="btn primary" value="ok">אישור</button><button class="btn" value="later">אחר כך</button></div>`,
  (v, f) => {
    if (v !== 'ok') return;
    const ok = new Set([...f.querySelectorAll('input[name=v]:checked')].map(x => x.value));
    for (const i of its) {
      if (ok.has(i.id)) bought(i.id, o.when);
      else S.items[i.id] = { ...S.items[i.id], ordered: '', need: true, note: [S.items[i.id].note, 'לא הגיע במשלוח'].filter(Boolean).join(' · '), at: now() };
    }
    S.orders[id] = { ...o, status: 'done', missing: its.filter(i => !ok.has(i.id)).map(i => i.id), changes: f.changes.value.trim(), at: now() };
    save(); render();
    const miss = its.length - ok.size;
    toast(miss ? (miss === 1 ? 'מוצר אחד חזר לרשימה' : `${miss} מוצרים חזרו לרשימה`) : 'מעולה, הכול הגיע ✓');
  });
}
function cancelOrder(id) {
  const o = S.orders[id]; if (!o || !confirm('לבטל את המשלוח? המוצרים יחזרו לרשימה.')) return;
  for (const x of Object.keys(o.items)) if (S.items[x] && S.items[x].ordered === id) S.items[x] = { ...S.items[x], ordered: '', at: now() };
  S.orders[id] = { ...o, status: 'cancelled', at: now() };
  save(); render();
}
// התראה כשהאפליקציה פתוחה (או ברקע) בזמן התזכורת
function askNotify() { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); }
function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const shown = store.get('shop-notified') || {};
  for (const o of pendingOrders()) {
    if (now() < remindAt(o) || shown[o.id]) continue;
    shown[o.id] = 1; store.set('shop-notified', shown);
    const opts = { body: 'לבדוק שהגיע כל מה שהוזמן', tag: o.id, data: { url: appUrl(o) }, icon: 'icon-192.png' };
    navigator.serviceWorker && navigator.serviceWorker.getRegistration ? navigator.serviceWorker.getRegistration().then(r => r ? r.showNotification(`המשלוח מ${o.chainName} הגיע?`, opts) : new Notification(`המשלוח מ${o.chainName} הגיע?`, opts)).catch(() => {}) : null;
  }
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
    return { chain: c, found: found.length, sum: found.reduce((s, r) => s + r.cells[c.id].total, 0), common: common.reduce((s, r) => s + (r.cells[c.id] ? r.cells[c.id].total : 0), 0), fee: f };
  }).filter(t => t.found);
  const maxFound = Math.max(0, ...totals.map(t => t.found));
  const ranked = [...totals].sort((a, b) => (a.common + a.fee) - (b.common + b.fee));
  const best = ranked.find(t => t.found >= maxFound - 1) || ranked[0] || null;
  return { rows, totals: ranked, best, commonCount: common.length };
}

// שומרים רק את מה שצריך מכל תוצאה, כדי שההשוואה תעבור מהר לשאר המכשירים
const slim = (list) => (list || []).slice(0, 6).map(p => ({ name: p.name, price: p.price, unit: p.unit || '', image: p.image || '', url: p.url || '', promo: p.promo || '', unitPrice: p.unitPrice || null }));
async function runCompare() {
  const list = superNeeded();
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
  let advice = null, adviceError = USE_AI ? '' : 'off';
  if (USE_AI) try {
    comparing.stage = 'advice'; render();
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
  const list = superNeeded();
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
      <p>${recText(b)}</p></div>` : '';
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
// ההמלצה בלי Claude: הזולה בסל המשותף כולל משלוח, ובכמה היא זולה מהבאה אחריה
function recText(b) {
  const best = b.best, rest = b.totals.filter(t => t !== best);
  const next = rest[0];
  const parts = [`סל משותף של ${b.commonCount} מוצרים + משלוח: ${money(best.common + best.fee)}`];
  if (next) { const d = (next.common + next.fee) - (best.common + best.fee); if (d >= 1) parts.push(`זול ב-${money(d)} מ${next.chain.name}`); }
  const miss = b.rows.length - best.found;
  if (miss) parts.push(miss === 1 ? 'מוצר אחד לא נמצא שם' : `${miss} מוצרים לא נמצאו שם`);
  const promos = b.rows.filter(r => r.cells[best.chain.id] && r.cells[best.chain.id].promo).length;
  if (promos) parts.push(promos === 1 ? 'מוצר אחד במבצע' : `${promos} מוצרים במבצע`);
  return esc(parts.join(' · ')) + '.';
}
function linksTable(list) {
  return `<h2 class="cat">חיפוש ידני בכל רשת</h2><ul class="list links">${list.map(i => `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}</span><span class="lk">${CHAINS.map(c => `<a style="--c:${c.color}" href="${searchUrl(c, i)}" target="_blank" rel="noopener">${c.name}</a>`).join('')}</span></li>`).join('')}</ul>`;
}

// ---------- הגדרות ----------
function settingsView() {
  const removed = Object.values(S.items).filter(i => i.deleted && i.kind !== 'once');
  const install = standalone() ? '<p>✓ האפליקציה מותקנת במכשיר הזה.</p>'
    : installEvt ? '<button class="btn primary" data-install>התקנה בטלפון</button>'
    : isIOS() ? '<p>באייפון: לוחצים על כפתור השיתוף <b>⎋</b> בספארי ← <b>הוספה למסך הבית</b>.</p>'
    : '<p>בכרום: תפריט ⋮ ← <b>התקנת אפליקציה</b> (או "הוספה למסך הבית").</p>';
  const done = Object.values(S.orders).filter(o => o.status === 'done').sort((a, b) => b.when - a.when).slice(0, 5);
  return `<section class="hero"><h1>הגדרות</h1><p>רשימה אחת לכל הבית – כל שינוי מופיע בכל המכשירים</p></section>
    <div class="card"><h3>🙋 מי משתמש בטלפון הזה?</h3>
      <label class="field inline">השם שלי<span class="row"><input id="me" value="${esc(me())}" placeholder="למשל: יעל" autocomplete="off"></span></label>
      <p class="note">השם מופיע ליד מוצרים שהוספת, וכשאת/ה בקניות.</p></div>
    <div class="card"><h3>📲 התקנה בטלפון</h3>${install}
      <p>כדי שעוד מכשיר יראה את אותה רשימה, פשוט פותחים בו את הכתובת הזו:</p>
      <div class="code">${esc(location.origin + location.pathname)}</div>
      <div class="row-btns"><button class="btn" data-sharelink>שליחת הקישור בווטסאפ</button></div>
      <p class="status">סנכרון: <span id="sync-t">${{ ok: 'מחובר ✓', off: 'אין חיבור לשרת', idle: 'בודק…' }[syncState]}</span></p>
    </div>
    <div class="card"><h3>🚚 דמי משלוח משוערים</h3>
      ${CHAINS.map(c => `<label class="field inline">${c.name}<span class="row">₪<input type="number" min="0" step="0.1" inputmode="decimal" data-fee="${c.id}" value="${fee(c.id)}"></span></label>`).join('')}
    </div>
    ${done.length ? `<div class="card"><h3>📦 משלוחים אחרונים</h3><ul class="plain">${done.map(o => `<li><b>${esc(o.chainName)}</b> · ${whenText(o.when)}${o.missing && o.missing.length ? ` · <span class="warn-t">לא הגיעו: ${o.missing.map(x => esc(S.items[x] ? S.items[x].name : '')).join(', ')}</span>` : ' · הכול הגיע'}${o.changes ? ` · ${esc(o.changes)}` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><h3>🖼️ תמונות</h3><p>תמונות המוצרים נלקחות מאתרי הרשתות כשמחפשים מחירים.</p>
      <button class="btn ghost" data-noimgs>חזרה לאיורים</button></div>
    <div class="card"><h3>🧺 מוצרים קבועים</h3><ul class="list compact">${live().filter(i => i.kind !== 'once').sort((a, b) => a.name.localeCompare(b.name, 'he')).map(i => { const c = cycleOf(i.hist, i.snooze); return `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}${c ? `<small>בערך כל ${c.every} ימים</small>` : ''}</span><button class="icon" data-edit="${i.id}" aria-label="עריכה">✎</button></li>`; }).join('')}</ul>
      <button class="btn wide" data-add="">מוצר חדש</button>
      ${removed.length ? `<details><summary>מוצרים שנמחקו (${removed.length})</summary><ul class="list compact">${removed.map(i => `<li>${tileArt(i, true)}<span class="nm">${esc(i.name)}</span><button class="btn" data-restore="${i.id}">החזרה</button></li>`).join('')}</ul></details>` : ''}
    </div>
    <p class="note">הרשימה ההתחלתית: ${PRODUCTS.length} מוצרים שהופיעו לפחות 3 פעמים בקבוצה "קניות מקסימות", וממנה גם הקצב ההתחלתי של כל מוצר.</p>`;
}

// ---------- עריכה / הוספה ----------
function guessEmoji(name) { const h = EMOJI_HINTS.find(([re]) => re.test(name)); return h ? h[1] : ''; }
function openEditor(id, name = '') {
  const isNew = id === 'new';
  const it = isNew ? { id: 'new', name, cat: 'pantry', emoji: guessEmoji(name), q: '', note: '', kind: '' } : S.items[id];
  const c = !isNew && cycleOf(it.hist, it.snooze);
  const dlg = $('#editor');
  dlg.innerHTML = `<form method="dialog" class="sheet">
    <h3>${isNew ? 'מוצר חדש' : 'עריכת מוצר'}</h3>
    <label class="field">שם<input name="name" required value="${esc(it.name)}" autocomplete="off"></label>
    <fieldset class="seg"><legend>זה מוצר…</legend>
      <label><input type="radio" name="kind" value="once" required${it.kind === 'once' ? ' checked' : ''}><span>חד פעמי<small>יורד אחרי שקונים</small></span></label>
      <label><input type="radio" name="kind" value="fixed" required${it.kind === 'fixed' || (!isNew && !it.kind) ? ' checked' : ''}><span>קבוע<small>נשאר במסך "מה חסר"</small></span></label>
    </fieldset>
    <label class="field">קטגוריה<select name="cat">${CATS.map(c => `<option value="${c.id}"${c.id === it.cat ? ' selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></label>
    <label class="field">סמל (אימוג'י)<input name="emoji" value="${esc(it.emoji || '')}" maxlength="4" placeholder="${catOf(it.cat).icon}"></label>
    <label class="field">מה לחפש באתרי הרשתות<input name="q" value="${esc(it.q || '')}" placeholder="${esc(it.name || 'למשל: חלב 3% 1 ליטר')}"></label>
    <label class="field">הערה<input name="note" value="${esc(it.note || '')}" placeholder="למשל: בלי גלעין, 1 ק״ג"></label>
    ${c ? `<p class="note">⏳ נקנה בערך כל ${c.every} ימים · לאחרונה לפני ${c.since} ימים</p>` : ''}
    <div class="row-btns"><button class="btn primary" value="save">שמירה</button><button class="btn" value="cancel" formnovalidate>ביטול</button>${!isNew ? '<button class="btn danger" value="delete" formnovalidate>מחיקה</button>' : ''}</div>
  </form>`;
  const form = $('form', dlg);
  form.name.addEventListener('input', () => { if (!form.emoji.value) form.emoji.placeholder = guessEmoji(form.name.value) || catOf(form.cat.value).icon; });
  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v === 'delete') { touch(id, { deleted: true, need: false }); toast('נמחק. אפשר להחזיר מההגדרות'); return; }
    if (v !== 'save') return;
    const nm = form.name.value.trim(); if (!nm) return;
    const data = { name: nm, kind: form.kind.value || 'fixed', cat: form.cat.value, emoji: form.emoji.value.trim() || guessEmoji(nm), q: form.q.value.trim(), note: form.note.value.trim() };
    if (isNew) {
      const nid = 'u' + now().toString(36) + Math.random().toString(36).slice(2, 5);
      S.items[nid] = { id: nid, ...data, count: 0, need: true, qty: 1, got: false, hist: [], by: me(), at: now() };
      filter = ''; save(); render(); toast(`"${nm}" נוסף לרשימה${data.kind === 'once' ? ' (חד פעמי)' : ''}`);
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
function setNeed(id, on) {
  const i = S.items[id];
  touch(id, { need: on, got: false, qty: on ? (i.qty || 1) : 1, by: on ? me() : i.by, snooze: 0 });
}

// ---------- אירועים ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || t.closest('dialog')) return;
  const d = t.dataset;
  if (d.v || d.go) { view = d.v || d.go; S.view = view; save(false); render(); scrollTo(0, 0); }
  else if (d.toggle) {
    const i = S.items[d.toggle];
    if (isOrdered(i)) { toast(`"${i.name}" כבר בדרך במשלוח`); return; }
    setNeed(d.toggle, !i.need); if (navigator.vibrate) navigator.vibrate(10);
  }
  else if (d.cat !== undefined && t.classList.contains('chip')) { catFilter = d.cat; render(); }
  else if (d.add !== undefined) openEditor('new', d.add);
  else if (d.edit) openEditor(d.edit);
  else if (d.qty) { const i = S.items[d.qty]; touch(d.qty, { qty: Math.max(1, Math.min(99, (i.qty || 1) + Number(d.d))) }); }
  else if (d.cart) { const i = S.items[d.cart]; touch(d.cart, { got: !i.got }); if (navigator.vibrate) navigator.vibrate(10); }
  else if ('startShop' in d) startShop();
  else if ('stopShop' in d) stopShop();
  else if ('checkout' in d) checkout();
  else if ('startDelivery' in d) startDelivery();
  else if (d.verify) verifyOrder(d.verify);
  else if (d.remind) reminderSheet(d.remind);
  else if (d.cancelOrder) cancelOrder(d.cancelOrder);
  else if (d.soonAdd) setNeed(d.soonAdd, true);
  else if (d.snooze) { touch(d.snooze, { snooze: now() }); toast('נרשם. נזכיר שוב בסבב הבא'); }
  else if ('addsoon' in d) { for (const { i } of runningOut()) S.items[i.id] = { ...i, need: true, by: me(), snooze: 0, at: now() }; save(); render(); toast('נוסף לרשימה'); }
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
  if (t.closest('dialog')) return;
  if (t.dataset.pref) { S.prefs[t.dataset.pref] = { name: t.value, at: now() }; save(); render(); }
  else if (t.dataset.fee) { const n = Number(t.value); S.fees[t.dataset.fee] = { value: Number.isFinite(n) && n >= 0 ? n : DEFAULT_FEE, at: now() }; save(); }
  else if (t.id === 'me') { store.set('shop-me', t.value.trim()); toast('נשמר'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'q' && filter.trim()) {
    const f = filter.trim(), hit = live().find(i => i.name === f);
    if (hit) { filter = ''; setNeed(hit.id, true); toast(`"${f}" ברשימה`); } else openEditor('new', f);
  }
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (view === 'home' || view === 'settings') render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); checkReminders(); } });
let lastRemindRender = 0;
setInterval(() => {
  if (!document.hidden && !syncing) sync();
  checkReminders();
  // כשמגיע זמן הבדיקה של משלוח, הבאנר מופיע בלי לרענן
  const due = pendingOrders().filter(o => now() >= remindAt(o)).length;
  if (due !== lastRemindRender && !document.querySelector('dialog[open]') && document.activeElement?.id !== 'q') { lastRemindRender = due; render(); }
}, POLL_MS);

lastRemindRender = pendingOrders().filter(o => now() >= remindAt(o)).length;
render();
sync().then(() => {
  // קישור מהתזכורת ביומן: ?verify=<משלוח>
  const v = new URLSearchParams(location.search).get('verify');
  if (v) { history.replaceState(null, '', location.pathname); view = 'list'; render(); verifyOrder(v); }
});
checkReminders();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
