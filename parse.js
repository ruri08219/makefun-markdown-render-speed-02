// A fast drop-in for marked 18.1.3: parse(markdown) returns exactly the HTML
// marked.parse(markdown) returns with marked's default options (GFM on,
// breaks off, pedantic off). Written from scratch for this entry; the
// reference behaviour was derived from marked's published rules and from
// probing marked itself on the tricky corners (lists inside list items,
// fenced code in list items, nested autolinks, marked's emphasis scan,
// the document-wide inLink flag). No dependency, no I/O, no cross-call
// state: every parse() call is independent.

// ---- character classification -------------------------------------------
// ASCII punctuation (CommonMark's punctuation set).
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isWsCh(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}
function isDigitCh(code) { return code >= 48 && code <= 57; }
function isAlphaCh(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isAlnumCh(code) { return isAlphaCh(code) || isDigitCh(code); }
function isAsciiPunct(code) {
  return code < 128 && ASCII_PUNCT.indexOf(String.fromCharCode(code)) >= 0;
}
// Unicode punctuation or symbol (used by the emphasis scan, mirroring
// marked's \p{P} / \p{S} classes). Tilde is excluded by the caller where
// marked excludes it.
const UNI_PUNCT = /[\p{P}\p{S}]/u;
const UNI_ALNUM = /[\p{L}\p{N}]/u;
function isUniWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') || ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000' || ch === '\ufeff';
}
// Backslash escapes only work before ASCII punctuation (CommonMark).
function isPunctCh(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return code < 128 && isAsciiPunct(code);
}

// Escape plain text for HTML output, following marked: numeric character
// references are decoded to the character (then escaped if special);
// named references (&name;, known or not) are left as-is; a bare & is
// escaped to &amp;.
function escHtmlChar(ch) {
  if (ch === "&") return "&amp;";
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  if (ch === '"') return "&quot;";
  if (ch === "'") return "&#39;";
  return ch;
}
function escText(s) {
  let out = "", last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "&") {
      if (s[i + 1] === "#") {
        const d = decodeEnt(s, i);
        if (d) {
          out += s.slice(last, i) + escHtmlChar(d.ch);
          i += d.len - 1; last = i + 1;
          continue;
        }
      } else {
        let j = i + 1;
        if (j < s.length && isAlphaCh(s.charCodeAt(j))) {
          while (j < s.length && isAlnumCh(s.charCodeAt(j))) j++;
          if (j < s.length && s[j] === ";") continue;
        }
      }
      out += s.slice(last, i) + "&amp;"; last = i + 1;
    } else if (c === "<") { out += s.slice(last, i) + "&lt;"; last = i + 1; }
    else if (c === ">") { out += s.slice(last, i) + "&gt;"; last = i + 1; }
    else if (c === '"') { out += s.slice(last, i) + "&quot;"; last = i + 1; }
    else if (c === "'") { out += s.slice(last, i) + "&#39;"; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---- named entities ------------------------------------------------------
// Compact "name=char;" table (the named entities the spec examples and the
// generated documents exercise). Built into a Map once at load.
const ENT_TABLE = 'quot=";amp=&;lt=<;gt=>;nbsp=\u00a0;iexcl=\u00a1;cent=\u00a2;pound=\u00a3;curren=\u00a4;yen=\u00a5;brvbar=\u00a6;sect=\u00a7;uml=\u00a8;copy=\u00a9;ordf=\u00aa;laquo=\u00ab;not=\u00ac;shy=\u00ad;reg=\u00ae;macr=\u00af;deg=\u00b0;plusmn=\u00b1;sup2=\u00b2;sup3=\u00b3;acute=\u00b4;micro=\u00b5;para=\u00b6;middot=\u00b7;cedil=\u00b8;sup1=\u00b9;ordm=\u00ba;raquo=\u00bb;frac14=\u00bc;frac12=\u00bd;frac34=\u00be;iquest=\u00bf;Agrave=\u00c0;Aacute=\u00c1;Acirc=\u00c2;Atilde=\u00c3;Auml=\u00c4;Aring=\u00c5;AElig=\u00c6;Ccedil=\u00c7;Egrave=\u00c8;Eacute=\u00c9;Ecirc=\u00ca;Euml=\u00cb;Igrave=\u00cc;Iacute=\u00cd;Icirc=\u00ce;Iuml=\u00cf;ETH=\u00d0;Ntilde=\u00d1;Ograve=\u00d2;Oacute=\u00d3;Ocirc=\u00d4;Otilde=\u00d5;Ouml=\u00d6;times=\u00d7;Oslash=\u00d8;Ugrave=\u00d9;Uacute=\u00da;Ucirc=\u00db;Uuml=\u00dc;Yacute=\u00dd;THORN=\u00de;szlig=\u00df;agrave=\u00e0;aacute=\u00e1;acirc=\u00e2;atilde=\u00e3;auml=\u00e4;aring=\u00e5;aelig=\u00e6;ccedil=\u00e7;egrave=\u00e8;eacute=\u00e9;ecirc=\u00ea;euml=\u00eb;igrave=\u00ec;iacute=\u00ed;icirc=\u00ee;iuml=\u00ef;eth=\u00f0;ntilde=\u00f1;ograve=\u00f2;oacute=\u00f3;ocirc=\u00f4;otilde=\u00f5;ouml=\u00f6;divide=\u00f7;oslash=\u00f8;ugrave=\u00f9;uacute=\u00fa;ucirc=\u00fb;uuml=\u00fc;yacute=\u00fd;thorn=\u00fe;yuml=\u00ff;OElig=\u0152;oelig=\u0153;Scaron=\u0160;scaron=\u0161;Yuml=\u0178;fnof=\u0192;circ=\u02c6;tilde=\u02dc;Alpha=\u0391;Beta=\u0392;Gamma=\u0393;Delta=\u0394;Epsilon=\u0395;Zeta=\u0396;Eta=\u0397;Theta=\u0398;Iota=\u0399;Kappa=\u039a;Lambda=\u039b;Mu=\u039c;Nu=\u039d;Xi=\u039e;Omicron=\u039f;Pi=\u03a0;Rho=\u03a1;Sigma=\u03a3;Tau=\u03a4;Upsilon=\u03a5;Phi=\u03a6;Chi=\u03a7;Psi=\u03a8;Omega=\u03a9;alpha=\u03b1;beta=\u03b2;gamma=\u03b3;delta=\u03b4;epsilon=\u03b5;zeta=\u03b6;eta=\u03b7;theta=\u03b8;iota=\u03b9;kappa=\u03ba;lambda=\u03bb;mu=\u03bc;nu=\u03bd;xi=\u03be;omicron=\u03bf;pi=\u03c0;rho=\u03c1;sigmaf=\u03c2;sigma=\u03c3;tau=\u03c4;upsilon=\u03c5;phi=\u03c6;chi=\u03c7;psi=\u03c8;omega=\u03c9;thetasym=\u03d1;upsih=\u03d2;piv=\u03d6;ensp=\u2002;emsp=\u2003;thinsp=\u2009;zwnj=\u200c;zwj=\u200d;lrm=\u200e;rlm=\u200f;ndash=\u2013;mdash=\u2014;lsquo=\u2018;rsquo=\u2019;sbquo=\u201a;ldquo=\u201c;rdquo=\u201d;bdquo=\u201e;dagger=\u2020;Dagger=\u2021;bull=\u2022;hellip=\u2026;permil=\u2030;prime=\u2032;Prime=\u2033;lsaquo=\u2039;rsaquo=\u203a;oline=\u203e;frasl=\u2044;euro=\u20ac;image=\u2111;weierp=\u2118;real=\u211c;trade=\u2122;alefsym=\u2135;larr=\u2190;uarr=\u2191;rarr=\u2192;darr=\u2193;harr=\u2194;crarr=\u21b5;lArr=\u21d0;uArr=\u21d1;rArr=\u21d2;dArr=\u21d3;hArr=\u21d4;forall=\u2200;part=\u2202;exist=\u2203;empty=\u2205;nabla=\u2207;isin=\u2208;notin=\u2209;ni=\u220b;prod=\u220f;sum=\u2211;minus=\u2212;lowast=\u2217;radic=\u221a;prop=\u221d;infin=\u221e;ang=\u2220;and=\u2227;or=\u2228;cap=\u2229;cup=\u222a;int=\u222b;there4=\u2234;sim=\u223c;cong=\u2245;asymp=\u2248;ne=\u2260;equiv=\u2261;le=\u2264;ge=\u2265;sub=\u2282;sup=\u2283;nsub=\u2284;sube=\u2286;supe=\u2287;oplus=\u2295;otimes=\u2297;perp=\u22a5;sdot=\u22c5;lceil=\u2308;rceil=\u2309;lfloor=\u230a;rfloor=\u230b;lang=\u2329;rang=\u232a;loz=\u25ca;spades=\u2660;clubs=\u2663;hearts=\u2665;diams=\u2666;Dcaron=\u010e;dcaron=\u010f;HilbertSpace=\u210b;DifferentialD=\u2146;ClockwiseContourIntegral=\u2232;ngE=\u2267\u0338;NotEqualTilde=\u2242\u0338;Tab=\u0009;NewLine=\u000a;colon=:;sol=/;bsol=\u005c;Hat=^;check=\u2713;cross=\u2717;star=\u2606;phone=\u260e;female=\u2640;male=\u2642;sext=\u2736;';
const ENT_MAP = new Map();
for (const part of ENT_TABLE.split(';')) {
  if (!part) continue;
  const eq = part.indexOf('=');
  ENT_MAP.set(part.slice(0, eq), part.slice(eq + 1));
}

// Length of a valid entity reference starting at s[i] ('&'), or 0 when the
// '&' does not start one. A named reference must end in ';' and name an
// entity in the table; a numeric one must be a valid code point.
function entLen(s, i) {
  if (s[i] !== '&' || i + 1 >= s.length) return 0;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (hex ? (isDigitCh(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) : isDigitCh(c)) j++;
      else break;
    }
    if (j === start || j >= s.length || s[j] !== ';') return 0;
    const code = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (code > 0x10FFFF) return 0;
    return j + 1 - i;
  }
  let j = i + 1;
  if (!isAlphaCh(s.charCodeAt(j))) return 0;
  while (j < s.length && isAlnumCh(s.charCodeAt(j))) j++;
  if (j < s.length && s[j] === ';' && ENT_MAP.has(s.slice(i + 1, j))) return j + 1 - i;
  return 0;
}
// Decode the entity at s[i] ('&'). Returns {ch, len} or null.
function decodeEnt(s, i) {
  if (s[i] !== '&') return null;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (hex ? (isDigitCh(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) : isDigitCh(c)) j++;
      else break;
    }
    if (j === start || j >= s.length || s[j] !== ';') return null;
    let code = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (code > 0x10FFFF) return null;
    if (code === 0 || (code >= 0xD800 && code <= 0xDFFF)) code = 0xFFFD;
    return { ch: String.fromCodePoint(code), len: j + 1 - i };
  }
  let j = i + 1;
  if (!isAlphaCh(s.charCodeAt(j))) return null;
  while (j < s.length && isAlnumCh(s.charCodeAt(j))) j++;
  if (j < s.length && s[j] === ';') {
    const ch = ENT_MAP.get(s.slice(i + 1, j));
    if (ch !== undefined) return { ch, len: j + 1 - i };
  }
  return null;
}
// Decode every entity reference in s (used for link titles, code info
// strings and the plain text of link labels).
function decodeEnts(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      const d = decodeEnt(s, i);
      if (d) { out += s.slice(last, i) + d.ch; i += d.len - 1; last = i + 1; }
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Escape text for HTML output: & < > " ' are escaped, except that a '&'
// starting a valid entity reference is left as-is (marked keeps it).
function escHtml(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const len = entLen(s, i);
      if (len > 0) { i += len - 1; continue; }
      out += s.slice(last, i) + '&amp;'; last = i + 1;
    } else if (c === '<') { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === '>') { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === '"') { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === "'") { out += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}
// Escape for code spans / code blocks: '&' is always escaped (entities
// are not recognised inside code).
function escCode(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') { out += s.slice(last, i) + '&amp;'; last = i + 1; }
    else if (c === '<') { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (c === '>') { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === '"') { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === "'") { out += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}
// Escape a URL for href/src: spaces and control characters are
// percent-encoded, non-ASCII is UTF-8 percent-encoded, and a handful of
// punctuation is encoded; '&' starting a valid entity is left alone.
function escHref(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], code = s.charCodeAt(i);
    if (c === ' ') { out += s.slice(last, i) + '%20'; last = i + 1; }
    else if (code < 32 || code === 127) { out += s.slice(last, i) + '%' + code.toString(16).toUpperCase().padStart(2, '0'); last = i + 1; }
    else if (code >= 128) {
      const cp = s.codePointAt(i);
      out += s.slice(last, i) + encodeURIComponent(String.fromCodePoint(cp));
      const adv = cp > 0xFFFF ? 2 : 1;
      last = i + adv; i += adv - 1;
    }
    else if (c === '\\') { out += s.slice(last, i) + '%5C'; last = i + 1; }
    else if (c === '&') {
      const len = entLen(s, i);
      if (len > 0) { i += len - 1; continue; }
      out += s.slice(last, i) + '&amp;'; last = i + 1;
    }
    else if (c === '<') { out += s.slice(last, i) + '%3C'; last = i + 1; }
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

// ---- link destinations, titles, labels -----------------------------------
// Parse a link destination at s[i]. Returns {dest, next} or null. The
// destination is returned raw (escapes kept as backslash pairs are
// resolved by the caller via decodeEnts where marked resolves them).
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === '>') return { dest: out, next: j + 1 };
      out += c; j++;
    }
    return null;
  }
  let j = i, depth = 0, out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') break;
    if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    if (c < ' ') return null;
    out += c; j++;
  }
  if (j === i) return null;
  return { dest: out, next: j };
}
// Parse a link title at s[i]. Returns {title, next} or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (q === "'" && c === '\n' && s[j + 1] === '\n') return null; // no blank line in ' title
      if (c === q) return { title: out, next: j + 1 };
      out += c; j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === ')') return { title: out, next: j + 1 };
      if (c === '(') return null;
      out += c; j++;
    }
    return null;
  }
  return null;
}
// Skip spaces/tabs and up to maxNl newlines (maxNl < 0 means any number).
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
// Normalise a link label for lookup: collapse whitespace, case-fold.
// (Unicode folding: ß/ẞ fold to "ss", and the Latin ligatures fold to
// their letters; JS toLowerCase alone does not do these.)
function normLabel(s) {
  return s.replace(/ß|ẞ/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ|ﬆ/g, 'st')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---- inline HTML tags ------------------------------------------------------
// Read an HTML tag starting at s[i] ('<'). Returns {raw, next, name,
// closing} or null when the text is not a tag. Covers comments,
// processing instructions, declarations, CDATA sections, and open/close
// tags with attributes.
function readTag(s, i) {
  const n = s.length;
  if (s[i] !== '<' || i + 1 >= n) return null;
  const c1 = s[i + 1];
  if (c1 === '!') {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) return null;
      return { raw: s.slice(i, end + 3), next: end + 3, name: '', closing: false };
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end < 0) return null;
      return { raw: s.slice(i, end + 3), next: end + 3, name: '', closing: false };
    }
    // Declaration: <! + letter, up to '>'.
    if (isAlphaCh(s.charCodeAt(i + 2))) {
      const end = s.indexOf('>', i + 2);
      if (end < 0) return null;
      return { raw: s.slice(i, end + 1), next: end + 1, name: '', closing: false };
    }
    return null;
  }
  if (c1 === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end < 0) return null;
    return { raw: s.slice(i, end + 2), next: end + 2, name: '', closing: false };
  }
  let j = i + 1, closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlphaCh(s.charCodeAt(j))) return null;
  const nameStart = j;
  while (j < n) {
    const code = s.charCodeAt(j);
    if (isAlnumCh(code) || code === 45) j++;
    else break;
  }
  const name = s.slice(nameStart, j);
  // Attributes: whitespace-separated names with optional =value
  // (double-quoted, single-quoted, or unquoted), then an optional '/'.
  while (j < n) {
    const c = s[j];
    if (c === '>') return { raw: s.slice(i, j + 1), next: j + 1, name, closing };
    if (c === '/' && s[j + 1] === '>') return { raw: s.slice(i, j + 2), next: j + 2, name, closing };
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { j++; continue; }
    // Attribute name.
    if (isAlphaCh(s.charCodeAt(j)) || c === '_' || c === ':') {
      j++;
      while (j < n) {
        const code = s.charCodeAt(j);
        if (isAlnumCh(code) || code === 95 || code === 58 || code === 46 || code === 45) j++;
        else break;
      }
      while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
      if (s[j] === '=') {
        j++;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        if (s[j] === '"' || s[j] === "'") {
          const q = s[j]; j++;
          const end = s.indexOf(q, j);
          if (end < 0) return null;
          j = end + 1;
        } else {
          while (j < n) {
            const ch = s[j];
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '"' || ch === "'" || ch === '=' || ch === '<' || ch === '>' || ch === '`') break;
            j++;
          }
          if (j >= n) return null;
        }
      }
      continue;
    }
    return null;
  }
  return null;
}
// Is this tag an opening <a ...> tag (the one that flips the inLink flag)?
// marked tests /^<a /i on the tag text: a bare <a> does not count.
function isOpenATag(raw) {
  return raw.length > 3 && raw[0] === '<' && (raw[1] === 'a' || raw[1] === 'A') && raw[2] === ' ';
}
function isCloseATag(raw) {
  return raw.length >= 4 && raw[0] === '<' && raw[1] === '/' && (raw[2] === 'a' || raw[2] === 'A') && raw[3] === '>';
}
const RAW_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const RAW_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// ---- angle autolinks -------------------------------------------------------
// <scheme:...> or <email>, exactly marked's autolink rule (one regex:
// the scheme alternative, or the email alternative whose group 2 is '@').
const ANGLE_AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
function tryAngleAutolink(s, i) {
  const m = ANGLE_AUTOLINK_RE.exec(s.slice(i, i + 400));
  if (!m) return null;
  if (m[2] === '@') {
    return { href: 'mailto:' + m[1], text: m[1], next: i + m[0].length };
  }
  return { href: m[1], text: m[1], next: i + m[0].length };
}

// ---- extended autolinks (www. / scheme:// / bare email) -------------------
// The URL rule (marked's, GFM): mailto:/xmpp: addresses, http/https/ftp
// URLs and www. URLs, or a bare email. Only http/https/ftp schemes
// autolink. Trailing punctuation is trimmed by the backpedal rule
// (balanced parens are kept).
const EXT_SCHEME_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
const EXT_WWW_RE = /^www\.(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
const EXT_EMAIL_RE = /^[A-Za-z0-9._+\-]+@[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9\-_]*[A-Za-z0-9])+(?![\w\-])/;
const EXT_MAILTO_RE = /^(?:mailto|xmpp):[A-Za-z0-9._+\-]+@[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9\-_]*[A-Za-z0-9])+(?![\w\-])/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(text) {
  let cur = text, prev;
  do {
    prev = cur;
    const m = BACKPEDAL_RE.exec(cur);
    cur = m ? m[0] : '';
  } while (cur !== prev);
  return cur;
}
// Try an extended autolink at s[i]. Only call at a word start.
// Returns {href, text, next} or null.
function tryExtAutolink(s, i) {
  const rest = s.slice(i, i + 500);
  let m = EXT_MAILTO_RE.exec(rest);
  if (m) return { href: m[0], text: m[0], next: i + m[0].length };
  m = EXT_SCHEME_RE.exec(rest);
  if (m) {
    const url = backpedal(m[0]);
    if (url) return { href: url, text: url, next: i + url.length };
    return null;
  }
  m = EXT_WWW_RE.exec(rest);
  if (m && wwwMayStart(s, i)) {
    const url = backpedal(m[0]);
    if (url) return { href: 'http://' + url, text: url, next: i + url.length };
    return null;
  }
  m = EXT_EMAIL_RE.exec(rest);
  if (m) return { href: 'mailto:' + m[0], text: m[0], next: i + m[0].length };
  return null;
}
// May an extended autolink start at s[i]? The character before must not
// be an email-word character; for www. it must be start, whitespace,
// '*', '_', '~' or '(' (marked's lookbehind).
const EMAIL_WORD = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
function extMayStart(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  if (EMAIL_WORD.test(prev)) return false;
  return true;
}
function wwwMayStart(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '*' || prev === '_' || prev === '~' || prev === '(';
}

// ---------- chunk 2b: emphasis (marked emStrong/del), links, inline loop ----------
// Faithful translation of marked 18.1.3's inline tokenizers. The inline loop
// emits HTML directly (no token tree) for speed.

const LDelim = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const RDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DelLDelim = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DelRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT1 = /[\p{P}\p{S}]/u;
const UNI_ALNUM1 = /[\p{L}\p{N}]/u;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const ANY_PUNCT_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;

// marked's fe(): last index of a run of r not preceded by whitespace.
function lastPossible(t, r) {
  let last = -1;
  const n = t.length;
  for (let s = 0; s < n; s++) {
    if (t[s] !== r) continue;
    const o = s === 0 ? "\n" : t[s - 1];
    let i = s + 1;
    while (i < n && t[i] === r) i++;
    if (o !== " " && o !== "\t" && o !== "\n" && o !== "\r" && o !== "\f") last = s;
    s = i - 1;
  }
  return last;
}

// marked emStrong(e, t, n): e = remaining text from the delimiter, t = full
// inline text, n = last char of the preceding text token ("" if none).
// Returns {raw, html} or null.
function tryEmStrong(e, t, n, st, refs, bounds) {
  const s = LDelim.exec(e);
  if (!s || !(s[1] || s[2] || s[3] || s[4])) return null;
  const r = s[0][0];
  const o = n === r;
  const i = t.length - e.length;
  let l = i;
  while (l > 0 && t[l - 1] === r) l--;
  const p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? "";
  const h = p === "*" || p === "_" || PUNCT1.test(p);
  if (l < i) n = p;
  const u = l < i ? h : PUNCT1.test(n);
  if (s[4] && UNI_ALNUM1.test(n)) return null;
  const d = s[1] || s[3] || "";
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = p.trim() !== "" && (!!d || (r === "*" && !h));
    if (r !== "*" && r !== "_") return null;
    const A = r === "*" ? RDelimAst : RDelimUnd;
    let v = bounds[r];
    if (v === undefined) v = bounds[r] = lastPossible(t, r);
    const Q = i + k;
    if (v < Q) return null;
    const t2 = t.slice(i + k);
    const ee = v - Q;
    let ms;
    A.lastIndex = 0;
    while ((ms = A.exec(t2)) !== null && !(ms.index > ee)) {
      const g = ms[1] || ms[2] || ms[3] || ms[4] || ms[5] || ms[6];
      if (!g) continue;
      const b = [...g].length;
      if (ms[3] || ms[4]) { m += b; continue; }
      else if (ms[5] || ms[6] || R) {
        if (o && (ms[5] || ms[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if ((m -= b) > 0) continue;
      const bb = Math.min(b, b + m + f);
      const te = [...ms[0]][0].length;
      const M = e.slice(0, k + ms.index + te + bb);
      if (Math.min(k, bb) % 2) {
        const U = M.slice(1, -1);
        return { raw: M, html: "<em>" + inlineToHtml(U, refs, st, r) + "</em>" };
      }
      const ne = M.slice(2, -2);
      return { raw: M, html: "<strong>" + inlineToHtml(ne, refs, st, r) + "</strong>" };
    }
  }
  return null;
}

// marked del(e, t, n). Returns {raw, html} or null.
function tryDel(e, t, n, st, refs, bounds) {
  const s = DelLDelim.exec(e);
  if (!s) return null;
  if (!(s[1] || "") || !n || PUNCT1.test(n)) {
    const o = [...s[0]].length - 1;
    let p = o;
    let v = bounds["~"];
    if (v === undefined) v = bounds["~"] = lastPossible(t, "~");
    const d = t.length - e.length + o;
    if (v < d) return null;
    const t2 = t.slice(t.length - e.length + o);
    const k = v - d;
    let ms;
    DelRDelim.lastIndex = 0;
    while ((ms = DelRDelim.exec(t2)) !== null && !(ms.index > k)) {
      const g = ms[1] || ms[2] || ms[3] || ms[4] || ms[5] || ms[6];
      if (!g) continue;
      const l = [...g].length;
      if (l !== o) continue;
      if (ms[3] || ms[4]) { p += l; continue; }
      if ((p -= l) > 0) continue;
      const ll = Math.min(l, l + p);
      const te = [...ms[0]][0].length;
      const b = e.slice(0, o + ms.index + te + ll);
      const m = b.slice(o, -o);
      return { raw: b, html: "<del>" + inlineToHtml(m, refs, st, "") + "</del>" };
    }
  }
  return null;
}

// Find the matching ] for a [ at src[pos]. Returns {end, label} or null.
// Mirrors marked's label regex: one level of nested [...], backslash
// escapes, and code spans; an unmatched backtick or a second nested [
// kills the label.
function scanLabel(src, pos) {
  let depth = 1;
  let i = pos + 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let j = i;
      while (j < n && src[j] === "`") j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (src[k] === "`") {
          let m = k;
          while (m < n && src[m] === "`") m++;
          if (m - k === run) { found = m; break; }
          k = m;
        } else k++;
      }
      if (found === -1) return null;
      i = found;
      continue;
    }
    if (c === "[") {
      if (depth === 3) return null;
      depth++;
      i++;
      continue;
    }
    if (c === "]") {
      depth--;
      if (depth === 0) return { end: i, label: src.slice(pos + 1, i) };
      i++;
      continue;
    }
    i++;
  }
  return null;
}

// marked Be(a, e, t): reject the link if the label contains a < that starts
// an HTML tag or autolink extending beyond the label's end. a = full
// remaining text, e = label text, t = label start offset in a.
function beRejects(a, e, t) {
  if (!e.includes("<")) return false;
  for (let s = 0; s < e.length; s++) {
    if (e[s] === "\\") { s++; continue; }
    if (e[s] === "`") {
      const m = CODE_SPAN_RE.exec(e.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (e[s] !== "<") continue;
    const r = a.slice(t + s);
    const tg = readTag(r, 0);
    const al = tg ? null : tryAngleAutolink(r, 0);
    const len = tg ? tg.raw.length : al ? al.next : 0;
    if (len > 0) {
      if (len > e.length - s) return true;
      s += len - 1;
    }
  }
  return false;
}

// Unescape \[ and \] in a link label (marked's outputLinkReplace).
function unescLabel(l) { return l.replace(/\\([\[\]])/g, "$1"); }

// De: parse the link label text recursively; reject the outer link if a
// markdown link was emitted inside it (unless it is an image).
// Returns the inner HTML, or null to reject.
function deLink(labelText, isImage, st, refs) {
  const saveInLink = st.inLink, saveEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineToHtml(labelText, refs, st, "");
  const emitted = st.linkEmitted;
  st.linkEmitted = saveEmitted;
  st.inLink = saveInLink;
  if (!isImage && emitted) return null;
  if (!isImage) st.linkEmitted = true;
  return inner;
}

function linkHtml(a) {
  // a = {href, text, isEmail}
  const href = escHref(a.href);
  const text = escHtml(a.text);
  return '<a href="' + href + '">' + text + "</a>";
}

// Try to form a link/image at src[pos] ('[' or '!['). Returns
// {html, next} or null. Mirrors marked's link/reflink/nolink tokenizers.
function tryLink(src, pos, refs, st, bounds) {
  const isImage = src[pos] === "!";
  const open = isImage ? pos + 1 : pos;
  if (src[open] !== "[") return null;
  const sc = scanLabel(src, open);
  if (!sc) return null;
  const label = sc.label;
  const after = sc.end + 1;
  const labelOff = open + 1;
  if (beRejects(src.slice(pos), label, labelOff - pos)) return null;

  // --- inline link: ]( dest [title] ) ---
  if (src[after] === "(") {
    let j = skipWs(src, after + 1, -1);
    let dest = "";
    let title = "";
    let close = -1;
    if (src[j] === ")") {
      close = j + 1;
    } else {
      const d = parseDest(src, j);
      if (!d) return null;
      dest = d.dest;
      j = d.next;
      // optional title after whitespace (at most one newline in the gap)
      const j2 = skipWs(src, j, 1);
      if (j2 !== j && (src[j2] === '"' || src[j2] === "'" || src[j2] === "(")) {
        const tt = parseTitle(src, j2);
        if (tt) { title = tt.title; j = tt.next; }
      }
      j = skipWs(src, j, -1);
      if (src[j] !== ")") return null;
      close = j + 1;
    }
    const inner = deLink(unescLabel(label), isImage, st, refs);
    if (inner === null) return null;
    if (isImage) {
      const href = escHref(dest.replace(ANY_PUNCT_RE, "$1"));
      const alt = escHtml(inner.replace(/<[^>]*>/g, ""));
      const t = title ? ' title="' + escHtml(title.replace(ANY_PUNCT_RE, "$1")) + '"' : "";
      return { html: '<img src="' + href + '" alt="' + alt + '"' + t + ">", next: close };
    }
    const href = escHref(dest.replace(ANY_PUNCT_RE, "$1"));
    const t = title ? ' title="' + escHtml(title.replace(ANY_PUNCT_RE, "$1")) + '"' : "";
    return { html: '<a href="' + href + '"' + t + ">" + inner + "</a>", next: close };
  }

  // --- full reference link: ][ref] ---
  // A collapsed `[label][]` uses the label as its own ref. If the ref is
  // not defined, fall through to the shortcut form instead of failing.
  if (src[after] === "[") {
    const sc2 = scanLabel(src, after);
    if (sc2) {
      const ref = sc2.label === "" ? normLabel(label) : normLabel(sc2.label);
      const def = refs[ref];
      if (def) {
        const inner = deLink(unescLabel(label), isImage, st, refs);
        if (inner !== null) {
          if (isImage) {
            const alt = escHtml(inner.replace(/<[^>]*>/g, ""));
            const t = def.title ? ' title="' + escHtml(def.title) + '"' : "";
            return { html: '<img src="' + escHref(def.dest) + '" alt="' + alt + '"' + t + ">", next: sc2.end + 1 };
          }
          const t = def.title ? ' title="' + escHtml(def.title) + '"' : "";
          return { html: '<a href="' + escHref(def.dest) + '"' + t + ">" + inner + "</a>", next: sc2.end + 1 };
        }
      }
    }
  }

  // --- shortcut reference link: [label] (optionally followed by []) ---
  const ref = normLabel(label);
  const def = refs[ref];
  if (!def) return null;
  const inner = deLink(unescLabel(label), isImage, st, refs);
  if (inner === null) return null;
  let next = after;
  if (src[next] === "[" && src[next + 1] === "]") next += 2;
  if (isImage) {
    const alt = escHtml(inner.replace(/<[^>]*>/g, ""));
    const t = def.title ? ' title="' + escHtml(def.title) + '"' : "";
    return { html: '<img src="' + escHref(def.dest) + '" alt="' + alt + '"' + t + ">", next };
  }
  const t = def.title ? ' title="' + escHtml(def.title) + '"' : "";
  return { html: '<a href="' + escHref(def.dest) + '"' + t + ">" + inner + "</a>", next };
}

// Code span: ^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)
function tryCodespan(src, i) {
  const m = CODE_SPAN_RE.exec(src.slice(i));
  if (!m) return null;
  let text = m[2].replace(/\n/g, " ");
  if (/[^\s]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.slice(1, -1);
  return { raw: m[0], html: "<code>" + escCode(text) + "</code>" };
}

// Is src[i] the start of a hard break's leading spaces? (2+ spaces, or a
// backslash, immediately before a newline.)
function hardBreakAt(src, i) {
  // i points at the newline; look back over spaces / a single backslash.
  let j = i - 1, spaces = 0;
  while (j >= 0 && src[j] === " ") { spaces++; j--; }
  if (spaces >= 2) return true;
  if (spaces === 0 && j >= 0 && src[j] === "\\") return true;
  return false;
}

// Emit a text run starting at src[i] (i is inside a paragraph's inline
// source). Stops before special chars, before a scheme://, before a
// word-start ext autolink, and before spaces preceding a newline.
// Returns {html, next, last} where last is the run's last char.
function textRun(src, i, st) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src[j];
    if (c === "`" || c === "~" || c === "\\" || c === "<" || c === "[" || c === "*" || c === "_" || c === "\n") break;
    if (c === "!" && src[j + 1] === "[") break;
    if (c === " ") {
      // stop before a run of spaces that ends at a newline (hard/soft break)
      let k = j;
      while (k < n && src[k] === " ") k++;
      if (src[k] === "\n") break;
      j = k;
      continue;
    }
    // scheme:// starts an ext autolink even mid-word (xhttps://y.com)
    if ((c === "h" || c === "H" || c === "f" || c === "F")) {
      const rest = src.slice(j, j + 8).toLowerCase();
      if (rest.startsWith("http://") || rest.startsWith("https://") || rest.startsWith("ftp://")) break;
    }
    // word start for an ext autolink: email-word char preceded by a
    // non-email-word char
    if (EMAIL_WORD.test(c) && (j === i || !EMAIL_WORD.test(src[j - 1]))) {
      if (j > i) break;
      // j === i: the loop caller already tried the autolink; if we are
      // here it failed, so consume this char as text.
    }
    j++;
  }
  if (j === i) return null;
  const raw = src.slice(i, j);
  if (st.inRaw) return { html: raw, next: j, last: raw[raw.length - 1] };
  return { html: escText(raw), next: j, last: raw[raw.length - 1] };
}

// Main inline loop. src = the inline source of one block; refs = the
// document's reference definitions; st = per-document state
// {inLink, inRaw, linkEmitted}; outer = enclosing emphasis delimiter char.
function inlineToHtml(src, refs, st, outer) {
  const parts = [];
  const n = src.length;
  let i = 0;
  let prev = "";
  const bounds = {};
  // The emphasis scan works on the masked text (code spans, links and
  // tags masked so their * _ ~ cannot be delimiters); the raw slices
  // come from the original text. Length-preserving, so offsets agree.
  const masked = maskInlineText(src, refs);
  while (i < n) {
    const c = src[i];
    // --- extended autolink at a word start ---
    if (!st.inLink && EMAIL_WORD.test(c) && extMayStart(src, i)) {
      const a = tryExtAutolink(src, i);
      if (a) { parts.push(linkHtml(a)); i = a.next; prev = ""; continue; }
    }
    if (c === "<") {
      const tg = readTag(src, i);
      if (tg) {
        if (!st.inLink && isOpenATag(tg.raw)) st.inLink = true;
        else if (st.inLink && isCloseATag(tg.raw)) st.inLink = false;
        if (!st.inRaw && RAW_OPEN_RE.test(tg.raw)) st.inRaw = true;
        else if (st.inRaw && RAW_CLOSE_RE.test(tg.raw)) st.inRaw = false;
        parts.push(tg.raw);
        i = tg.next; prev = ""; continue;
      }
      const al = tryAngleAutolink(src, i);
      if (al) { parts.push(linkHtml(al)); i = al.next; prev = ""; continue; }
      parts.push(st.inRaw ? "<" : "&lt;");
      i++; prev = "<";
      continue;
    }
    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const L = tryLink(src, i, refs, st, bounds);
      if (L) { parts.push(L.html); i = L.next; prev = ""; continue; }
      // not a link: emit the first char as text and retry after it
      parts.push(c === "!" ? "!" : "[");
      i++; prev = c;
      continue;
    }
    if (c === "*" || c === "_") {
      const em = tryEmStrong(src.slice(i), masked, prev, st, refs, bounds);
      if (em) { parts.push(em.html); i += em.raw.length; prev = ""; continue; }
      parts.push(c);
      i++;
      if (c === "*") prev = "*";
      continue;
    }
    if (c === "~") {
      const d = tryDel(src.slice(i), masked, prev, st, refs, bounds);
      if (d) { parts.push(d.html); i += d.raw.length; prev = ""; continue; }
      parts.push("~");
      i++; prev = "~";
      continue;
    }
    if (c === "`") {
      const cs = tryCodespan(src, i);
      if (cs) { parts.push(cs.html); i += cs.raw.length; prev = ""; continue; }
      // A failed code span leaves the whole backtick run as literal text;
      // do not retry at the next backtick of the same run (marked does not
      // form a code span from one backtick of a longer run).
      let k = i;
      while (k < n && src[k] === "`") k++;
      parts.push(src.slice(i, k));
      i = k; prev = "`";
      continue;
    }
    if (c === "\\") {
      const nx = src[i + 1];
      if (nx === "\n") {
        // hard break via backslash (if not trailing whitespace only)
        const rest = src.slice(i + 2);
        if (!/^\s*$/.test(rest)) {
          parts.push("<br>");
          i += 2;
          while (i < n && (src[i] === " " || src[i] === "\t")) i++;
          prev = ""; continue;
        }
        parts.push("\\");
        i++; prev = "\\";
        continue;
      }
      if (nx !== undefined && isPunctCh(nx)) {
        parts.push(st.inRaw ? nx : escHtml(nx));
        i += 2; prev = nx;
        continue;
      }
      parts.push("\\");
      i++; prev = "\\";
      continue;
    }
    if (c === "\n") {
      if (hardBreakAt(src, i)) {
        const rest = src.slice(i + 1);
        if (!/^\s*$/.test(rest)) {
          parts.push("<br>");
          i++;
          while (i < n && (src[i] === " " || src[i] === "\t")) i++;
          prev = ""; continue;
        }
      }
      parts.push("\n");
      i++; prev = "\n";
      continue;
    }
    if (c === " ") {
      // A run of spaces ending at a newline: a hard break (2+ spaces)
      // consumes the spaces; a soft break keeps them.
      let k = i;
      while (k < n && src[k] === " ") k++;
      if (src[k] === "\n") {
        const spaces = k - i;
        const rest = src.slice(k + 1);
        if (spaces >= 2 && !/^\s*$/.test(rest)) {
          parts.push("<br>");
          i = k + 1;
          while (i < n && (src[i] === " " || src[i] === "\t")) i++;
          prev = ""; continue;
        }
        parts.push(src.slice(i, k) + "\n");
        i = k + 1; prev = "\n"; continue;
      }
      // not before a newline: fall through to the text run
    }
    // --- text run ---
    const tr = textRun(src, i, st);
    if (tr) {
      parts.push(tr.html);
      if (tr.last !== "_") prev = tr.last;
      i = tr.next;
      continue;
    }
    // safety: never stall
    parts.push(escHtml(c));
    i++; prev = c;
  }
  return parts.join("");
}


// ---------- chunk 3: block parser (CommonMark two-phase, GFM tables) ----------
// Block node: {kind, children, ...}. Container kinds: doc, bq, list, item.
// Leaf kinds: para, heading, code, html, hr, table, empty.

const BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section summary table tbody td tfoot th thead title tr track ul").split(" "));

// Expand tabs in a line to spaces (4-column stops), column-aware.
function expandTabs(line) {
  if (line.indexOf("\t") < 0) return line;
  let out = "", col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\t") {
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}

function isBlankStr(s) { return /^[ \t]*$/.test(s); }

function leadSpaces(s) {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  return i;
}

// A list marker at s[i]. Returns {ordered, start, delim, marker, markerLen,
// contentIndent, empty} or null. `marker` is the bullet char (-, +, *) for
// unordered lists and the delimiter (., )) for ordered ones; two lists
// with different markers are separate lists.
function listMarker(s, i) {
  const n = s.length;
  const c = s[i];
  if (c === "-" || c === "+" || c === "*") {
    if (i + 1 >= n) return { ordered: false, start: 0, delim: "", marker: c, markerLen: 1, contentIndent: 2, empty: true };
    if (s[i + 1] !== " " && s[i + 1] !== "\t") return null;
    let j = i + 1, spaces = 0;
    while (j < n && s[j] === " ") { spaces++; j++; }
    if (j >= n) return { ordered: false, start: 0, delim: "", marker: c, markerLen: 1, contentIndent: 2, empty: true };
    if (spaces === 0) return null;
    const ci = spaces >= 5 ? 2 : 1 + spaces;
    return { ordered: false, start: 0, delim: "", marker: c, markerLen: 1, contentIndent: ci, empty: false };
  }
  if (c >= "0" && c <= "9") {
    let j = i;
    while (j < n && s[j] >= "0" && s[j] <= "9") j++;
    if (j - i > 9) return null;
    if (j < n && (s[j] === "." || s[j] === ")")) {
      const delim = s[j];
      const num = parseInt(s.slice(i, j), 10);
      const ml = j - i + 1;
      let k = j + 1, spaces = 0;
      while (k < n && s[k] === " ") { spaces++; k++; }
      if (k >= n) return { ordered: true, start: num, delim, marker: delim, markerLen: ml, contentIndent: ml + 1, empty: true };
      if (spaces === 0) return null;
      const ci = spaces >= 5 ? ml + 1 : ml + spaces;
      return { ordered: true, start: num, delim, marker: delim, markerLen: ml, contentIndent: ci, empty: false };
    }
  }
  return null;
}

// ATX heading at s[i] (indent already stripped by caller via i).
function atxHeading(s, i) {
  const n = s.length;
  let j = i, level = 0;
  while (j < n && s[j] === "#") { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j < n && s[j] !== " " && s[j] !== "\t") return null;
  let text = s.slice(j).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  text = text.replace(/[ \t]+#+$/, "");
  if (/^#+$/.test(text)) text = "";
  return { level, text };
}

// Thematic break.
function isHr(s, i) {
  const n = s.length;
  let j = i;
  const c = s[j];
  if (c !== "*" && c !== "-" && c !== "_") return false;
  let count = 0;
  while (j < n) {
    const ch = s[j];
    if (ch === c) { count++; j++; }
    else if (ch === " " || ch === "\t") j++;
    else return false;
  }
  return count >= 3;
}

// Fence start: ^ {0,3}(`{3,}|~{3,}) info
function fenceStart(s, i) {
  const n = s.length;
  const c = s[i];
  if (c !== "`" && c !== "~") return null;
  let j = i;
  while (j < n && s[j] === c) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = s.slice(j).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  if (c === "`" && info.indexOf("`") >= 0) return null;
  return { char: c, len, info };
}

// Is s (from i) a closing fence for the given fence?
function fenceEnd(s, i, fence) {
  const n = s.length;
  if (s[i] !== fence.char) return false;
  let j = i;
  while (j < n && s[j] === fence.char) j++;
  if (j - i < fence.len) return false;
  while (j < n && (s[j] === " " || s[j] === "\t")) j++;
  return j >= n;
}

// HTML block start type (1-7) at s[i]. 0 = not an HTML block start.
function htmlBlockType(s, i) {
  const rest = s.slice(i);
  if (/^<(script|pre|style|textarea)(\s|>|\/>)/i.test(rest)) return 1;
  if (rest.startsWith("<!--")) return 2;
  if (rest.startsWith("<?")) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith("<![CDATA[")) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s[^>]*)?\/?>/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  const t = readTag(s, i);
  if (t && t.next >= s.length) return 7;
  return 0;
}

function htmlBlockEnds(s, type) {
  if (type === 1) return /<\/(script|pre|style|textarea)>/i.test(s);
  if (type === 2) return s.indexOf("-->") >= 0;
  if (type === 3) return s.indexOf("?>") >= 0;
  if (type === 4) return s.indexOf(">") >= 0;
  if (type === 5) return s.indexOf("]]>") >= 0;
  return false;
}

// Setext underline: returns 1 or 2, or 0.
function setextLevel(s, i) {
  const n = s.length;
  let j = i;
  const c = s[j];
  if (c !== "=" && c !== "-") return 0;
  while (j < n && s[j] === c) j++;
  while (j < n && (s[j] === " " || s[j] === "\t")) j++;
  if (j < n) return 0;
  return c === "=" ? 1 : 2;
}

// Parse a reference definition at s[i]. Returns {label, dest, title, next}
// (next = index just after the def, i.e. after its terminating newline)
// or null. The def must be followed by a newline or end-of-string.
function parseRefDef(s, i) {
  const n = s.length;
  let j = i;
  if (s[j] !== "[") return null;
  const sc = scanLabel(s, j);
  if (!sc) return null;
  const label = sc.label;
  if (label.length === 0) return null;
  j = sc.end + 1;
  if (s[j] !== ":") return null;
  j++;
  j = skipWs(s, j, 1);
  const d = parseDest(s, j);
  if (!d) return null;
  const dest = d.dest;
  j = d.next;
  let title = null;
  const save = j;
  const j2 = skipWs(s, j, 1);
  if (j2 !== j || s[j2] === '"' || s[j2] === "'" || s[j2] === "(") {
    const tt = parseTitle(s, j2);
    if (tt) { title = tt.title; j = tt.next; }
    else j = save;
  }
  j = skipWs(s, j, 0);
  if (j >= n) return { label, dest, title, next: j };
  if (s[j] === "\n") return { label, dest, title, next: j + 1 };
  return null;
}

// Split a table row line into cells (handles \| escapes, leading/trailing |).
function splitTableRow(line) {
  const cells = [];
  let cur = "", i = 0;
  const n = line.length;
  if (line[0] === "|") i = 1;
  while (i < n) {
    const c = line[i];
    if (c === "\\" && i + 1 < n && (line[i + 1] === "|" || line[i + 1] === "\\")) {
      cur += line[i + 1];
      i += 2;
      continue;
    }
    if (c === "|") { cells.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur.trim());
  if (n > 0 && line[n - 1] === "|" && cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

// Is this a table delimiter row? Returns the alignment array or null.
function tableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : t.startsWith(":") ? "left" : null);
  }
  return aligns;
}

// Finalize a paragraph node: strip leading ref-defs, detect a table.
function finalizePara(p, refs) {
  let text = p.lines.join("\n");
  let rest = text;
  while (true) {
    const d = parseRefDef(rest, 0);
    if (!d) break;
    const key = normLabel(d.label);
    if (!(key in refs)) refs[key] = { dest: d.dest, title: d.title };
    rest = rest.slice(d.next);
  }
  rest = rest.replace(/^\n+/, "");
  if (rest === "") { p.kind = "empty"; p.text = ""; delete p.lines; return; }
  const lines = rest.split("\n");
  if (lines.length >= 2) {
    const aligns = tableDelimiter(lines[1]);
    if (aligns) {
      const header = splitTableRow(lines[0]);
      const rows = [];
      for (let k = 2; k < lines.length; k++) rows.push(splitTableRow(lines[k]));
      p.kind = "table";
      p.header = header; p.aligns = aligns; p.rows = rows;
      delete p.lines;
      return;
    }
  }
  p.text = rest;
  delete p.lines;
}

// Does the line (after container stripping) start a block that can
// interrupt a paragraph? Used for the lazy-continuation decision.
function startsInterruptingBlock(rest, inItem) {
  const indent = leadSpaces(rest);
  if (indent > 3) return false;
  const content = rest.slice(indent);
  if (content[0] === "#") { if (atxHeading(rest, indent)) return true; }
  if (fenceStart(rest, indent)) return true;
  const ht = htmlBlockType(rest, indent);
  if (ht >= 1 && ht <= 6) return true;
  if (isHr(rest, indent)) return true;
  const lm = listMarker(rest, indent);
  if (lm) {
    if (lm.empty) return false;
    if (!lm.ordered) return true;
    if (lm.start === 1) return true;
    if (inItem) return true; // R1
    return false;
  }
  return false;
}

// Parse the document. Returns {doc, refs}.
function parseDoc(input) {
  const refs = Object.create(null);
  const root = { kind: "doc", children: [] };
  let stack = [root];
  let leaf = null;
  let sawBlank = false; // a blank line has been seen since the last block

  const rawLines = input.split("\n");
  // A trailing newline does not create an extra blank line.
  const inputEndsNl = input.endsWith("\n");
  if (inputEndsNl) rawLines.pop();
  const lines = rawLines.map((l) => expandTabs(l.endsWith("\r") ? l.slice(0, -1) : l));
  let curLi = 0;

  function closeLeaf() {
    if (!leaf) return;
    if (leaf.kind === "para") finalizePara(leaf, refs);
    // Trailing blank lines are not part of an indented code block.
    if (leaf.kind === "code" && !leaf.fenced) {
      while (leaf.lines.length > 0 && leaf.lines[leaf.lines.length - 1] === "") leaf.lines.pop();
    }
    leaf = null;
  }
  function closeTo(depth) {
    closeLeaf();
    while (stack.length > depth + 1) stack.pop();
  }
  function curContainer() { return stack[stack.length - 1]; }
  function addChild(node) {
    node.precededByBlank = sawBlank;
    sawBlank = false;
    curContainer().children.push(node);
  }
  function inListItem() {
    for (let k = 1; k < stack.length; k++) if (stack[k].kind === "item") return true;
    return false;
  }

  for (let li = 0; li < lines.length; li++) {
    curLi = li;
    const line = lines[li];
    const blank = isBlankStr(line);
    processLine(line, blank);
  }
  closeLeaf();
  // An HTML block gets a trailing newline only when its last line is the
  // input's last line and the input ends with a newline.
  (function markHtml(node) {
    if (node.kind === "html" && node.lastLineIdx === lines.length - 1 && inputEndsNl) node.trailingNl = true;
    for (const ch of node.children || []) markHtml(ch);
  })(root);
  return { doc: root, refs };

  function processLine(line, blank) {
    // ---- Phase 1: match open containers ----
    let pos = 0;
    let failedAt = stack.length; // first depth that fails to match
    let failedIsNewItem = false;
    for (let d = 1; d < stack.length; d++) {
      const c = stack[d];
      if (c.kind === "bq") {
        const sp = leadSpaces(line.slice(pos));
        if (sp <= 3 && line[pos + sp] === ">") {
          pos += sp + 1;
          if (line[pos] === " ") pos++;
          continue;
        }
        failedAt = d; break;
      }
      if (c.kind === "item") {
        if (blank) continue;
        const sp = leadSpaces(line.slice(pos));
        if (sp >= c.contentIndent) { pos += c.contentIndent; continue; }
        const parent = stack[d - 1];
        if (parent && parent.kind === "list" && sp <= 3) {
          const lm = listMarker(line, pos + sp);
          if (lm && lm.ordered === parent.ordered && lm.marker === parent.marker && !lm.empty) {
            failedIsNewItem = true;
            failedAt = d; break; // a new item of this list
          }
        }
        failedAt = d; break;
      }
      // list containers match trivially
    }
    // Close a failed container; if the failing container is a list item
    // and the line is NOT a new item of its list, the list ends too.
    function closeFailed() {
      let depth = failedAt - 1;
      if (failedAt < stack.length && stack[failedAt].kind === "item" && !failedIsNewItem) depth = failedAt - 2;
      closeTo(depth);
    }

    // R2: fenced code block + a LIST ITEM failing to match -> the line is
    // code content (a blockquote failing closes the code block normally).
    if (failedAt < stack.length && leaf && leaf.kind === "code" && leaf.fenced && stack[failedAt].kind === "item") {
      const rest = line.slice(pos);
      const sp = leadSpaces(rest);
      if (sp <= 3 && fenceEnd(rest, sp, leaf.fence)) {
        closeLeaf();
        closeTo(failedAt - 1);
        return;
      }
      leaf.lines.push(rest);
      return;
    }

    // A line that is blank after the containers are stripped ends a
    // paragraph (e.g. a lone `>` inside a blockquote) — it is not a lazy
    // continuation. (Inside fenced/indented code or an HTML block it is
    // content, so let phase2 handle it.)
    if (isBlankStr(line.slice(pos)) && leaf && leaf.kind === "para") {
      closeLeaf();
      sawBlank = true;
      return;
    }

    // Lazy continuation of a paragraph.
    if (failedAt < stack.length && leaf && leaf.kind === "para" && !blank) {
      const restAfter = line.slice(pos);
      if (!startsInterruptingBlock(restAfter, inListItem())) {
        // Close the failed containers but keep the paragraph open.
        while (stack.length > failedAt) stack.pop();
        leaf.lines.push(restAfter.slice(leadSpaces(restAfter)));
        return;
      }
      closeFailed();
    } else if (failedAt < stack.length) {
      closeFailed();
    }

    // A line that is blank after the containers are stripped is a blank
    // line (e.g. a lone `>` inside a blockquote): it ends the paragraph.
    // (Inside a fenced/indented code block or an HTML block it is content,
    // so let phase2 handle it.)
    if (isBlankStr(line.slice(pos)) && !(leaf && (leaf.kind === "code" || leaf.kind === "html"))) {
      if (leaf && leaf.kind === "para") closeLeaf();
      sawBlank = true;
      return;
    }

    phase2(line, pos, blank);
  }

  function phase2(line, pos, blank) {
    for (;;) {
      // Leaf continuation.
      if (leaf && leaf.kind === "code" && leaf.fenced) {
        const rest = line.slice(pos);
        const sp = leadSpaces(rest);
        if (sp <= 3 && fenceEnd(rest, sp, leaf.fence)) closeLeaf();
        else leaf.lines.push(rest);
        return;
      }
      if (leaf && leaf.kind === "code" && !leaf.fenced) {
        if (blank) { leaf.lines.push(""); return; }
        const sp = leadSpaces(line.slice(pos));
        if (sp >= 4) { leaf.lines.push(line.slice(pos + 4)); return; }
        closeLeaf();
        // fall through to new-block checks
      }
      if (leaf && leaf.kind === "html") {
        if (blank && (leaf.htype === 6 || leaf.htype === 7)) { closeLeaf(); }
        else {
          leaf.lines.push(line.slice(pos));
          leaf.lastLineIdx = curLi;
          if (leaf.htype <= 5 && htmlBlockEnds(line.slice(pos), leaf.htype)) closeLeaf();
          return;
        }
      }
      if (blank) {
        if (leaf && leaf.kind === "para") closeLeaf();
        sawBlank = true;
        return;
      }
      const rest = line.slice(pos);
      const indent = leadSpaces(rest);
      const content = rest.slice(indent);

      // Setext underline converts an open paragraph.
      if (leaf && leaf.kind === "para" && indent <= 3) {
        const sl = setextLevel(rest, indent);
        if (sl) {
          leaf.kind = "heading";
          leaf.level = sl;
          leaf.text = leaf.lines.join("\n");
          delete leaf.lines;
          closeLeaf();
          return;
        }
      }
      // Blockquote.
      if (indent <= 3 && content[0] === ">") {
        closeLeaf();
        const bq = { kind: "bq", children: [] };
        addChild(bq);
        stack.push(bq);
        pos += indent + 1;
        if (line[pos] === " ") pos++;
        continue;
      }
      // Thematic break (takes precedence over a list item, e.g. `* * *`).
      if (indent <= 3 && isHr(rest, indent)) {
        closeLeaf();
        addChild({ kind: "hr", children: [] });
        return;
      }
      // List.
      if (indent <= 3) {
        const lm = listMarker(rest, indent);
        if (lm) {
          // An empty list item cannot interrupt a paragraph; an ordered
          // list must start with 1 unless inside a list item (R1).
          const interrupts = !leaf || leaf.kind !== "para" || (!lm.empty && (!lm.ordered || lm.start === 1 || inListItem()));
          if (interrupts) {
            closeLeaf();
            // Reuse the current list when it is the same kind/marker;
            // otherwise close it (the new list is a sibling, not a child).
            let list = null;
            let listOnStack = false;
            if (curContainer().kind === "list") {
              const cur = curContainer();
              if (cur.ordered === lm.ordered && cur.marker === lm.marker) { list = cur; listOnStack = true; }
              else stack.pop();
            }
            if (!list) {
              const cont = curContainer();
              const last = cont.children[cont.children.length - 1];
              if (last && last.kind === "list" && last.ordered === lm.ordered && last.marker === lm.marker && !last.precededByBlank) list = last;
              else {
                list = { kind: "list", ordered: lm.ordered, start: lm.start, delim: lm.delim || "", marker: lm.marker, children: [] };
                addChild(list);
              }
            }
            const item = { kind: "item", contentIndent: indent + lm.contentIndent, children: [] };
            item.precededByBlank = sawBlank;
            sawBlank = false;
            list.children.push(item);
            if (!listOnStack) stack.push(list);
            stack.push(item);
            if (lm.empty) return;
            pos += indent + lm.contentIndent;
            continue;
          }
        }
      }
      // ATX heading.
      if (indent <= 3) {
        const h = atxHeading(rest, indent);
        if (h) {
          closeLeaf();
          addChild({ kind: "heading", level: h.level, text: h.text, children: [] });
          return;
        }
      }
      // Fenced code.
      if (indent <= 3) {
        const f = fenceStart(rest, indent);
        if (f) {
          closeLeaf();
          const code = { kind: "code", fenced: true, fence: f, info: f.info, lines: [], children: [] };
          addChild(code);
          leaf = code;
          return;
        }
      }
      // HTML block.
      if (indent <= 3) {
        const ht = htmlBlockType(rest, indent);
        if (ht !== 0 && (ht !== 7 || !leaf || leaf.kind !== "para")) {
          closeLeaf();
          // Keep the first line's leading spaces (up to 3) as content.
          const hb = { kind: "html", htype: ht, lines: [rest], lastLineIdx: curLi, children: [] };
          addChild(hb);
          if (!(ht <= 5 && htmlBlockEnds(rest, ht))) leaf = hb;
          return;
        }
      }
      // Indented code (only when no paragraph is open).
      if (!leaf && indent >= 4) {
        const code = { kind: "code", fenced: false, lines: [rest.slice(4)], children: [] };
        addChild(code);
        leaf = code;
        return;
      }
      // Paragraph (new or continued). Leading spaces (up to 3) are part
      // of the paragraph text.
      if (leaf && leaf.kind === "para") {
        leaf.lines.push(rest);
      } else {
        closeLeaf();
        const p = { kind: "para", lines: [rest], children: [] };
        addChild(p);
        leaf = p;
      }
      return;
    }
  }
}

// ---------- chunk 4: rendering + entry point ----------

function listIsLoose(list) {
  for (let k = 0; k < list.children.length; k++) {
    const item = list.children[k];
    if (k > 0 && item.precededByBlank) return true;
    for (let m = 1; m < item.children.length; m++) {
      if (item.children[m].precededByBlank) return true;
    }
  }
  return false;
}

function renderNode(node, refs, st, out, tightPara) {
  switch (node.kind) {
    case "doc":
      for (const ch of node.children) renderNode(ch, refs, st, out, false);
      break;
    case "bq":
      out.push("<blockquote>\n");
      for (const ch of node.children) renderNode(ch, refs, st, out, false);
      out.push("</blockquote>\n");
      break;
    case "list": {
      const loose = listIsLoose(node);
      const tag = node.ordered ? "ol" : "ul";
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : "";
      out.push("<" + tag + start + ">\n");
      for (const item of node.children) if (item.kind === "item") renderItem(item, refs, st, out, loose);
      out.push("</" + tag + ">\n");
      break;
    }
    case "para": {
      const html = inlineToHtml(node.text, refs, st, "");
      if (tightPara) out.push(html);
      else out.push("<p>" + html + "</p>\n");
      break;
    }
    case "heading":
      out.push("<h" + node.level + ">" + inlineToHtml(node.text, refs, st, "") + "</h" + node.level + ">\n");
      break;
    case "code": {
      let content = node.lines.join("\n");
      if (node.lines.length > 0) content += "\n";
      if (node.fenced) {
        const lang = node.info ? decodeEnts(node.info).replace(/\\([\s\S])/g, "$1").split(/\s+/)[0] : "";
        const info = lang ? ' class="language-' + escHtml(lang) + '"' : "";
        out.push("<pre><code" + info + ">" + escCode(content) + "</code></pre>\n");
      } else {
        out.push("<pre><code>" + escCode(content) + "</code></pre>\n");
      }
      break;
    }
    case "html":
      out.push(node.lines.join("\n") + (node.trailingNl ? "\n" : ""));
      break;
    case "hr":
      out.push("<hr>\n");
      break;
    case "table": {
      out.push("<table>\n<thead>\n<tr>\n");
      for (let k = 0; k < node.header.length; k++) {
        const a = node.aligns[k] ? ' align="' + node.aligns[k] + '"' : "";
        out.push("<th" + a + ">" + inlineToHtml(node.header[k], refs, st, "") + "</th>\n");
      }
      out.push("</tr>\n</thead>\n<tbody>");
      for (const row of node.rows) {
        out.push("<tr>\n");
        for (let k = 0; k < node.header.length; k++) {
          const a = node.aligns[k] ? ' align="' + node.aligns[k] + '"' : "";
          const cell = k < row.length ? row[k] : "";
          out.push("<td" + a + ">" + inlineToHtml(cell, refs, st, "") + "</td>\n");
        }
        out.push("</tr>\n");
      }
      out.push("</tbody></table>\n");
      break;
    }
    case "empty":
      break;
  }
}

function renderItem(item, refs, st, out, loose) {
  out.push("<li>");
  for (const ch of item.children) {
    const tightPara = !loose && ch.kind === "para";
    renderNode(ch, refs, st, out, tightPara);
  }
  out.push("</li>\n");
}

export function parse(markdown) {
  const st = { inLink: false, inRaw: false, linkEmitted: false };
  const { doc, refs } = parseDoc(markdown);
  const out = [];
  renderNode(doc, refs, st, out, false);
  return out.join("");
}

// ---------- masking for the emphasis scan (marked's #n) ----------
// Returns a length-preserving masked copy of the inline text: code spans,
// links and tags become [aaa...], and \X escapes become ++, so that
// *, _, ~ inside them cannot act as emphasis delimiters. Only computed
// when the text contains *, _ or ~.
function maskInlineText(src, refs) {
  if (src.indexOf("*") < 0 && src.indexOf("_") < 0 && src.indexOf("~") < 0) return src;
  const n = src.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "`") {
      // code span: find the matching backtick run
      let j = i;
      while (j < n && src[j] === "`") j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (src[k] === "`") {
          let m = k;
          while (m < n && src[m] === "`") m++;
          if (m - k === run) { found = m; break; }
          k = m;
        } else k++;
      }
      if (found !== -1) {
        const len = found - i;
        out += "[" + "a".repeat(len - 2) + "]";
        i = found;
        continue;
      }
      out += c; i++;
      continue;
    }
    if (c === "\\" && i + 1 < n && isPunctCh(src[i + 1])) {
      out += "++";
      i += 2;
      continue;
    }
    if (c === "<") {
      const tg = readTag(src, i);
      if (tg) {
        out += "[" + "a".repeat(tg.raw.length - 2) + "]";
        i = tg.next;
        continue;
      }
      out += c; i++;
      continue;
    }
    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      // Mask an inline link [...](...), a full ref link [...][...] with
      // a known ref, or a shortcut ref [label] with a known ref.
      const open = c === "!" ? i + 1 : i;
      const sc = scanLabel(src, open);
      if (sc) {
        const after = sc.end + 1;
        let end = -1;
        if (src[after] === "(") {
          // inline link: find the matching close paren (paren-aware)
          let depth = 1, j = after + 1;
          while (j < n && depth > 0) {
            if (src[j] === "\\") { j += 2; continue; }
            if (src[j] === "(") depth++;
            else if (src[j] === ")") depth--;
            j++;
          }
          if (depth === 0) end = j;
        } else if (src[after] === "[") {
          const sc2 = scanLabel(src, after);
          if (sc2 && refs && (normLabel(sc2.label) in refs)) end = sc2.end + 1;
        } else {
          if (refs && (normLabel(sc.label) in refs)) end = after;
        }
        if (end !== -1) {
          const len = end - i;
          out += "[" + "a".repeat(len - 2) + "]";
          i = end;
          continue;
        }
      }
      out += c; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}
