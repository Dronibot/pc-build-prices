// Geizhals.de: усі пропозиції магазинів з доставкою в Німеччину для товару.
// Увага: Geizhals блокує IP дата-центрів (GitHub Actions) — працює з домашнього інтернету.
import { get } from './sources.mjs';

const GH = 'https://geizhals.de';
const num = s => { if (s == null) return null; const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const unesc = s => (s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export async function geizhalsProduct(url) {
  const { text } = await get(url, { lang: 'de-DE,de;q=0.9,en;q=0.5' });
  const t = unesc((text.match(/<title>([^<]+)/i)?.[1] || '').replace(/&#xa0;|&nbsp;/g, ' '));
  const title = t.replace(/\s*ab\s*€.*$/, '').replace(/\s*\|.*$/, '').trim();
  const offers = [];
  for (const seg0 of text.split(/id="offer-index-\d+"/).slice(1)) {
    const seg = seg0.slice(0, 12000);
    const price = num(seg.match(/gh_price">€\s*([\d.,]+)/)?.[1]);
    const shop = unesc(seg.match(/merchant: '([^']+)'/)?.[1]);
    const redir = seg.match(/(?:https:\/\/geizhals\.de)?(\/redir\/[A-Za-z0-9_\-]+)/)?.[1];
    // доставка: перша сума € у блоці доставки
    const delivery = seg.match(/class="offer__delivery[\s\S]{0,2500}?<\/div>\s*<\/div>/)?.[0] || '';
    const shipM = delivery.match(/€\s*([\d.,]+)/);
    const ship = shipM ? num(shipM[1]) : null;
    const avail = /lagernd|sofort|1-3 Werktage|verfügbar/i.test(delivery.replace(/<[^>]+>/g, ' ')) ? true : null;
    if (price && shop) offers.push({ shop, price, ship, total: ship != null ? Math.round((price + ship) * 100) / 100 : null, url: redir ? GH + redir : url, available: avail });
  }
  const m = t.match(/ab\s*€\s*([\d.,]+)/);
  if (!offers.length) {
    if (/keine Angebote/i.test(text)) throw Object.assign(new Error('наразі немає пропозицій у Німеччині'), { noOffers: true });
    if (!m) throw new Error('не вдалося знайти ціни на Geizhals');
  }
  offers.sort((a, b) => a.price - b.price);
  // схожі моделі (меню «варіанти») — кандидати для заміни
  const variants = [];
  for (const v of text.matchAll(/<a\s+href="([^"]*-a\d+\.html)"\s+class="variant-dropdown-item[^"]*"[\s\S]*?<\/a>/g)) {
    const name = unesc(v[0].match(/variant-dropdown-item__name">([^<]+)/)?.[1] || '').trim();
    const p = num(v[0].match(/gh_price">€\s*([\d.,]+)/)?.[1]);
    const oc = parseInt(v[0].match(/(\d+)\s*Angebot/)?.[1] || '0', 10);
    const href = v[1].startsWith('http') ? v[1] : GH + '/' + v[1].replace(/^\//, '');
    if (name && p && href.split('?')[0] !== url.split('?')[0]) variants.push({ title: name, url: href, min: p, max: null, offers: oc, vendor: '' });
  }
  return {
    variants,
    shop: 'Geizhals (мін. ціна)', title, url, currency: 'EUR',
    price: offers[0]?.price ?? num(m?.[1]), min: offers[0]?.price ?? num(m?.[1]),
    max: offers.length ? offers[offers.length - 1].price : null,
    offerCount: offers.length || null, offers: offers.slice(0, 40), available: offers.length > 0,
  };
}
