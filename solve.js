// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Written from the reference's stated rules (the kit README + the reference
// program's observable behaviour) with a different speed shape than a tree
// walk:
//  - Templates are COMPILED to native JS functions (codegen over the parsed
//    node tree): loops and branches become real JS, path lookups become
//    direct property reads on a prototype-chained scope object, and output
//    accumulates in one shared chunk array per render.
//  - Markdown renders in a single fused pass (no token objects): lines are
//    classified by char codes, plain inline runs are escaped in bulk, and
//    only markup characters are visited one by one.
//  - slugify skips Unicode normalisation for pure-ASCII text (NFKD is the
//    identity there) and every pure helper is memoised per case.
//  - Front matter is parsed by line offsets; the body is one slice, never a
//    split-and-rejoin.
// All caches live inside a single run() call: each case is answered alone.

// ------------------------------------------------------------ text helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESCAPABLE_RE.test(text) ? text.replace(/[&<>"']/g, (c) => ESCAPES[c]) : text;
}

/** Append `text` HTML-escaped onto chunk array `out`. */
function pushEscaped(out, text) {
  if (text !== '') out.push(escapeHtml(text));
}

const SLUG_MAX = 64;

/** The slug scan for text known to be ASCII (index loop, no iterator). */
function slugScanAscii(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug scan for normalised non-ASCII text (code-point walk). */
function slugScan(plain) {
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised in the per-case `cache` Map. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // NFKD is the identity on ASCII and ASCII holds no combining marks, so the
  // scan can run on the text itself; anything else takes the full rule.
  const slug = ascii ? slugScanAscii(text) : slugScan(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether char code `c` is whitespace in the /\s/ sense. */
function isWSCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters.
      if (raw === '' || raw.length > 64) return { error: 'key "slug": not a slug' };
      let seg = 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
        else if (c === 45 && seg > 0) seg = 0;
        else return { error: 'key "slug": not a slug' };
      }
      if (seg === 0) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked by
 * offset; the body is the slice after the closing line.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // First pass: the closing line must exist before any line is judged (a
  // file with no closing --- is refused for that alone).
  const spans = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(pos, end) === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    spans.push([pos, end]);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // the opening --- is line 1
  for (const [ls, le] of spans) {
    const line = text.slice(ls, le);
    lineNo++;
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // "key: value": [a-z_]+, a colon, then the end or one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58 || (k + 1 < line.length && line.charCodeAt(k + 1) !== 32)) {
      return { error: `line ${lineNo} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw = k + 1 === line.length ? '' : line.slice(k + 2);
    let b = raw.length;
    while (b > 0 && (raw.charCodeAt(b - 1) === 32 || raw.charCodeAt(b - 1) === 9)) b--;
    raw = raw.slice(0, b);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose next char is not *), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline onto chunk array `out`; `env.link(target)` resolves a
 * link's href. Plain runs between markup characters are escaped in bulk.
 */
function inlineInto(out, s, env) {
  let i = 0;
  const len = s.length;
  while (i < len) {
    // Scan one plain run: it ends at the nearest backtick, *, [ or escapable
    // backslash, found with native indexOf scans. A backslash escaping
    // nothing is plain text and the run continues past it.
    let j = len;
    let k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('\\', i);
    while (k !== -1 && k < j) {
      if (k + 1 < len && ESCAPABLE.has(s[k + 1])) { j = k; break; }
      k = s.indexOf('\\', k + 1);
    }
    if (j > i) pushEscaped(out, s.slice(i, j));
    if (j >= len) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      out.push(n === '>' ? '&gt;' : n); // escapeHtml of an escapable char
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>');
        pushEscaped(out, s.slice(i + 1, k));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(out, s.slice(i + 2, k), env);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(out, s.slice(i + 1, k), env);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // c === '['
    const close = findUnescaped(s, ']', i + 1);
    const m = close !== -1 && s[close + 1] === '(' ? s.indexOf(')', close + 2) : -1;
    const target = m === -1 ? '' : s.slice(close + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="');
      pushEscaped(out, env.link(target));
      out.push('">');
      inlineInto(out, s.slice(i + 1, close), env);
      out.push('</a>');
      i = m + 1;
      continue;
    }
    out.push('[');
    i++;
  }
}

/** A fence-open line's language, or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet line's item text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered line's { start, text }, or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) >= 48 && line.charCodeAt(n) <= 57) n++;
  if (n === 0 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i === line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/**
 * `src` rendered: its HTML (a "\n" after every block), its table of contents
 * (every level 2 and 3 heading: level, id and its inline HTML) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  // Classify every line once: 0 blank, 1 fence (data: lang), 2 heading
  // (data: {depth, text}), 3 break, 4 quote, 5 bullet (data: item text),
  // 6 ordered (data: {start, text}), 7 other text. The block pass below
  // then never re-tests a line, and a paragraph runs while the kind is
  // none of 0-3 (only a blank, a fence, a heading or a break ends one).
  const kinds = new Uint8Array(n);
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (isBlank(line)) { kinds[i] = 0; continue; }
    const lang = fenceLang(line);
    if (lang !== null) { kinds[i] = 1; data[i] = lang; continue; }
    const h = headingOf(line);
    if (h !== null) { kinds[i] = 2; data[i] = h; continue; }
    if (isHr(line)) { kinds[i] = 3; continue; }
    if (line.charCodeAt(0) === 62) { kinds[i] = 4; continue; }
    const b = bulletOf(line);
    if (b !== null) { kinds[i] = 5; data[i] = b; continue; }
    const o = orderedOf(line);
    if (o !== null) { kinds[i] = 6; data[i] = o; continue; }
    kinds[i] = 7;
  }
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const kind = kinds[i];
    if (kind === 0) { i++; continue; }
    if (kind === 1) {
      const lang = data[i];
      i++;
      parts.push('<pre><code');
      if (lang !== '') { parts.push(' class="language-'); parts.push(escapeHtml(lang)); parts.push('"'); }
      parts.push('>');
      while (i < n && !isFenceClose(lines[i])) { pushEscaped(parts, lines[i]); parts.push('\n'); i++; }
      i++;
      parts.push('</code></pre>\n');
      continue;
    }
    if (kind === 2) {
      const heading = data[i];
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const hp = [];
      inlineInto(hp, heading.text, env);
      const html = hp.join('');
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) { parts.push('<hr>\n'); i++; continue; }
    if (kind === 4) {
      const kept = [];
      while (i < n && kinds[i] === 4) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
      }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(parts, kept.join('\n'), env);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const first = data[i];
      const items = [];
      while (i < n) {
        if (kinds[i] === kind) {
          items.push([trimLine(isOrdered ? data[i].text : data[i])]);
          i++;
          continue;
        }
        if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      parts.push(isOrdered ? (first.start !== 1 ? `<ol start="${first.start}">` : '<ol>') : '<ul>');
      parts.push('\n');
      for (const item of items) {
        parts.push('<li>');
        inlineInto(parts, item.join('\n'), env);
        parts.push('</li>\n');
      }
      parts.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    // kind === 7: a paragraph, running while the kind is none of 0-3.
    const body = [trimLine(lines[i])];
    i++;
    while (i < n && kinds[i] > 3) body.push(trimLine(lines[i++]));
    const hp = [];
    inlineInto(hp, body.join('\n'), env);
    const html = hp.join('');
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Path descent past the first name: each next name an own property, or undefined. */
function descend(v, k1, k2, k3) {
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k1)) return undefined;
  v = v[k1];
  if (k2 === undefined) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k2)) return undefined;
  v = v[k2];
  if (k3 === undefined) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k3)) return undefined;
  return v[k3];
}

/** First-name lookup for the names a prototype chain cannot hold safely. */
function walkScope(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s, name)) s = Object.getPrototypeOf(s);
  return s === null ? undefined : s[name];
}

const UNSAFE_FIRST = new Set(['__proto__', 'constructor', 'prototype']);

/** JS source reading `path` in `scopeVar`: direct reads on the scope chain, own-property descent after. */
function lookupCode(scopeVar, path) {
  const first = path[0];
  let base = UNSAFE_FIRST.has(first) ? `W(${scopeVar}, ${JSON.stringify(first)})` : `${scopeVar}.${first}`;
  if (path.length === 1) return base;
  if (path.length <= 4) return `D(${base}, ${path.slice(1).map((p) => JSON.stringify(p)).join(', ')})`;
  // Longer paths (not seen in this dialect's templates): fold in pairs.
  let expr = base;
  for (let k = 1; k < path.length; k += 3) {
    expr = `D(${expr}, ${path.slice(k, k + 3).map((p) => JSON.stringify(p)).join(', ')})`;
  }
  return expr;
}

/** Emit JS statements rendering `nodes` with scope variable `scopeVar` into `out`. */
function emitNodes(nodes, scopeVar, state) {
  let code = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code += `out.push(${JSON.stringify(n.text)});`;
        break;
      case 'var':
        code += `out.push(E(T(${lookupCode(scopeVar, n.path)})));`;
        break;
      case 'raw':
        code += `out.push(T(${lookupCode(scopeVar, n.path)}));`;
        break;
      case 'if': {
        const branch = `R(${lookupCode(scopeVar, n.path)}) !== ${n.not}`;
        code += `if (${branch}) {${emitNodes(n.then, scopeVar, state)}}`;
        if (n.else !== null) code += ` else {${emitNodes(n.else, scopeVar, state)}}`;
        break;
      }
      case 'for': {
        const id = state.next++;
        const xs = `xs${id}`;
        const ln = `ln${id}`;
        const k = `k${id}`;
        const sc = `sc${id}`;
        code += `{ const ${xs} = ${lookupCode(scopeVar, n.path)}; if (Array.isArray(${xs})) { const ${ln} = ${xs}.length; `;
        code += `for (let ${k} = 0; ${k} < ${ln}; ${k}++) { const ${sc} = Object.create(${scopeVar}); `;
        if (n.name === '__proto__') code += `Object.defineProperty(${sc}, '__proto__', { value: ${xs}[${k}], enumerable: true, writable: true, configurable: true }); `;
        else code += `${sc}.${n.name} = ${xs}[${k}]; `;
        code += `${sc}.loop = { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${ln} - 1, length: ${ln} }; `;
        code += emitNodes(n.body, sc, state);
        code += '} } }';
        break;
      }
      case 'include': {
        const id = state.next++;
        code += `if (depth < ${INCLUDE_DEPTH}) { const f${id} = ctx.fns.get(${JSON.stringify(n.name)}); if (f${id} !== undefined) f${id}(${scopeVar}, ctx, depth + 1, out); }`;
        break;
      }
    }
  }
  return code;
}

/** Compile a parsed template into a native render function (scope, ctx, depth, out). */
function compileTemplate(nodes) {
  const body = emitNodes(nodes, 'scope', { next: 0 });
  return new Function('scope', 'ctx', 'depth', 'out', `const E = ctx.E, T = ctx.T, R = ctx.R, D = ctx.D, W = ctx.W;\n${body}`);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35) return target; // '/' or '#'
        let scheme = false;
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          for (let i = 1; i < target.length; i++) {
            const c = target.charCodeAt(i);
            if (c === 58) { scheme = true; break; }
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
          }
        }
        if (scheme) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest first and then by slug; each post's newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, then the index and tag pages.
  const ctx = { fns: templates, E: escapeHtml, T: textOf, R: truthy, D: descend, W: walkScope };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    Object.assign(scope, vars);
    const out = [];
    fn(scope, ctx, 0, out);
    return out.join('');
  };
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}
