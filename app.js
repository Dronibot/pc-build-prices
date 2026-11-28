'use strict';
// Ціни на збірку ПК — статичний фронтенд (без збірки й залежностей).
// Дані: data/config.json, data/prices.json, data/overrides.json (генерує робот).
// Головна валюта — €, ₴ лише довідково за курсом НБУ.

const REPO = 'Dronibot/pc-build-prices';
const LS_KEY = 'pcb-overrides-v1';
const LS_TAB = 'pcb-tab-v1';
const RELOAD_MS = 5 * 60 * 1000;           // перечитувати дані
const ROBOT_EVERY_MS = 2 * 60 * 60 * 1000; // робот оновлює ціни кожні ~2 год
const TOP_OFFERS = 8;

const S = {
  config: null, prices: null, server: {}, local: lsGet(LS_KEY, {}),
  tab: lsGet(LS_TAB, 'user'), error: null, loadedAt: null, loading: false,
  open: new Set(), // відкриті <details> (топ магазинів)
};

/* ---------- утиліти ---------- */
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватний режим */ } }

// Безпечне створення елементів: дані лише через textContent / атрибути.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
function safeUrl(u) {
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
function link(href, text, cls) {
  const u = safeUrl(href);
  if (!u) return h('span', { class: cls }, text);
  return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
const isGeizhals = u => /(^|\.)geizhals\.(de|at|eu)$/i.test(host(u));
const sameUrl = (a, b) => !!a && !!b && String(a).trim() === String(b).trim();

const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = n => typeof n === 'number' && isFinite(n);
const uah = n => num(n) ? nf0.format(Math.round(n)) + ' ₴' : '—';
const eur = n => num(n) ? nf2.format(n) + ' €' : '—';
function money(n, cur) {
  if (!num(n)) return '—';
  if (cur === 'UAH') return uah(n);
  if (cur === 'USD') return nf2.format(n) + ' $';
  return eur(n);
}
function rate(cur) { if (cur === 'UAH') return 1; const r = S.prices?.rates?.[cur || 'EUR']; return num(r) ? r : null; }
function toUAH(n, cur) { const r = rate(cur); return num(n) && r ? n * r : null; }
function toEUR(n, cur) { if (!num(n)) return null; if (!cur || cur === 'EUR') return n; const u = toUAH(n, cur), r = rate('EUR'); return u != null && r ? u / r : null; }
// Довідковий еквівалент у гривнях — дрібно сірим
const uahHint = e => { const u = toUAH(e, 'EUR'); return u != null ? h('span', { class: 'uah' }, ' ≈ ' + uah(u)) : null; };

function rel(iso) {
  const t = Date.parse(iso); if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  const hr = Math.floor(m / 60);
  if (hr < 48) return `${hr} год ${m % 60 ? (m % 60) + ' хв ' : ''}тому`;
  return `${Math.floor(hr / 24)} дн тому`;
}
function until(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} хв`;
  return `${Math.floor(m / 60)} год${m % 60 ? ' ' + (m % 60) + ' хв' : ''}`;
}
function dt(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
function dShort(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
}
// Відносний час, який оновлюється щохвилини без перерендеру.
const relEl = (prefix, iso, cls = 'muted small') => iso ? h('span', { class: cls + ' rel', 'data-ts': iso, 'data-prefix': prefix, title: dt(iso) }, prefix + rel(iso)) : null;
function tickRel() { document.querySelectorAll('.rel[data-ts]').forEach(el => { el.textContent = el.dataset.prefix + rel(el.dataset.ts); }); }

/* ---------- дані ---------- */
async function getJSON(path, optional) {
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${r.status}`); }
  return r.json();
}

async function load() {
  if (S.loading) return;
  S.loading = true; setReloadBusy(true);
  try {
    const [config, prices, server] = await Promise.all([
      getJSON('data/config.json'),
      getJSON('data/prices.json', true).catch(() => null),
      getJSON('data/overrides.json', true).catch(() => null),
    ]);
    S.config = config; S.prices = prices; S.server = server && typeof server === 'object' ? server : {};
    S.error = null; S.loadedAt = new Date().toISOString();
    reconcile();
  } catch (e) {
    S.error = e.message || String(e);
  } finally {
    S.loading = false; setReloadBusy(false);
    render();
  }
}
function setReloadBusy(b) { const btn = document.getElementById('reload'); btn.disabled = b; btn.textContent = b ? 'Завантаження…' : 'Перечитати дані'; }

const item = url => (url && S.prices?.items?.[url]) || null;
const validServer = o => o && typeof o === 'object' && o.url && o.url !== 'reset';

// Локальна заміна, що збігається із серверною, більше не потрібна.
function reconcile() {
  let changed = false;
  for (const [bid, parts] of Object.entries(S.local)) {
    for (const [pid, lo] of Object.entries(parts || {})) {
      const so = S.server?.[bid]?.[pid];
      if (validServer(so) && sameUrl(so.url, lo.url)) { delete parts[pid]; changed = true; }
    }
    if (!Object.keys(parts || {}).length) { delete S.local[bid]; changed = true; }
  }
  if (changed) lsSet(LS_KEY, S.local);
}
function ovOf(bid, pid) {
  const lo = S.local?.[bid]?.[pid];
  const so = S.server?.[bid]?.[pid];
  if (lo) return { ...lo, from: 'local', server: validServer(so) ? so : null };
  if (validServer(so)) return { ...so, from: 'server' };
  return null;
}
function setLocal(bid, pid, ov) {
  S.local[bid] ||= {};
  if (ov) S.local[bid][pid] = ov; else delete S.local[bid][pid];
  if (!Object.keys(S.local[bid]).length) delete S.local[bid];
  lsSet(LS_KEY, S.local);
  render();
}

/* ---------- ціни ---------- */
// Geizhals: актуальні дані або останні успішні (last), якщо сервер заблоковано.
function gz(url) {
  const it = item(url);
  if (!it) return { it: null, d: null, stale: false };
  if (it.ok) return { it, d: it, stale: false };
  if (!it.noOffers && it.last && num(it.last.min ?? it.last.price)) return { it, d: it.last, stale: true };
  return { it, d: null, stale: false };
}
const gzMin = d => d ? (num(d.min) ? d.min : num(d.price) ? d.price : null) : null;
const gzOffers = d => (Array.isArray(d?.offers) ? d.offers : []).filter(o => o && num(o.price));

// Ціна заміни, €
function ovPrice(ov) {
  if (isGeizhals(ov.url)) {
    const { d, stale } = gz(ov.url);
    if (gzMin(d) != null) return { eur: gzMin(d), src: stale ? 'stale' : 'gz' };
    if (num(ov.min)) return { eur: ov.min, src: 'candidate' };
    return null;
  }
  const it = item(ov.url);
  if (it?.ok && num(it.price)) { const e = toEUR(it.price, it.currency || 'EUR'); if (e != null) return { eur: e, src: 'link' }; }
  if (num(ov.min)) return { eur: ov.min, src: 'candidate' };
  return null;
}
// «Зараз мінімум у DE» для деталі, €
function nowPrice(part, ov) {
  if (ov) { const p = ovPrice(ov); return p ? { ...p, replaced: true } : null; }
  const { d, stale } = gz(part.geizhals);
  if (gzMin(d) != null) return { eur: gzMin(d), src: stale ? 'stale' : 'gz' };
  if (num(part.sheet?.internet)) return { eur: part.sheet.internet, src: 'sheet' };
  return null;
}
// Ціна оригінального магазину з таблиці: жива або з таблиці
function shopPrice(part) {
  if (part.shop && !sameUrl(part.shop, part.geizhals)) {
    const it = item(part.shop);
    if (it?.ok && num(it.price)) { const e = toEUR(it.price, it.currency || 'EUR'); if (e != null) return { eur: e, live: true, name: it.shop || host(part.shop) }; }
  }
  if (num(part.sheet?.internet)) return { eur: part.sheet.internet, live: false, name: item(part.shop)?.shop || host(part.shop) };
  return null;
}

function totals(build, withOv) {
  const t = { now: 0, miss: 0, src: {}, n: build.parts.length, ovCount: 0 };
  for (const p of build.parts) {
    const ov = withOv ? ovOf(build.id, p.id) : null;
    if (ov) t.ovCount++;
    const np = nowPrice(p, ov);
    if (np) { t.now += np.eur; const k = np.replaced ? 'replaced' : np.src; t.src[k] = (t.src[k] || 0) + 1; } else t.miss++;
  }
  return t;
}
// Збірки-«списки» (таблиця, PCPartPicker): мають ціни зі списку й оригінальні магазини
const isList = b => b.id === 'user' || b.kind === 'list';
const LBL = { from: 'з таблиці', in: 'У таблиці', with: 'з таблицею', shop: CUR.shop };
let CUR = LBL; // підписи поточної збірки під час рендеру
const lbl = b => ({ ...LBL, ...(b?.labels || {}) });
function sheetTotals(build) {
  const st = build.sheetTotals || {};
  const sum = k => build.parts.reduce((a, p) => a + (num(p.sheet?.[k]) ? p.sheet[k] : 0), 0);
  return { internet: num(st.internet) ? st.internet : sum('internet'), pcpp: num(st.pcpp) ? st.pcpp : num(st.chooseYourParts) ? st.chooseYourParts : sum('pcpp') };
}
const signedEur = d => `${d > 0 ? '+' : d < 0 ? '−' : ''}${eur(Math.abs(d))}`;

/* ---------- рендер: шапка ---------- */
function renderMeta() {
  const meta = document.getElementById('meta');
  const P = S.prices;
  const rows = [];
  if (P?.updatedAt) {
    rows.push(h('span', null, 'Оновлено ', relEl('', P.updatedAt, 'strong'), h('span', { class: 'muted' }, ` (${dt(P.updatedAt)})`)));
    const next = Date.parse(P.updatedAt) + ROBOT_EVERY_MS - Date.now();
    rows.push(h('span', { class: 'muted' }, next > 0 ? `Наступне ≈ через ${until(next)}` : next > -30 * 60000 ? 'Наступне оновлення ≈ зараз' : 'Наступне оновлення затримується'));
  } else rows.push(h('span', { class: 'muted' }, S.config ? 'Ціни ще не зібрано' : 'Завантаження…'));
  if (num(P?.rates?.EUR)) rows.push(h('span', { class: 'muted' }, 'Курс НБУ: 1 € = ', nf2.format(P.rates.EUR) + ' ₴', P.rates.date ? ` (${P.rates.date})` : ''));
  if (P?.stats) rows.push(h('span', null, `Цін отримано: ${P.stats.ok ?? 0} з ${P.stats.total ?? 0}`));
  if (S.loadedAt) rows.push(relEl('Дані перечитано ', S.loadedAt));
  const metaKids = rows.map(r => h('span', { class: 'meta-item' }, r));
  const gzItems = Object.entries(P?.items || {}).filter(([u]) => isGeizhals(u)).map(([, it]) => it);
  if (gzItems.length && gzItems.every(it => !it.ok)) {
    metaKids.push(h('span', { class: 'meta-item meta-warn' }, 'Ціни Geizhals оновлюються з домашнього комп’ютера, сервер GitHub блокується'));
  }
  meta.replaceChildren(...metaKids);

  const shops = document.getElementById('shops');
  const by = P?.stats?.byShop || {};
  const names = Object.keys(by).sort((a, b) => (by[b].ok + by[b].fail) - (by[a].ok + by[a].fail));
  if (!names.length) { shops.replaceChildren(); return; }
  shops.replaceChildren(
    h('span', { class: 'muted small' }, 'Магазини:'),
    ...names.map(n => {
      const s = by[n]; const ok = s.ok || 0, fail = s.fail || 0;
      const st = fail === 0 ? 'ok' : ok === 0 ? 'bad' : 'part';
      const mark = st === 'ok' ? '✓' : st === 'bad' ? '✗' : `${ok}/${ok + fail}`;
      const tip = st === 'ok' ? `парситься: ${ok}` : `не вдалося: ${fail}${s.error ? ' — ' + s.error : ''}`;
      return h('span', { class: `chip chip-${st}`, title: tip }, n + ' ', h('b', null, mark));
    }),
  );
}

/* ---------- рендер: підсумки ---------- */
function totalRow(label, main, sub, cls) {
  return h('div', { class: 'trow' + (cls ? ' ' + cls : '') }, h('div', { class: 'tlabel' }, label), main ? h('div', { class: 'tval' }, main) : null, sub ? h('div', { class: 'tsub' }, sub) : null);
}
const eurMain = e => [h('strong', null, eur(e)), uahHint(e)];
const SRC = { gz: 'Geizhals', stale: 'Geizhals (застарілі)', sheet: 'з таблиці', replaced: 'заміни' };

function renderSummary() {
  const box = document.getElementById('summary');
  const cards = S.config.builds.map(b => {
    const t = totals(b, true), t0 = t.ovCount ? totals(b, false) : null;
    const rows = [];
    const srcText = Object.entries(t.src).map(([k, v]) => `${SRC[k] || k}: ${v}`).concat(t.miss ? [`без ціни: ${t.miss}`] : []).join(' · ');
    const warn = (t.src.sheet || t.src.stale || t.miss) ? h('span', { class: 'warn-text' }, 'Не всі ціни актуальні. ') : null;
    if (isList(b)) {
      const L = lbl(b); const st = sheetTotals(b);
      rows.push(totalRow(L.from[0].toUpperCase() + L.from.slice(1), eurMain(st.internet), `PCPartPicker: ${eur(st.pcpp)}`));
      const d = t.now - st.internet;
      rows.push(totalRow('Зараз мінімум у DE', eurMain(t.now), [warn, srcText], 'tmain'));
      rows.push(totalRow('Різниця ' + L.with, h('strong', { class: d > 0 ? 'up' : d < 0 ? 'down' : '' }, signedEur(d)), d > 0 ? 'зараз дорожче' : d < 0 ? 'зараз дешевше' : 'без змін'));
    } else {
      rows.push(totalRow('Мінімум у DE (Geizhals)', eurMain(t.now), [warn, srcText], 'tmain'));
    }
    if (t0) rows.push(totalRow(`Без замін (замінено: ${t.ovCount})`, null, eur(t0.now)));
    return h('article', { class: 'card tcard' + (S.tab === b.id ? ' sel' : '') },
      h('div', { class: 'tcard-head' }, h('h2', null, b.title),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': String(S.tab === b.id), onclick: () => selectTab(b.id, true) }, 'Деталі')),
      rows);
  });
  box.replaceChildren(...cards);
}

function renderCompare() {
  const box = document.getElementById('compare');
  const opts = [];
  for (const b of S.config.builds) {
    const t = totals(b, true);
    if (isList(b)) opts.push({ label: `${b.title} — ціни ${lbl(b).from}`, v: sheetTotals(b).internet });
    if (t.now > 0) opts.push({ label: isList(b) ? `${b.title} — зараз` : b.title, v: t.now, note: t.miss ? `без ціни: ${t.miss}` : '', incomplete: t.miss > 0 });
  }
  if (opts.length < 2) { box.replaceChildren(); return; }
  opts.sort((a, b) => a.v - b.v);
  const best = opts[0];
  box.replaceChildren(h('div', { class: 'card' },
    h('h2', null, 'Порівняння'),
    h('ol', { class: 'cmp' }, opts.map((o, i) => {
      const d = o.v - best.v, pct = best.v ? Math.round(d / best.v * 100) : 0;
      return h('li', { class: i === 0 ? 'best' : '' },
        h('span', { class: 'cmp-label' }, o.label, o.note ? h('span', { class: 'muted small' }, ' · ' + o.note) : null),
        h('span', { class: 'cmp-val' }, eur(o.v), uahHint(o.v)),
        h('span', { class: 'badge ' + (i === 0 ? 'badge-down' : 'badge-up') }, i === 0 ? 'найдешевше' : `+${eur(d)} (+${pct}%)`));
    })),
    h('p', { class: 'muted small' }, 'Без доставки.' + (opts.some(o => o.incomplete) ? ' Частина цін відсутня — порівняння приблизне.' : '')),
  ));
}

/* ---------- рендер: вкладки й деталі ---------- */
function selectTab(id, scroll) {
  S.tab = id; lsSet(LS_TAB, id); render();
  if (scroll) document.getElementById('tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderTabs() {
  const box = document.getElementById('tabs');
  if (!S.config.builds.some(b => b.id === S.tab)) S.tab = S.config.builds[0]?.id;
  box.replaceChildren(...S.config.builds.map(b => h('button', {
    type: 'button', role: 'tab', id: 'tab-' + b.id, class: 'tab', 'aria-selected': String(S.tab === b.id), tabindex: S.tab === b.id ? '0' : '-1',
    onclick: () => selectTab(b.id),
    onkeydown: e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const ids = S.config.builds.map(x => x.id); const i = ids.indexOf(S.tab);
      selectTab(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]);
      document.getElementById('tab-' + S.tab)?.focus();
    },
  }, b.title)));
}
function renderBuild() {
  const box = document.getElementById('build');
  const b = S.config.builds.find(x => x.id === S.tab);
  if (!b) { box.replaceChildren(); return; }
  box.setAttribute('aria-labelledby', 'tab-' + b.id);
  box.replaceChildren(b.note ? h('p', { class: 'note' }, b.note) : null, ...b.parts.map(p => renderPart(b, p)));
}

const cat = id => S.config.categories?.[id] || id;

function changeEl(it) {
  const c = it?.change;
  if (!c || !num(c.from) || !num(c.to) || c.from === c.to) return null;
  const d = c.to - c.from, cur = it.currency || 'EUR';
  const pct = c.from ? Math.abs(Math.round(d / c.from * 1000) / 10) : 0;
  return h('span', { class: 'chg ' + (d > 0 ? 'up' : 'down'), title: `було ${money(c.from, cur)}` },
    `${d > 0 ? '▲ +' : '▼ −'}${money(Math.abs(d), cur)} (${pct}%)`, c.since ? ` з ${dShort(c.since)}` : '');
}
function statusText(it) {
  if (!it) return 'ще не перевірено';
  if (it.noOffers) return 'наразі немає пропозицій у Німеччині';
  if (it.gone) return 'товар знято з продажу (404)';
  if (/timeout|abort|таймаут|тайм-аут/i.test(it.error || '')) return 'магазин не відповідає автоматичним запитам (тайм-аут)';
  if (it.blocked) return 'магазин блокує автоматичні запити';
  return 'не вдалося отримати ціну' + (it.error ? `: ${it.error}` : '');
}
function priceLine(price, cur) {
  const e = toEUR(price, cur);
  return h('div', { class: 'price' }, h('strong', null, money(price, cur)),
    cur && cur !== 'EUR' && e != null ? h('span', { class: 'approx' }, ' ≈ ' + eur(e)) : null,
    cur !== 'UAH' ? uahHint(e) : null);
}
function blk(label, ...kids) { return h('div', { class: 'blk' }, h('div', { class: 'blk-label' }, label), kids); }
function lastKnown(it) {
  if (!it || it.ok || !num(it.lastPrice)) return null;
  return h('div', { class: 'small' }, 'Остання відома: ', money(it.lastPrice, it.currency || 'EUR'), it.lastOkAt ? h('span', { class: 'muted' }, ` (${dShort(it.lastOkAt)})`) : null);
}
function checkedLine(it, chgSrc) {
  if (!it) return null;
  return h('div', { class: 'meta-line' }, changeEl(chgSrc || it), relEl('перевірено ', it.checkedAt));
}

// Блок «магазин / посилання» з ціною
function shopBlock(label, url, opts = {}) {
  const it = item(url);
  const name = it?.shop || host(url) || 'магазин';
  const kids = [];
  if (it?.ok && num(it.price)) {
    kids.push(priceLine(it.price, it.currency || 'EUR'));
    if (it.available === false) kids.push(h('span', { class: 'tag tag-warn' }, 'немає в наявності'));
  } else {
    kids.push(h('div', { class: 'status' + (it ? ' status-bad' : '') }, it ? statusText(it) : (opts.pending || 'ще не перевірено')));
    kids.push(lastKnown(it));
  }
  if (num(opts.sheet)) kids.push(h('div', { class: 'small' }, CUR.in + ': ', h('strong', null, eur(opts.sheet)), h('span', { class: 'muted' }, num(opts.sheetPcpp) ? ` · PCPartPicker ${eur(opts.sheetPcpp)}` : '')));
  kids.push(checkedLine(it));
  kids.push(h('div', { class: 'actions' }, link(url, 'Відкрити ' + name + ' ↗', 'btn btn-sm btn-ghost')));
  if (opts.note) kids.push(h('div', { class: 'warn-note' }, opts.note));
  return blk(`${label} · ${name}`, kids);
}

function shipText(o) {
  if (num(o.ship)) return o.ship === 0 ? 'доставка безкоштовна' : `+${eur(o.ship)} доставка`;
  return 'доставка не вказана';
}
const availText = a => a === true ? 'є в наявності' : a === false ? 'немає в наявності' : '';

// Магазини з доставкою в Німеччину (Geizhals): мін. ціна, найдешевший магазин, топ-8
function gzBlock(url, { label = 'Магазини з доставкою в Німеччину (Geizhals)', fallback, key, sheet, note } = {}) {
  const { it, d, stale } = gz(url);
  const kids = [];
  const min = gzMin(d);
  if (min != null) {
    const offers = gzOffers(d);
    kids.push(h('div', { class: 'price' }, h('span', { class: 'muted small' }, 'від '), h('strong', null, eur(min)),
      num(d.max) && d.max !== min ? h('span', { class: 'approx' }, ` до ${eur(d.max)}`) : null, uahHint(min)));
    const o0 = offers[0];
    if (o0) {
      kids.push(h('div', { class: 'small' }, 'Найдешевше: ', h('strong', null, o0.shop || host(o0.url)),
        num(o0.total) ? [' · з доставкою ', h('strong', null, eur(o0.total))] : h('span', { class: 'muted' }, ' · ' + shipText(o0))));
    }
    if (d.offerCount) kids.push(h('div', { class: 'small muted' }, `${d.offerCount} пропозицій`));
    if (stale) kids.push(h('div', { class: 'warn-note' }, `Дані від ${dt(d.checkedAt)}, Geizhals не дав оновити` + (it.blocked || /403|429|block|заблок/i.test(it.error || '') ? ' (сервер заблоковано)' : it.error ? `: ${it.error}` : '')));
    if (num(sheet)) kids.push(h('div', { class: 'small' }, CUR.in + ': ', h('strong', null, eur(sheet))));
    if (!stale) kids.push(checkedLine(it));
    else { const c = changeEl({ change: it.change || d.change, currency: 'EUR' }); if (c) kids.push(h('div', { class: 'meta-line' }, c)); }
    const actions = [];
    if (o0) actions.push(link(o0.url, `Купити · ${o0.shop || host(o0.url)}`, 'btn btn-sm btn-primary'));
    actions.push(link(url, 'Geizhals ↗', 'btn btn-sm btn-ghost'));
    kids.push(h('div', { class: 'actions' }, actions));
    if (offers.length > 1) {
      const k = key || url;
      const det = h('details', { class: 'offers', open: S.open.has(k) },
        h('summary', null, `Топ-${Math.min(TOP_OFFERS, offers.length)} магазинів`),
        h('ol', null, offers.slice(0, TOP_OFFERS).map(o => h('li', null,
          h('div', { class: 'o-row' },
            h('span', { class: 'o-shop' }, o.shop || host(o.url)),
            h('span', { class: 'o-price' }, eur(o.price)),
            link(o.url, 'Купити ↗', 'o-link')),
          h('div', { class: 'o-meta' },
            num(o.total) && o.total !== o.price ? `разом ${eur(o.total)} (${shipText(o)})` : shipText(o),
            availText(o.available) ? h('span', { class: o.available === false ? 'warn-text' : '' }, ' · ' + availText(o.available)) : null)))));
      det.addEventListener('toggle', () => { det.open ? S.open.add(k) : S.open.delete(k); });
      kids.push(det);
    }
  } else if (fallback && num(fallback.min) && !(it && it.noOffers)) {
    kids.push(h('div', { class: 'price' }, h('span', { class: 'muted small' }, 'від '), h('strong', null, eur(fallback.min)),
      num(fallback.max) && fallback.max !== fallback.min ? h('span', { class: 'approx' }, ` до ${eur(fallback.max)}`) : null, uahHint(fallback.min)));
    kids.push(h('div', { class: 'small muted' }, [fallback.offers ? `${fallback.offers} пропозицій · ` : '', 'зі списку схожих моделей; деталі — після перевірки роботом']));
    kids.push(h('div', { class: 'actions' }, link(url, 'Geizhals ↗', 'btn btn-sm btn-ghost')));
  } else {
    kids.push(h('div', { class: 'status' + (it ? ' status-bad' : '') }, url ? statusText(it) : 'немає посилання на Geizhals'));
    if (it?.last && num(gzMin(it.last))) kids.push(h('div', { class: 'small' }, 'Остання відома: ', eur(gzMin(it.last)), it.last.checkedAt ? h('span', { class: 'muted' }, ` (${dShort(it.last.checkedAt)})`) : null));
    else kids.push(lastKnown(it));
    if (num(sheet)) kids.push(h('div', { class: 'small' }, CUR.in + ': ', h('strong', null, eur(sheet))));
    if (url) kids.push(checkedLine(it), h('div', { class: 'actions' }, link(url, 'Geizhals ↗', 'btn btn-sm btn-ghost')));
  }
  if (note) kids.push(h('div', { class: 'warn-note' }, note));
  return blk(label, kids);
}

// «Де дешевше»: магазин з таблиці vs мін. Geizhals
function cheaperBadge(part) {
  const sp = shopPrice(part);
  const { d } = gz(part.geizhals);
  const min = gzMin(d);
  if (!sp || min == null || sameUrl(part.shop, part.geizhals)) return null;
  const diff = sp.eur - min;
  const si = item(part.shop);
  const src = sp.live ? '' : ' · ціна магазину ' + CUR.from + (si?.gone ? ', зараз товар знято з продажу' : si?.noOffers ? ', зараз немає пропозицій' : '');
  if (Math.abs(diff) < 0.01) return h('div', { class: 'where' }, h('span', { class: 'badge' }, 'Ціни однакові'), h('span', { class: 'muted small' }, src));
  const gzShop = gzOffers(d)[0]?.shop || 'Geizhals';
  const pct = Math.round(Math.abs(diff) / Math.min(sp.eur, min) * 100);
  return h('div', { class: 'where' }, h('span', { class: 'badge ' + (diff > 0 ? 'badge-down' : 'badge-de') },
    diff > 0 ? `У ${gzShop} дешевше на ${eur(diff)} (${pct}%)` : `У ${sp.name} дешевше на ${eur(-diff)} (${pct}%)`),
    h('span', { class: 'muted small' }, ' без доставки' + src));
}

function issueUrl(bid, pid, fields, kind = 'Заміна') {
  const q = { template: 'zamina.yml', title: `${kind}: ${bid}/${pid}`, build: bid, part: pid, ...fields };
  return `https://github.com/${REPO}/issues/new?` + Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function renderPart(b, p) {
  CUR = lbl(b);
  const ov = ovOf(b.id, p.id);
  const head = h('div', { class: 'part-head' },
    h('span', { class: 'cat' }, cat(p.id)),
    ov ? h('span', { class: 'tag ' + (ov.from === 'local' ? 'tag-local' : 'tag-saved') }, ov.from === 'local' ? 'замінено · лише в цьому браузері' : 'замінено · збережено') : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openDialog(b, p) }, 'Замінити'));
  const body = ov ? renderReplaced(b, p, ov) : isList(b) ? renderUserOrig(p) : renderAltOrig(p);
  return h('article', { class: 'card part' + (ov ? ' replaced' : '') }, head, body);
}

function renderUserOrig(p) {
  const same = sameUrl(p.shop, p.geizhals);
  return [
    h('h3', { class: 'pname' }, link(p.pcpp, p.name)),
    h('div', { class: 'blocks' },
      !same && p.shop ? shopBlock(CUR.shop, p.shop, { sheet: p.sheet?.internet, sheetPcpp: p.sheet?.pcpp, note: p.shopNote }) : null,
      gzBlock(p.geizhals, { key: 'user/' + p.id, sheet: same ? p.sheet?.internet : null, note: same ? p.shopNote : null })),
    cheaperBadge(p),
  ];
}

function renderAltOrig(p) {
  return [
    h('h3', { class: 'pname' }, link(p.geizhals, p.name)),
    p.why ? h('p', { class: 'why' }, p.why) : null,
    h('div', { class: 'blocks' }, gzBlock(p.geizhals, { key: 'alt/' + p.id })),
  ];
}

// Підсумок оригіналу одним рядком (для закресленого блоку)
function origSummary(b, p) {
  const bits = [];
  if (isList(b) && num(p.sheet?.internet)) bits.push(`${lbl(b).in.toLowerCase()} ${eur(p.sheet.internet)}`);
  const min = gzMin(gz(p.geizhals).d); if (min != null) bits.push(`DE від ${eur(min)}`);
  return bits.join(' · ');
}

function renderReplaced(b, p, ov) {
  const out = [h('h3', { class: 'pname' }, link(ov.url, ov.name || host(ov.url) || 'Деталь'))];
  const pending = 'ціна з’явиться після перевірки роботом' + (ov.from === 'local' ? ' (спершу збережіть заміну)' : '');
  const block = isGeizhals(ov.url)
    ? gzBlock(ov.url, { fallback: ov.from === 'local' ? ov : null, key: `${b.id}/${p.id}/ov` })
    : shopBlock('За посиланням', ov.url, { pending });
  out.push(h('div', { class: 'blocks' }, block));

  const acts = [];
  if (ov.from === 'local') {
    acts.push(h('a', { class: 'btn btn-primary btn-sm', href: issueUrl(b.id, p.id, { name: ov.name || '', url: ov.url }), target: '_blank', rel: 'noopener noreferrer' }, 'Зберегти назавжди й відстежувати ціну'));
    acts.push(h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => setLocal(b.id, p.id, null) }, ov.server ? 'Скасувати локальну заміну' : 'Повернути оригінал'));
  } else {
    acts.push(h('a', { class: 'btn btn-sm btn-ghost', href: issueUrl(b.id, p.id, { name: '', url: 'reset' }, 'Скинути'), target: '_blank', rel: 'noopener noreferrer' }, 'Повернути оригінал'));
  }
  out.push(h('div', { class: 'actions save' }, acts));
  out.push(h('p', { class: 'muted small' }, ov.from === 'local'
    ? 'Відкриється форма на GitHub: після надсилання робот за ~1–2 хв додасть деталь і підтягне ціну.'
    : 'Повернення відкриє форму на GitHub: після надсилання робот за ~1–2 хв поверне оригінал.'));
  if (ov.from === 'server' && (ov.by || ov.at || ov.issue)) {
    const iss = ov.issue == null ? null : /^\d+$/.test(String(ov.issue)) ? `https://github.com/${REPO}/issues/${ov.issue}` : ov.issue;
    out.push(h('p', { class: 'muted small' }, 'Збережено', ov.by ? ` · ${ov.by}` : '', ov.at ? ` · ${dt(ov.at)}` : '', iss ? [' · ', link(iss, 'issue')] : null));
  }

  const os = origSummary(b, p);
  out.push(h('div', { class: 'orig' }, h('span', { class: 'muted small' }, 'Оригінал: '),
    h('s', null, isList(b) ? link(p.pcpp, p.name) : link(p.geizhals, p.name)),
    os ? h('span', { class: 'muted small' }, ' · ' + os) : null));
  if (ov.from === 'local' && ov.server) out.push(h('div', { class: 'orig' }, h('span', { class: 'muted small' }, 'Збережена заміна: '), h('s', null, link(ov.server.url, ov.server.name || host(ov.server.url)))));
  return out;
}

/* ---------- діалог заміни ---------- */
const dlg = document.getElementById('dlg');
let downOnBackdrop = false;
dlg.addEventListener('mousedown', e => { downOnBackdrop = e.target === dlg; });
dlg.addEventListener('click', e => { if (e.target === dlg && downOnBackdrop) dlg.close(); downOnBackdrop = false; });

function openDialog(b, p) {
  const cur = ovOf(b.id, p.id);
  const cands = (S.prices?.candidates?.[p.search] || []).filter(c => c && safeUrl(c.url));
  const ctitle = c => { const t = String(c.title || ''), v = String(c.vendor || ''); return v && !t.toLowerCase().startsWith(v.toLowerCase()) ? `${v} ${t}` : t || c.url; };
  const curUrl = cur ? cur.url : p.geizhals;
  let mode = cands.length ? 'gz' : 'own';

  const close = h('button', { type: 'button', class: 'btn btn-ghost btn-sm dlg-x', 'aria-label': 'Закрити', onclick: () => dlg.close() }, '✕');
  const tabA = h('button', { type: 'button', class: 'seg' }, 'Схожі моделі (Geizhals)');
  const tabB = h('button', { type: 'button', class: 'seg' }, 'Своє посилання');

  // а) схожі моделі з Geizhals
  const filter = h('input', { type: 'search', class: 'inp', placeholder: 'Фільтр за назвою', 'aria-label': 'Фільтр за назвою' });
  const list = h('ul', { class: 'cands' });
  const empty = h('p', { class: 'muted small' });
  function drawList() {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = cands.filter(c => words.every(w => ctitle(c).toLowerCase().includes(w)));
    list.replaceChildren(...shown.map(c => {
      const isCur = sameUrl(c.url, curUrl);
      return h('li', { class: isCur ? 'cur' : '' },
        h('button', { type: 'button', class: 'cand', onclick: () => pickCandidate(c) },
          h('span', { class: 'cand-title' }, ctitle(c)),
          h('span', { class: 'cand-meta' }, num(c.min) ? (num(c.max) && c.max !== c.min ? `${eur(c.min)} – ${eur(c.max)}` : `від ${eur(c.min)}`) : 'ціна невідома',
            c.offers ? ` · ${c.offers} пропоз.` : '', isCur ? ' · поточна' : '')),
        link(c.url, '↗', 'cand-link'));
    }));
    empty.textContent = !cands.length ? 'Схожих моделей поки немає — робот збирає їх під час оновлення. Скористайтеся «Своє посилання».' : shown.length ? '' : 'Нічого не знайдено.';
  }
  filter.addEventListener('input', drawList);
  const paneA = h('div', { class: 'pane' }, filter, empty, list);

  function pickCandidate(c) {
    const so = S.server?.[b.id]?.[p.id];
    // вибрали оригінал (без серверної заміни) або саму серверну заміну — локальна не потрібна
    if ((!validServer(so) && sameUrl(c.url, p.geizhals)) || (validServer(so) && sameUrl(c.url, so.url))) setLocal(b.id, p.id, null);
    else setLocal(b.id, p.id, { name: ctitle(c), url: c.url, src: 'geizhals', min: c.min ?? null, max: c.max ?? null, offers: c.offers ?? null, at: new Date().toISOString() });
    dlg.close();
  }

  // б) своє посилання
  const urlIn = h('input', { type: 'url', class: 'inp', required: true, placeholder: 'https://…', id: 'own-url', autocomplete: 'off' });
  const nameIn = h('input', { type: 'text', class: 'inp', required: true, placeholder: 'Напр. MSI MAG A850GL', id: 'own-name', autocomplete: 'off', maxlength: '200' });
  const err = h('p', { class: 'err small', role: 'alert' });
  const form = h('form', { class: 'pane', novalidate: true },
    h('label', { for: 'own-url' }, 'Посилання на товар'), urlIn,
    h('label', { for: 'own-name' }, 'Назва деталі'), nameIn, err,
    h('p', { class: 'muted small' }, 'Будь-який магазин або сторінка Geizhals. Ціну перевірить робот після збереження заміни.'),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Застосувати')));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const u = safeUrl(urlIn.value.trim()); const n = nameIn.value.trim();
    if (!u) { err.textContent = 'Потрібне посилання http(s)://'; urlIn.focus(); return; }
    if (!n) { err.textContent = 'Вкажіть назву деталі'; nameIn.focus(); return; }
    setLocal(b.id, p.id, { name: n, url: u, src: isGeizhals(u) ? 'geizhals' : 'custom', at: new Date().toISOString() });
    dlg.close();
  });

  const body = h('div', { class: 'dlg-body' });
  function setMode(m) {
    mode = m;
    tabA.setAttribute('aria-pressed', String(m === 'gz')); tabB.setAttribute('aria-pressed', String(m === 'own'));
    body.replaceChildren(m === 'gz' ? paneA : form);
    (m === 'gz' ? filter : urlIn).focus();
  }
  tabA.addEventListener('click', () => setMode('gz'));
  tabB.addEventListener('click', () => setMode('own'));

  dlg.replaceChildren(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, `Замінити: ${cat(p.id)}`), close),
    h('p', { class: 'muted small dlg-sub' }, `${b.title} · зараз: ${cur ? cur.name || cur.url : p.name}`),
    h('div', { class: 'segs', role: 'group', 'aria-label': 'Спосіб заміни' }, tabA, tabB),
    body);
  drawList();
  dlg.showModal();
  setMode(mode);
}

/* ---------- головний рендер ---------- */
function render() {
  renderMeta();
  const notice = document.getElementById('notice');
  const msgs = [];
  if (S.error) msgs.push(h('div', { class: 'notice notice-bad', role: 'alert' }, `Не вдалося завантажити дані: ${S.error}`));
  if (S.config && !S.prices) msgs.push(h('div', { class: 'notice' }, 'Ціни ще не зібрано — робот оновлює їх кожні ~2 год. Поки показано дані з таблиці.'));
  notice.replaceChildren(...msgs);
  if (!S.config) return;
  renderSummary();
  renderCompare();
  renderTabs();
  renderBuild();
}

document.getElementById('reload').addEventListener('click', load);
setInterval(load, RELOAD_MS);
setInterval(() => { tickRel(); if (S.prices) renderMeta(); }, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!S.loadedAt || Date.now() - Date.parse(S.loadedAt) > RELOAD_MS)) load();
});
window.addEventListener('storage', e => { if (e.key === LS_KEY) { S.local = lsGet(LS_KEY, {}); reconcile(); render(); } });
load();
