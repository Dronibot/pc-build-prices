// Оновлення цін: читає data/config.json + data/overrides.json,
// перевіряє кожне посилання, бере пропозиції магазинів з доставкою в DE з Geizhals, пише data/prices.json і data/history.json.
// Geizhals блокує IP дата-центрів (GitHub Actions) — тоді лишаються останні відомі дані (stale).
import fs from 'fs';
import { fetchPrice, shopOf, get } from './sources.mjs';
import { geizhalsProduct } from './geizhals.mjs';
const isGh = u => /^https:\/\/(www\.)?geizhals\.(de|at|eu)\//.test(u);

const D = new URL('../data/', import.meta.url);
const rd = (f, def) => { try { return JSON.parse(fs.readFileSync(new URL(f, D), 'utf8')); } catch { return def; } };
const wr = (f, v) => fs.writeFileSync(new URL(f, D), JSON.stringify(v, null, 1) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const config = rd('config.json');
const overrides = rd('overrides.json', {});
const prev = rd('prices.json', { items: {} });
const history = rd('history.json', {});
const now = new Date().toISOString();
const ONLY = process.argv.includes('--only-overrides');

// 1) Курс НБУ
async function rates() {
  const out = {};
  for (const cc of ['EUR', 'USD']) {
    try {
      const { text } = await get(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${cc}&json`);
      const j = JSON.parse(text)[0]; out[cc] = j.rate; out.date = j.exchangedate;
    } catch (e) { console.warn('НБУ', cc, e.message); }
  }
  return out.EUR ? out : prev.rates;
}

// 2) Збираємо всі посилання
const jobs = new Map(); // url -> {kind}
const searches = new Set();
const add = (url, kind) => { if (url && /^https?:\/\//.test(url) && !jobs.has(url)) jobs.set(url, { kind }); };
for (const b of config.builds) {
  for (const p of b.parts) {
    if (!ONLY) { add(p.shop, 'shop'); add(p.geizhals, 'geizhals'); }
    const o = overrides[b.id]?.[p.id];
    if (o) { add(o.url, 'override'); }
  }
}

const items = ONLY ? { ...prev.items } : {};
function record(url, res) {
  const old = prev.items?.[url];
  const h = history[url] || (history[url] = []);
  if (res.ok) {
    const last = h[h.length - 1];
    if (!last || last[1] !== res.price) h.push([now, res.price]);
    if (h.length > 300) h.splice(0, h.length - 300);
  }
  // зміна ціни: останнє значення, що відрізняється від поточного
  let change = null;
  const cur = res.ok ? res.price : old?.price;
  if (cur != null && h.length) {
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i][1] !== cur) { change = { from: h[i][1], to: cur, since: h[i + 1]?.[0] || now }; break; }
    }
  }
  if (!res.ok && res.blocked && old?.ok && Date.now() - Date.parse(old.checkedAt) < 12 * 3600e3) {
    items[url] = { ...old, lastAttemptError: res.error, lastAttemptAt: now }; return;
  }
  items[url] = res.ok
    ? { ...res, ok: true, checkedAt: now, priceSince: h[h.length - 1]?.[0] || now, change }
    : { ok: false, error: res.error, blocked: !!res.blocked, gone: !!res.gone, noOffers: !!res.noOffers, checkedAt: now, shop: shopOf(url).name,
        // остання відома ціна, якщо колись вдавалося
        last: old?.ok ? { ...old, change: undefined } : old?.last ?? null,
        lastPrice: old?.ok ? old.price : old?.lastPrice ?? null, currency: old?.currency ?? null, lastOkAt: old?.ok ? old.checkedAt : old?.lastOkAt ?? null, change };
}

const R = await rates();
let i = 0;
for (const [url, j] of jobs) {
  i++;
  // Geizhals блокує сервери GitHub — там його не чіпаємо, лишаємо дані з домашнього запуску
  if (isGh(url) && (process.env.GITHUB_ACTIONS || process.env.SKIP_GEIZHALS) && prev.items?.[url]) {
    items[url] = prev.items[url]; console.log(`↷ ${i}/${jobs.size} Geizhals пропущено (сервер GitHub) ${url.slice(0, 70)}`); continue;
  }
  try {
    const r = isGh(url) ? await geizhalsProduct(url) : await fetchPrice(url);
    record(url, { ...r, ok: true, kind: j.kind });
    console.log(`✓ ${i}/${jobs.size} ${r.shop} ${r.price} ${r.currency} ${url.slice(0, 80)}`);
  } catch (e) {
    record(url, { ok: false, error: e.message, blocked: e.blocked, gone: e.gone, noOffers: e.noOffers });
    console.log(`✗ ${i}/${jobs.size} ${e.message} ${url.slice(0, 80)}`);
  }
  await sleep(1200);
}

// 3) Кандидати для заміни: схожі моделі зі сторінок Geizhals (поточні + збережені раніше)
const candidates = {};
for (const b of config.builds) for (const p of b.parts) {
  const key = p.search || p.id; const list = candidates[key] || (candidates[key] = []);
  for (const u of [p.geizhals, p.shop, overrides[b.id]?.[p.id]?.url]) {
    const it = items[u]; const src = it?.ok ? it : it?.last;
    if (src?.title && src.min && isGh(u) && !list.some(x => x.url === u)) list.push({ title: src.title, url: u, min: src.min, max: src.max, offers: src.offerCount, vendor: '' });
    for (const v of src?.variants || []) if (!list.some(x => x.url === v.url)) list.push(v);
  }
}
for (const [k, list] of Object.entries(prev.candidates || {})) {
  const cur = candidates[k] || (candidates[k] = []);
  if (!cur.length) cur.push(...list.filter(x => /geizhals/.test(x.url)));
}
for (const k in candidates) candidates[k].sort((a, b) => a.min - b.min);
const autoMatch = {};

const okCount = Object.values(items).filter(x => x.ok).length;
const byShop = {};
for (const [u, it] of Object.entries(items)) {
  const s = shopOf(u).name; byShop[s] ||= { ok: 0, fail: 0, error: null };
  if (it.ok) byShop[s].ok++; else { byShop[s].fail++; byShop[s].error = it.error; }
}
wr('prices.json', { updatedAt: now, rates: R, items, candidates, autoMatch, stats: { total: Object.keys(items).length, ok: okCount, byShop } });
wr('history.json', history);
console.log(`Готово: ${okCount}/${Object.keys(items).length} цін, курс EUR ${R?.EUR}`);
