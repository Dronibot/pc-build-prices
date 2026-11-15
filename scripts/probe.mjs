#!/usr/bin/env node
// Перевірка, які магазини віддають ціну звичайним запитом з поточної машини (локально або на GitHub Actions).
//   node scripts/probe.mjs scripts/probe-urls.txt      — файл: по одному URL на рядок, # коментарі
//   node scripts/probe.mjs <url> [<url> …]              — або URL аргументами
// Для кожного URL: «OK|FAIL магазин ціна валюта url | помилка», наприкінці — JSON-підсумок.
// Пауза між запитами ≥1 с (до одного сайту — ≥2 с). Без залежностей.
import fs from 'node:fs';
import { fetchPrice, shopOf } from './sources.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readUrls(args) {
  const out = [];
  for (const a of args) {
    if (/^https?:\/\//i.test(a)) { out.push(a); continue; }
    if (!fs.existsSync(a)) { console.error(`Не знайдено файл або це не URL: ${a}`); process.exit(2); }
    for (const line of fs.readFileSync(a, 'utf8').split(/\r?\n/)) {
      const s = line.replace(/\s#.*$/, '').trim();
      if (!s || s.startsWith('#')) continue;
      const u = s.split(/\s+/).find(x => /^https?:\/\//i.test(x));
      if (u) out.push(u);
    }
  }
  return [...new Set(out)];
}

const kind = e => e.blocked ? 'blocked' : e.gone ? 'gone' : e.noOffers ? 'no-offers'
  : (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout'
  : /fetch failed/i.test(e.message) ? 'network' : 'error';

const errText = e => {
  let m = e.message || String(e);
  const c = e.cause?.code || e.cause?.message;
  if (c && !m.includes(c)) m += ` (${c})`;
  return m.replace(/\s+/g, ' ').slice(0, 200);
};

const urls = readUrls(process.argv.slice(2));
if (!urls.length) { console.error('Використання: node scripts/probe.mjs <файл-з-URL | URL …>'); process.exit(2); }

const results = [];
const lastHit = new Map();
for (const url of urls) {
  let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
  const wait = Math.max(1000, (lastHit.get(host) ?? 0) + 2000 - Date.now());
  if (results.length) await sleep(wait);
  const shop = shopOf(url).name;
  const t0 = Date.now();
  try {
    const r = await fetchPrice(url);
    results.push({ ok: true, shop: r.shop || shop, price: r.price, currency: r.currency, available: r.available, title: r.title, url, ms: Date.now() - t0 });
    console.log(`OK   ${(r.shop || shop).padEnd(22)} ${String(r.price).padStart(9)} ${String(r.currency).padEnd(3)} ${url}`);
  } catch (e) {
    results.push({ ok: false, shop, kind: kind(e), error: errText(e), url, ms: Date.now() - t0 });
    console.log(`FAIL ${shop.padEnd(22)} ${'-'.padStart(9)} ${'-'.padEnd(3)} ${url} | ${errText(e)}`);
  }
  lastHit.set(host, Date.now());
}

const byShop = {};
for (const r of results) {
  const s = (byShop[r.shop] ||= { ok: 0, fail: 0, kinds: {}, errors: [] });
  if (r.ok) s.ok++; else { s.fail++; s.kinds[r.kind] = (s.kinds[r.kind] || 0) + 1; if (!s.errors.includes(r.error)) s.errors.push(r.error); }
}
const summary = {
  date: new Date().toISOString(),
  runner: process.env.GITHUB_ACTIONS ? `github-actions (${process.env.RUNNER_OS || '?'})` : 'local',
  node: process.version,
  total: results.length, ok: results.filter(r => r.ok).length, fail: results.filter(r => !r.ok).length,
  shopsOk: Object.keys(byShop).filter(k => byShop[k].ok > 0).sort(),
  shopsFail: Object.keys(byShop).filter(k => byShop[k].ok === 0).sort(),
  byShop, results,
};
console.log('\n' + JSON.stringify(summary, null, 2));

// На GitHub Actions — ще й таблиця в Summary
if (process.env.GITHUB_STEP_SUMMARY) {
  const esc = s => String(s ?? '').replace(/\|/g, '\\|');
  const md = ['| | Магазин | Ціна | URL / помилка |', '|---|---|---|---|',
    ...results.map(r => `| ${r.ok ? '✅' : '⛔'} | ${esc(r.shop)} | ${r.ok ? `${r.price} ${r.currency}` : esc(r.kind)} | ${esc(r.url)}${r.ok ? '' : ' — ' + esc(r.error)} |`)];
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Probe: ${summary.ok}/${summary.total} OK\n\n${md.join('\n')}\n`); } catch { }
}
