// השרת של אפליקציית הקניות (Cloudflare Worker "shopping123")
//   GET  /ping              מה מוגדר
//   GET  /list              הרשימה המשותפת לכל המכשירים
//   PUT  /list              מיזוג: לכל מוצר נשמרת הגרסה עם at המאוחר יותר
//   GET/PUT /compare        ההשוואה האחרונה (מחירים + ניתוח), כדי שכל המכשירים יראו אותה
//   GET  /prices?q=טופו     מחירים ומבצעים עדכניים מכל רשת (רק כשלוחצים "חיפוש מחירים" באפליקציה)
//   POST /advice            Claude מנתח את התוצאות: איזה מוצר מתאים בכל רשת, ואיפה כדאי להזמין
//
// הגדרות ב-Cloudflare: KV בשם LIBRARY, וסוד ANTHROPIC_API_KEY (רשות – בלעדיו יש השוואה בלי ניתוח).
// כתובות ה-API של הרשתות לא נבדקו מול האתרים האמיתיים (סביבת הפיתוח חוסמת אותם).

export const CHAINS = {
  shufersal: { name: 'שופרסל', search: (q) => 'https://www.shufersal.co.il/online/he/search?text=' + encodeURIComponent(q) },
  rami: { name: 'רמי לוי', search: (q) => 'https://www.rami-levy.co.il/he/online/search?q=' + encodeURIComponent(q) },
  carrefour: { name: 'קרפור', search: (q) => 'https://www.carrefour.co.il/search?q=' + encodeURIComponent(q) },
  hazi: { name: 'חצי חינם', search: (q) => 'https://shop.hazi-hinam.co.il/search?q=' + encodeURIComponent(q) }
};
const MODEL = 'claude-opus-5-5';
const UA = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36', 'accept-language': 'he-IL,he;q=0.9' };
const MAX_RESULTS = 8;
const PRICE_CACHE_SEC = 1800;   // רק כדי ששתי לחיצות צמודות לא יחפשו פעמיים; "רענון" עוקף
const MAX_LIST_BYTES = 1024 * 1024;
const DAILY_ADVICE_LIMIT = 40;

const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
const abs = (u, base) => { try { return u ? new URL(u, base).href : ''; } catch (e) { return ''; } };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);

// ---------- גודל אריזה ומחיר ליחידה ----------
// "טופו 300 גרם" → 300 גרם; "חלב 3% 1 ליטר" → 1000 מ"ל; "12 יח'" → 12 יחידות; "2*500 גרם" → 1000 גרם
export function parseSize(text) {
  const s = String(text || '').replace(/[״"]/g, '"').replace(/ק"ג|קילו(גרם)?/g, 'קג').replace(/מ"ל/g, 'מל');
  const m = s.match(/(?:(\d+)\s*[*x×]\s*)?(\d+(?:\.\d+)?)\s*(קג|גרם|גר'?|ג'|ליטר|ל'|מל|יח'?|יחידות|ביצים)(?![֐-׿])/);
  if (!m) return null;
  const n = Number(m[2]) * Number(m[1] || 1), u = m[3];
  if (u === 'קג') return { amount: n * 1000, unit: 'g' };
  if (/^(גרם|גר'?|ג')$/.test(u)) return { amount: n, unit: 'g' };
  if (u === 'ליטר' || u === "ל'") return { amount: n * 1000, unit: 'ml' };
  if (u === 'מל') return { amount: n, unit: 'ml' };
  return { amount: n, unit: 'unit' };
}
// מחיר ל-100 גרם / 100 מ"ל / ליחידה
export function unitPrice(price, size) {
  if (!price || !size || !size.amount) return null;
  if (size.unit === 'unit') return { value: Math.round(price / size.amount * 100) / 100, per: 'ליחידה' };
  return { value: Math.round(price / size.amount * 10000) / 100, per: size.unit === 'g' ? 'ל-100 גרם' : 'ל-100 מ"ל' };
}
// טקסט מבצע מכל שדה שנראה כמו מבצע (promotion, sale, deal...)
export function promoText(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return '';
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (!/promo|sale|deal|discount|campaign/i.test(k)) continue;
    if (typeof v === 'string') { if (/[֐-׿]/.test(v)) out.push(v); continue; }
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x === 'string') { if (/[֐-׿]/.test(x)) out.push(x); }
      else if (x && typeof x === 'object') {
        const t = x.description || x.text || x.name || x.title || x.promotionDescription || x.msg;
        if (typeof t === 'string') out.push(t); else { const deep = promoText(x, depth + 1); if (deep) out.push(deep); }
      }
    }
  }
  return [...new Set(out.map(clean))].filter(Boolean).join(' · ').slice(0, 120);
}
function product(name, price, extra = {}) {
  const p = num(price);
  return { name: clean(name), price: p, unit: clean(extra.unit || ''), image: extra.image || '', url: extra.url || '', promo: extra.promo || '',
    unitPrice: unitPrice(p, parseSize((extra.unit || '') + ' ' + name)) };
}

// ---------- מפענחים לכל רשת ----------
export function parseShufersal(data) {
  const list = Array.isArray(data && data.results) ? data.results : [];
  return list.map(x => {
    const img = (Array.isArray(x.images) ? (x.images.find(i => i.format === 'medium') || x.images[0]) : null) || {};
    return product(x.name, x.price && (x.price.value ?? x.price.formattedValue), { unit: clean(x.unitDescription || x.size || ''),
      image: abs(img.url, 'https://www.shufersal.co.il'), url: abs(x.url, 'https://www.shufersal.co.il/online/he/'), promo: promoText(x) });
  }).filter(x => x.name && x.price).slice(0, MAX_RESULTS);
}
export function parseRami(data, q) {
  const list = Array.isArray(data && data.data) ? data.data : [];
  return list.map(x => {
    const p = x.price && typeof x.price === 'object' ? x.price.price : x.price;
    const im = x.images && (x.images.small || x.images.original);
    return product(x.name, p, { unit: clean(x.gs && x.gs.Net_Content && x.gs.Net_Content.text || ''),
      image: im ? abs(im, 'https://img.rami-levy.co.il') : '', url: CHAINS.rami.search(q), promo: promoText(x) });
  }).filter(x => x.name && x.price).slice(0, MAX_RESULTS);
}
// דף חיפוש כללי: מוצרים מ-JSON-LD, ואם אין – זוגות name/price מתוך JSON שמוטמע בדף
export function parseHtmlProducts(html, base) {
  const out = [];
  const add = (o) => {
    const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
    const image = Array.isArray(o.image) ? o.image[0] : (o.image && o.image.url) || o.image;
    const p = product(o.name, offer && (offer.price ?? offer.lowPrice), { image: abs(typeof image === 'string' ? image : '', base), url: abs(o.url, base) || base, promo: promoText(o) });
    if (p.name && p.price) out.push(p);
  };
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = o['@type'];
    if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) add(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  for (const m of String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1])); } catch (e) { /* JSON לא תקין */ }
  }
  if (!out.length) {
    const re = /"name"\s*:\s*"([^"]{2,100})"[^{}]{0,400}?"price"\s*:\s*"?(\d+(?:\.\d+)?)/g;
    for (const m of String(html || '').matchAll(re)) {
      let name; try { name = JSON.parse('"' + m[1] + '"'); } catch (e) { name = m[1]; }
      if (/[֐-׿]/.test(name)) out.push(product(name, m[2], { url: base }));
    }
  }
  const seen = new Set();
  return out.filter(x => x.price && !seen.has(x.name) && seen.add(x.name)).slice(0, MAX_RESULTS);
}

async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
async function getHtml(url) {
  const r = await fetch(url, { headers: { ...UA, accept: 'text/html' }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.text();
}
export const FETCHERS = {
  shufersal: async (q) => parseShufersal(await getJson('https://www.shufersal.co.il/online/he/search/results?q=' + encodeURIComponent(q) + '&limit=12',
    { headers: { 'x-requested-with': 'XMLHttpRequest' } })),
  // 331: הסניף המקוון (המחירים באתר זהים לכל הארץ)
  rami: async (q) => parseRami(await getJson('https://www.rami-levy.co.il/api/catalog', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, aggs: 1, store: '331' }) }), q),
  carrefour: async (q) => parseHtmlProducts(await getHtml(CHAINS.carrefour.search(q)), CHAINS.carrefour.search(q)),
  hazi: async (q) => parseHtmlProducts(await getHtml(CHAINS.hazi.search(q)), CHAINS.hazi.search(q))
};

export async function shopPrices(env, q, { fresh = false } = {}) {
  const key = 'shopq:' + q;
  if (!fresh && env.LIBRARY) { const hit = await env.LIBRARY.get(key, 'json'); if (hit) return { ...hit, cached: true }; }
  const chains = {}, errors = {};
  await Promise.all(Object.keys(CHAINS).map(async (c) => {
    try { chains[c] = await FETCHERS[c](q); } catch (e) { chains[c] = []; errors[c] = String(e && e.message || e).slice(0, 80); }
  }));
  const out = { q, at: Date.now(), chains, errors };
  if (env.LIBRARY) await env.LIBRARY.put(key, JSON.stringify(out), { expirationTtl: PRICE_CACHE_SEC });
  return out;
}

// ---------- הניתוח של Claude ----------
const ADVICE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['best_chain', 'summary', 'split', 'picks', 'tips'],
  properties: {
    best_chain: { type: 'string', enum: Object.keys(CHAINS) },
    summary: { type: 'string' },
    split: { type: 'string' },
    picks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'chain', 'index', 'note'],
      properties: { item: { type: 'string' }, chain: { type: 'string', enum: Object.keys(CHAINS) }, index: { type: 'integer' }, note: { type: 'string' } } } },
    tips: { type: 'array', items: { type: 'string' } }
  }
};
export function advicePrompt(items, prices, fees) {
  const lines = items.map(i => {
    const per = Object.keys(CHAINS).map(c => {
      const list = (prices[i.id] && prices[i.id][c]) || [];
      if (!list.length) return `  ${c}: (no results)`;
      return `  ${c}:\n` + list.map((p, k) => `    [${k}] ${clean(p.name)}${p.unit ? ' | ' + clean(p.unit) : ''} | ₪${num(p.price)}${p.unitPrice ? ` (₪${p.unitPrice.value} ${p.unitPrice.per})` : ''}${p.promo ? ' | מבצע: ' + clean(p.promo) : ''}`).join('\n');
    }).join('\n');
    return `- id=${i.id} "${i.name}" qty=${i.qty}${i.note ? ` note="${i.note}"` : ''}\n${per}`;
  }).join('\n');
  const feeText = Object.entries(CHAINS).map(([c, x]) => `${c} (${x.name}): ₪${Number.isFinite(Number(fees[c])) ? Number(fees[c]) : 30}`).join(', ');
  return `A family in Jerusalem wants to order these groceries online from one of: Shufersal (shufersal), Rami Levy (rami), Carrefour (carrefour), Hazi Hinam (hazi).
Below are live search results from each chain's website, with current prices and promotions.

1. picks: for every item and every chain, give the index of the product that best matches what the family means (same kind of product, a sensible everyday size, respecting the note), or -1 if nothing in that chain's list is really that product. When sizes differ, compare by unit price; take promotions into account (e.g. "2 ב-20" when qty is 2). note: a very short Hebrew remark only when useful (a size or brand difference, a promotion), otherwise "".
2. best_chain and summary: where the whole order is cheapest overall, including the delivery fee (${feeText}) and the items a chain doesn't have. summary: 2-3 Hebrew sentences with the reason (approximate total, promotions, missing items).
3. split: one Hebrew sentence only if splitting between two chains clearly saves more than the extra delivery fee; otherwise "".
4. tips: up to 4 short practical Hebrew notes (promotions worth using, a cheaper size or brand, items to check on the site).
Use only the data below; never invent prices or promotions.

Items:
${lines}`;
}
export async function shopAdvice(env, body) {
  if (!env.ANTHROPIC_API_KEY) return { error: 'no_key' };
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 80).map(i => ({ id: String(i.id).slice(0, 40), name: clean(i.name), qty: Number(i.qty) || 1, note: clean(i.note) }));
  if (!items.length) return { error: 'empty' };
  if (env.LIBRARY) {
    const dayKey = 'advice-count:' + new Date().toISOString().slice(0, 10);
    const n = Number(await env.LIBRARY.get(dayKey)) || 0;
    if (n >= DAILY_ADVICE_LIMIT) return { error: 'daily_limit' };
    await env.LIBRARY.put(dayKey, String(n + 1), { expirationTtl: 172800 });
  }
  const prices = body.prices && typeof body.prices === 'object' ? body.prices : {};
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 16000, fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ADVICE_SCHEMA } },
      messages: [{ role: 'user', content: advicePrompt(items, prices, body.fees || {}) }]
    })
  });
  if (!r.ok) return { error: 'ai_' + r.status };
  const msg = await r.json();
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return { error: 'ai_' + msg.stop_reason };
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out; try { out = JSON.parse(text); } catch (e) { return { error: 'ai_bad_json' }; }
  // רק בחירות שמצביעות על מוצר שבאמת הופיע בתוצאות
  const ids = new Set(items.map(i => i.id));
  const picks = (out.picks || []).filter(p => ids.has(p.item) && CHAINS[p.chain] && Number.isInteger(p.index) &&
    (p.index === -1 || (prices[p.item] && Array.isArray(prices[p.item][p.chain]) && prices[p.item][p.chain][p.index])));
  return { best_chain: CHAINS[out.best_chain] ? out.best_chain : '', summary: clean(out.summary).slice(0, 600) || String(out.summary || '').slice(0, 600),
    split: String(out.split || '').slice(0, 300), picks, tips: (out.tips || []).slice(0, 4).map(t => String(t).slice(0, 200)), at: Date.now() };
}

// ---------- הרשימה המשותפת ----------
// מיזוג לפי רשומה: הגרסה עם at המאוחר יותר מנצחת (גם מחיקה, deleted: true).
// ההשוואה האחרונה (גדולה) נשמרת בנפרד ב-/compare; ברשימה רק compareAt, כדי שהבדיקה כל כמה שניות תהיה קלה.
// items: מוצרים · prefs: בחירת מוצר בכל רשת · fees: דמי משלוח · orders: משלוחים · meta: מי בקניות עכשיו
const SYNC_KEYS = ['items', 'prefs', 'fees', 'orders', 'meta'];
export function mergeShop(a, b) {
  const pick = (x, y) => {
    const out = { ...(x || {}) };
    for (const [id, it] of Object.entries(y || {})) {
      if (!it || typeof it !== 'object') continue;
      if (!out[id] || (Number(it.at) || 0) > (Number(out[id].at) || 0)) out[id] = it;
    }
    return out;
  };
  const out = { compareAt: Math.max(Number(a && a.compareAt) || 0, Number(b && b.compareAt) || 0) };
  for (const k of SYNC_KEYS) out[k] = pick(a && a[k], b && b[k]);
  return out;
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

export async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/ping') return json({ ok: true, kv: !!env.LIBRARY, ai: !!env.ANTHROPIC_API_KEY });
  if (path === '/prices' && req.method === 'GET') {
    const q = clean(url.searchParams.get('q')).slice(0, 60);
    if (!q) return json({ error: 'missing' }, 400);
    return json(await shopPrices(env, q, { fresh: url.searchParams.get('fresh') === '1' }));
  }
  if (path === '/advice' && req.method === 'POST') {
    const text = await req.text();
    if (text.length > 600 * 1024) return json({ error: 'too_large' }, 413);
    let body; try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const out = await shopAdvice(env, body);
    return json(out, out.error ? (out.error === 'no_key' ? 503 : out.error === 'daily_limit' ? 429 : 502) : 200);
  }
  if (path === '/list' || path === '/compare') {
    if (!env.LIBRARY) return json({ error: 'no_kv' }, 503);
    const cur = (await env.LIBRARY.get('shoplist:main', 'json')) || { compareAt: 0 };
    if (req.method === 'GET') return path === '/list' ? json(cur) : json((await env.LIBRARY.get('shoplist:compare', 'json')) || null);
    if (req.method !== 'PUT') return json({ error: 'method' }, 405);
    const text = await req.text();
    if (text.length > MAX_LIST_BYTES) return json({ error: 'too_large' }, 413);
    let body; try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad_json' }, 400); }
    if (path === '/compare') {
      // רק השוואה חדשה יותר מחליפה את הקיימת
      if (!body || !(Number(body.at) > (Number(cur.compareAt) || 0))) return json({ ok: false, compareAt: cur.compareAt });
      await env.LIBRARY.put('shoplist:compare', text);
      await env.LIBRARY.put('shoplist:main', JSON.stringify({ ...cur, compareAt: Number(body.at) }));
      return json({ ok: true, compareAt: Number(body.at) });
    }
    const next = mergeShop(cur, { ...body, compareAt: 0 });
    if (JSON.stringify(next).length > MAX_LIST_BYTES) return json({ error: 'too_large' }, 413);
    await env.LIBRARY.put('shoplist:main', JSON.stringify(next));
    return json(next);
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json({ error: 'worker_error', message: String(e && e.message || e) }, 500); }
  }
};
