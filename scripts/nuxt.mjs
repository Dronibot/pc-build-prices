// Розбір window.__NUXT__ (Nuxt 2) як ДАНИХ, без виконання JS сторінки.
// Формат: (function(a,b,...){ [a.x=...;]* return {...} }(arg1,arg2,...))
// Підтримуються JS-літерали: об'єкти, масиви, рядки, числа, true/false/null/void 0, ідентифікатори-параметри.

class P {
  constructor(s, vars = {}) { this.s = s; this.i = 0; this.vars = vars; }
  ws() { const s = this.s; while (this.i < s.length && /\s/.test(s[this.i])) this.i++; }
  peek() { this.ws(); return this.s[this.i]; }
  eat(ch) { this.ws(); if (this.s[this.i] !== ch) throw new Error(`expected ${ch} at ${this.i}: ${this.s.slice(this.i, this.i + 40)}`); this.i++; }
  ident() {
    this.ws(); const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) throw new Error('ident at ' + this.i + ': ' + this.s.slice(this.i, this.i + 40));
    this.i += m[0].length; return m[0];
  }
  str() {
    const q = this.s[this.i]; let j = this.i + 1, out = '';
    while (true) {
      const c = this.s[j];
      if (c === undefined) throw new Error('unterminated string');
      if (c === q) break;
      if (c === '\\') {
        const n = this.s[j + 1];
        if (n === 'u') { out += String.fromCharCode(parseInt(this.s.slice(j + 2, j + 6), 16)); j += 6; continue; }
        if (n === 'x') { out += String.fromCharCode(parseInt(this.s.slice(j + 2, j + 4), 16)); j += 4; continue; }
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[n] ?? n; j += 2; continue;
      }
      out += c; j++;
    }
    this.i = j + 1; return out;
  }
  value() {
    const c = this.peek(), s = this.s;
    if (c === '{') return this.obj();
    if (c === '[') return this.arr();
    if (c === '"' || c === "'") return this.str();
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(this.i, this.i + 40));
    if (num) { this.i += num[0].length; return Number(num[0]); }
    const id = this.ident();
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'null') return null;
    if (id === 'undefined') return undefined;
    if (id === 'void') { this.value(); return undefined; }
    if (id === 'Array' && this.peek() === '(') { this.eat('('); const n = this.value(); this.eat(')'); return new Array(n).fill(null); }
    if (id === 'new' || id === 'Date') { // new Date(...) або подібне — пропускаємо
      let depth = 0; while (this.i < s.length) { const ch = s[this.i]; if (ch === '(') depth++; if (ch === ')') { depth--; if (depth === 0) { this.i++; break; } } if (depth === 0 && /[,}\]]/.test(ch)) break; this.i++; }
      return null;
    }
    let v = Object.prototype.hasOwnProperty.call(this.vars, id) ? this.vars[id] : undefined;
    // доступ до властивостей a.b.c
    while (this.s[this.i] === '.') { this.i++; const k = this.ident(); v = v == null ? undefined : v[k]; }
    if (this.s[this.i] === '(') { // виклик (напр. Object.create(null)) — не виконуємо, пропускаємо
      let depth = 0;
      while (this.i < s.length) {
        const ch = s[this.i];
        if (ch === '"' || ch === "'") { this.str(); continue; }
        if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth === 0) { this.i++; break; } }
        this.i++;
      }
      return {};
    }
    return v;
  }
  key() {
    const c = this.peek();
    if (c === '"' || c === "'") return this.str();
    const m = /^[\w$]+/.exec(this.s.slice(this.i, this.i + 200)); this.i += m[0].length; return m[0];
  }
  obj() {
    this.eat('{'); const o = {};
    if (this.peek() === '}') { this.i++; return o; }
    while (true) {
      const k = this.key(); this.eat(':'); o[k] = this.value();
      const c = this.peek(); this.i++;
      if (c === '}') return o; if (c !== ',') throw new Error('obj sep ' + c + ' at ' + this.i);
    }
  }
  arr() {
    this.eat('['); const a = [];
    if (this.peek() === ']') { this.i++; return a; }
    while (true) {
      a.push(this.value()); const c = this.peek(); this.i++;
      if (c === ']') return a; if (c !== ',') throw new Error('arr sep ' + c + ' at ' + this.i);
    }
  }
}

export function parseNuxt(html) {
  const m = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!m) return null;
  const src = m[1].trim();
  const head = /^\(function\(([^)]*)\)\{/.exec(src);
  if (!head) return null;
  const params = head[1].split(',').map(x => x.trim()).filter(Boolean);
  // знайти кінець тіла функції: збалансовані дужки з урахуванням рядків
  let i = head[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'") { const p = new P(src); p.i = i; p.str(); i = p.i; continue; }
    if (c === '{') depth++; else if (c === '}') depth--;
    i++;
  }
  const body = src.slice(head[0].length, i - 1);
  // аргументи: (...)) в кінці
  const ap = new P(src); ap.i = i; ap.eat('(');
  const args = [];
  if (ap.peek() !== ')') while (true) { args.push(ap.value()); const c = ap.peek(); ap.i++; if (c === ')') break; }
  const vars = {}; params.forEach((p, k) => { vars[p] = args[k]; });
  // тіло: необов'язкові присвоєння "a.x=...;" і потім "return {...}"
  const bp = new P(body, vars);
  while (bp.i < body.length) {
    bp.ws();
    if (body.startsWith('return', bp.i)) { bp.i += 6; return bp.value(); }
    // присвоєння виду a.b=value; або a[0]=value;
    const id = bp.ident(); let target = vars[id], key = null;
    const path = [];
    while (body[bp.i] === '.' || body[bp.i] === '[') {
      if (body[bp.i] === '.') { bp.i++; path.push(bp.ident()); }
      else { bp.i++; path.push(bp.value()); bp.eat(']'); }
    }
    bp.eat('='); const val = bp.value();
    key = path.pop();
    for (const k of path) target = target?.[k];
    if (target && key !== undefined) target[key] = val;
    if (bp.peek() === ';') bp.i++;
  }
  return null;
}
