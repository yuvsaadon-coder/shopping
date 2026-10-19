// בדיקות: השרת (מפענחים, גודל אריזה, מיזוג, נקודות קצה, הניתוח של Claude) והאפליקציה בדפדפן עם שרת מדומה
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parseWooStore, parseShopifySuggest, parseShufersal, parseRami, parseHtmlProducts, parseSize, unitPrice, promoText, mergeShop, handle, advicePrompt } from '../worker/worker.js';
import { PRODUCTS } from '../products.js';

// ---------- רשימת הפתיחה ----------
assert.ok(PRODUCTS.length >= 40, 'products from the chat');
assert.equal(new Set(PRODUCTS.map(p => p.id)).size, PRODUCTS.length, 'unique ids');
assert.equal(new Set(PRODUCTS.map(p => p.name)).size, PRODUCTS.length, 'unique names');
assert.ok(PRODUCTS.every(p => p.count >= 3 && p.emoji && p.q), 'each appeared 3+ times and has an icon and a search term');

// ---------- גודל אריזה, מחיר ליחידה, מבצעים ----------
assert.deepEqual(parseSize('טופו טבעי 300 גרם'), { amount: 300, unit: 'g' });
assert.deepEqual(parseSize('בשר טחון 1 ק"ג'), { amount: 1000, unit: 'g' });
assert.deepEqual(parseSize('חלב 3% 1 ליטר'), { amount: 1000, unit: 'ml' });
assert.deepEqual(parseSize('רוטב סויה 250 מ"ל'), { amount: 250, unit: 'ml' });
assert.deepEqual(parseSize('ביצים L 12 יח\''), { amount: 12, unit: 'unit' });
assert.deepEqual(parseSize('מארז 2*500 גרם'), { amount: 1000, unit: 'g' });
assert.equal(parseSize('חסה'), null);
assert.deepEqual(unitPrice(12, { amount: 300, unit: 'g' }), { value: 4, per: 'ל-100 גרם' });
assert.deepEqual(unitPrice(24, { amount: 12, unit: 'unit' }), { value: 2, per: 'ליחידה' });
assert.equal(promoText({ name: 'x', promotionMsg: '2 ב-20 ₪' }), '2 ב-20 ₪');
assert.equal(promoText({ promotions: [{ description: '1+1 על כל המותג' }] }), '1+1 על כל המותג');
assert.equal(promoText({ sale: null, price: 3 }), '');

// ---------- מפענחים ----------
const sh = parseShufersal({ results: [
  { name: 'טופו טבעי', price: { value: 11.9 }, unitDescription: '300 גרם', url: '/online/he/p/P_1', promotionMsg: '2 ב-20 ₪',
    images: [{ format: 'small', url: 'https://res.cloudinary.com/s.jpg' }, { format: 'medium', url: 'https://res.cloudinary.com/m.jpg' }] },
  { name: 'בלי מחיר', price: {} }] });
assert.equal(sh.length, 1);
assert.deepEqual({ ...sh[0], unitPrice: undefined }, { name: 'טופו טבעי', price: 11.9, unit: '300 גרם', image: 'https://res.cloudinary.com/m.jpg', url: 'https://www.shufersal.co.il/online/he/p/P_1', promo: '2 ב-20 ₪', unitPrice: undefined });
assert.deepEqual(sh[0].unitPrice, { value: 3.97, per: 'ל-100 גרם' });
const ra = parseRami({ data: [{ name: 'טופו 250 גרם', price: { price: '9.90' }, images: { small: '/product/1/small.jpg' } }] }, 'טופו');
assert.equal(ra[0].price, 9.9); assert.equal(ra[0].image, 'https://img.rami-levy.co.il/product/1/small.jpg'); assert.equal(ra[0].unitPrice.value, 3.96);
const ld = parseHtmlProducts('<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"טופו קרפור","image":["/i.jpg"],"url":"/p/2","offers":{"price":"10.50"}}]}</script>', 'https://www.carrefour.co.il/search?q=x');
assert.deepEqual(ld.map(x => [x.name, x.price, x.image, x.url]), [['טופו קרפור', 10.5, 'https://www.carrefour.co.il/i.jpg', 'https://www.carrefour.co.il/p/2']]);
const emb = parseHtmlProducts('<script>window.__D={"items":[{"id":1,"name":"טופו חצי חינם","brand":"x","price":8.9},{"name":"English only","price":3}]}</script>', 'https://shop.hazi-hinam.co.il/search?q=x');
assert.deepEqual(emb.map(x => [x.name, x.price]), [['טופו חצי חינם', 8.9]]);
// החישוק: WooCommerce או Shopify
const woo = parseWooStore([{ name: 'טופו 300 גרם', permalink: 'https://hahishook.com/p/1', prices: { price: '890', regular_price: '990', sale_price: '890', currency_minor_unit: 2 }, images: [{ src: 'https://hahishook.com/t.jpg' }] }], 'https://hahishook.com');
assert.deepEqual([woo[0].name, woo[0].price, woo[0].promo, woo[0].unitPrice.value], ['טופו 300 גרם', 8.9, 'מבצע (במקום ₪9.9)', 2.97]);
const shop = parseShopifySuggest({ resources: { results: { products: [{ title: 'טופו', price: '9.50', url: '/products/tofu', image: 'https://cdn.shopify.com/t.jpg' }] } } }, 'https://hahishook.com');
assert.deepEqual([shop[0].name, shop[0].price, shop[0].url], ['טופו', 9.5, 'https://hahishook.com/products/tofu']);
assert.deepEqual(parseShufersal(null), []); assert.deepEqual(parseHtmlProducts('', 'https://x.co.il'), []);

// ---------- מיזוג ----------
const m = mergeShop({ items: { a: { name: 'א', need: true, at: 5 }, b: { name: 'ב', at: 9 } }, compareAt: 7 },
  { items: { a: { name: 'א', need: false, at: 7 }, b: { name: 'ב', need: true, at: 3 }, c: { name: 'ג', deleted: true, at: 1 } }, prefs: { 'a|rami': { name: 'x', at: 1 } }, fees: { rami: { value: 0, at: 2 } } });
assert.equal(m.items.a.need, false); assert.equal(m.items.b.need, undefined); assert.ok(m.items.c.deleted);
assert.equal(m.prefs['a|rami'].name, 'x');
assert.equal(mergeShop({ orders: { o1: { status: 'pending', at: 1 } } }, { orders: { o1: { status: 'done', at: 2 } }, meta: { shopping: { active: true, at: 3 } } }).orders.o1.status, 'done'); assert.equal(m.fees.rami.value, 0); assert.equal(m.compareAt, 7);

// ---------- נקודות קצה ----------
const kv = new Map();
const env = { LIBRARY: { get: async (k, t) => kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null, put: async (k, v) => { kv.set(k, v); } } };
const call = (path, init) => handle(new Request('https://w.dev' + path, init), env);
assert.equal((await call('/list', { method: 'OPTIONS' })).status, 204);
assert.equal((await call('/list', { method: 'PUT', body: JSON.stringify({ items: { tofu: { name: 'טופו', need: true, at: 10 } } }) })).status, 200);
let merged = await (await call('/list', { method: 'PUT', body: JSON.stringify({ items: { tofu: { name: 'טופו', need: false, at: 4 }, eggs: { name: 'ביצים', need: true, at: 11 } }, compareAt: 999 }) })).json();
assert.equal(merged.items.tofu.need, true, 'older change does not win'); assert.equal(merged.items.eggs.need, true);
assert.equal(merged.compareAt, 0, 'compareAt only changes through /compare');
assert.equal((await call('/compare', { method: 'PUT', body: JSON.stringify({ at: 50, prices: {} }) })).status, 200);
assert.equal((await (await call('/compare', { method: 'PUT', body: JSON.stringify({ at: 40, prices: { old: 1 } }) })).json()).ok, false, 'older comparison is ignored');
assert.equal((await (await call('/list')).json()).compareAt, 50);
assert.equal((await (await call('/compare')).json()).at, 50);
assert.equal((await call('/list', { method: 'PUT', body: 'x'.repeat(1100 * 1024) })).status, 413);

const orig = globalThis.fetch; const hosts = []; let aiBody = null;
globalThis.fetch = async (u, o = {}) => {
  const url = new URL(u); hosts.push(url.hostname);
  if (url.hostname === 'www.shufersal.co.il') return Response.json({ results: [{ name: 'טופו', price: { value: 12 }, images: [] }] });
  if (url.hostname === 'www.rami-levy.co.il') { assert.equal(JSON.parse(o.body).q, 'טופו'); return Response.json({ data: [{ name: 'טופו', price: { price: 10 } }] }); }
  if (url.hostname === 'www.carrefour.co.il') return new Response('blocked', { status: 403 });
  if (url.hostname === 'hahishook.com' && url.pathname.startsWith('/wp-json/')) return Response.json([{ name: 'טופו', permalink: 'https://hahishook.com/p/1', prices: { price: '890', currency_minor_unit: 2 } }]);
  if (url.hostname === 'api.anthropic.com') {
    aiBody = JSON.parse(o.body);
    assert.equal(o.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    return Response.json({ model: aiBody.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      best_chain: 'rami', summary: 'ברמי לוי הסל הכי זול.', split: '', tips: ['טופו במבצע'],
      picks: [{ item: 'tofu', chain: 'rami', index: 0, note: '' }, { item: 'tofu', chain: 'shufersal', index: 7, note: 'מומצא' }, { item: 'ghost', chain: 'rami', index: 0, note: '' }] }) }] });
  }
  return new Response('<html></html>');
};
let r = await (await call('/prices?q=' + encodeURIComponent('טופו'))).json();
assert.equal(r.chains.shufersal[0].price, 12); assert.equal(r.chains.rami[0].price, 10); assert.equal(r.chains.hachishuk[0].price, 8.9);
assert.deepEqual(r.chains.carrefour, []); assert.ok(r.errors.carrefour);
const priceHosts = hosts.length;
assert.ok(['www.shufersal.co.il', 'www.rami-levy.co.il', 'www.carrefour.co.il', 'shop.hazi-hinam.co.il', 'hahishook.com'].every(h => hosts.includes(h)), 'all five chains searched');
r = await (await call('/prices?q=' + encodeURIComponent('טופו'))).json();
assert.ok(r.cached, 'a second press within minutes comes from KV'); assert.equal(hosts.length, priceHosts);
await call('/prices?fresh=1&q=' + encodeURIComponent('טופו'));
assert.equal(hosts.length, priceHosts * 2, 'fresh=1 searches again');
// הניתוח: בלי מפתח → 503; עם מפתח → רק בחירות שמצביעות על מוצר אמיתי
assert.equal((await call('/advice', { method: 'POST', body: JSON.stringify({ items: [{ id: 'tofu', name: 'טופו' }] }) })).status, 503);
env.ANTHROPIC_API_KEY = 'k';
const prices = { tofu: { rami: [{ name: 'טופו', price: 10, promo: '2 ב-18' }], shufersal: [{ name: 'טופו', price: 12 }] } };
const adv = await (await call('/advice', { method: 'POST', body: JSON.stringify({ items: [{ id: 'tofu', name: 'טופו', qty: 2 }], prices, fees: { rami: 25 } }) })).json();
assert.equal(adv.best_chain, 'rami'); assert.deepEqual(adv.picks.map(p => p.chain), ['rami'], 'invented index and unknown item dropped');
assert.equal(aiBody.model, 'claude-opus-5-5'); assert.equal(aiBody.fallbacks, 'default'); assert.equal(aiBody.output_config.format.type, 'json_schema');
assert.ok(aiBody.messages[0].content.includes('מבצע: 2 ב-18') && aiBody.messages[0].content.includes('rami (רמי לוי): ₪25') && aiBody.messages[0].content.includes('qty=2'));
assert.ok(advicePrompt([{ id: 'x', name: 'x', qty: 1 }], {}, {}).includes('(no results)'));
globalThis.fetch = orig;
delete env.ANTHROPIC_API_KEY;
console.log('worker: ok');

// ---------- בדפדפן ----------
const root = new URL('..', import.meta.url).pathname;
const TYPES = { html: 'text/html', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', woff2: 'font/woff2' };
const http = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/shopping\//, '/').replace(/\/$/, '/index.html');
  try { const body = await readFile(root + path.slice(1)); res.writeHead(200, { 'content-type': TYPES[path.split('.').pop()] || 'application/octet-stream' }); res.end(body); }
  catch (e) { res.writeHead(404); res.end(); }
});
await new Promise(ok => http.listen(0, ok));
const BASE = `http://localhost:${http.address().port}/shopping/`;

const server = { scanCalls: [], list: null, compare: null, priceCalls: [], adviceCalls: [], adviceOff: false };
const PRICES = {   // קרפור לא מוצאת ביצים
  'ביצים L': { shufersal: 30, rami: 26, hazi: 25 }, 'טופו': { shufersal: 12, rami: 10, carrefour: 11, hazi: 13 }, 'עגבניות שרי': { shufersal: 9, rami: 8, carrefour: 10, hazi: 9 }
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function mock(ctx) {
  await ctx.route('https://shopping123.yuvsaadon.workers.dev/**', async (route) => {
    const u = new URL(route.request().url()), method = route.request().method();
    const h = { 'access-control-allow-origin': '*' };
    if (u.pathname === '/list') {
      if (method === 'PUT') server.list = mergeShop(server.list, { ...JSON.parse(route.request().postData()), compareAt: 0 });
      return route.fulfill({ json: { ...(server.list || { items: {} }), compareAt: server.compare ? server.compare.at : 0 }, headers: h });
    }
    if (u.pathname === '/compare') {
      if (method === 'PUT') server.compare = JSON.parse(route.request().postData());
      return route.fulfill({ json: method === 'PUT' ? { ok: true } : server.compare, headers: h });
    }
    if (u.pathname === '/prices') {
      const q = u.searchParams.get('q'); server.priceCalls.push(q + (u.searchParams.get('fresh') ? '!' : ''));
      const p = PRICES[q] || {};
      const chains = Object.fromEntries(['shufersal', 'rami', 'carrefour', 'hazi'].map(c => [c, p[c] ? [
        { name: q + ' ' + c, price: p[c], image: c === 'rami' ? 'https://img.example/' + encodeURIComponent(q) + '.png' : '', url: '', promo: c === 'hazi' && q === 'טופו' ? '2 ב-22' : '', unitPrice: { value: p[c] / 3, per: 'ל-100 גרם' } },
        { name: 'משהו אחר', price: 1 }] : []]));
      return route.fulfill({ json: { q, chains }, headers: h });
    }
    if (u.pathname === '/advice') {
      const b = JSON.parse(route.request().postData()); server.adviceCalls.push(b);
      if (server.adviceOff) return route.fulfill({ status: 503, json: { error: 'no_key' }, headers: h });
      // Claude בוחר את התוצאה הראשונה בכל מקום, ובחצי חינם מוצא שהביצים לא מתאימות
      const picks = [];
      for (const [id, chains] of Object.entries(b.prices)) for (const [c, list] of Object.entries(chains)) if (list.length) picks.push({ item: id, chain: c, index: id === 'eggs' && c === 'hazi' ? -1 : 0, note: id === 'tofu' && c === 'hazi' ? 'במבצע 2 ב-22' : '' });
      return route.fulfill({ json: { best_chain: 'rami', summary: 'ברמי לוי הסל הכי זול, גם עם המשלוח.', split: '', tips: ['כדאי לבדוק את מבצע הטופו בחצי חינם'], picks, at: Date.now() }, headers: h });
    }
    return route.fulfill({ status: 404, json: {}, headers: h });
  });
  await ctx.route('https://books.yuvsaadon.workers.dev/v1/messages', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const b = JSON.parse(route.request().postData()); server.scanCalls.push(b);
    const text = JSON.stringify({ store: 'רמי לוי', items: [
      { text: 'ביצים L 12', id: 'eggs', qty: 2, price: 50 }, { text: 'חלב 3% 1ל', id: 'milk', qty: 1, price: 6.9 }, { text: 'שקית', id: '', qty: 1, price: 0.1 }, { text: 'בדוי', id: 'nope', qty: 1, price: 1 }] });
    return route.fulfill({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text }] }, headers: cors });
  });
  await ctx.route('https://img.example/**', r => r.fulfill({ body: PNG, contentType: 'image/png' }));
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const T0 = new Date('2026-10-13T09:00:00+03:00');
const phone = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  await ctx.clock.setFixedTime(T0);
  await ctx.addInitScript((n) => { if (!localStorage.getItem('shop-me')) localStorage.setItem('shop-me', JSON.stringify(n)); }, name);
  await mock(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  return p;
};
const count = (p) => p.locator('#count').textContent();
const waitCount = (p, n) => p.waitForFunction((n) => document.querySelector('#count').textContent === n, n);
const a = await phone('יובל');
await a.goto(BASE);
await a.getByRole('heading', { name: 'מה חסר בבית?' }).waitFor();
assert.equal(await a.locator('[data-toggle]').count(), PRODUCTS.length, 'all products as tiles');
for (const id of ['eggs', 'tofu', 'cherry']) await a.click(`[data-toggle="${id}"]`);
assert.equal(await count(a), '3');
// "כנראה נגמר": לפי הימים שבהם כל מוצר הופיע בקבוצה; "עוד יש" דוחה לסבב הבא
const soonFirst = a.locator('.soon-list li').first();
assert.match(await soonFirst.textContent(), /בדרך כלל כל \d+ ימים · לפני \d+ ימים/);
const soonId = await soonFirst.locator('[data-snooze]').getAttribute('data-snooze');
await soonFirst.locator('[data-snooze]').click();
assert.equal(await a.locator(`.soon [data-snooze="${soonId}"]`).count(), 0, 'snoozed item leaves the list');
assert.equal(await count(a), '3');
// מוצר חדש מהחיפוש: חובה לבחור חד פעמי או קבוע
await a.fill('#q', 'במבה');
await a.getByRole('button', { name: 'הוספת "במבה"' }).click();
assert.equal(await a.locator('#editor input[name=emoji]').inputValue(), '🍿', 'emoji guessed from the name');
await a.locator('#editor').getByRole('button', { name: 'שמירה' }).click();
assert.ok(await a.locator('#editor[open]').count(), 'cannot save before choosing one-time or fixed');
await a.locator('#editor .seg label', { hasText: 'חד פעמי' }).click();
await a.locator('#editor').getByRole('button', { name: 'שמירה' }).click();
await waitCount(a, '4');

// הרשימה
await a.getByRole('button', { name: /הרשימה/ }).click();
await a.getByRole('heading', { name: 'רשימת קניות' }).waitFor();
assert.equal(await a.locator('.list li').count(), 4);
await a.locator('li', { hasText: 'ביצים' }).getByRole('button', { name: 'יותר' }).click();
assert.equal(await a.locator('li', { hasText: 'ביצים' }).locator('.qty b').textContent(), '2');

// מכשיר שני פותח את אותה כתובת ורואה את אותה רשימה; שינוי שלו מגיע לראשון בלי לרענן
await a.waitForFunction(() => document.querySelector('#sync').dataset.s === 'ok');
await a.waitForTimeout(1200);
assert.ok(server.list && server.list.items.tofu.need, 'list reached the server');
const b = await phone('יעל');
await b.goto(BASE);
await waitCount(b, '4');
await b.locator('.tile', { hasText: 'במבה' }).waitFor();
await b.click('[data-toggle="lemon"]');
await waitCount(b, '5');
await a.waitForFunction(() => document.querySelector('#count').textContent === '5', null, { timeout: 15000 });
await b.click('[data-toggle="lemon"]');
await waitCount(b, '4');
await a.waitForFunction(() => document.querySelector('#count').textContent === '4', null, { timeout: 15000 });

// אין חיפוש מחירים עד שלוחצים
await a.getByRole('button', { name: /איפה זול/ }).click();
assert.deepEqual(server.priceCalls, [], 'no automatic price search');
await a.getByRole('button', { name: /חיפוש מחירים ל-4 מוצרים/ }).click();
await a.locator('.rec').waitFor();
assert.equal(server.priceCalls.length, 4); assert.ok(server.priceCalls.every(q => q.endsWith('!')), 'always fresh prices');
assert.equal(server.adviceCalls.length, 0, 'Claude analysis is off for now');
// בלי Claude: ההמלצה לפי הסל המשותף (טופו + שרי, כי בקרפור אין ביצים) + משלוח: רמי 18+30, שופרסל 21+30
assert.match(await a.locator('.rec').textContent(), /הכי משתלם: רמי לוי[\s\S]*₪48[\s\S]*זול ב-₪3 משופרסל[\s\S]*מוצר אחד לא נמצא/);
assert.match(await a.locator('.checked').textContent(), /נבדק עכשיו/);
// תיבת ההוראה ל-Claude in Chrome: רשת אחת (רמי לוי 100 מול חצי חינם 102), עם המוצרים המדויקים
assert.match(await a.locator('.claude').textContent(), /הזמנה אחת ברמי לוי/);
const prompt = await a.locator('textarea[data-prompt="rami"]').inputValue();
assert.match(prompt, /rami-levy\.co\.il[\s\S]*אל תסיים את ההזמנה ואל תשלם[\s\S]*ביצים L rami – כמות 2[\s\S]*טופו rami – כמות 1[\s\S]*במבה – כמות 1 \(לא נמצא בהשוואה/);
await a.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await a.locator('[data-copy-prompt="rami"]').click();
assert.equal(await a.evaluate(() => navigator.clipboard.readText()), prompt);
// פיצול: רק כשזה חוסך יותר מהמשלוח הנוסף
const split = await a.evaluate(async () => {
  const { orderPlan, CHAINS } = await import('./app.js');
  const cell = (n, total) => ({ name: n, total });
  const row = (id, sh, ra) => ({ item: { id, name: id, qty: 1 }, cells: { shufersal: sh && cell(id + '-sh', sh), rami: ra && cell(id + '-ra', ra) } });
  const b = { rows: [row('x', 100, 160), row('y', 160, 100)] };
  const p1 = orderPlan(b, { shufersal: 30, rami: 30, carrefour: 30, hazi: 30 });
  const p2 = orderPlan({ rows: [row('x', 100, 104), row('y', 104, 100)] }, { shufersal: 30, rami: 30, carrefour: 30, hazi: 30 });
  return [p1.chains.map(c => c.id).join('+'), Math.round(p1.saving), p2.chains.length];
});
assert.deepEqual(split, ['rami+shufersal', 30, 1]);
// ביצים ×2: הזול בשורה חצי חינם 50
const eggs = a.locator('tr', { hasText: 'ביצים' });
assert.match(await eggs.locator('td.min').textContent(), /₪50/);
assert.match(await eggs.locator('td').nth(2).textContent(), /לא נמצא/);
// מבצע ומחיר ליחידה בתא
const tofuHazi = a.locator('tr', { hasText: 'טופו' }).locator('td').nth(3);
assert.match(await tofuHazi.textContent(), /₪4\.33 ל-100 גרם[\s\S]*2 ב-22/);
assert.match(await a.locator('tr', { hasText: 'במבה' }).textContent(), /לא נמצא/);
assert.ok(await a.locator('tr', { hasText: 'טופו' }).locator('.art.img img').count(), 'store image used');
if (process.env.SHOTS) await a.screenshot({ path: `${process.env.SHOTS}/prices.png`, fullPage: true });
// בחירה ידנית של מוצר אחר
await a.locator('select[data-pref="tofu|shufersal"]').selectOption('משהו אחר');
assert.match(await a.locator('tr', { hasText: 'טופו' }).locator('td').first().textContent(), /₪1/);
assert.match(await a.locator('.rec').textContent(), /הכי משתלם: שופרסל/, 'manual ₪1 tofu makes Shufersal cheapest');
// המכשיר השני מקבל את ההשוואה בלי לחפש שוב
await b.getByRole('button', { name: /איפה זול/ }).click();
await b.locator('.rec').waitFor({ timeout: 15000 });
assert.equal(server.priceCalls.length, 4, 'second phone did not search again');
// שינוי ברשימה אחרי החיפוש מסומן
await a.getByRole('button', { name: /מה חסר/ }).click();
await a.click('[data-toggle="garlic"]');
await a.getByRole('button', { name: /איפה זול/ }).click();
assert.match(await a.locator('.checked').textContent(), /הרשימה השתנתה מאז/);
assert.match(await a.locator('main').textContent(), /מוצר אחד נוסף אחרי החיפוש: שום/);
await a.getByRole('button', { name: /חיפוש מחדש/ }).click();
await a.locator('.rec').waitFor();
assert.equal(server.priceCalls.length, 9);
// דמי משלוח מההגדרות
await a.getByRole('button', { name: /הגדרות/ }).click();
await a.locator('input[data-fee="rami"]').fill('0');
await a.locator('input[data-fee="rami"]').dispatchEvent('change');
await a.getByRole('button', { name: /איפה זול/ }).click();
assert.match(await a.locator('.chain.best').textContent(), /רמי לוי[\s\S]*₪18[\s\S]*\+ משלוח ₪0/);

// מצב קניות: מה שנכנס לסל מסומן, ובסוף מאשרים. המכשיר השני רואה שמישהו בקניות.
await a.getByRole('button', { name: /הרשימה/ }).click();
assert.equal(await count(a), '5');
await a.getByRole('button', { name: /אני בקניות/ }).click();
await a.locator('[data-cart="tofu"]').click();
await a.locator('li', { hasText: 'במבה' }).locator('[data-cart]').click();
assert.match(await a.locator('.shop-hero').textContent(), /2 בסל · 3 נשארו/);
if (process.env.SHOTS) await a.screenshot({ path: `${process.env.SHOTS}/shopping.png`, fullPage: true });
await b.getByRole('button', { name: /מה חסר/ }).click();
await b.locator('.banner', { hasText: 'יובל בקניות עכשיו' }).waitFor({ timeout: 15000 });
await a.getByRole('button', { name: /סיום קניות \(2\)/ }).click();
await a.locator('#sheet').getByRole('button', { name: 'אישור – קניתי' }).click();
await waitCount(a, '3');
assert.equal(await a.locator('[data-toggle]', { hasText: 'במבה' }).count(), 0, 'one-time product is gone after buying');
const tofuHist = await a.evaluate(() => JSON.parse(localStorage.getItem('shop-state-v2')).items.tofu.hist.length);
assert.ok(tofuHist > 5, 'purchase recorded in the history');
await b.locator('.banner', { hasText: 'בקניות עכשיו' }).waitFor({ state: 'detached', timeout: 15000 });

// משלוח: מתי מגיע, מה בהזמנה; תזכורת ב-20:00 באותו יום לבדוק שהגיע הכול
await a.getByRole('button', { name: /הזמנתי משלוח/ }).click();
const dl = a.locator('#sheet');
await dl.locator('input[name=date]').fill('2026-10-13');
await dl.locator('input[name=time]').fill('12:00');
await dl.locator('label', { hasText: 'שום' }).locator('input').uncheck();
if (process.env.SHOTS) await a.screenshot({ path: `${process.env.SHOTS}/delivery.png` });
await dl.getByRole('button', { name: 'שמירה' }).click();
await dl.getByRole('heading', { name: /המשלוח נשמר/ }).waitFor();
const gcal = await dl.getByRole('link', { name: 'יומן Google' }).getAttribute('href');
assert.ok(gcal.includes('dates=20261013T170000Z/20261013T171500Z'), 'reminder at 20:00 Israel time: ' + gcal);
await dl.getByRole('button', { name: 'סגירה' }).click();
await waitCount(a, '1');
assert.match(await a.locator('.order').textContent(), /היום ב-12:00[\s\S]*ביצים/);
await a.getByRole('button', { name: /מה חסר/ }).click();
assert.ok(await a.locator('[data-toggle="eggs"] .truck').count(), 'ordered items marked on the tile');
assert.equal(await a.locator('.banner.warn').count(), 0, 'no check before 20:00');
await a.context().clock.setFixedTime(new Date('2026-10-13T20:05:00+03:00'));
await a.locator('.banner.warn', { hasText: 'הגיע כמו שהוזמן' }).waitFor({ timeout: 15000 });
await a.locator('.banner.warn').getByRole('button', { name: 'בדיקה' }).click();
await dl.locator('label', { hasText: 'ביצים' }).locator('input').uncheck();
await dl.locator('input[name=changes]').fill('הביאו שרי בקופסה אחרת');
await dl.getByRole('button', { name: 'אישור' }).click();
await waitCount(a, '2');
assert.equal(await a.locator('.banner.warn').count(), 0);
await a.getByRole('button', { name: /הרשימה/ }).click();
assert.match(await a.locator('li', { hasText: 'ביצים' }).textContent(), /לא הגיע במשלוח/);
await a.getByRole('button', { name: /הגדרות/ }).click();
assert.match(await a.locator('.card', { hasText: 'משלוחים אחרונים' }).textContent(), /לא הגיעו: ביצים[\s\S]*הביאו שרי/);

// קניתי בלי האפליקציה: מצלמים את הקבלה, Claude מזהה מה נקנה, מאשרים
const milkHist = await a.evaluate(() => JSON.parse(localStorage.getItem('shop-state-v2')).items.milk.hist.length);
await a.getByRole('button', { name: /הרשימה/ }).click();
await a.locator('input[data-scan-free]').setInputFiles({ name: 'kabala.png', mimeType: 'image/png', buffer: PNG });
await dl.getByRole('heading', { name: /מה נקנה · רמי לוי/ }).waitFor();
const scanReq = server.scanCalls[0];
assert.equal(scanReq.model, 'claude-opus-5'); assert.equal(scanReq.output_config.format.type, 'json_schema');
assert.equal(scanReq.messages[0].content[0].type, 'image');
assert.match(scanReq.messages[0].content.at(-1).text, /eggs: ביצים/);
assert.match(await dl.textContent(), /ביצים ×2 · ₪50[\s\S]*חלב · ₪6\.9[\s\S]*שורות שלא התאימו/);
await dl.getByRole('button', { name: 'אישור' }).click();
await waitCount(a, '1');
const st = await a.evaluate(() => JSON.parse(localStorage.getItem('shop-state-v2')).items);
assert.equal(st.milk.hist.length, milkHist + 1, 'milk recorded as bought even though it was not on the list');
assert.deepEqual(st.eggs.prices.at(-1).v, 25); assert.equal(st.eggs.prices.at(-1).store, 'רמי לוי');
// מחיר אחרון מהקבלה מופיע בעריכת המוצר
await a.getByRole('button', { name: /מה חסר/ }).click();
await a.click('[data-toggle="eggs"]');
await waitCount(a, '2');
await a.getByRole('button', { name: /הרשימה/ }).click();
await a.locator('li', { hasText: 'ביצים' }).getByRole('button', { name: 'עריכה' }).click();
assert.match(await a.locator('#editor').textContent(), /🧾 ₪25 ברמי לוי/);
await a.locator('#editor').getByRole('button', { name: 'ביטול' }).click();
await a.getByRole('button', { name: /מה חסר/ }).click();

// מוצר לפארם: נרשם תחת "פארם" ולא נכנס להשוואת המחירים ברשתות
await a.getByRole('button', { name: /מה חסר/ }).click();
await a.fill('#q', 'אקמול');
await a.keyboard.press('Enter');
assert.equal(await a.locator('#editor select[name=cat]').inputValue(), 'pantry');
await a.locator('#editor select[name=cat]').selectOption('pharm');
await a.locator('#editor .seg label', { hasText: 'קבוע' }).click();
await a.locator('#editor').getByRole('button', { name: 'שמירה' }).click();
await waitCount(a, '3');
await a.getByRole('button', { name: /הרשימה/ }).click();
assert.match(await a.locator('main').textContent(), /🛒 סופר[\s\S]*💊 פארם[\s\S]*אקמול/);
assert.match(await a.locator('li', { hasText: 'אקמול' }).textContent(), /הוסיף\/ה: יובל/);
await a.getByRole('button', { name: /איפה זול/ }).click();
assert.match(await a.locator('[data-compare]').textContent(), /ל-2 מוצרים/, 'pharmacy items are not compared');

// עריכה ומחיקה, והחזרה מההגדרות
await a.getByRole('button', { name: /הרשימה/ }).click();
await a.locator('li', { hasText: 'שום' }).getByRole('button', { name: 'עריכה' }).click();
await a.locator('#editor').getByRole('button', { name: 'מחיקה' }).click();
await waitCount(a, '2');
await a.getByRole('button', { name: /הגדרות/ }).click();
await a.locator('details summary').click();
await a.getByRole('button', { name: 'החזרה' }).click();
assert.ok(await a.locator('.compact li', { hasText: 'שום' }).count());
// שרת לא זמין: האפליקציה ממשיכה לעבוד מהטלפון
await a.context().unroute('https://shopping123.yuvsaadon.workers.dev/**');
await a.context().route('https://shopping123.yuvsaadon.workers.dev/**', r => r.abort());
await a.getByRole('button', { name: /מה חסר/ }).click();
await a.click('[data-toggle="mushrooms"]');
await a.waitForFunction(() => document.querySelector('#sync').dataset.s === 'off');
assert.equal(await count(a), '3');
if (process.env.SHOTS) for (const v of ['home', 'list', 'settings']) { await b.evaluate((v) => document.querySelector(`nav [data-v="${v}"]`).click(), v); await b.waitForTimeout(300); await b.screenshot({ path: `${process.env.SHOTS}/${v}.png`, fullPage: true }); }
// אם השרת פעיל בשם shopping (ולא kniyot), האפליקציה מוצאת אותו לבד
const c = await phone('יעל');
await c.context().unroute('https://shopping123.yuvsaadon.workers.dev/**');
await c.context().route('https://shopping123.yuvsaadon.workers.dev/**', r => r.abort());
await c.context().route('https://shopping.yuvsaadon.workers.dev/**', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/ping') return route.fulfill({ json: { ok: true, kv: true }, headers: { 'access-control-allow-origin': '*' } });
  return route.fulfill({ json: { ...(server.list || {}), compareAt: 0 }, headers: { 'access-control-allow-origin': '*' } });
});
await c.goto(BASE);
await c.waitForFunction(() => document.querySelector('#sync').dataset.s === 'ok', null, { timeout: 20000 });
assert.equal(await c.evaluate(() => localStorage.getItem('shop-server')), 'https://shopping.yuvsaadon.workers.dev');
assert.deepEqual(errors, []);
await browser.close();
http.close();
console.log('app: ok');
