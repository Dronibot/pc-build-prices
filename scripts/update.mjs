// Оновлення цін: читає data/config.json + data/overrides.json,
// перевіряє кожне посилання, шукає ті самі деталі на Hotline.ua, пише data/prices.json і data/history.json.
import fs from 'fs';
import { fetchPrice, hotlineSearch, shopOf, get } from './sources.mjs';

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
    if (!ONLY) { add(p.shop, 'shop'); add(p.geizhals, 'geizhals'); add(p.hotline, 'hotline'); }
    if (p.search) searches.add(p.search);
    const o = overrides[b.id]?.[p.id];
    if (o) { add(o.url, 'override'); add(o.hotline, 'hotline'); }
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
  items[url] = res.ok
    ? { ...res, ok: true, checkedAt: now, priceSince: h[h.length - 1]?.[0] || now, change }
    : { ok: false, error: res.error, blocked: !!res.blocked, gone: !!res.gone, checkedAt: now, shop: shopOf(url).name,
        // остання відома ціна, якщо колись вдавалося
        lastPrice: old?.ok ? old.price : old?.lastPrice ?? null, currency: old?.currency ?? null, lastOkAt: old?.ok ? old.checkedAt : old?.lastOkAt ?? null, change };
}

const R = await rates();
let i = 0;
for (const [url, j] of jobs) {
  i++;
  try {
    const r = await fetchPrice(url);
    record(url, { ...r, ok: true, kind: j.kind });
    console.log(`✓ ${i}/${jobs.size} ${r.shop} ${r.price} ${r.currency} ${url.slice(0, 80)}`);
  } catch (e) {
    record(url, { ok: false, error: e.message, blocked: e.blocked, gone: e.gone });
    console.log(`✗ ${i}/${jobs.size} ${e.message} ${url.slice(0, 80)}`);
  }
  await sleep(1200);
}

// 3) Кандидати для заміни (пошук на Hotline за категорією)
const candidates = ONLY ? (prev.candidates || {}) : {};
if (!ONLY) for (const q of searches) {
  try {
    candidates[q] = (await hotlineSearch(q)).filter(x => x.min).slice(0, 12);
    console.log(`🔎 ${q}: ${candidates[q].length}`);
  } catch (e) { candidates[q] = prev.candidates?.[q] || []; console.log(`🔎✗ ${q}: ${e.message}`); }
  await sleep(1200);
}

// 4) Автопідбір Hotline для власних посилань без hotline-відповідника
const norm = s => (s || '').toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi, ' ').split(' ').filter(w => w.length > 1);
const autoMatch = ONLY ? { ...(prev.autoMatch || {}) } : {};
for (const b of config.builds) for (const p of b.parts) {
  const o = overrides[b.id]?.[p.id];
  if (!o || o.hotline || /hotline\.ua/.test(o.url)) continue;
  const q = o.name || items[o.url]?.title; if (!q) continue;
  try {
    const res = await hotlineSearch(q.slice(0, 80));
    const qa = new Set(norm(q));
    let best = null, bs = 0;
    for (const c of res.slice(0, 8)) {
      const t = norm(c.title); const hit = t.filter(w => qa.has(w)).length / Math.max(t.length, 1);
      if (hit > bs && c.min) { bs = hit; best = c; }
    }
    if (best && bs >= 0.5) {
      autoMatch[o.url] = { ...best, score: Math.round(bs * 100) / 100 };
      const r = await fetchPrice(best.url).catch(() => null);
      if (r) record(best.url, { ...r, ok: true, kind: 'hotline' });
    } else delete autoMatch[o.url];
  } catch (e) { console.log('автопідбір ✗', q, e.message); }
  await sleep(1200);
}

const okCount = Object.values(items).filter(x => x.ok).length;
const byShop = {};
for (const [u, it] of Object.entries(items)) {
  const s = shopOf(u).name; byShop[s] ||= { ok: 0, fail: 0, error: null };
  if (it.ok) byShop[s].ok++; else { byShop[s].fail++; byShop[s].error = it.error; }
}
wr('prices.json', { updatedAt: now, rates: R, items, candidates, autoMatch, stats: { total: Object.keys(items).length, ok: okCount, byShop } });
wr('history.json', history);
console.log(`Готово: ${okCount}/${Object.keys(items).length} цін, курс EUR ${R?.EUR}`);
