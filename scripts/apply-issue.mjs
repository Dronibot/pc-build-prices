// Застосовує заміну деталі з GitHub issue до data/overrides.json.
//
//   node scripts/apply-issue.mjs            — розібрати ISSUE_BODY і записати/видалити заміну
//   node scripts/apply-issue.mjs --report   — надрукувати Markdown-коментар з результатом (для gh issue comment)
//
// Env: ISSUE_BODY, ISSUE_TITLE, ISSUE_NUMBER, ISSUE_AUTHOR, ISSUE_ASSOC (author_association),
//      DATA_DIR (типово ../data — для тестів), RESULT_FILE (типово $RUNNER_TEMP/apply-result.json),
//      GITHUB_OUTPUT (якщо є — пишемо ok=/action=).
// Без залежностей.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || path.join(HERE, '..', 'data'));
const RESULT_FILE = process.env.RESULT_FILE || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'apply-result.json');
const ALLOWED_ASSOC = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const readJson = (f, def) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }
  catch (e) { if (def !== undefined) return def; throw e; }
};
const writeJson = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1) + '\n');

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

// ---------- розбір тіла issue ----------

// Назви полів (заголовки issue form або ключі "key: value") -> внутрішній ключ
const ALIASES = {
  build: 'build', 'збірка': 'build', 'зборка': 'build',
  part: 'part', 'деталь': 'part', 'категорія': 'part',
  name: 'name', 'назва': 'name',
  url: 'url', link: 'url', 'посилання': 'url',
  hotline: 'hotline', 'hotline.ua': 'hotline',
};
function keyOf(label) {
  const l = String(label).trim().toLowerCase();
  const paren = l.match(/\(([a-z]+)\)\s*$/); // "Збірка (build)"
  if (paren && ALIASES[paren[1]]) return ALIASES[paren[1]];
  if (ALIASES[l]) return ALIASES[l];
  const first = l.split(/[\s(]/)[0];
  return ALIASES[first] || null;
}
const emptyVal = v => { const t = (v ?? '').trim(); return t === '_No response_' || t === 'None' ? '' : t; };

export function parseBody(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n');
  const out = {};
  // 1) Формат GitHub issue form: "### <label>\n\n<value>\n\n"
  const parts = text.split(/^###[ \t]+/m);
  if (parts.length > 1) {
    for (const chunk of parts.slice(1)) {
      const nl = chunk.indexOf('\n');
      const label = nl < 0 ? chunk : chunk.slice(0, nl);
      const value = nl < 0 ? '' : chunk.slice(nl + 1);
      const k = keyOf(label);
      if (k && !(k in out)) out[k] = emptyVal(value);
    }
  }
  // 2) Простий формат "key: value" по рядках (не перезаписує поля з форми)
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-zА-Яа-яІіЇїЄєҐґ.]+)\s*[:=]\s*(.*)$/);
    if (!m) continue;
    const k = keyOf(m[1]);
    if (k && !(k in out)) out[k] = emptyVal(m[2]);
  }
  return out;
}

// ---------- валідація ----------

const CTRL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu; // керуючі, bidi-override, zero-width тощо
const clean = s => String(s ?? '').replace(CTRL, '').replace(/\s+/g, ' ').trim();

function isBadHost(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return 'порожній хост';
  if (h.startsWith('[') || h.includes(':')) return 'IP-адреси не дозволені';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return 'IP-адреси не дозволені';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost не дозволений';
  if (/\.(local|internal|lan|home|arpa)$/.test(h)) return 'локальні адреси не дозволені';
  if (!h.includes('.')) return 'хост має бути доменним іменем';
  return null;
}

function checkUrl(raw, field, { hotlineOnly = false } = {}) {
  const s = String(raw).trim();
  if (s.length > 500) fail(`${field}: посилання довше за 500 символів.`);
  if (/[\s\p{Cc}]/u.test(s)) fail(`${field}: посилання не може містити пробілів або керуючих символів.`);
  let u;
  try { u = new URL(s); } catch { fail(`${field}: це не схоже на посилання (очікується https://...).`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(`${field}: дозволені лише посилання http:// або https://.`);
  if (u.username || u.password) fail(`${field}: посилання не може містити логін/пароль.`);
  const bad = isBadHost(u.hostname);
  if (bad) fail(`${field}: ${bad}.`);
  if (hotlineOnly && !(u.protocol === 'https:' && (u.hostname === 'hotline.ua' || u.hostname === 'www.hotline.ua')))
    fail(`${field}: має бути посилання на https://hotline.ua/... або порожньо.`);
  return u.href;
}

export function validate(fields, config, title = '') {
  let build = clean(fields.build).toLowerCase();
  let part = clean(fields.part).toLowerCase();
  let url = clean(fields.url);
  // Заголовок «Скинути: user cpu» / «Скинути: user/cpu» — скорочена форма
  const t = String(title || '').trim();
  const tm = t.match(/^(Скинути|Заміна)\s*:\s*([a-z0-9_-]+)\s*[\s/·:,-]\s*([a-z0-9_-]+)/i);
  if (tm) { build ||= tm[2].toLowerCase(); part ||= tm[3].toLowerCase(); }
  if (/^Скинути\s*:/i.test(t) && !url) url = 'reset';

  const builds = config.builds || [];
  if (!build) fail(`Не вказано збірку (build). Можливі значення: ${builds.map(b => b.id).join(', ')}.`);
  const b = builds.find(x => x.id === build);
  if (!b) fail(`Невідома збірка «${build.slice(0, 40)}». Можливі значення: ${builds.map(x => x.id).join(', ')}.`);
  const partIds = b.parts.map(p => p.id);
  if (!part) fail(`Не вказано деталь (part). Можливі значення: ${partIds.join(', ')}.`);
  if (!partIds.includes(part)) fail(`У збірці «${build}» немає деталі «${part.slice(0, 40)}». Можливі значення: ${partIds.join(', ')}.`);
  if (!url) fail('Не вказано посилання (url). Щоб повернути оригінальну деталь, напишіть reset.');

  if (url.toLowerCase() === 'reset') return { action: 'reset', build, part };

  const finalUrl = checkUrl(url, 'url');
  const name = clean(fields.name);
  if (!name) fail('Не вказано назву деталі (name).');
  if (name.length > 200) fail(`Назва задовга (${name.length} символів, максимум 200).`);
  const hl = clean(fields.hotline);
  const hotline = hl ? checkUrl(hl, 'hotline', { hotlineOnly: true }) : '';
  return { action: 'set', build, part, name, url: finalUrl, ...(hotline ? { hotline } : {}) };
}

// ---------- застосування ----------

function apply() {
  const assoc = process.env.ISSUE_ASSOC;
  if (assoc && !ALLOWED_ASSOC.includes(assoc)) fail('Лише власник репо може змінювати збірку.');
  const config = readJson('config.json');
  const fields = parseBody(process.env.ISSUE_BODY);
  const v = validate(fields, config, process.env.ISSUE_TITLE);
  const overrides = readJson('overrides.json', {});
  const issue = Number(process.env.ISSUE_NUMBER) || null;
  const by = clean(process.env.ISSUE_AUTHOR).slice(0, 100) || null;
  const previous = overrides[v.build]?.[v.part] || null;

  if (v.action === 'reset') {
    if (overrides[v.build]) {
      delete overrides[v.build][v.part];
      if (!Object.keys(overrides[v.build]).length) delete overrides[v.build];
    }
  } else {
    overrides[v.build] ||= {};
    overrides[v.build][v.part] = {
      name: v.name, url: v.url, ...(v.hotline ? { hotline: v.hotline } : {}),
      by, at: new Date().toISOString(), issue,
    };
  }
  writeJson('overrides.json', overrides);
  return { ok: true, ...v, issue, by, hadPrevious: !!previous };
}

function saveResult(res) {
  try { fs.writeFileSync(RESULT_FILE, JSON.stringify(res, null, 1)); } catch (e) { console.error('Не вдалося записати RESULT_FILE:', e.message); }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${res.ok}\naction=${res.action || ''}\n`);
  }
}

// ---------- коментар з результатом ----------

// Безпечний вивід тексту користувача в Markdown: без згадок @, без розмітки коду
const md = s => String(s ?? '').replace(CTRL, '').replace(/[`<>]/g, '').replace(/@/g, '@\u200b').replace(/([*_[\]|\\#])/g, '\\$1');
const link = u => `<${String(u).replace(/[<>\s]/g, '')}>`;
const fmtPrice = it => `**${[it.price, it.currency].filter(Boolean).join(' ')}**` + (it.shop ? ` (${md(it.shop)})` : '');

function report() {
  let res;
  try { res = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); }
  catch { res = { ok: false, error: 'Скрипт заміни не виконався (немає файлу результату). Див. лог workflow.' }; }
  const lines = [];
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;

  if (!res.ok) {
    lines.push('❌ **Заміну не застосовано.**', '', md(res.error || 'Невідома помилка.'), '',
      'Відредагуйте issue (виправте поля) — робот перевірить ще раз.');
  } else {
    const config = readJson('config.json', { builds: [], categories: {} });
    const b = config.builds.find(x => x.id === res.build);
    const cat = config.categories?.[res.part] || res.part;
    const where = `${md(b?.title || res.build)} → ${md(cat)}`;
    if (res.action === 'reset') {
      lines.push(`↩️ **Повернуто оригінальну деталь:** ${where}.`);
      if (!res.hadPrevious) lines.push('', '_(Заміни для цієї деталі й так не було.)_');
    } else {
      const prices = readJson('prices.json', { items: {} });
      const it = prices.items?.[res.url];
      lines.push(`✅ **Деталь замінено:** ${where}`, '', `- **Назва:** ${md(res.name)}`, `- **Посилання:** ${link(res.url)}`);
      if (it?.ok) lines.push(`- **Ціна:** ${fmtPrice(it)}`);
      else if (it) lines.push(`- **Ціна:** не вдалося отримати — ${md(it.error || 'помилка')}${it.blocked ? ' (магазин блокує автоматичні запити; ціну можна вказати через посилання Hotline)' : ''}`);
      else lines.push('- **Ціна:** ще не перевірена — з\'явиться після наступного оновлення.');
      if (res.hotline) {
        const h = prices.items?.[res.hotline];
        lines.push(`- **Hotline:** ${link(res.hotline)}${h?.ok ? ` — ${fmtPrice(h)}` : h ? ` — ${md(h.error || 'помилка')}` : ''}`);
      } else {
        const am = prices.autoMatch?.[res.url];
        if (am) lines.push(`- **Hotline (автопідбір):** ${md(am.title)} ${link(am.url)}`);
      }
    }
  }
  if (res.ok && process.env.PRICE_OUTCOME === 'failure') lines.push('', '⚠️ Перевірка ціни завершилася з помилкою — ціна оновиться під час наступного планового запуску.');
  if (res.ok && process.env.COMMIT_OUTCOME === 'failure') lines.push('', '⚠️ **Не вдалося зберегти зміни в репо (git push).** Issue залишено відкритим — відредагуйте його, щоб спробувати ще раз.');
  if (runUrl) lines.push('', `<sub>[Лог виконання](${runUrl})</sub>`);
  process.stdout.write(lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n');
}

// ---------- main ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--report')) {
    report();
  } else {
    try {
      const res = apply();
      saveResult(res);
      console.log(res.action === 'reset'
        ? `Скинуто заміну: ${res.build}/${res.part}`
        : `Заміна: ${res.build}/${res.part} → ${res.name} (${res.url})`);
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `Внутрішня помилка: ${e.message}`;
      saveResult({ ok: false, error: msg });
      console.error('Помилка:', msg);
      process.exit(1);
    }
  }
}
