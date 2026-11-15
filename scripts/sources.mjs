// Отримання цін з магазинів. Лише звичайні HTTP-запити до публічних сторінок,
// без обходу антибот-захисту: якщо магазин блокує (403/капча) — повертаємо помилку.
import { parseNuxt } from './nuxt.mjs';

const UA = 'Mozilla/5.0 (compatible; PCBuildPriceBot/1.0; +https://github.com/Dronibot/pc-build-prices)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function get(url, { lang = 'uk-UA,uk;q=0.9,en;q=0.5', tries = 2 } = {}) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': lang },
        redirect: 'follow', signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      if (r.status === 404 || r.status === 410) throw Object.assign(new Error(`сторінку не знайдено (HTTP ${r.status}) — товар, ймовірно, знято з продажу`), { gone: true });
      if (r.status === 403 || r.status === 429 || r.status === 503 || /<title>(Just a moment|Attention Required)|challenges\.cloudflare\.com|captcha-delivery/i.test(text.slice(0, 8000)))
        throw Object.assign(new Error(`магазин блокує автоматичні запити (HTTP ${r.status})`), { blocked: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (isJsChallenge(text))
        throw Object.assign(new Error('магазин показує JS-перевірку замість сторінки (антибот) — автоматично ціну не отримати'), { blocked: true });
      return { text, url: r.url };
    } catch (e) {
      lastErr = e; if (e.blocked || e.gone) break; await sleep(1500);
    }
  }
  throw lastErr;
}

// Маленька сторінка-заглушка, що ставить cookie скриптом і перезавантажується/перемальовується
// (Elmir: elm38=…; EXE.ua: «Виконується з'єднання…»). Ми її не виконуємо — це блок.
function isJsChallenge(text) {
  if (text.length > 30000 || /application\/ld\+json/i.test(text)) return false;
  return /<title>\s*Виконується з'єднання/i.test(text)
    || (/(?:\bd|document)\.cookie\s*=/.test(text) && /\.reload\(|(?:\bd|document)\.write\(/.test(text));
}

const num = s => {
  if (s == null) return null; if (typeof s === 'number') return s;
  let t = String(s).replace(/[^\d.,]/g, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, '');
  const n = parseFloat(t); return Number.isFinite(n) ? n : null;
};

function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1].trim()); (Array.isArray(j) ? j : [j]).forEach(x => out.push(...(x['@graph'] || [x]))); } catch { }
  }
  return out;
}

function fromLd(html) {
  for (const o of jsonLd(html)) {
    const types = [].concat(o['@type'] || []);
    if (!types.includes('Product')) continue;
    let offers = [].concat(o.offers || []);
    for (const of of offers) {
      const price = num(of.price ?? of.lowPrice);
      if (price) {
        const avail = String(of.availability || '');
        return { price, currency: of.priceCurrency || null, title: o.name, available: avail ? /InStock|PreOrder|LimitedAvailability/i.test(avail) : null };
      }
    }
  }
  return null;
}

// schema.org microdata: <meta|data|span itemprop="price" content|value="…">, атрибути в будь-якому порядку (Moyo, Epicentr)
const attr = (tag, a) => tag.match(new RegExp(`\\b${a}=["']([^"']+)`, 'i'))?.[1];
function fromMicro(html) {
  const m = html.match(/<[^>]+\bitemprop=["']price["'][^>]*>([^<]*)/i);
  if (!m) return null;
  const price = num(attr(m[0], 'content') ?? attr(m[0], 'value') ?? m[1]);
  if (!price) return null;
  const c = html.match(/<[^>]+\bitemprop=["']priceCurrency["'][^>]*>/i);
  const a = html.match(/<[^>]+\bitemprop=["']availability["'][^>]*>/i);
  const av = a ? (attr(a[0], 'href') || attr(a[0], 'content') || '') : '';
  return { price, currency: c ? attr(c[0], 'content') : null, available: av ? /InStock|PreOrder|LimitedAvailability/i.test(av) : null };
}

function fromMeta(html) {
  const p = html.match(/<meta[^>]+(?:property|itemprop)=["'](?:product:price:amount|og:price:amount|price)["'][^>]*content=["']([^"']+)/i);
  if (!p) return null;
  const c = html.match(/<meta[^>]+(?:property|itemprop)=["'](?:product:price:currency|og:price:currency|priceCurrency)["'][^>]*content=["']([^"']+)/i);
  return { price: num(p[1]), currency: c ? c[1] : null };
}

const title = html => (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1]
  || html.match(/<title>([^<]+)/i)?.[1] || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
// прибирає SEO-хвости з og:title: «≡ … – купити в Києві | …», «ᐉ … • Краща ціна…», «… в інтернет-магазині Цитрус»
const cleanTitle = t => String(t || '').replace(/^[≡ᐉ▶►➤\s]+/, '')
  .replace(/\s+(?:[–—|•]\s*)?(?:купити|купить|краща ціна|лучшая цена|в інтернет-магазині|в интернет-магазине)(?![а-яіїєґ]).*$/i, '')
  .trim();

// ---------- Hotline ----------
const HL = 'https://hotline.ua';
export async function hotlineProduct(url) {
  const { text } = await get(url);
  const N = parseNuxt(text);
  const ld = fromLd(text);
  const edges = N?.state?.product?.offers?.edges || [];
  const offers = edges.map(e => e.node).filter(o => o && o.price).map(o => ({
    shop: o.firmTitle, site: (o.firmExtraInfo?.website || '').toLowerCase(),
    price: Math.round(o.price), url: o.conversionUrl ? HL + o.conversionUrl : url,
    used: o.conditionId && o.conditionId !== 0 ? true : /б\/у|вжив|уцін/i.test(o.condition || ''),
  })).filter(o => !o.used).sort((a, b) => a.price - b.price);
  let t = title(text).replace(/\s*[–-]\s*купити.*$/i, '').replace(/^Hotline\s*-\s*/i, '');
  if (!offers.length && !ld) throw new Error('на Hotline немає пропозицій');
  return {
    title: t, url, currency: 'UAH',
    price: offers[0]?.price ?? ld?.price ?? null,
    min: offers[0]?.price ?? ld?.price ?? null,
    max: offers.length ? offers[offers.length - 1].price : null,
    offerCount: offers.length || null,
    offers: offers.slice(0, 40),
    available: offers.length > 0,
  };
}

export async function hotlineSearch(q) {
  const { text } = await get(`${HL}/ua/sr/?q=${encodeURIComponent(q)}`);
  const N = parseNuxt(text);
  const list = N?.state?.sr?.productsSearch || [];
  return list.map(p => ({ id: p._id, title: p.title, url: HL + '/ua' + p.url, min: p.minPrice, max: p.maxPrice, offers: p.offerCount, vendor: p.vendor?.title }));
}

// ---------- Конкретні магазини ----------
function amazon(html) {
  // ціна в основному блоці покупки
  const core = html.match(/id="corePrice(?:Display_desktop)?_feature_div"[\s\S]{0,4000}?class="a-offscreen">([^<]+)</)
    || html.match(/id="apex_desktop"[\s\S]{0,4000}?class="a-offscreen">([^<]+)</);
  const p = core ? num(core[1]) : null;
  if (!p) return null;
  const unavailable = /id="outOfStock"|Derzeit nicht verfügbar|Currently unavailable/i.test(html);
  return { price: p, currency: 'EUR', available: !unavailable };
}

function geizhals(html) {
  // мінімальна ціна саме цієї моделі — у заголовку сторінки: "… ab € 299,89 (2026) | Preisvergleich …"
  const t = (html.match(/<title>([^<]+)/i)?.[1] || '').replace(/&#xa0;|&nbsp;/g, ' ');
  const m = t.match(/ab\s*€\s*([\d.,]+)/);
  if (!m) {
    if (/keine Angebote/i.test(html)) throw Object.assign(new Error('наразі немає пропозицій у Німеччині'), { noOffers: true });
    return null;
  }
  return { price: num(m[1]), currency: 'EUR', title: t.replace(/\s*ab\s*€.*$/, '').trim(), available: true };
}

// ---------- Німеччина / доставка в DE (перевірено 2026-11-15) ----------
// JSON-LD, де Product/ProductGroup вкладено глибше (MediaMarkt/Saturn: {"@type":"BuyAction","object":{"@type":"ProductGroup","offers":…}})
function ldDeep(html) {
  const seen = [];
  const walk = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 6) return;
    if (Array.isArray(o)) return o.forEach(x => walk(x, d + 1));
    const types = [].concat(o['@type'] || []);
    if (types.some(t => /^(Product|ProductGroup)$/.test(t)) && o.offers) seen.push(o);
    for (const k of ['object', 'mainEntity', 'itemOffered', '@graph', 'hasVariant']) if (o[k]) walk(o[k], d + 1);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { }
  }
  for (const o of seen) for (const of of [].concat(o.offers || [])) {
    const price = num(of.price ?? of.lowPrice);
    if (!price) continue;
    const avail = String(of.availability || '');
    return { price, currency: of.priceCurrency || null, title: o.name, available: avail ? /InStock|PreOrder|LimitedAvailability/i.test(avail) : null };
  }
  return null;
}

// Jacob (Shopware): ціна — itemprop="price" у блоці product-detail-buy. Якщо товару немає,
// ціни там нема, а в og/meta стоїть заглушка (напр. 100) — тож загальні парсери не застосовуємо.
function jacob(html) {
  const i = html.indexOf('class="product-detail-buy"');
  if (i < 0) return null;
  const box = html.slice(i, i + 20000);
  const p = box.match(/<meta[^>]+itemprop=["']price["'][^>]*content=["']([^"']+)/i);
  if (!p) {
    if (/Benachrichtigen, sobald wieder verfügbar/i.test(box))
      throw Object.assign(new Error('товару немає в наявності — Jacob не показує ціну'), { noOffers: true });
    return null;
  }
  return { price: num(p[1]), currency: 'EUR', available: /In den Warenkorb/i.test(box) && !/Benachrichtigen, sobald wieder verfügbar/i.test(box) };
}

const amazonUS = html => { const r = amazon(html); return r && { ...r, currency: 'USD' }; };

const DE = 'de-DE,de;q=0.9,en;q=0.5';
const SHOPS_DE = [
  // ✅ парсяться звичайним запитом (з ПК користувача)
  { re: /(^|\.)mindfactory\.de$/, name: 'Mindfactory', lang: DE },                 // JSON-LD
  { re: /(^|\.)alternate\.de$/, name: 'Alternate', lang: DE },                     // JSON-LD
  { re: /(^|\.)arlt\.com$/, name: 'ARLT', lang: DE, currency: 'EUR' },             // microdata
  { re: /(^|\.)future-x\.de$/, name: 'Future-X', lang: DE },                       // microdata
  { re: /(^|\.)mediamarkt\.de$/, name: 'MediaMarkt', parse: ldDeep, lang: DE },    // JSON-LD BuyAction→ProductGroup
  { re: /(^|\.)saturn\.de$/, name: 'Saturn', parse: ldDeep, lang: DE },            // те саме, що MediaMarkt
  { re: /(^|\.)jacob\.de$/, name: 'Jacob Elektronik', parse: jacob, lang: DE },
  { re: /(^|\.)e-tec\.at$/, name: 'e-tec.at', lang: DE },                          // JSON-LD
  { re: /(^|\.)ditech\.at$/, name: 'DiTech.at', lang: DE },
  { re: /(^|\.)office-partner\.de$/, name: 'office-partner.de', lang: DE },        // microdata
  // ⛔ з ПК користувача блокують (403 Cloudflare/«bot detected»/капча/TLS/таймаут) — лишаємо для перевірки з GitHub Actions
  { re: /(^|\.)alza\.de$/, name: 'alza.de', lang: DE },
  { re: /(^|\.)caseking\.de$/, name: 'Caseking', lang: DE },
  { re: /(^|\.)proshop\.de$/, name: 'Proshop.de', lang: DE },
  { re: /(^|\.)notebooksbilliger\.de$/, name: 'notebooksbilliger.de', lang: DE },
  { re: /(^|\.)computeruniverse\.net$/, name: 'computeruniverse', lang: DE, currency: 'EUR' },
  { re: /(^|\.)otto\.de$/, name: 'Otto', lang: DE },
  { re: /(^|\.)kaufland\.de$/, name: 'Kaufland', lang: DE },
  { re: /(^|\.)pc-king\.de$/, name: 'PC-KING', lang: DE },
  { re: /(^|\.)electronis\.de$/, name: 'electronis.de', lang: DE },
  // США / міжнародні з доставкою в DE
  { re: /(^|\.)amazon\.com$/, name: 'Amazon.com', parse: amazonUS, lang: 'en-US,en;q=0.9', currency: 'USD' },
  { re: /(^|\.)newegg\.com$/, name: 'Newegg', lang: 'en-US,en;q=0.9', currency: 'USD' },
  { re: /(^|\.)bhphotovideo\.com$/, name: 'B&H Photo', lang: 'en-US,en;q=0.9', currency: 'USD' },
];

const SHOPS = [
  ...SHOPS_DE,
  { re: /(^|\.)hotline\.ua$/, name: 'Hotline', special: 'hotline' },
  { re: /(^|\.)price\.ua$/, name: 'Price.ua (мін. ціна)' },
  { re: /(^|\.)amazon\.de$/, name: 'Amazon.de', parse: amazon, lang: 'de-DE,de;q=0.9,en;q=0.5' },
  { re: /(^|\.)geizhals\.(de|at|eu)$/, name: 'Geizhals', parse: geizhals, lang: 'de-DE,de;q=0.9' },
  { re: /(^|\.)red-tech\.de$/, name: 'Red Tech', lang: 'de-DE,de;q=0.9' },
  { re: /(^|\.)cyberport\.de$/, name: 'Cyberport', lang: 'de-DE,de;q=0.9' },
  // Galaxus не відповідає на запити бота (висить до таймауту) — одна спроба, таймаут = блок
  { re: /(^|\.)galaxus\.(de|ch|at)$/, name: 'Galaxus', lang: 'de-DE,de;q=0.9', tries: 1, timeoutIsBlock: true },
  { re: /(^|\.)pcpartpicker\.com$/, name: 'PCPartPicker', currency: 'USD' },
  // Українські магазини, перевірено 2026-11-15:
  //   JSON-LD — Telemart, KTC, Click.ua, Citrus, Touch; microdata — Moyo, Epicentr;
  //   блокують (Cloudflare / 403 / JS-челендж) — Rozetka, Allo, Comfy, Foxtrot, Brain, ITbox, MTA, Can.ua, ELMIR, EXE.ua
  { re: /(^|\.)rozetka\.com\.ua$/, name: 'Rozetka' },
  { re: /(^|\.)telemart\.ua$/, name: 'Telemart' },
  { re: /(^|\.)comfy\.ua$/, name: 'Comfy' },
  { re: /(^|\.)foxtrot\.com\.ua$/, name: 'Foxtrot' },
  { re: /(^|\.)moyo\.ua$/, name: 'Moyo' },
  { re: /(^|\.)brain\.com\.ua$/, name: 'Brain' },
  { re: /(^|\.)ktc\.ua$/, name: 'KTC' },
  { re: /(^|\.)elmir\.ua$/, name: 'ELMIR' },
  { re: /(^|\.)allo\.ua$/, name: 'Allo' },
  { re: /(^|\.)citrus\.(com\.)?ua$/, name: 'Citrus' },
  { re: /(^|\.)epicentrk?\.ua$/, name: 'Epicentr' },
  { re: /(^|\.)itbox\.ua$/, name: 'ITbox' },
  { re: /(^|\.)mta\.ua$/, name: 'MTA' },
  { re: /(^|\.)exe\.ua$/, name: 'EXE.ua' },
  { re: /(^|\.)click\.ua$/, name: 'Click.ua' },
  { re: /(^|\.)can\.ua$/, name: 'Can.ua' },
  { re: /(^|\.)touch\.com\.ua$/, name: 'Touch' },
];

export function shopOf(url) {
  let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
  return SHOPS.find(s => s.re.test(host)) || { name: host || '?' };
}

// Посилання Hotline «Купити» (/go/price/<id>/) — 302 на сторінку товару в магазині
async function resolveHotlineGo(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) {
    const u = new URL(loc, url);
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^hotline$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  }
  throw Object.assign(new Error('посилання Hotline на магазин більше не діє'), { gone: true });
}

// Ціна за довільним посиланням на товар
export async function fetchPrice(url) {
  if (/^https?:\/\/(www\.)?hotline\.ua\/go\//i.test(url)) {
    const target = await resolveHotlineGo(url);
    if (!/hotline\.ua\/go\//i.test(target)) { await sleep(1000); return fetchPrice(target); }
  }
  const shop = shopOf(url);
  if (shop.special === 'hotline') { const h = await hotlineProduct(url); return { ...h, shop: 'Hotline (мін. ціна)' }; }
  let text, finalUrl;
  try { ({ text, url: finalUrl } = await get(url, { lang: shop.lang, tries: shop.tries })); }
  catch (e) {
    if (shop.timeoutIsBlock && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      throw Object.assign(new Error('магазин не відповідає автоматичним запитам (таймаут)'), { blocked: true });
    throw e;
  }
  const r = (shop.parse && shop.parse(text)) || fromLd(text) || fromMicro(text) || fromMeta(text);
  if (!r || !r.price) throw Object.assign(new Error(/amazon\./.test(url) ? 'Amazon не показує ціну автоматичним запитам' : 'не вдалося знайти ціну на сторінці'), { blocked: /amazon\./.test(url) });
  const host = new URL(finalUrl).hostname;
  let currency = r.currency || shop.currency || (/\.(de|at|eu|ch)$/.test(host) ? 'EUR' : 'UAH');
  if (/^(грн|uah|₴)/i.test(currency)) currency = 'UAH';
  if (/^(€|eur)/i.test(currency)) currency = 'EUR';
  return { shop: shop.name, title: cleanTitle(r.title || title(text)), price: r.price, currency, available: r.available ?? null, url };
}
