// A fast, dependency-free Markdown renderer whose parse() returns exactly
// the HTML marked 18.1.3 renders with its default options (GFM on, breaks
// off). Written from scratch against the CommonMark 0.31.2 and GFM 0.29
// specifications, with the practice set used as an oracle for the places
// where marked departs from the spec. No code is copied from marked.
//
// Design: a line-based block parser (open-container stack, leaf blocks) and
// a single-pass inline parser built on a delimiter stack. parse() keeps no
// state between calls.

const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

// ---- character classification -------------------------------------------
function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }
// Unicode whitespace, used by the emphasis flanking rules (U+00A0 and
// friends count as whitespace there, but not as block spaces).
function isUnicodeWs(c) {
  if (isSpace(c)) return true;
  const cp = c.codePointAt(0);
  return cp === 0xA0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000;
}
function isDigit(c) { return c >= '0' && c <= '9'; }
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) { return c !== undefined && PUNCT.indexOf(c) >= 0; }
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}
// column width of leading whitespace (tab advances to next multiple of 4)
// `col0` is the absolute column of s[0]; returns the absolute column and
// the index of the first non-whitespace character.
function indentOf(s, col0) {
  let col = col0, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, i };
}

// ---- escaping ------------------------------------------------------------
// Text / code escaping: marked escapes & < > " ' in text and code content,
// except that an & starting a valid entity reference is left alone.
// (Named references are kept verbatim, even invented ones; numeric
// references are kept only when their value is a valid code point.)
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Length of a valid entity reference starting at s[i] ('&'), or 0.
function entityLenAt(s, i) {
  if (s[i] !== '&' || i + 1 >= s.length) return 0;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
    if (j === start || j >= s.length || s[j] !== ';') return 0;
    const code = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (code > 0x10FFFF) return 0;
    return j + 1 - i;
  }
  let j = i + 1;
  if (!isAlpha(s[j])) return 0;
  while (j < s.length && isAlnum(s[j])) j++;
  if (j < s.length && s[j] === ';') return j + 1 - i;
  return 0;
}
const ESC_RE = /&(#\d+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)?|[<>"']/g;
function esc(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return s.replace(ESC_RE, (m) => {
    if (m.length === 1) return m === '&' ? '&amp;' : ESC_MAP[m];
    // An entity-shaped match: a numeric reference above the valid
    // range is not an entity (escaped like a bare &).
    if (m[1] === '#') {
      const hex = m[2] === 'x' || m[2] === 'X';
      const code = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      if (code > 0x10FFFF) return '&amp;' + m.slice(1);
    }
    return m;
  });
}
// Escape for code content: `&` is always escaped (entities are not
// recognised inside code spans or code blocks).
const ESC_CODE_RE = /[&<>"']/g;
function escCode(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return s.replace(ESC_CODE_RE, (m) => ESC_MAP[m]);
}
// Attribute / URL escaping: a & that starts a valid entity reference is
// left alone (marked keeps &ouml; etc. verbatim in hrefs and titles).
function escAttr(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const len = entityLenAt(s, i);
      if (len > 0) { i += len - 1; continue; }
      out += s.slice(last, i) + '&amp;'; last = i + 1;
    } else if (c === '"') { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === "'") { out += s.slice(last, i) + '&#39;'; last = i + 1; }
    else if (c === '<') { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === '>') { out += s.slice(last, i) + '&gt;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}
// URL escaping for href/src: encode spaces and control chars, escape & < >
// (marked percent-encodes a bare space and leaves most punctuation alone).
function escHref(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], code = s.charCodeAt(i);
    if (c === ' ') { out += s.slice(last, i) + '%20'; last = i + 1; }
    else if (code < 32 || code === 127) { out += s.slice(last, i) + '%' + code.toString(16).toUpperCase().padStart(2, '0'); last = i + 1; }
    else if (code >= 128) {
      // Non-ASCII: percent-encode the code point as UTF-8.
      const cp = s.codePointAt(i);
      out += s.slice(last, i) + encodeURIComponent(String.fromCodePoint(cp));
      const adv = cp > 0xFFFF ? 2 : 1;
      last = i + adv; i += adv - 1;
    }
    else if (c === '\\') { out += s.slice(last, i) + '%5C'; last = i + 1; }
    else if (c === '&') {
      const len = entityLenAt(s, i);
      if (len > 0) { i += len - 1; continue; }
      out += s.slice(last, i) + '&amp;'; last = i + 1;
    } else if (c === '<') { out += s.slice(last, i) + '%3C'; last = i + 1; }
    else if (c === '>') { out += s.slice(last, i) + '%3E'; last = i + 1; }
    else if (c === '"') { out += s.slice(last, i) + '%22'; last = i + 1; }
    else if (c === "'") { out += s.slice(last, i) + '&#39;'; last = i + 1; }
    else if (c === '[') { out += s.slice(last, i) + '%5B'; last = i + 1; }
    else if (c === ']') { out += s.slice(last, i) + '%5D'; last = i + 1; }
    else if (c === '{') { out += s.slice(last, i) + '%7B'; last = i + 1; }
    else if (c === '}') { out += s.slice(last, i) + '%7D'; last = i + 1; }
    else if (c === '|') { out += s.slice(last, i) + '%7C'; last = i + 1; }
    else if (c === '^') { out += s.slice(last, i) + '%5E'; last = i + 1; }
    else if (c === '`') { out += s.slice(last, i) + '%60'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---- entities ------------------------------------------------------------
// Named HTML entities (the ones the spec examples and generated documents
// exercise, plus the common Latin-1, Greek, punctuation and math sets).
const ENT = {
  quot: '"', amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', iexcl: '\u00a1',
  cent: '\u00a2', pound: '\u00a3', curren: '\u00a4', yen: '\u00a5',
  brvbar: '\u00a6', sect: '\u00a7', uml: '\u00a8', copy: '\u00a9',
  ordf: '\u00aa', laquo: '\u00ab', not: '\u00ac', shy: '\u00ad',
  reg: '\u00ae', macr: '\u00af', deg: '\u00b0', plusmn: '\u00b1',
  sup2: '\u00b2', sup3: '\u00b3', acute: '\u00b4', micro: '\u00b5',
  para: '\u00b6', middot: '\u00b7', cedil: '\u00b8', sup1: '\u00b9',
  ordm: '\u00ba', raquo: '\u00bb', frac14: '\u00bc', frac12: '\u00bd',
  frac34: '\u00be', iquest: '\u00bf', Agrave: '\u00c0', Aacute: '\u00c1',
  Acirc: '\u00c2', Atilde: '\u00c3', Auml: '\u00c4', Aring: '\u00c5',
  AElig: '\u00c6', Ccedil: '\u00c7', Egrave: '\u00c8', Eacute: '\u00c9',
  Ecirc: '\u00ca', Euml: '\u00cb', Igrave: '\u00cc', Iacute: '\u00cd',
  Icirc: '\u00ce', Iuml: '\u00cf', ETH: '\u00d0', Ntilde: '\u00d1',
  Ograve: '\u00d2', Oacute: '\u00d3', Ocirc: '\u00d4', Otilde: '\u00d5',
  Ouml: '\u00d6', times: '\u00d7', Oslash: '\u00d8', Ugrave: '\u00d9',
  Uacute: '\u00da', Ucirc: '\u00db', Uuml: '\u00dc', Yacute: '\u00dd',
  THORN: '\u00de', szlig: '\u00df', agrave: '\u00e0', aacute: '\u00e1',
  acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5',
  aelig: '\u00e6', ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9',
  ecirc: '\u00ea', euml: '\u00eb', igrave: '\u00ec', iacute: '\u00ed',
  icirc: '\u00ee', iuml: '\u00ef', eth: '\u00f0', ntilde: '\u00f1',
  ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5',
  ouml: '\u00f6', divide: '\u00f7', oslash: '\u00f8', ugrave: '\u00f9',
  uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd',
  thorn: '\u00fe', yuml: '\u00ff', OElig: '\u0152', oelig: '\u0153',
  Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178', fnof: '\u0192',
  circ: '\u02c6', tilde: '\u02dc', Alpha: '\u0391', Beta: '\u0392',
  Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395', Zeta: '\u0396',
  Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039a',
  Lambda: '\u039b', Mu: '\u039c', Nu: '\u039d', Xi: '\u039e',
  Omicron: '\u039f', Pi: '\u03a0', Rho: '\u03a1', Sigma: '\u03a3',
  Tau: '\u03a4', Upsilon: '\u03a5', Phi: '\u03a6', Chi: '\u03a7',
  Psi: '\u03a8', Omega: '\u03a9', alpha: '\u03b1', beta: '\u03b2',
  gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5', zeta: '\u03b6',
  eta: '\u03b7', theta: '\u03b8', iota: '\u03b9', kappa: '\u03ba',
  lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be',
  omicron: '\u03bf', pi: '\u03c0', rho: '\u03c1', sigmaf: '\u03c2',
  sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5', phi: '\u03c6',
  chi: '\u03c7', psi: '\u03c8', omega: '\u03c9', thetasym: '\u03d1',
  upsih: '\u03d2', piv: '\u03d6', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e',
  rlm: '\u200f', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018',
  rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d',
  bdquo: '\u201e', dagger: '\u2020', Dagger: '\u2021', bull: '\u2022',
  hellip: '\u2026', permil: '\u2030', prime: '\u2032', Prime: '\u2033',
  lsaquo: '\u2039', rsaquo: '\u203a', oline: '\u203e', frasl: '\u2044',
  euro: '\u20ac', image: '\u2111', weierp: '\u2118', real: '\u211c',
  trade: '\u2122', alefsym: '\u2135', larr: '\u2190', uarr: '\u2191',
  rarr: '\u2192', darr: '\u2193', harr: '\u2194', crarr: '\u21b5',
  lArr: '\u21d0', uArr: '\u21d1', rArr: '\u21d2', dArr: '\u21d3',
  hArr: '\u21d4', forall: '\u2200', part: '\u2202', exist: '\u2203',
  empty: '\u2205', nabla: '\u2207', isin: '\u2208', notin: '\u2209',
  ni: '\u220b', prod: '\u220f', sum: '\u2211', minus: '\u2212',
  lowast: '\u2217', radic: '\u221a', prop: '\u221d', infin: '\u221e',
  ang: '\u2220', and: '\u2227', or: '\u2228', cap: '\u2229',
  cup: '\u222a', int: '\u222b', there4: '\u2234', sim: '\u223c',
  cong: '\u2245', asymp: '\u2248', ne: '\u2260', equiv: '\u2261',
  le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283',
  nsub: '\u2284', sube: '\u2286', supe: '\u2287', oplus: '\u2295',
  otimes: '\u2297', perp: '\u22a5', sdot: '\u22c5', lceil: '\u2308',
  rceil: '\u2309', lfloor: '\u230a', rfloor: '\u230b', lang: '\u2329',
  rang: '\u232a', loz: '\u25ca', spades: '\u2660', clubs: '\u2663',
  hearts: '\u2665', diams: '\u2666', apos: "'", Dcaron: '\u010e',
  dcaron: '\u010f', HilbertSpace: '\u210b', DifferentialD: '\u2146',
  ClockwiseContourIntegral: '\u2232', ngE: '\u2267\u0338',
  NotEqualTilde: '\u2242\u0338', Tab: '\t', NewLine: '\n',
  colon: ':', sol: '/', bsol: '\\', Hat: '^', check: '\u2713',
  cross: '\u2717', star: '\u2606', phone: '\u260e', female: '\u2640',
  male: '\u2642', sext: '\u2736',
};

// ---- entity decoding -----------------------------------------------------
// Decode a numeric entity reference starting at s[i] ('&'), or null when
// s[i] is not one. Named references are NOT decoded: marked keeps them
// verbatim in its output, and the escaper leaves them alone.
function decodeEntityAt(s, i) {
  if (s[i] !== '&' || s[i + 1] !== '#') return null;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
  if (j === start || j >= s.length || s[j] !== ';') return null;
  let code = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (code > 0x10FFFF) return null;
  if (!code || (code >= 0xD800 && code <= 0xDFFF)) code = 0xFFFD;
  return { ch: String.fromCodePoint(code), len: j + 1 - i };
}
// Decode entities in a whole string (used for link titles, code info, ...).
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      const d = decodeEntityAt(s, i);
      if (d) { out += s.slice(last, i) + d.ch; i += d.len - 1; last = i + 1; }
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---- link destination / title parsing ------------------------------------
// Parse a link destination starting at s[i] (after optional spaces).
// Returns {dest, next} where next is the index just past the destination,
// or null. `dest` is the raw destination string.
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === '>') return { dest: out, next: j + 1 };
      out += c; j++;
    }
    return null;
  }
  let j = i, depth = 0, out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') break;
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    if (c < ' ' ) return null;
    out += c; j++;
  }
  if (j === i) return null;
  return { dest: out, next: j };
}
// Parse a link title starting at s[i] (after optional spaces/newlines).
// Returns {title, next} or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === q) return { title: out, next: j + 1 };
      if (c === '\n' && q === '"') { /* titles may span lines */ }
      out += c; j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === ')') return { title: out, next: j + 1 };
      if (c === '(') return null;
      out += c; j++;
    }
    return null;
  }
  return null;
}
// Skip spaces/tabs/newlines (up to `maxNl` newlines, -1 = any).
function skipWs(s, i, maxNl) {
  let nl = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === '\n') { nl++; if (maxNl >= 0 && nl > maxNl) break; i++; }
    else break;
  }
  return i;
}
// Normalise a link label: collapse internal whitespace, case-fold.
// Unicode case folding: ß/ẞ fold to "ss" (JS toLowerCase maps ẞ to ß,
// not ss), plus the Latin ligatures that fold to two letters.
function normLabel(s) {
  return s.replace(/ß|ẞ/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ|ﬆ/g, 'st')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---- HTML tag recognition ------------------------------------------------
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section summary table tbody td tfoot th thead title tr track ul').split(' '));
// Try to read an HTML tag starting at s[i] ('<'). Returns {raw, next} or null.
function readHtmlTag(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  let j = i + 1;
  if (j < n && s[j] === '!') {
    if (s.startsWith('<!--', j - 1)) {
      // "<!-->" and "<!--->" are complete (empty) comments on their own.
      if (s.startsWith('<!-->', j - 1)) return { raw: '<!-->', next: i + 5 };
      if (s.startsWith('<!--->', j - 1)) return { raw: '<!--->', next: i + 6 };
      const e = s.indexOf('-->', j + 2);
      if (e < 0) return null;
      return { raw: s.slice(i, e + 3), next: e + 3 };
    }
    if (s.startsWith('<![CDATA[', j - 1)) {
      const e = s.indexOf(']]>', j + 8);
      if (e < 0) return null;
      return { raw: s.slice(i, e + 3), next: e + 3 };
    }
    // declaration <!A ...> or <!DOCTYPE ...>
    if (j + 1 < n && /[A-Z]/.test(s[j + 1])) {
      let k = j + 1;
      while (k < n && s[k] !== '>') k++;
      if (k >= n) return null;
      return { raw: s.slice(i, k + 1), next: k + 1 };
    }
    return null;
  }
  if (j < n && s[j] === '?') {
    const e = s.indexOf('?>', j + 1);
    if (e < 0) return null;
    return { raw: s.slice(i, e + 2), next: e + 2 };
  }
  let close = false;
  if (j < n && s[j] === '/') { close = true; j++; }
  if (j >= n || !isAlpha(s[j])) return null;
  const nameStart = j;
  while (j < n && (isAlnum(s[j]) || s[j] === '-')) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  // A closing tag takes no attributes: only whitespace, then ">".
  if (close) {
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k < n && s[k] === '>') return { raw: s.slice(i, k + 1), next: k + 1, name, close };
    return null;
  }
  // attributes (each attribute must be preceded by whitespace)
  let k = j, hadWs = false;
  while (k < n) {
    const c = s[k];
    if (c === '>') return { raw: s.slice(i, k + 1), next: k + 1, name, close };
    if (c === '/' && s[k + 1] === '>') return { raw: s.slice(i, k + 2), next: k + 2, name, close };
    if (c === ' ' || c === '\t' || c === '\n') { k++; hadWs = true; continue; }
    if (!hadWs) return null;
    if (isAlpha(c) || c === '_' || c === ':') {
      k++;
      while (k < n && (isAlnum(s[k]) || s[k] === '_' || s[k] === ':' || s[k] === '.' || s[k] === '-')) k++;
      k = skipWs(s, k, -1);
      if (s[k] === '=') {
        k = skipWs(s, k + 1, -1);
        if (s[k] === '"' || s[k] === "'") {
          const q = s[k]; k++;
          while (k < n && s[k] !== q) k++;
          if (k >= n) return null;
          k++;
        } else {
          while (k < n && !isSpace(s[k]) && s[k] !== '>' && s[k] !== '"' && s[k] !== "'" && s[k] !== '=' && s[k] !== '<' && s[k] !== '`') k++;
        }
      }
      // Whitespace skipped while parsing this attribute still counts
      // as the separator before the next attribute (boolean attributes
      // end right after the name, past the separating space).
      hadWs = s[k - 1] === ' ' || s[k - 1] === '\t' || s[k - 1] === '\n';
      continue;
    }
    return null;
  }
  return null;
}

// ---- inline parsing ------------------------------------------------------
// Nodes: {t:'text',s} {t:'code',s} {t:'html',s} {t:'br'} {t:'link',href,title,children}
//        {t:'img',src,title,alt} {t:'em',children} {t:'strong',children} {t:'del',children}
function isPunctChar(c) {
  if (c === undefined) return false;
  if (isPunct(c)) return true;
  const code = c.codePointAt(0);
  return code > 127 && /[\p{P}\p{S}]/u.test(c);
}
function trimAutolinkUrl(u) {
  let end = u.length;
  for (;;) {
    if (end === 0) break;
    const c = u[end - 1];
    if (c === ';') {
      const m = /&[A-Za-z0-9#]+;$/.exec(u.slice(0, end));
      if (m) { end -= m[0].length; continue; }
      // A bare trailing ';' is stripped by marked's _backpedal (it is
      // in the trailing-punctuation class); only a ';' that closes an
      // entity reference is kept (handled above).
      end--; continue;
    }
    if (c === ')' ) {
      let open = 0, close = 0;
      for (let i = 0; i < end; i++) { if (u[i] === '(') open++; else if (u[i] === ')') close++; }
      if (close > open) { end--; continue; }
      break;
    }
    if ('?.!,:\'"'.indexOf(c) >= 0 || c === ']' || c === '}') { end--; continue; }
    // marked's _backpedal also strips a trailing run of * ~ _ ' "
    // (e.g. www.mark.com** or www.down.com/output~~ must not swallow
    // the emphasis/delimiter run that follows the URL).
    if (c === '*' || c === '~' || c === '_' || c === "'" || c === '"') { end--; continue; }
    break;
  }
  return u.slice(0, end);
}
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![A-Za-z0-9_-])/;
const EMAIL_RE_FULL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;
// Match a bare email at s[i]. marked's email regex has a (?![\w-])
// lookahead, so it backtracks to a shorter domain when the address is
// followed by -/_/alnum (e.g. first@x.example.com- links only
// first@x.example). Exception: when the address is followed by a `_`
// run that can close an active `_` opener, marked re-tokenizes inside
// the resulting <em> and links the whole address — so link it in full.
function emailAt(s, i, delims) {
  const full = EMAIL_RE_FULL.exec(s.slice(i));
  if (full) {
    const end = i + full[0].length;
    if (s[end] === '_') {
      let j = end;
      while (j < s.length && s[j] === '_') j++;
      const prev = s[end - 1], next = j < s.length ? s[j] : '';
      const leftFlank = next !== '' && !isUnicodeWs(next) && (!isPunctChar(next) || prev === '' || isUnicodeWs(prev) || isPunctChar(prev));
      const rightFlank = prev !== '' && !isUnicodeWs(prev) && (!isPunctChar(prev) || next === '' || isUnicodeWs(next) || isPunctChar(next));
      const canClose = rightFlank && (!leftFlank || isPunctChar(next));
      if (canClose && delims && delims.some(d => d.char === '_' && d.active && d.canOpen)) {
        return { text: full[0], next: end };
      }
    }
  }
  const em = EMAIL_RE.exec(s.slice(i));
  if (!em) return null;
  return { text: em[0], next: i + em[0].length };
}
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;
// Does the `]` at s[j] close an active `[` label that will form a link?
// marked skips its bare-URL tokenizer inside a link label, so a bare URL
// there must not swallow the closing `]` (otherwise tryLink never sees
// it). Outside a link, a bare URL keeps the `]` (marked's backpedal
// does not strip it).
function labelCloseAt(s, j, delims, refs) {
  let op = null;
  for (let d = delims.length - 1; d >= 0; d--) {
    if (delims[d].char === '[' && delims[d].active) { op = delims[d]; break; }
  }
  if (!op) return false;
  const after = s[j + 1];
  if (after === '(' || after === '[') return true;
  if (op.pos !== undefined && refs) {
    const raw = s.slice(op.pos + op.len, j);
    if (refs[normLabel(raw)]) return true;
  }
  return false;
}
function tryExtAutolink(s, i, delims, refs) {
  // www. autolink
  if (s.startsWith('www.', i)) {
    const m = DOMAIN_RE.exec(s.slice(i + 4));
    if (m) {
      let end = i + 4 + m[0].length, j = end;
      while (j < s.length && !isSpace(s[j]) && s[j] !== '<') {
        if (s[j] === ']' && labelCloseAt(s, j, delims, refs)) break;
        j++;
      }
      let url = trimAutolinkUrl(s.slice(i, j));
      if (url.length > 4) return { href: 'http://' + url, text: url, next: i + url.length };
    }
    return null;
  }
  // scheme:// autolink and scheme:email autolink
  const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(s.slice(i));
  if (sm) {
    const scheme = sm[0];
    if (s.startsWith('://', i + scheme.length - 1 + 1 - 1)) { /* unreachable guard */ }
    if (s.slice(i + scheme.length, i + scheme.length + 2) === '//') {
      let j = i + scheme.length + 2;
      while (j < s.length && !isSpace(s[j]) && s[j] !== '<') {
        if (s[j] === ']' && labelCloseAt(s, j, delims, refs)) break;
        j++;
      }
      let url = trimAutolinkUrl(s.slice(i, j));
      if (url.length > scheme.length + 3) return { href: url, text: url, next: i + url.length };
      return null;
    }
    // scheme:email[/path] — only the lowercase schemes xmpp: and
    // mailto: form a scheme autolink; xmpp: allows one path segment,
    // mailto: does not. Any other scheme is literal text and the email
    // after it is a bare email autolink instead.
    if (scheme === 'xmpp:' || scheme === 'mailto:') {
      const em = emailAt(s, i + scheme.length, delims);
      if (em) {
        let end = em.next;
        if (scheme === 'xmpp:' && s[end] === '/') {
          let j = end + 1;
          while (j < s.length && !isSpace(s[j]) && s[j] !== '<' && s[j] !== '/' && s[j] !== '?' && s[j] !== '#') j++;
          if (j > end + 1) {
            const url = trimAutolinkUrl(s.slice(i, j));
            if (url.length > end - i) return { href: url, text: url, next: i + url.length };
          }
        }
        const url = trimAutolinkUrl(s.slice(i, end));
        return { href: url, text: url, next: i + url.length };
      }
    }
    return null;
  }
  // bare email autolink
  const em = emailAt(s, i, delims);
  if (em) return { href: 'mailto:' + em.text, text: em.text, next: em.next };
  return null;
}
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.s;
    else if (nd.t === 'code') out += nd.s;
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'br') out += '\n';
    else if (nd.t === 'img') out += nd.alt;
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}
// Replace bare-URL autolinks ("ext") in a node list with plain text
// nodes (their display text); angle-bracket autolinks are left alone.
function flattenExtAuto(list) {
  for (let i = 0; i < list.length; i++) {
    const nd = list[i];
    if (nd.t === 'link' && nd.auto === 'ext') {
      list[i] = { t: 'text', s: nd.children ? plainText(nd.children) : nd.href };
    } else if (nd.children) {
      flattenExtAuto(nd.children);
    }
  }
}
function inlineParse(s, refs) {
  const nodes = [];
  const delims = []; // {char,node,off,len,canOpen,canClose,active,image}
  // Fast path: most inline strings contain no bare-URL/email autolink
  // candidate at all (no www. / :// / @). Skip every per-word autolink
  // attempt and word-start break when there is nothing to find.
  const hasAuto = s.includes('www.') || s.includes('://') || s.includes('@');
  function addText(str) {
    if (!str) return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === 'text') last.s += str;
    else nodes.push({ t: 'text', s: str });
  }
  function textNodeFor(offLen) {
    // the text node currently being appended to (must exist)
    let last = nodes[nodes.length - 1];
    if (!last || last.t !== 'text') { nodes.push({ t: 'text', s: '' }); last = nodes[nodes.length - 1]; }
    return last;
  }
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    // --- extended autolinks (only at a word start) ---
    if (hasAuto && (c === 'w' || isAlpha(c)) && (i === 0 || isSpace(s[i - 1]) || isPunctChar(s[i - 1]))) {
      if (c === 'w' || s[i + 1] === ':' || true) {
        const au = tryExtAutolink(s, i, delims, refs);
        if (au) { nodes.push({ t: 'link', href: au.href, title: null, children: [{ t: 'text', s: au.text }], auto: 'ext' }); i = au.next; continue; }
      }
    }
    if (c === '\\') {
      if (i + 1 < n && s[i + 1] === '\n') { nodes.push({ t: 'br' }); i += 2; continue; }
      if (i + 1 < n && isPunct(s[i + 1])) {
        // A backslash-escaped & is literal, not an entity start: emit
        // it pre-escaped so the text escaper leaves it alone.
        addText(s[i + 1] === '&' ? '&amp;' : s[i + 1]); i += 2; continue;
      }
      addText('\\'); i++; continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const run = j - i;
      // find a matching run of exactly `run` backticks
      let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let e = k;
          while (e < n && s[e] === '`') e++;
          if (e - k === run) { found = k; break; }
          k = e;
        } else k++;
      }
      if (found >= 0) {
        let content = s.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 'code', s: content });
        i = found + run; continue;
      }
      addText(s.slice(i, j)); i = j; continue;
    }
    if (c === '&') {
      const d = decodeEntityAt(s, i);
      if (d) { addText(d.ch); i += d.len; continue; }
      addText('&'); i++; continue;
    }
    if (c === '<') {
      // autolink <scheme:...> or <email>
      const m = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/.exec(s.slice(i, i + 400));
      const em2 = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(s.slice(i, i + 400));
      if (m) {
        const url = m[0].slice(1, -1);
        nodes.push({ t: 'link', href: url, title: null, children: [{ t: 'text', s: url }], auto: 'angle' });
        i += m[0].length; continue;
      }
      if (em2) {
        const addr = em2[1];
        nodes.push({ t: 'link', href: 'mailto:' + addr, title: null, children: [{ t: 'text', s: addr }], auto: 'angle' });
        i += em2[0].length; continue;
      }
      const tag = readHtmlTag(s, i);
      if (tag) { nodes.push({ t: 'html', s: tag.raw }); i = tag.next; continue; }
      addText('&lt;'); i++; continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      if (image) addText('!['); else addText('[');
      const nd = textNodeFor();
      delims.push({ char: '[', node: nd, off: nd.s.length - (image ? 2 : 1), len: image ? 2 : 1, canOpen: true, canClose: false, active: true, image, pos: i });
      i += image ? 2 : 1; continue;
    }
    if (c === ']') {
      const res = tryLink(s, i, nodes, delims, refs);
      if (res) { i = res.next; continue; }
      addText(']'); i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const run = j - i;
      if (c === '~') {
        if (run === 1 || run === 2) {
          addText(s.slice(i, j));
          const nd = textNodeFor();
          const prev = i > 0 ? s[i - 1] : '';
          const next = j < n ? s[j] : '';
          const leftFlank = next !== '' && !isUnicodeWs(next) && (!isPunctChar(next) || prev === '' || isUnicodeWs(prev) || isPunctChar(prev));
          const rightFlank = prev !== '' && !isUnicodeWs(prev) && (!isPunctChar(prev) || next === '' || isUnicodeWs(next) || isPunctChar(next));
          delims.push({ char: '~', node: nd, off: nd.s.length - run, len: run, canOpen: leftFlank, canClose: rightFlank, active: true, image: false });
        } else {
          addText(s.slice(i, j));
        }
        i = j; continue;
      }
      const prev = i > 0 ? s[i - 1] : '';
      const next = j < n ? s[j] : '';
      const leftFlank = next !== '' && !isUnicodeWs(next) && (!isPunctChar(next) || prev === '' || isUnicodeWs(prev) || isPunctChar(prev));
      const rightFlank = prev !== '' && !isUnicodeWs(prev) && (!isPunctChar(prev) || next === '' || isUnicodeWs(next) || isPunctChar(next));
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || isPunctChar(prev));
        canClose = rightFlank && (!leftFlank || isPunctChar(next));
      } else {
        canOpen = leftFlank; canClose = rightFlank;
      }
      addText(s.slice(i, j));
      const nd = textNodeFor();
      delims.push({ char: c, node: nd, off: nd.s.length - run, len: run, canOpen, canClose, active: true, image: false });
      i = j; continue;
    }
    if (c === '\n') {
      // hard break: two or more trailing spaces (all are stripped)
      const last = nodes[nodes.length - 1];
      if (last && last.t === 'text' && last.s.length >= 2 && last.s.endsWith('  ')) {
        last.s = last.s.replace(/[ \t]+$/, '');
        if (last.s === '') nodes.pop();
        nodes.push({ t: 'br' });
      } else {
        addText('\n');
      }
      i++; continue;
    }
    // plain text run: up to next special char, or up to a word start
    // where an extended autolink (www./scheme/email) could begin
    let j = i;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' || ch === '`' || ch === '&' || ch === '<' || ch === '[' || ch === ']' || ch === '*' || ch === '_' || ch === '~' || ch === '\n' || ch === '!') break;
      if (hasAuto && j > i && (ch === 'w' || isAlpha(ch)) && (isSpace(s[j - 1]) || isPunctChar(s[j - 1]))) break;
      j++;
    }
    if (j === i) { addText(c); i++; continue; }
    addText(s.slice(i, j)); i = j;
  }
  resolveEmphasis(nodes, delims);
  return renderNodes(nodes);
}

// ---- link resolution (called when ']' is scanned) ------------------------
function tryLink(s, i, nodes, delims, refs) {
  for (let d = delims.length - 1; d >= 0; d--) {
    const op = delims[d];
    if (!op.active || op.char !== '[') continue;
    const opIdx = nodes.indexOf(op.node);
    if (opIdx < 0) { op.active = false; continue; }
    const tailText = op.node.s.slice(op.off + op.len);
    const text = tailText + plainText(nodes.slice(opIdx + 1));
    let j = i + 1, href = null, title = null, next = -1;
    if (s[j] === '(') {
      // Inline link: if it does not parse, fall through to the
      // shortcut reference below instead of giving up on the opener.
      let k = skipWs(s, j + 1, -1);
      let dest = null;
      if (s[k] === ')') dest = { dest: '', next: k };
      else dest = parseDest(s, k);
      if (dest) {
        let m = skipWs(s, dest.next, -1);
        const t = parseTitle(s, m);
        if (t) { title = t.title; m = skipWs(s, t.next, -1); }
        if (s[m] === ')') { href = dest.dest; next = m + 1; }
      }
    }
    if (href === null && s[j] === '[') {
      // Full reference link: a label that does not resolve deactivates
      // the opener (it must not fall through to a shortcut, or a
      // following "[bar][baz]" could never form).
      let k = j + 1, label = null;
      if (s[k] === ']') { label = text; k++; }
      else {
        const e = s.indexOf(']', k);
        // The label may not contain an unescaped '['; an escaped
        // "\[" is fine and stays part of the raw label.
        let bad = e < 0;
        if (!bad) {
          for (let p = k; p < e; p++) {
            if (s[p] === '[' && (p === k || s[p - 1] !== '\\')) { bad = true; break; }
          }
        }
        if (!bad) { label = s.slice(k, e); k = e + 1; }
      }
      if (label === null || label === '' || normLabel(label) === '') { op.active = false; return null; }
      const ref = refs[normLabel(label)];
      if (!ref) { op.active = false; return null; }
      href = ref.dest; title = ref.title; next = k;
    }
    if (href === null) {
      // Shortcut reference link. The label is the link text, but
      // backslash escapes are kept verbatim for matching ("foo\!" does
      // not match a "foo!" definition), so when the raw source of the
      // text contains a backslash, match on the raw source instead of
      // the unescaped plain text.
      let label = text;
      if (op.pos !== undefined) {
        const raw = s.slice(op.pos + op.len, i);
        if (raw.indexOf('\\') >= 0) label = raw;
      }
      if (label === '' || normLabel(label) === '') { op.active = false; return null; }
      const ref = refs[normLabel(label)];
      if (!ref) { op.active = false; return null; }
      href = ref.dest; title = ref.title; next = i + 1;
    }
    // A link's text must not contain another (non-autolink) link:
    // marked discards the outer link when a regular link is emitted
    // inside its label, but ANGLE autolinks nest inside it, and bare
    // URLs/emails are tokenized as plain text there (marked skips its
    // `url` tokenizer while inLink). Images are allowed, and an
    // image's alt text may contain one as plain text.
    if (!op.image) {
      const hasLink = (list) => {
        for (const nd of list) {
          if (nd.t === 'link' && !nd.auto) return true;
          if (nd.children && hasLink(nd.children)) return true;
        }
        return false;
      };
      if (hasLink(nodes.slice(opIdx + 1))) { op.active = false; return null; }
    }
    // Deactivate any '[' delimiters inside the link text.
    for (let q = 0; q < delims.length; q++) {
      const dd = delims[q];
      if (dd.char === '[' && dd.active && nodes.indexOf(dd.node) > opIdx) dd.active = false;
    }
    op.active = false;
    // Split the opener's text node at the '[': the tail after it is the
    // first of the link's children. Delimiters pointing into the tail
    // move to the new node with adjusted offsets.
    const tnode = op.node;
    const tail = tnode.s.slice(op.off + op.len);
    const children = [];
    let tailNode = null;
    if (tail !== '') {
      tailNode = { t: 'text', s: tail };
      children.push(tailNode);
      for (let q = 0; q < delims.length; q++) {
        const dd = delims[q];
        if (dd.node === tnode && dd.off > op.off) { dd.node = tailNode; dd.off = dd.off - (op.off + op.len); }
      }
    }
    tnode.s = tnode.s.slice(0, op.off);
    children.push(...nodes.splice(opIdx + 1));
    // Bare-URL/email autolinks inside the link text are plain text in
    // marked (its `url` tokenizer is skipped while inLink); angle
    // autolinks stay nested.
    flattenExtAuto(children);
    if (tnode.s === '') nodes.splice(opIdx, 1);
    if (op.image) {
      const alt = plainText(children);
      nodes.push({ t: 'img', src: href, title, alt, children });
    } else {
      nodes.push({ t: 'link', href, title, children });
    }
    return { next };
  }
  return null;
}
// ---- emphasis resolution -------------------------------------------------
function resolveEmphasis(nodes, delims) {
  const inNodes = (d) => nodes.indexOf(d.node) >= 0;
  // Process closers in scan order; a closer with length left after a wrap
  // keeps looking for an earlier opener.
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || !inNodes(closer)) continue;
    if (closer.char !== '*' && closer.char !== '_' && closer.char !== '~') continue;
    if (!closer.canClose) continue;
    while (closer.active && closer.len > 0 && closer.canClose && inNodes(closer)) {
      let found = null;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = delims[oi];
        if (!opener.active || opener.char !== closer.char || !inNodes(opener)) continue;
        if (!opener.canOpen) continue;
        if (closer.char !== '~') {
          const oneCanBoth = (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
          const odd = oneCanBoth
            && ((opener.len + closer.len) % 3 === 0) && (opener.len % 3 !== 0 || closer.len % 3 !== 0);
          if (odd) continue;
        }
        if (closer.char === '~' && opener.len !== closer.len) continue;
        found = opener;
        break;
      }
      if (!found) break;
      const use = closer.char === '~' ? closer.len : (found.len >= 2 && closer.len >= 2 ? 2 : 1);
      // marked quirk: when this closer is an ambiguous run (can both
      // open and close) matching an OPENER-LIKE inner opener (preceded
      // by space/punct, so marked's scan counts it toward the opener's
      // total), an earlier still-active opener A with (A.len +
      // closer.len) divisible by 3 and A.len not divisible by 3 has
      // this closer skipped by marked's rule of 3 — and the inner
      // opener's length keeps A's count above zero at the next closer,
      // so A can never match (e.g. `*a **b**c*` leaves the outer `*`
      // literal while the inner `**` still forms <strong>). Kill such
      // openers — but only when the next closer after this one is a
      // plain closer too short to absorb the count; otherwise A may
      // still match later (cf. cm-411 `*foo**bar**baz*`, where the
      // inner `**` is ambiguous, not opener-like, and the outer em
      // DOES form).
      if (closer.char !== '~' && closer.canOpen && closer.canClose
        && found.canOpen && !found.canClose) {
        const fi = delims.indexOf(found);
        const ci2 = delims.indexOf(closer);
        let D = null;
        for (let di = ci2 + 1; di < delims.length; di++) {
          const dd = delims[di];
          if (dd.active && dd.char === closer.char && dd.canClose && inNodes(dd)) { D = dd; break; }
        }
        if (D && !D.canOpen) {
          for (let ai = 0; ai < fi; ai++) {
            const A = delims[ai];
            if (!A.active || A.char !== closer.char || !A.canOpen || !inNodes(A)) continue;
            if (A.len % 3 !== 0 && (A.len + closer.len) % 3 === 0) {
              let sumOpener = 0;
              for (let xi = ai + 1; xi < ci2; xi++) {
                const X = delims[xi];
                if (X.active && X.char === closer.char && X.canOpen && !X.canClose) sumOpener += X.len;
              }
              if (D.len < A.len + sumOpener) A.active = false;
            }
          }
        }
      }
      wrapEmphasis(nodes, found, closer, use, delims);
    }
  }
  // Recurse into children that may hold unresolved delimiters.
  for (const nd of nodes) {
    if (nd.children && nd.children.length) resolveEmphasis(nd.children, delims);
  }
}
function wrapEmphasis(nodes, opener, closer, use, delims) {
  const oi = nodes.indexOf(opener.node);
  const ci = nodes.indexOf(closer.node);
  if (oi < 0 || ci < 0 || oi > ci) return;
  const onode = opener.node, cnode = closer.node;
  const oText = onode.s, cText = cnode.s;
  // Opener: consumed chars are the LAST `use` of its run.
  const oLeft = oText.slice(0, opener.off) + oText.slice(opener.off, opener.off + opener.len - use);
  const oMid = oText.slice(opener.off + opener.len);
  // Closer: consumed chars are the FIRST `use` of its run.
  const cBefore = cText.slice(0, closer.off);
  const cAfter = cText.slice(closer.off + use, closer.off + closer.len) + cText.slice(closer.off + closer.len);
  const children = [];
  let oMidNode = null, innerNode = null, cBeforeNode = null;
  if (oi === ci) {
    if (oMid !== '' || cBefore !== '') {
      // same node: content is between the two runs
      const inner = oText.slice(opener.off + opener.len, closer.off);
      if (inner !== '') { innerNode = { t: 'text', s: inner }; children.push(innerNode); }
    }
  } else {
    if (oMid !== '') { oMidNode = { t: 'text', s: oMid }; children.push(oMidNode); }
    for (let k = oi + 1; k < ci; k++) children.push(nodes[k]);
    if (cBefore !== '') { cBeforeNode = { t: 'text', s: cBefore }; children.push(cBeforeNode); }
  }
  const type = closer.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
  const emNode = { t: type, children };
  const replacement = [];
  let oLeftNode = null, cAfterNode = null;
  if (oLeft !== '') { oLeftNode = { t: 'text', s: oLeft }; replacement.push(oLeftNode); }
  replacement.push(emNode);
  if (cAfter !== '') { cAfterNode = { t: 'text', s: cAfter }; replacement.push(cAfterNode); }
  nodes.splice(oi, ci - oi + 1, ...replacement);
  const oLen = opener.len, cLen = closer.len;
  const oOff = opener.off, cOff = closer.off;
  opener.len -= use;
  closer.len -= use;
  if (opener.len <= 0) opener.active = false;
  else if (oLeftNode) { opener.node = oLeftNode; opener.off = oLeftNode.s.length - opener.len; }
  if (closer.len <= 0) closer.active = false;
  else if (cAfterNode) { closer.node = cAfterNode; closer.off = 0; }
  // Re-point every other delimiter that sat in the split text nodes:
  // the runs they mark now live in the new nodes. (A delimiter's run is
  // non-empty, so the target node always exists when it is needed.)
  // oOff/cOff are the opener/closer offsets BEFORE the two delimiters
  // above were re-pointed; the loop must use those, not the mutated ones.
  if (delims) {
    for (const dd of delims) {
      if (dd === opener || dd === closer || !dd.active) continue;
      if (dd.node === onode) {
        if (dd.off < oOff) { if (oLeftNode) dd.node = oLeftNode; }
        else if (oi !== ci && dd.off >= oOff + oLen) { if (oMidNode) { dd.node = oMidNode; dd.off -= oOff + oLen; } }
        else if (oi === ci && dd.off >= oOff + oLen && dd.off < cOff) { if (innerNode) { dd.node = innerNode; dd.off -= oOff + oLen; } }
      }
      if (dd.node === cnode) {
        if (oi !== ci && dd.off < cOff) { if (cBeforeNode) dd.node = cBeforeNode; }
        else if (dd.off >= cOff + cLen) { if (cAfterNode) { dd.node = cAfterNode; dd.off -= cOff + use; } }
      }
    }
  }
  // The remaining (unconsumed) delimiter chars stay as text; the
  // delimiter offsets now point at the run start, which holds them.
}
// ---- rendering -----------------------------------------------------------
function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += esc(nd.s); break;
      case 'code': out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'link': {
        out += '<a href="' + escHref(nd.href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>' + renderNodes(nd.children) + '</a>';
        break;
      }
      case 'img': {
        // The alt text is the plain text of the (emphasis-resolved)
        // children, computed at render time so emphasis inside the
        // image text is stripped rather than left literal.
        const alt = nd.children ? plainText(nd.children) : nd.alt;
        out += '<img src="' + escHref(nd.src) + '" alt="' + escAttr(alt) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>';
        break;
      }
      case 'em': out += '<em>' + renderNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.children) + '</del>'; break;
    }
  }
  return out;
}

// ---- block parsing -------------------------------------------------------
// Column-aware helpers. A line is handled as a string plus the absolute
// column of its first character (col0). Tabs advance to the next multiple
// of 4. Removing a container prefix expands the line's leading tabs to
// spaces (that is how marked renders them); removing an indented-code
// indent does not expand tabs that survive the strip.
function stripColumns(str, col0, n) {
  let i = 0, col = col0, left = n, lead = '';
  while (left > 0 && i < str.length) {
    const ch = str[i];
    if (ch === ' ') { i++; col++; left--; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (w <= left) { i++; col += w; left -= w; }
      else { lead = ' '.repeat(w - left); col += left; left = 0; i++; }
    } else break;
  }
  return { str: lead + str.slice(i), col0: col };
}
function expandLeadingTabs(str, col0) {
  let out = '', col = col0, i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ') { out += ' '; i++; col++; }
    else if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); i++; col += w; }
    else break;
  }
  return out + str.slice(i);
}
function stripPrefix(str, col0, n) {
  const r = stripColumns(str, col0, n);
  return { str: expandLeadingTabs(r.str, r.col0), col0: r.col0 };
}
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}
// Does a paragraph line end with a hard break (2+ trailing spaces/tabs,
// or an unescaped trailing backslash)?
function endsWithHardBreak(line) {
  let k = line.length, ws = 0;
  while (k > 0 && (line[k - 1] === ' ' || line[k - 1] === '\t')) { k--; ws++; }
  if (ws >= 2) return true;
  if (ws > 0) return false;
  let bs = 0;
  while (k > 0 && line[k - 1] === '\\') { k--; bs++; }
  return bs % 2 === 1;
}

// Split a table row on unescaped pipes outside code spans.
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n) {
      // An escaped pipe is a literal pipe in the cell (the backslash
      // is consumed by the table split, so a code span holding it
      // renders just "|"); other escapes are left for inline parsing.
      if (line[i + 1] === '|') { cur += '|'; i += 2; continue; }
      cur += line[i] + line[i + 1]; i += 2; continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && line[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (line[k] === '`') {
          let e = k;
          while (e < n && line[e] === '`') e++;
          if (e - k === run) { found = k; break; }
          k = e;
        } else k++;
      }
      if (found >= 0) {
        // The table split consumes "\|" even inside a code span, so
        // the cell's code span holds a bare "|" (a backslash that is
        // itself escaped, "\\|", is left alone).
        cur += line.slice(i, found + run).replace(/(?<!\\)\\\|/g, '|');
        i = found + run;
      }
      else { cur += line.slice(i, j); i = j; }
      continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  let first = 0;
  while (first < n && (line[first] === ' ' || line[first] === '\t')) first++;
  if (line[first] === '|' && cells[0] === '') cells.shift();
  let last = n - 1;
  while (last >= 0 && (line[last] === ' ' || line[last] === '\t')) last--;
  if (line[last] === '|' && cells[cells.length - 1] === '') cells.pop();
  return cells;
}
function tryTable(lines) {
  // The delimiter row must not be indented more than 3 columns.
  {
    let cols = 0;
    for (const ch of lines[1]) {
      if (ch === ' ') cols++;
      else if (ch === '\t') cols += 4 - (cols % 4);
      else break;
    }
    if (cols > 3) return null;
  }
  const header = splitTableRow(lines[0]);
  if (header.length === 0) return null;
  const delim = splitTableRow(lines[1]);
  if (delim.length !== header.length) return null;
  const aligns = [];
  for (const cell of delim) {
    if (!/^:?-+:?$/.test(cell)) return null;
    aligns.push(cell[0] === ':' && cell[cell.length - 1] === ':' ? 'center'
      : cell[0] === ':' ? 'left' : cell[cell.length - 1] === ':' ? 'right' : null);
  }
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const row = splitTableRow(lines[i]);
    while (row.length < header.length) row.push('');
    rows.push(row.slice(0, header.length));
  }
  return { t: 'table', header, aligns, rows };
}

// Parse a link reference definition at the start of s[i]. Returns
// {label, dest, title, next} or null.
function parseRefDef(s, i) {
  let j = i, spaces = 0;
  while (j < s.length && s[j] === ' ' && spaces < 3) { j++; spaces++; }
  if (s[j] !== '[') return null;
  let k = j + 1, label = '';
  while (k < s.length && s[k] !== ']') {
    if (s[k] === '[') return null;
    // Backslash escapes are kept verbatim in the label: labels match
    // on their raw text ("ref\[" matches "ref\[", not "ref[").
    if (s[k] === '\\' && k + 1 < s.length && isPunct(s[k + 1])) { label += s[k] + s[k + 1]; k += 2; continue; }
    label += s[k]; k++;
  }
  if (k >= s.length || s[k] !== ']' || label === '' || label.length > 999) return null;
  if (normLabel(label) === '') return null;
  k++;
  if (s[k] !== ':') return null;
  k++;
  const m = skipWs(s, k, 1);
  const dest = parseDest(s, m);
  if (!dest) return null;
  // After the destination: optional spaces/tabs, then an optional title.
  let q = dest.next;
  while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
  let title = null, endPos;
  if (q >= s.length || s[q] === '\n') {
    // Title may be on the next line, alone on its line.
    if (q < s.length) {
      let r = q + 1;
      while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
      const t = parseTitle(s, r);
      if (t) {
        let e = t.next;
        while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e++;
        if (e >= s.length || s[e] === '\n') {
          title = t.title;
          return { label, dest: dest.dest, title, next: e < s.length ? e + 1 : e };
        }
      }
    }
    endPos = q;
  } else {
    // A title on the same line must be separated from the destination
    // by whitespace; "<bar>(baz)" is not a definition.
    if (q === dest.next) return null;
    const t = parseTitle(s, q);
    if (!t) return null;
    title = t.title;
    let e = t.next;
    while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e++;
    if (e < s.length && s[e] !== '\n') return null;
    endPos = e;
  }
  return { label, dest: dest.dest, title, next: endPos < s.length ? endPos + 1 : endPos };
}

function parseDoc(lines, refs) {
  const doc = { t: 'doc', children: [], parent: null };
  const open = [doc];
  let cur = '', col0 = 0;
  const tip = () => open[open.length - 1];
  function clearBlankFlags(node) {
    let n = node;
    while (n) { n.endsWithBlank = false; n = n.parent; }
  }
  function noteBlank() {
    // A blank line nested inside a blockquote does not make an
    // enclosing list loose: when the innermost open block is a
    // blockquote, do not set the flag on list/item ancestors.
    const inBq = tip().t === 'bq';
    let n = tip();
    while (n) {
      if (!(inBq && (n.t === 'list' || n.t === 'item'))) n.endsWithBlank = true;
      n = n.parent;
    }
  }
  function addBlock(parent, node) {
    if (parent.t === 'item' && parent.endsWithBlank && parent.children.length > 0 && parent.parent) {
      parent.parent.loose = true;
    }
    if (parent.t === 'list' && parent.endsWithBlank) parent.loose = true;
    node.parent = parent;
    parent.children.push(node);
    clearBlankFlags(parent);
  }
  function closeTip() {
    const node = open.pop();
    if (node.t === 'para') {
      const final = finalizePara(node, refs);
      const idx = node.parent.children.indexOf(node);
      if (final) { node.parent.children[idx] = final; final.parent = node.parent; }
      else node.parent.children.splice(idx, 1);
    } else if (node.t === 'code' && !node.fenced) {
      // Indented code: all trailing blank (whitespace-only) lines go.
      while (node.lines.length && node.lines[node.lines.length - 1].trim() === '') node.lines.pop();
    } else if (node.t === 'code' && node.fenced) {
      // Fenced code: exactly one trailing empty line goes (the newline
      // before the closing fence / end of the block is not content).
      if (node.lines.length && node.lines[node.lines.length - 1] === '') node.lines.pop();
    }
  }
  function closeTo(depth, openEnded) {
    while (open.length > depth) {
      const node = open[open.length - 1];
      if (openEnded && node.t === 'html') node.noTrail = true;
      closeTip();
    }
  }
  // Finalise a paragraph: strip leading link reference definitions,
  // detect a task-list marker, detect a table.
  function finalizePara(para) {
    const text = para.lines.join('\n');
    let pos = 0;
    for (;;) {
      const d = parseRefDef(text, pos);
      if (!d) break;
      const key = normLabel(d.label);
      if (!(key in refs)) refs[key] = { dest: d.dest, title: d.title };
      pos = d.next;
    }
    let rest = text.slice(pos).replace(/^\n+/, '');
    if (rest.trim() === '') return null;
    const restLines = rest.split('\n');
    // Task list: first paragraph of a list item starting with [ ] / [x].
    const parent = para.parent;
    if (parent && parent.t === 'item' && parent.children[0] === para) {
      const m = /^\[( |x|X)\](?:[ \t]|$)/.exec(restLines[0]);
      if (m) {
        parent.task = m[1] === ' ' ? ' ' : 'x';
        restLines[0] = restLines[0].slice(m[0].length);
        if (restLines[0] === '' && restLines.length === 1) return null;
      }
    }
    if (restLines.length >= 2) {
      const tbl = tryTable(restLines);
      if (tbl) return tbl;
    }
    return { t: 'para', lines: restLines };
  }

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    // A line is blank when it is blank in the source, or when the
    // container prefixes were removed and nothing is left. Whitespace
    // left behind by a prefix removal (e.g. ">  " leaves " ") is
    // paragraph content, not a blank line.
    const srcBlank = isBlankStr(rawLine);
    const isBlankLine = () => srcBlank || cur === '';
    cur = rawLine; col0 = 0;
    let lazy = false;
    // ---- phase 1: match open containers ----
    let depth = 1, failed = false;
    while (depth < open.length) {
      const blk = open[depth];
      if (blk.t === 'bq') {
        const ind = indentOf(cur, col0);
        if (ind.col - col0 <= 3 && cur[ind.i] === '>') {
          let p = ind.i + 1, c = ind.col + 1;
          if (cur[p] === ' ' || cur[p] === '\t') {
            const r = stripPrefix(cur.slice(p), c, 1);
            cur = r.str; col0 = r.col0;
          } else { cur = cur.slice(p); col0 = c; }
          depth++;
        } else if (isBlankStr(cur)) { cur = ''; depth++; }
        else { failed = true; break; }
      } else if (blk.t === 'list') {
        depth++;
      } else if (blk.t === 'item') {
        if (isBlankStr(cur)) { cur = ''; depth++; }
        else {
          const ind = indentOf(cur, col0);
          if (ind.col - col0 >= blk.contentIndent) {
            // An empty item that has seen a blank line is closed for
            // indented content: a following indented line is not part
            // of it (a new list marker can still start a new item).
            if (blk.children.length === 0 && blk.endsWithBlank) { failed = true; break; }
            const r = stripPrefix(cur, col0, blk.contentIndent);
            cur = r.str; col0 = r.col0;
            depth++;
          } else { failed = true; break; }
        }
      } else break;
    }
    if (failed) {
      const t = tip();
      // Effective close depth: if the failure is at an item and the
      // line does not start a new item in the parent list, the list
      // itself must close too (otherwise a following paragraph would
      // land inside the <ul>/<ol> as a bare child).
      let effDepth = depth;
      let act0 = null;
      if (open[depth] && open[depth].t === 'item') {
        const parentList = open[depth - 1];
        act0 = blockStart(cur, col0, false);
        if (!(act0 && act0.kind === 'list' && parentList && parentList.t === 'list' && act0.key === parentList.key)) {
          effDepth = depth - 1;
        }
      }
      if (t.t === 'para' && !isBlankLine()) {
        // Lazy continuation: a line indented 4+ columns is an
        // indented-code-like line, which cannot interrupt a paragraph,
        // so it is always lazy. Otherwise the line is lazy only when it
        // cannot start a new block at all (any list marker, heading,
        // fence, HTML block, or thematic break ends the paragraph and
        // its containers). A setext underline does NOT end it: the
        // underline is outside the paragraph's container, so it cannot
        // convert the paragraph, and it is a lazy continuation line.
        const ind = indentOf(cur, col0);
        if (ind.col - col0 >= 4) { lazy = true; }
        else {
          let isBlockStart = false;
          if (act0 || blockStart(cur, col0, false)) isBlockStart = true;
          if (!isBlockStart) lazy = true;
          else closeTo(effDepth, true);
        }
      } else {
        closeTo(effDepth, true);
      }
    }
    if (lazy) {
      // Lazy continuation line of a paragraph: append as text.
      const para = tip();
      let content = cur;
      // A setext underline as a lazy line: if the paragraph already
      // has a lazy line, its leading spaces become 4 spaces (a leading
      // tab is kept as-is); the first lazy underline is appended as-is.
      const setextM = /^[ \t]*([=-]+)[ \t]*$/.exec(content);
      if (setextM) {
        if (para.hasLazy && content[0] !== '\t') {
          const lead = content.match(/^ */)[0];
          content = '    ' + content.slice(lead.length);
        }
        if (para.lines.length && endsWithHardBreak(para.lines[para.lines.length - 1])) {
          content = content.replace(/^[ \t]+/, '');
        }
        para.lines.push(content);
        para.hasLazy = true;
        continue;
      }
      if (para.parent !== doc) {
        const ind = indentOf(content, col0);
        if (ind.col - col0 >= 4) {
          const r = stripColumns(content, col0, 4);
          content = r.str; col0 = r.col0;
        }
        content = expandLeadingTabs(content, col0);
      }
      // A line following a hard break loses its leading whitespace.
      if (para.lines.length && endsWithHardBreak(para.lines[para.lines.length - 1])) {
        content = content.replace(/^[ \t]+/, '');
      }
      para.lines.push(content);
      para.hasLazy = true;
      continue;
    }
    // ---- phase 2: open leaf continuation ----
    const leaf = tip();
    if (leaf.t === 'code' && leaf.fenced) {
      const ind = indentOf(cur, col0);
      let closing = false;
      if (ind.col - col0 <= 3) {
        let p = ind.i;
        let run = 0;
        while (cur[p] === leaf.fence) { p++; run++; }
        if (run >= leaf.fenceLen) {
          const rest = cur.slice(p);
          if (leaf.fence === '`' ? isBlankStr(rest) : true) closing = true;
        }
      }
      if (closing) { closeTip(); continue; }
      const r = leaf.fenceIndent > 0 ? stripColumns(cur, col0, leaf.fenceIndent) : { str: cur, col0 };
      leaf.lines.push(r.str);
      continue;
    }
    if (leaf.t === 'html') {
      // Types 2-5 end only at their closing marker (they run through
      // blank lines); types 6-7 end at a blank line.
      if ((leaf.htmlType === 6 || leaf.htmlType === 7) && isBlankLine()) {
        leaf.noTrail = true;
        closeTip();
        noteBlank();
        continue;
      }
      leaf.lines.push(cur);
      let end = false;
      if (leaf.htmlType === 1 && cur.toLowerCase().includes('</' + leaf.endTag)) end = true;
      else if (leaf.htmlType === 2 && cur.includes('-->')) end = true;
      else if (leaf.htmlType === 3 && cur.includes('?>')) end = true;
      else if (leaf.htmlType === 4 && cur.includes('>')) end = true;
      else if (leaf.htmlType === 5 && cur.includes(']]>')) end = true;
      if (end) closeTip();
      continue;
    }
    if (leaf.t === 'code' && !leaf.fenced) {
      // A blank line in the source closes an enclosing blockquote
      // (and the code with it) instead of joining the code: the next
      // ">" line starts a new blockquote.
      let inBq = false;
      if (isBlankStr(cur) && srcBlank) {
        let p = leaf.parent;
        while (p) { if (p.t === 'bq') { inBq = true; break; } p = p.parent; }
      }
      if (inBq) { closeTip(); /* fall through to the blank line */ }
      else if (isBlankStr(cur)) {
        // A blank line keeps its content past the 4-column code
        // indent (e.g. six spaces become two), not an empty string.
        const r = stripColumns(cur, col0, 4);
        leaf.lines.push(r.str);
        continue;
      } else {
        const ind = indentOf(cur, col0);
        if (ind.col - col0 >= 4) {
          const r = stripColumns(cur, col0, 4);
          leaf.lines.push(r.str);
          continue;
        }
        closeTip();
        // fall through to phase 3 with the line reprocessed
      }
    }
    // ---- blank line ----
    if (isBlankLine()) {
      // marked's table-body regex only excludes SPACE-only blank
      // lines, so a whitespace line containing a tab is swallowed
      // as an (empty) table row when the open paragraph is a table.
      const tp0 = tip();
      if (tp0.t === 'para' && cur.indexOf('\t') >= 0 && isBlankStr(cur)
        && tp0.lines.length >= 2 && tryTable(tp0.lines)) {
        tp0.lines.push(cur);
        continue;
      }
      if (tip().t === 'para') closeTip();
      // A blank line directly after an HTML block removes the block's
      // trailing newline (marked renders the raw block text up to, but
      // not including, the newline before the blank line).
      const t = tip();
      if (t.children && t.children.length) {
        const last = t.children[t.children.length - 1];
        if (last.t === 'html') last.noTrail = true;
      }
      // A blank line in the source closes open blockquotes (a following
      // ">" line starts a NEW blockquote); lists and list items stay
      // open across blank lines. A line that only becomes empty after
      // a container marker is removed (e.g. ">") does not close it.
      // noteBlank runs first, while the tip is still the blockquote,
      // so a blank line nested in a quote does not loosen the list.
      noteBlank();
      if (srcBlank) { while (tip().t === 'bq') closeTip(); }
      continue;
    }
    // ---- phase 3: new blocks / paragraph ----
    for (;;) {
      const curTip = tip();
      if (curTip.t === 'para') {
        // Setext underline: convert the paragraph into a heading. Any
        // link reference definitions leading the paragraph are kept.
        const ind = indentOf(cur, col0);
        if (ind.col - col0 <= 3) {
          const rest = cur.slice(ind.i);
          if (/^(=+|-+)[ \t]*$/.test(rest)) {
            const level = rest[0] === '=' ? 1 : 2;
            const text = curTip.lines.join('\n');
            let pos = 0;
            for (;;) {
              const d = parseRefDef(text, pos);
              if (!d) break;
              const key = normLabel(d.label);
              if (!(key in refs)) refs[key] = { dest: d.dest, title: d.title };
              pos = d.next;
            }
            const content = text.slice(pos).replace(/^\n+/, '').replace(/^[ \t]+/, '').replace(/[ \t\n]+$/, '');
            if (content.trim() !== '') {
              const parent = curTip.parent;
              const idx = parent.children.indexOf(curTip);
              parent.children.splice(idx, 1);
              open.pop();
              addBlock(parent, { t: 'heading', level, content });
              break;
            }
            // The paragraph is only reference definitions: the
            // underline is an ordinary paragraph line, not a heading.
            // Fall through to the paragraph continuation below.
          }
        }
        // Interrupting block starts. Inside a list item, marked lexes
        // the item's text with state.top=false, so the paragraph there
        // is a single line and ANY list marker (any start number)
        // begins a new block — unlike at top level, where only a list
        // starting with 1 (or a bullet) interrupts a paragraph.
        let inItem = false;
        for (let p = curTip.parent; p; p = p.parent) { if (p.t === 'item') { inItem = true; break; } }
        const act = blockStart(cur, col0, true, inItem);
        if (!act) {
          // Paragraph continuation.
          let content = cur;
          if (curTip.parent !== doc) {
            const ind2 = indentOf(content, col0);
            if (ind2.col - col0 >= 4) {
              const r = stripColumns(content, col0, 4);
              content = r.str; col0 = r.col0;
            }
            content = expandLeadingTabs(content, col0);
          }
          // A line following a hard break loses its leading whitespace.
          if (curTip.lines.length && endsWithHardBreak(curTip.lines[curTip.lines.length - 1])) {
            content = content.replace(/^[ \t]+/, '');
          }
          curTip.lines.push(content);
          break;
        }
        closeTip();
        if (!handleBlockStart(act)) break;
        continue;
      }
      const act = blockStart(cur, col0, false);
      if (!act) {
        const para = { t: 'para', lines: [cur] };
        addBlock(tip(), para);
        open.push(para);
        break;
      }
      if (!handleBlockStart(act)) break;
    }
  }
  closeTo(1);
  return doc;

  // ---- block-start detection and handling (closures over the loop) ----
  function blockStart(s, c0, inPara, inItem) {
    const ind = indentOf(s, c0);
    const rel = ind.col - c0;
    if (rel > 3) {
      if (!inPara) return { kind: 'indented' };
      return null;
    }
    const p = ind.i;
    const ch = s[p];
    if (ch === undefined) return null;
    // ATX heading
    if (ch === '#') {
      let q = p, run = 0;
      while (s[q] === '#') { q++; run++; }
      if (run <= 6 && (q >= s.length || s[q] === ' ' || s[q] === '\t')) {
        return { kind: 'atx', level: run, pos: q };
      }
      return null;
    }
    // Fenced code
    if (ch === '`' || ch === '~') {
      let q = p, run = 0;
      while (s[q] === ch) { q++; run++; }
      if (run >= 3) {
        const info = s.slice(q);
        if (ch === '`' && info.includes('`')) return null;
        return { kind: 'fence', fence: ch, len: run, info, indent: rel };
      }
      return null;
    }
    // HTML block
    if (ch === '<') {
      const hb = htmlStart(s, p);
      if (hb) {
        if (inPara && hb.type === 7) return null;
        return { kind: 'html', ...hb };
      }
    }
    // Thematic break
    if (ch === '-' || ch === '_' || ch === '*') {
      let q = p, count = 0, ok = true;
      while (q < s.length) {
        const c = s[q];
        if (c === ch) { count++; q++; }
        else if (c === ' ' || c === '\t') q++;
        else { ok = false; break; }
      }
      if (ok && count >= 3) return { kind: 'hr' };
    }
    // Blockquote
    if (ch === '>') return { kind: 'bq', pos: p };
    // List
    const lm = listMarker(s, c0, ind);
    if (lm) {
      if (inPara) {
        const empty = lm.empty;
        if (empty) return null;
        if (lm.ordered && lm.start !== 1 && !inItem) return null;
      }
      return { kind: 'list', ...lm };
    }
    return null;
  }
  function handleBlockStart(act) {
    // Returns true when the rest of the line should be re-examined
    // (a container was opened), false when the line is consumed.
    const s = cur, c0 = col0;
    if (act.kind === 'atx') {
      // The closing sequence (#s preceded by a space) is removed
      // before the leading whitespace is stripped, so that a heading
      // whose content is only #s (e.g. "### ###") comes out empty.
      let content = s.slice(act.pos).replace(/[ \t]+#+[ \t]*$/, '');
      content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      addBlock(tip(), { t: 'heading', level: act.level, content });
      return false;
    }
    if (act.kind === 'hr') {
      addBlock(tip(), { t: 'hr' });
      return false;
    }
    if (act.kind === 'fence') {
      const info = act.info.trim();
      const code = { t: 'code', fenced: true, fence: act.fence, fenceLen: act.len, info, fenceIndent: act.indent, lines: [] };
      addBlock(tip(), code);
      open.push(code);
      return false;
    }
    if (act.kind === 'indented') {
      const r = stripColumns(s, c0, 4);
      const code = { t: 'code', fenced: false, lines: [r.str] };
      addBlock(tip(), code);
      open.push(code);
      return false;
    }
    if (act.kind === 'html') {
      const html = { t: 'html', htmlType: act.type, endTag: act.endTag, lines: [s] };
      addBlock(tip(), html);
      let end = false;
      if (act.type === 1 && s.toLowerCase().includes('</' + act.endTag)) end = true;
      else if (act.type === 2 && s.includes('-->')) end = true;
      else if (act.type === 3 && s.includes('?>')) end = true;
      else if (act.type === 4 && s.includes('>')) end = true;
      else if (act.type === 5 && s.includes(']]>')) end = true;
      if (!end) open.push(html);
      return false;
    }
    if (act.kind === 'bq') {
      const bq = { t: 'bq', children: [] };
      addBlock(tip(), bq);
      open.push(bq);
      const p = act.pos + 1;
      const ind = indentOf(s, c0);
      const base = ind.col + 1;
      if (s[p] === ' ' || s[p] === '\t') {
        const r = stripPrefix(s.slice(p), base, 1);
        cur = r.str; col0 = r.col0;
      } else { cur = s.slice(p); col0 = base; }
      return true;
    }
    if (act.kind === 'list') {
      // Find or create the list at this level.
      let list = null;
      const t = tip();
      if (t.t === 'list' && t.key === act.key) list = t;
      else {
        if (t.t === 'list') closeTip();
        list = { t: 'list', ordered: act.ordered, start: act.start, key: act.key, loose: false, children: [] };
        addBlock(tip(), list);
        open.push(list);
      }
      const item = { t: 'item', children: [], contentIndent: act.contentIndent, task: null };
      addBlock(list, item);
      open.push(item);
      if (act.empty) return false;
      cur = act.content; col0 = col0 + act.contentIndent;
      return true;
    }
    return false;
  }
  function listMarker(s, c0, ind) {
    const p = ind.i;
    const markerCol = ind.col;
    let q = p;
    const ch = s[q];
    if (ch === '-' || ch === '+' || ch === '*') {
      if (s[q + 1] !== ' ' && s[q + 1] !== '\t' && q + 1 < s.length) return null;
      if (q + 1 >= s.length) return { ordered: false, key: 'b' + ch, start: 1, contentIndent: (markerCol - c0) + 2, empty: true, content: '' };
      return finishMarker(s, p, markerCol, 1, q + 1, false, 'b' + ch, 1, c0);
    }
    if (isDigit(ch)) {
      let r = q;
      while (r < s.length && isDigit(s[r])) r++;
      if (r - q > 9) return null;
      const delim = s[r];
      if (delim !== '.' && delim !== ')') return null;
      if (s[r + 1] !== ' ' && s[r + 1] !== '\t' && r + 1 < s.length) return null;
      const start = parseInt(s.slice(q, r), 10);
      const width = (r - q) + 1;
      if (r + 1 >= s.length) return { ordered: true, key: 'o' + delim, start, contentIndent: (markerCol - c0) + width + 1, empty: true, content: '' };
      return finishMarker(s, p, markerCol, width, r + 1, true, 'o' + delim, start, c0);
    }
    return null;
  }
  // contentIndent is RELATIVE to the line's col0: after blockquote
  // markers are stripped, different lines have different absolute
  // columns, so only the relative indent is comparable across lines.
  function finishMarker(s, p, markerCol, markerWidth, after, ordered, key, start, c0) {
    let q = after, col = markerCol + markerWidth, cols = 0;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) {
      if (s[q] === ' ') { q++; col++; cols++; }
      else { const w = 4 - (col % 4); q++; col += w; cols += w; }
      if (cols >= 5) break;
    }
    if (q >= s.length || isBlankStr(s.slice(q))) {
      return { ordered, key, start, contentIndent: (markerCol - c0) + markerWidth + 1, empty: true, content: '' };
    }
    if (cols >= 5) {
      const r = stripColumns(s.slice(p + markerWidth), markerCol + markerWidth, 1);
      return { ordered, key, start, contentIndent: (markerCol - c0) + markerWidth + 1, empty: false, content: expandLeadingTabs(r.str, r.col0) };
    }
    return { ordered, key, start, contentIndent: col - c0, empty: false, content: expandLeadingTabs(s.slice(q), col) };
  }
  function htmlStart(s, p) {
    // Returns {type, endTag} or null. s[p] === '<'.
    const rest = s.slice(p);
    const low = rest.toLowerCase();
    if (low.startsWith('<!--')) return { type: 2 };
    if (low.startsWith('<![cdata[')) return { type: 5 };
    if (low.startsWith('<?')) return { type: 3 };
    if (/^<![A-Z]/.test(rest)) return { type: 4 };
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(rest);
    if (!m) return null;
    const name = m[1].toLowerCase();
    const closing = rest[1] === '/';
    // Type 1: opening tag of script/pre/style/textarea only. A closing
    // tag of those names is not a block start (it is type 7 when alone
    // on the line, inline HTML otherwise).
    if (!closing && /^(script|pre|style|textarea)$/.test(name)) return { type: 1, endTag: name };
    if (BLOCK_TAGS.has(name)) return { type: 6 };
    // Type 7: the line holds only this one tag.
    const tag = readHtmlTag(s, p);
    if (tag && tag.next >= s.length) return { type: 7 };
    if (tag) {
      // A lone tag followed only by whitespace also counts.
      let q = tag.next;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q >= s.length) return { type: 7 };
    }
    return null;
  }
}

// ---- rendering -----------------------------------------------------------
function renderDoc(doc, refs) {
  let out = '';
  for (const child of doc.children) out += renderNode(child, refs, false);
  return out;
}
function renderNode(node, refs, tightPara) {
  switch (node.t) {
    case 'para': {
      const inner = inlineParse(node.lines.join('\n'), refs);
      return tightPara ? inner : '<p>' + inner + '</p>\n';
    }
    case 'heading':
      return '<h' + node.level + '>' + inlineParse(node.content, refs) + '</h' + node.level + '>\n';
    case 'code': {
      let content = node.lines.join('\n');
      if (content !== '') content += '\n';
      if (node.fenced && node.info) {
        let lang = node.info.split(/[ \t]+/)[0];
        lang = lang.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        return '<pre><code class="language-' + escAttr(lang) + '">' + escCode(content) + '</code></pre>\n';
      }
      return '<pre><code>' + escCode(content) + '</code></pre>\n';
    }
    case 'html':
      return node.lines.join('\n') + (node.noTrail ? '' : '\n');
    case 'hr':
      return '<hr>\n';
    case 'bq': {
      let inner = '';
      for (const child of node.children) inner += renderNode(child, refs, false);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list': {
      let inner = '';
      for (const child of node.children) inner += renderNode(child, refs, false);
      if (node.ordered) {
        return '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n' + inner + '</ol>\n';
      }
      return '<ul>\n' + inner + '</ul>\n';
    }
    case 'item': {
      let inner = '';
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        const isPara = child.t === 'para';
        const tight = !node.parent.loose;
        if (i === 0 && node.task !== null && isPara) {
          const innerHtml = inlineParse(child.lines.join('\n'), refs);
          const box = node.task === 'x'
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ';
          inner += tight ? box + innerHtml : '<p>' + box + innerHtml + '</p>\n';
          continue;
        }
        inner += renderNode(child, refs, isPara && !node.parent.loose);
      }
      if (node.task !== null && kids.length === 0) {
        inner = node.task === 'x'
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
      }
      return '<li>' + inner + '</li>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.header.length; i++) {
        const a = node.aligns[i];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(node.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            const a = node.aligns[i];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(row[i], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

// ---- entry point ---------------------------------------------------------
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  let lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = Object.create(null);
  const doc = parseDoc(lines, refs);
  // An HTML block that is the last block of the input and is not
  // followed by a newline in the source has no trailing newline.
  if (src !== '' && !src.endsWith('\n')) {
    let node = doc;
    while (node.children && node.children.length) node = node.children[node.children.length - 1];
    if (node.t === 'html') node.noTrail = true;
  }
  return renderDoc(doc, refs);
}
