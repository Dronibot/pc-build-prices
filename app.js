'use strict';
// Ціни на збірку ПК — статичний фронтенд (без збірки й залежностей).
// Дані: data/config.json, data/prices.json, data/overrides.json (генерує робот у GitHub Actions).

const REPO = 'Dronibot/pc-build-prices';
const LS_KEY = 'pcb-overrides-v1';
const LS_TAB = 'pcb-tab-v1';
const RELOAD_MS = 5 * 60 * 1000;           // перечитувати дані
const ROBOT_EVERY_MS = 2 * 60 * 60 * 1000; // робот оновлює ціни кожні ~2 год

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
const isHotline = u => /(^|\.)hotline\.ua$/i.test(host(u));
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

/* ---------- ціни деталі ---------- */
const hotlineOf = ov => ov ? (isHotline(ov.url) ? ov.url : (safeUrl(ov.hotline) ? ov.hotline : null)) : null;

// Мінімальна ціна в Україні, ₴
function uaPrice(part, ov) {
  if (ov) {
    const hu = hotlineOf(ov);
    const it = item(hu);
    if (it?.ok && num(it.min ?? it.price)) return { uah: it.min ?? it.price, src: 'hotline' };
    if (num(ov.min)) return { uah: ov.min, src: 'candidate' };
    const li = item(ov.url);
    if (li?.ok && li.currency === 'UAH' && num(li.price)) return { uah: li.price, src: 'link' };
    const am = S.prices?.autoMatch?.[ov.url];
    const ai = item(am?.url);
    if (ai?.ok && num(ai.min ?? ai.price)) return { uah: ai.min ?? ai.price, src: 'auto' };
    if (num(am?.min)) return { uah: am.min, src: 'auto' };
    if (it && !it.ok && num(it.lastPrice)) return { uah: it.lastPrice, src: 'last' };
    return null;
  }
  const it = item(part.hotline);
  if (it?.ok && num(it.min ?? it.price)) return { uah: it.min ?? it.price, src: 'hotline' };
  if (it && num(it.lastPrice)) return { uah: it.lastPrice, src: 'last' };
  return null;
}
// Ціна «Німеччина зараз», € (лише для збірки з таблиці)
function dePrice(part, ov) {
  if (ov) {
    const li = item(ov.url);
    if (li?.ok && li.currency !== 'UAH' && num(li.price)) { const e = toEUR(li.price, li.currency); if (e != null) return { eur: e, src: 'replaced' }; }
    const ua = uaPrice(part, ov); const r = rate('EUR');
    if (ua && r) return { eur: ua.uah / r, src: 'replacedUA' };
    return null;
  }
  const s = item(part.shop);
  if (s?.ok && num(s.price) && s.currency !== 'UAH') { const e = toEUR(s.price, s.currency); if (e != null) return { eur: e, src: 'live' }; }
  const g = item(part.geizhals);
  if (g?.ok && num(g.price)) return { eur: g.price, src: 'geizhals' };
  if (num(part.sheet?.internet)) return { eur: part.sheet.internet, src: 'sheet' };
  return null;
}
// Найкраща жива ціна в Німеччині, ₴ (для бейджа «де дешевше»)
function deBestUAH(urls) {
  let best = null;
  for (const u of urls) {
    const it = item(u);
    if (it?.ok && num(it.price) && it.currency !== 'UAH') { const v = toUAH(it.price, it.currency); if (v != null && (best == null || v < best)) best = v; }
  }
  return best;
}

function totals(build, withOv) {
  const t = { ua: 0, uaMiss: 0, de: 0, deMiss: 0, src: {}, n: build.parts.length, ovCount: 0 };
  for (const p of build.parts) {
    const ov = withOv ? ovOf(build.id, p.id) : null;
    if (ov) t.ovCount++;
    const ua = uaPrice(p, ov);
    if (ua) t.ua += ua.uah; else t.uaMiss++;
    if (build.id === 'user') {
      const de = dePrice(p, ov);
      if (de) { t.de += de.eur; t.src[de.src] = (t.src[de.src] || 0) + 1; } else t.deMiss++;
    }
  }
  return t;
}
function sheetTotals(build) {
  const st = build.sheetTotals || {};
  const sum = k => build.parts.reduce((a, p) => a + (num(p.sheet?.[k]) ? p.sheet[k] : 0), 0);
  return { internet: num(st.internet) ? st.internet : sum('internet'), pcpp: num(st.pcpp) ? st.pcpp : num(st.chooseYourParts) ? st.chooseYourParts : sum('pcpp') };
}

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
  if (num(P?.rates?.EUR)) rows.push(h('span', null, 'Курс НБУ: 1 € = ', h('strong', null, nf2.format(P.rates.EUR) + ' ₴'), P.rates.date ? h('span', { class: 'muted' }, ` (${P.rates.date})`) : null));
  if (P?.stats) rows.push(h('span', null, `Цін отримано: ${P.stats.ok ?? 0} з ${P.stats.total ?? 0}`));
  if (S.loadedAt) rows.push(relEl('Дані перечитано ', S.loadedAt));
  meta.replaceChildren(...rows.map(r => h('span', { class: 'meta-item' }, r)));

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
  return h('div', { class: 'trow' + (cls ? ' ' + cls : '') }, h('div', { class: 'tlabel' }, label), h('div', { class: 'tval' }, main), sub ? h('div', { class: 'tsub' }, sub) : null);
}
function eurUah(e) { const u = toUAH(e, 'EUR'); return [h('strong', null, eur(e)), u != null ? h('span', { class: 'approx' }, ' ≈ ' + uah(u)) : null]; }

function renderSummary() {
  const box = document.getElementById('summary');
  const cards = S.config.builds.map(b => {
    const t = totals(b, true), t0 = t.ovCount ? totals(b, false) : null;
    const rows = [];
    if (b.id === 'user') {
      const st = sheetTotals(b);
      rows.push(totalRow('З таблиці (інтернет)', eurUah(st.internet), `PCPartPicker: ${eur(st.pcpp)}`));
      const parts = [];
      const L = { live: 'живі', geizhals: 'Geizhals', sheet: 'з таблиці', replaced: 'заміни', replacedUA: 'заміни (ціна UA)' };
      for (const [k, v] of Object.entries(t.src)) parts.push(`${L[k] || k}: ${v}`);
      if (t.deMiss) parts.push(`без ціни: ${t.deMiss}`);
      const notLive = (t.src.geizhals || 0) + (t.src.sheet || 0);
      rows.push(totalRow('Німеччина зараз', eurUah(t.de), [notLive ? h('span', { class: 'warn-text' }, `Не всі ціни живі. `) : null, parts.join(' · ')]));
    }
    rows.push(totalRow(b.id === 'user' ? 'Найдешевше в Україні' : 'Україна (мін. Hotline)', h('strong', null, uah(t.ua)), t.uaMiss ? h('span', { class: 'warn-text' }, `без ціни: ${t.uaMiss} з ${t.n}`) : `${t.n} деталей`, 'tmain'));
    if (t0) {
      const sub = b.id === 'user' ? `Німеччина ${eur(t0.de)} · Україна ${uah(t0.ua)}` : `Україна ${uah(t0.ua)}`;
      rows.push(totalRow(`Без замін (замінено: ${t.ovCount})`, null, sub));
    }
    return h('article', { class: 'card tcard' + (S.tab === b.id ? ' sel' : '') },
      h('div', { class: 'tcard-head' }, h('h2', null, b.title),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': String(S.tab === b.id), onclick: () => selectTab(b.id, true) }, 'Деталі')),
      rows);
  });
  box.replaceChildren(...cards);
}

function renderCompare() {
  const box = document.getElementById('compare');
  const user = S.config.builds.find(b => b.id === 'user'), alt = S.config.builds.find(b => b.id === 'alt');
  const opts = [];
  if (user) {
    const t = totals(user, true);
    const de = toUAH(t.de, 'EUR');
    if (de != null && t.de > 0) opts.push({ label: 'Моя збірка — купити в Німеччині', v: de, note: '≈ за курсом, без доставки' + (t.deMiss ? `, без ціни: ${t.deMiss}` : ''), incomplete: t.deMiss > 0 });
    if (t.ua > 0) opts.push({ label: 'Моя збірка — купити в Україні', v: t.ua, note: t.uaMiss ? `без ціни: ${t.uaMiss}` : '', incomplete: t.uaMiss > 0 });
  }
  if (alt) {
    const t = totals(alt, true);
    if (t.ua > 0) opts.push({ label: 'Оновлена збірка — в Україні', v: t.ua, note: t.uaMiss ? `без ціни: ${t.uaMiss}` : '', incomplete: t.uaMiss > 0 });
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
        h('span', { class: 'cmp-val' }, uah(o.v)),
        h('span', { class: 'badge ' + (i === 0 ? 'badge-down' : 'badge-up') }, i === 0 ? 'найдешевше' : `+${uah(d)} (+${pct}%)`));
    })),
    opts.some(o => o.incomplete) ? h('p', { class: 'muted small' }, 'Частина цін відсутня — порівняння приблизне.') : null,
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
  const d = c.to - c.from, cur = it.currency;
  const pct = c.from ? Math.abs(Math.round(d / c.from * 1000) / 10) : 0;
  return h('span', { class: 'chg ' + (d > 0 ? 'up' : 'down'), title: `було ${money(c.from, cur)}` },
    `${d > 0 ? '▲ +' : '▼ −'}${money(Math.abs(d), cur)} (${pct}%)`, c.since ? ` з ${dShort(c.since)}` : '');
}
function statusText(it) {
  if (!it) return 'ще не перевірено';
  if (it.gone) return 'товар знято з продажу (404)';
  if (it.blocked) return 'магазин блокує автоматичні запити';
  if (/timeout|abort/i.test(it.error || '')) return 'магазин не відповів (тайм-аут)';
  return 'не вдалося отримати ціну' + (it.error ? `: ${it.error}` : '');
}
function priceLine(price, cur) {
  const u = cur !== 'UAH' ? toUAH(price, cur) : null;
  return h('div', { class: 'price' }, h('strong', null, money(price, cur)), u != null ? h('span', { class: 'approx' }, ' ≈ ' + uah(u)) : null);
}
function blk(label, ...kids) { return h('div', { class: 'blk' }, h('div', { class: 'blk-label' }, label), kids); }
function lastKnown(it) {
  if (!it || it.ok || !num(it.lastPrice)) return null;
  return h('div', { class: 'small' }, 'Остання відома: ', money(it.lastPrice, it.currency || 'EUR'), it.lastOkAt ? h('span', { class: 'muted' }, ` (${dShort(it.lastOkAt)})`) : null);
}
function checkedLine(it) {
  if (!it) return null;
  return h('div', { class: 'meta-line' }, changeEl(it), relEl('перевірено ', it.checkedAt));
}

// Блок «магазин / посилання» з ціною в € або ₴
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
  if (opts.sheet) kids.push(h('div', { class: 'small' }, 'У таблиці: ', h('strong', null, eur(opts.sheet)), h('span', { class: 'muted' }, num(opts.sheetPcpp) ? ` · PCPartPicker ${eur(opts.sheetPcpp)}` : '')));
  kids.push(checkedLine(it));
  kids.push(h('div', { class: 'actions' }, link(url, 'Відкрити ' + name + ' ↗', 'btn btn-sm btn-ghost')));
  if (opts.note) kids.push(h('div', { class: 'warn-note' }, opts.note));
  return blk(`${label} · ${name}`, kids);
}

function geizhalsBlock(url) {
  const it = item(url);
  const kids = [];
  if (it?.ok && num(it.price)) kids.push(priceLine(it.price, it.currency || 'EUR'));
  else kids.push(h('div', { class: 'status' + (it ? ' status-bad' : '') }, statusText(it)), lastKnown(it));
  kids.push(checkedLine(it), h('div', { class: 'actions' }, link(url, 'Geizhals ↗', 'btn btn-sm btn-ghost')));
  return blk('Німеччина мін. (Geizhals)', kids);
}

// Hotline: мін. ціна, найдешевший магазин, топ-5
function hotlineBlock(url, { label = 'Україна (Hotline)', note, fallback, key } = {}) {
  const it = item(url);
  const kids = [];
  if (it?.ok && num(it.min ?? it.price)) {
    const offers = Array.isArray(it.offers) ? it.offers : [];
    kids.push(h('div', { class: 'price' }, h('span', { class: 'muted small' }, 'від '), h('strong', null, uah(it.min ?? it.price)),
      num(it.max) && it.max !== it.min ? h('span', { class: 'approx' }, ` до ${uah(it.max)}`) : null));
    if (it.offerCount) kids.push(h('div', { class: 'small muted' }, `${it.offerCount} пропозицій`));
    if (it.available === false) kids.push(h('span', { class: 'tag tag-warn' }, 'немає в наявності'));
    kids.push(checkedLine(it));
    const actions = [];
    if (offers[0]) actions.push(link(offers[0].url, `Купити · ${offers[0].shop || host(offers[0].url)}`, 'btn btn-sm btn-primary'));
    actions.push(link(url, 'Hotline ↗', 'btn btn-sm btn-ghost'));
    kids.push(h('div', { class: 'actions' }, actions));
    if (offers.length > 1) {
      const k = key || url;
      const det = h('details', { class: 'offers', open: S.open.has(k) },
        h('summary', null, `Топ-${Math.min(5, offers.length)} магазинів`),
        h('ol', null, offers.slice(0, 5).map(o => h('li', null,
          h('span', { class: 'o-shop' }, o.shop || o.site || host(o.url)), o.used ? h('span', { class: 'tag tag-warn' }, 'вживаний') : null,
          h('span', { class: 'o-price' }, uah(o.price)),
          link(o.url, 'Купити ↗', 'o-link')))));
      det.addEventListener('toggle', () => { det.open ? S.open.add(k) : S.open.delete(k); });
      kids.push(det);
    }
  } else if (fallback && num(fallback.min)) {
    kids.push(h('div', { class: 'price' }, h('span', { class: 'muted small' }, 'від '), h('strong', null, uah(fallback.min)),
      num(fallback.max) && fallback.max !== fallback.min ? h('span', { class: 'approx' }, ` до ${uah(fallback.max)}`) : null));
    kids.push(h('div', { class: 'small muted' }, [fallback.offers ? `${fallback.offers} пропозицій · ` : '', 'з пошуку Hotline']));
    kids.push(h('div', { class: 'actions' }, link(url, 'Hotline ↗', 'btn btn-sm btn-ghost')));
  } else {
    kids.push(h('div', { class: 'status' + (it ? ' status-bad' : '') }, url ? statusText(it) : 'немає посилання на Hotline'), lastKnown(it));
    if (url) kids.push(checkedLine(it), h('div', { class: 'actions' }, link(url, 'Hotline ↗', 'btn btn-sm btn-ghost')));
  }
  if (note) kids.push(h('div', { class: 'warn-note' }, note));
  return blk(label, kids);
}

function cheaperBadge(deUAH, ua) {
  if (deUAH == null || !ua) return null;
  const d = ua.uah - deUAH; const base = Math.min(ua.uah, deUAH);
  const pct = base ? Math.round(Math.abs(d) / base * 100) : 0;
  if (Math.abs(d) < 1) return h('div', { class: 'where' }, h('span', { class: 'badge' }, 'Ціни однакові'));
  return h('div', { class: 'where' }, h('span', { class: 'badge ' + (d > 0 ? 'badge-de' : 'badge-ua') },
    d > 0 ? `У Німеччині дешевше на ${uah(d)} (${pct}%)` : `В Україні дешевше на ${uah(-d)} (${pct}%)`),
    h('span', { class: 'muted small' }, ' без доставки'));
}

function issueUrl(bid, pid, fields, kind = 'Заміна') {
  const q = { template: 'zamina.yml', title: `${kind}: ${bid}/${pid}`, build: bid, part: pid, ...fields };
  return `https://github.com/${REPO}/issues/new?` + Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function renderPart(b, p) {
  const ov = ovOf(b.id, p.id);
  const head = h('div', { class: 'part-head' },
    h('span', { class: 'cat' }, cat(p.id)),
    ov ? h('span', { class: 'tag ' + (ov.from === 'local' ? 'tag-local' : 'tag-saved') }, ov.from === 'local' ? 'замінено · лише в цьому браузері' : 'замінено · збережено') : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openDialog(b, p) }, 'Замінити'));
  const body = ov ? renderReplaced(b, p, ov) : b.id === 'user' ? renderUserOrig(p) : renderAltOrig(p);
  return h('article', { class: 'card part' + (ov ? ' replaced' : '') }, head, body);
}

function renderUserOrig(p) {
  const ua = uaPrice(p, null);
  return [
    h('h3', { class: 'pname' }, link(p.pcpp, p.name)),
    h('div', { class: 'blocks' },
      shopBlock('Магазин з таблиці', p.shop, { sheet: p.sheet?.internet, sheetPcpp: p.sheet?.pcpp, note: p.shopNote }),
      p.geizhals ? geizhalsBlock(p.geizhals) : null,
      hotlineBlock(p.hotline, { note: p.hotlineNote, key: 'user/' + p.id })),
    cheaperBadge(deBestUAH([p.shop, p.geizhals]), ua),
  ];
}

function renderAltOrig(p) {
  return [
    h('h3', { class: 'pname' }, link(p.hotline, p.name)),
    p.why ? h('p', { class: 'why' }, p.why) : null,
    h('div', { class: 'blocks' }, hotlineBlock(p.hotline, { note: p.hotlineNote, key: 'alt/' + p.id })),
  ];
}

// Підсумок оригіналу одним рядком (для закресленого блоку)
function origSummary(b, p) {
  const bits = [];
  if (b.id === 'user') { const de = dePrice(p, null); if (de) bits.push(`Німеччина ${eur(de.eur)}`); }
  const ua = uaPrice(p, null); if (ua) bits.push(`Україна від ${uah(ua.uah)}`);
  return bits.join(' · ');
}

function renderReplaced(b, p, ov) {
  const out = [h('h3', { class: 'pname' }, link(ov.url, ov.name || host(ov.url) || 'Деталь'))];
  const blocks = [];
  const hu = hotlineOf(ov);
  const am = !hu ? S.prices?.autoMatch?.[ov.url] : null;
  if (!isHotline(ov.url)) {
    blocks.push(shopBlock('За посиланням', ov.url, { pending: 'ціна з’явиться після перевірки роботом' + (ov.from === 'local' ? ' (спершу збережіть заміну)' : '') }));
  }
  if (hu) blocks.push(hotlineBlock(hu, { fallback: ov.from === 'local' ? ov : null, key: `${b.id}/${p.id}/ov` }));
  else if (am && safeUrl(am.url)) {
    blocks.push(hotlineBlock(am.url, { label: 'Автопідбір Hotline — перевірте відповідність', fallback: am, key: `${b.id}/${p.id}/am`,
      note: `Знайдено: ${am.title || '—'}${num(am.score) ? ` (збіг ${Math.round(am.score * 100)}%)` : ''}` }));
  } else if (!isHotline(ov.url)) {
    blocks.push(blk('Україна (Hotline)', h('div', { class: 'status' }, ov.from === 'local' ? 'після збереження робот спробує знайти цю деталь на Hotline' : 'відповідник на Hotline не знайдено')));
  }
  out.push(h('div', { class: 'blocks' }, blocks));
  if (b.id === 'user') out.push(cheaperBadge(deBestUAH([ov.url]), uaPrice(p, ov)));

  const acts = [];
  if (ov.from === 'local') {
    const fields = { name: ov.name || '', url: ov.url };
    if (ov.hotline && !sameUrl(ov.hotline, ov.url)) fields.hotline = ov.hotline;
    acts.push(h('a', { class: 'btn btn-primary btn-sm', href: issueUrl(b.id, p.id, fields), target: '_blank', rel: 'noopener noreferrer' }, 'Зберегти назавжди й відстежувати ціну'));
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

  const orig = h('div', { class: 'orig' }, h('span', { class: 'muted small' }, 'Оригінал: '),
    h('s', null, b.id === 'user' ? link(p.pcpp, p.name) : link(p.hotline, p.name)),
    h('span', { class: 'muted small' }, origSummary(b, p) ? ' · ' + origSummary(b, p) : ''));
  out.push(orig);
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
  let mode = cands.length ? 'hl' : 'own';

  const close = h('button', { type: 'button', class: 'btn btn-ghost btn-sm dlg-x', 'aria-label': 'Закрити', onclick: () => dlg.close() }, '✕');
  const tabA = h('button', { type: 'button', class: 'seg' }, 'Обрати з Hotline');
  const tabB = h('button', { type: 'button', class: 'seg' }, 'Своє посилання');

  // а) кандидати Hotline
  const filter = h('input', { type: 'search', class: 'inp', placeholder: 'Фільтр за назвою', 'aria-label': 'Фільтр за назвою' });
  const list = h('ul', { class: 'cands' });
  const empty = h('p', { class: 'muted small' });
  function drawList() {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = cands.filter(c => words.every(w => ctitle(c).toLowerCase().includes(w)));
    list.replaceChildren(...shown.map(c => {
      const isCur = sameUrl(c.url, cur ? hotlineOf(cur) : p.hotline);
      return h('li', { class: isCur ? 'cur' : '' },
        h('button', { type: 'button', class: 'cand', onclick: () => pickCandidate(c) },
          h('span', { class: 'cand-title' }, ctitle(c)),
          h('span', { class: 'cand-meta' }, num(c.min) ? (num(c.max) && c.max !== c.min ? `${uah(c.min)} – ${uah(c.max)}` : uah(c.min)) : 'ціна невідома',
            c.offers ? ` · ${c.offers} пропоз.` : '', isCur ? ' · поточна' : '')),
        link(c.url, '↗', 'cand-link'));
    }));
    empty.textContent = !cands.length ? 'Кандидатів поки немає — робот збирає їх під час оновлення. Скористайтеся «Своє посилання».' : shown.length ? '' : 'Нічого не знайдено.';
  }
  filter.addEventListener('input', drawList);
  const paneA = h('div', { class: 'pane' }, filter, empty, list);

  function pickCandidate(c) {
    const so = S.server?.[b.id]?.[p.id];
    // вибрали те саме, що вже в оригіналі (без серверної заміни) або в серверній — локальна не потрібна
    if ((!validServer(so) && sameUrl(c.url, p.hotline)) || (validServer(so) && sameUrl(c.url, so.url))) setLocal(b.id, p.id, null);
    else setLocal(b.id, p.id, { name: ctitle(c), url: c.url, src: 'hotline', min: c.min ?? null, max: c.max ?? null, offers: c.offers ?? null, at: new Date().toISOString() });
    dlg.close();
  }

  // б) своє посилання
  const urlIn = h('input', { type: 'url', class: 'inp', required: true, placeholder: 'https://…', id: 'own-url', autocomplete: 'off' });
  const nameIn = h('input', { type: 'text', class: 'inp', required: true, placeholder: 'Напр. MSI MAG A850GL', id: 'own-name', autocomplete: 'off', maxlength: '200' });
  const err = h('p', { class: 'err small', role: 'alert' });
  const form = h('form', { class: 'pane', novalidate: true },
    h('label', { for: 'own-url' }, 'Посилання на товар (будь-який магазин)'), urlIn,
    h('label', { for: 'own-name' }, 'Назва деталі'), nameIn, err,
    h('p', { class: 'muted small' }, 'Ціну перевірить робот після збереження заміни. Для не-Hotline посилань робот спробує знайти відповідник на Hotline.'),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Застосувати')));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const u = safeUrl(urlIn.value.trim()); const n = nameIn.value.trim();
    if (!u) { err.textContent = 'Потрібне посилання http(s)://'; urlIn.focus(); return; }
    if (!n) { err.textContent = 'Вкажіть назву деталі'; nameIn.focus(); return; }
    setLocal(b.id, p.id, { name: n, url: u, src: isHotline(u) ? 'hotline' : 'custom', at: new Date().toISOString() });
    dlg.close();
  });

  const body = h('div', { class: 'dlg-body' });
  function setMode(m) {
    mode = m;
    tabA.setAttribute('aria-pressed', String(m === 'hl')); tabB.setAttribute('aria-pressed', String(m === 'own'));
    body.replaceChildren(m === 'hl' ? paneA : form);
    (m === 'hl' ? filter : urlIn).focus();
  }
  tabA.addEventListener('click', () => setMode('hl'));
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
