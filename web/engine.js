/* PDF identity swap: the engine.
 *
 * Text is swapped in place, in the font the PDF already draws it in: each character of the old
 * word rewritten as the new word's, a character added or taken out where the new word is longer
 * or shorter. Nothing is drawn over the page, so the old text is gone from the file rather than
 * hidden, and the file is written whole. The new word fills the old word's width, so nothing
 * else on the page moves. No AI, no network: rules only, on the bytes of the file.
 */
const PDFSwapEngine = (() => {
  "use strict";

  const P = () => globalThis.PDFLib;
  const N = (s) => P().PDFName.of(s);
  const I = [1, 0, 0, 1, 0, 0];
  const TIGHTEN_LIMIT = 50; // thousandths of the font size a letter may be pulled in
  const LOOSEN_LIMIT = 50; // ... or pushed out: well under the tenth of an em text readers (pdf.js among them) take for a space
  const INVISIBLE = new Set([3, 7]);
  const SHOW = new Set(["Tj", "TJ", "'", '"']);
  const ALNUM = /[\p{L}\p{N}]/u;

  const REASONS = {
    space: "the PDF has no space character here, and the new text needs a character where the old text had a space",
    ligature: "two letters are drawn as one character here (a ligature)",
    hidden: "the text is invisible (a hidden text layer over a scanned picture), so the visible page would not change",
    hiddenUnpainted: "the scan's hidden text holds this value, but it could not be found in the picture of the page, so the picture would still show it",
    size: "the text is drawn at size zero",
    unreadable: "this part of the page could not be read",
    widths: "the font does not say how wide its characters are",
    words: "the stand-in has a different number of words than the value",
  };

  // ------------------------------------------------------------------ bytes
  const latin1 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const fromLatin1 = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  function concat(parts) {
    const bufs = parts.map((p) => (typeof p === "string" ? fromLatin1(p) : p));
    const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bufs) { out.set(b, o); o += b.length; }
    return out;
  }

  // ------------------------------------------------------------------ lexer
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
  class LexError extends Error {}

  function literal(d, i) {
    let depth = 1; i++;
    const out = [];
    while (i < d.length) {
      let c = d[i];
      if (c === 92) {
        i++; if (i >= d.length) break; c = d[i];
        const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[c];
        if (esc !== undefined) { out.push(esc); i++; }
        else if (c >= 48 && c <= 55) { let v = 0, j = i; while (j < d.length && j - i < 3 && d[j] >= 48 && d[j] <= 55) { v = v * 8 + d[j] - 48; j++; } out.push(v & 255); i = j; }
        else if (c === 13) { i++; if (d[i] === 10) i++; }
        else if (c === 10) i++;
        else { out.push(c); i++; }
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) { depth--; if (depth === 0) return [Uint8Array.from(out), i + 1]; }
      out.push(c); i++;
    }
    throw new LexError("a string with no end");
  }
  function hexstr(d, i) {
    let j = i + 1, digits = "";
    while (j < d.length && d[j] !== 62) { if (!WS.has(d[j])) digits += String.fromCharCode(d[j]); j++; }
    if (j >= d.length) throw new LexError("a hex string with no end");
    if (!/^[0-9A-Fa-f]*$/.test(digits)) throw new LexError("a hex string that is not hex");
    if (digits.length % 2) digits += "0";
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(digits.substr(k * 2, 2), 16);
    return [out, j + 1];
  }
  function skipDict(d, i) {
    let depth = 0;
    while (i < d.length) {
      if (d[i] === 60 && d[i + 1] === 60) { depth++; i += 2; }
      else if (d[i] === 62 && d[i + 1] === 62) { depth--; i += 2; if (depth === 0) return i; }
      else if (d[i] === 40) i = literal(d, i)[1];
      else if (d[i] === 60) i = hexstr(d, i)[1];
      else i++;
    }
    throw new LexError("a dictionary with no end");
  }
  const wordEnd = (d, i) => { while (i < d.length && !WS.has(d[i]) && !DELIM.has(d[i])) i++; return i; };
  function skipInlineImage(d, i) {
    for (;;) {
      while (i < d.length && WS.has(d[i])) i++;
      if (i >= d.length) throw new LexError("an inline image with no data");
      const c = d[i];
      if (c === 40) i = literal(d, i)[1];
      else if (c === 60 && d[i + 1] === 60) i = skipDict(d, i);
      else if (c === 60) i = hexstr(d, i)[1];
      else if (c === 91 || c === 93) i++;
      else if (c === 47) i = wordEnd(d, i + 1);
      else { const e = wordEnd(d, i); if (e === i) { i++; continue; } const w = latin1(d.subarray(i, e)); i = e; if (w === "ID") break; }
    }
    i++;
    for (let j = i; ;) {
      let k = -1;
      for (let x = j; x < d.length - 1; x++) if (d[x] === 69 && d[x + 1] === 73) { k = x; break; }
      if (k < 0) throw new LexError("an inline image with no end");
      const after = d[k + 2];
      if (WS.has(d[k - 1]) && (after === undefined || WS.has(after) || DELIM.has(after))) return k + 2;
      j = k + 1;
    }
  }
  function decodeName(raw) { return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }

  function parse(d) {
    const ops = [];
    let stack = [[]], first = -1, i = 0;
    while (i < d.length) {
      const c = d[i];
      if (WS.has(c)) { i++; continue; }
      if (c === 37) { while (i < d.length && d[i] !== 10 && d[i] !== 13) i++; continue; }
      const start = i;
      if (first < 0) first = start;
      const top = stack[stack.length - 1];
      if (c === 40) { const [v, e] = literal(d, i); i = e; top.push({ t: "s", v, hex: false, raw: d.subarray(start, i) }); }
      else if (c === 60 && d[i + 1] === 60) { i = skipDict(d, i); top.push({ t: "o", raw: d.subarray(start, i) }); }
      else if (c === 60) { const [v, e] = hexstr(d, i); i = e; top.push({ t: "s", v, hex: true, raw: d.subarray(start, i) }); }
      else if (c === 91) { stack.push([]); i++; }
      else if (c === 93) { if (stack.length === 1) throw new LexError("an array closed that was never opened"); const a = stack.pop(); stack[stack.length - 1].push(a); i++; }
      else if (c === 47) { i = wordEnd(d, i + 1); top.push({ t: "name", v: decodeName(latin1(d.subarray(start + 1, i))), raw: d.subarray(start, i) }); }
      else if (c === 41 || c === 62 || c === 123 || c === 125) throw new LexError("a stray delimiter");
      else {
        i = wordEnd(d, i);
        const w = latin1(d.subarray(start, i));
        if (NUMBER.test(w)) top.push({ t: "n", v: parseFloat(w), raw: d.subarray(start, i) });
        else if (w === "true" || w === "false" || w === "null") top.push({ t: "o", raw: d.subarray(start, i) });
        else {
          if (stack.length !== 1) throw new LexError("an operator inside an array");
          if (w === "BI") i = skipInlineImage(d, i);
          ops.push({ op: w, args: stack[0], start: first, end: i });
          stack = [[]]; first = -1;
        }
      }
    }
    if (stack.length !== 1) throw new LexError("an array that is never closed");
    return ops;
  }
  function encodeString(v, hex) {
    if (hex) { let s = "<"; for (const b of v) s += (b < 16 ? "0" : "") + b.toString(16).toUpperCase(); return fromLatin1(s + ">"); }
    const out = [40];
    for (const b of v) {
      if (b === 40 || b === 41 || b === 92) out.push(92, b);
      else if (b < 32 || b > 126) { out.push(92); for (const ch of b.toString(8).padStart(3, "0")) out.push(ch.charCodeAt(0)); }
      else out.push(b);
    }
    out.push(41);
    return Uint8Array.from(out);
  }
  function formatNumber(v) { let s = v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); if (s === "-0" || s === "") s = "0"; return s; }

  // ------------------------------------------------------------------ matrices
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const at = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

  // ------------------------------------------------------------------ pdf-lib helpers
  const isA = (o, cls) => o && P()[cls] && o instanceof P()[cls];
  const nameOf = (o) => (isA(o, "PDFName") ? o.decodeText() : null);
  const numOf = (o, dflt) => (isA(o, "PDFNumber") ? o.asNumber() : dflt);
  function arrayOf(ctx, o) { o = o && isA(o, "PDFRef") ? ctx.lookup(o) : o; return isA(o, "PDFArray") ? o.asArray().map((x) => (isA(x, "PDFRef") ? ctx.lookup(x) : x)) : null; }
  const refTag = (o) => (isA(o, "PDFRef") ? o.tag : null);
  function streamBytes(s) {
    if (isA(s, "PDFRawStream")) return P().decodePDFRawStream(s).decode();
    if (s && typeof s.getContents === "function") return s.getContents();
    throw new Error("not a stream");
  }
  function textOf(o) { return isA(o, "PDFString") || isA(o, "PDFHexString") ? o.decodeText() : null; }

  // ------------------------------------------------------------------ fonts
  const SUBSET = /^[A-Z]{6}\+/;
  const TABLES = {};
  function table(key) {
    if (!TABLES[key]) { const m = new Map(); for (const [k, v] of Object.entries(PDFSWAP_DATA.enc[key])) m.set(+k, v); TABLES[key] = m; }
    return TABLES[key];
  }
  function glyphToChar(name) {
    if (PDFSWAP_DATA.glyphs[name]) return PDFSWAP_DATA.glyphs[name];
    let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
    if (m) return String.fromCodePoint(...m[1].match(/.{4}/g).map((h) => parseInt(h, 16)));
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (m) return String.fromCodePoint(parseInt(m[1], 16));
    return null;
  }
  /** A ToUnicode destination: UTF-16BE code units, or a single byte written short. */
  function utf16(hex) {
    if (hex.length < 4) return hex ? String.fromCharCode(parseInt(hex, 16)) : "";
    const u = [];
    for (let k = 0; k + 4 <= hex.length; k += 4) u.push(parseInt(hex.substr(k, 4), 16));
    return String.fromCharCode(...u);
  }
  function parseToUnicode(bytes) {
    const s = latin1(bytes), map = new Map();
    const blocks = /beginbfchar([\s\S]*?)endbfchar|beginbfrange([\s\S]*?)endbfrange/g;
    let m;
    while ((m = blocks.exec(s))) {
      if (m[1] !== undefined) {
        const toks = m[1].match(/<[0-9A-Fa-f\s]*>/g) || [];
        for (let k = 0; k + 1 < toks.length; k += 2) map.set(parseInt(toks[k].replace(/[<>\s]/g, ""), 16) || 0, utf16(toks[k + 1].replace(/[<>\s]/g, "")));
      } else {
        const toks = m[2].match(/<[0-9A-Fa-f\s]*>|\[|\]/g) || [];
        let k = 0;
        while (k + 2 < toks.length) {
          const lo = parseInt(toks[k].replace(/[<>\s]/g, ""), 16), hi = parseInt(toks[k + 1].replace(/[<>\s]/g, ""), 16);
          if (toks[k + 2] === "[") {
            let j = k + 3;
            for (let code = lo; j < toks.length && toks[j] !== "]"; code++, j++) map.set(code, utf16(toks[j].replace(/[<>\s]/g, "")));
            k = j + 1;
          } else {
            const dst = toks[k + 2].replace(/[<>\s]/g, "");
            const units = []; for (let q = 0; q + 4 <= dst.length; q += 4) units.push(parseInt(dst.substr(q, 4), 16));
            if (!units.length) units.push(parseInt(dst, 16));
            for (let code = lo; code <= hi && code - lo < 65536; code++) {
              const u = units.slice(); u[u.length - 1] += code - lo;
              map.set(code, String.fromCharCode(...u));
            }
            k += 3;
          }
        }
      }
    }
    return map;
  }

  class Font {
    constructor(key, name) {
      Object.assign(this, { key, name, twoByte: false, toText: new Map(), widths: new Map(), defaultWidth: null, subset: SUBSET.test(name), problem: null, used: new Map(), _rev: null });
    }
    get label() { return this.name.replace(SUBSET, "") || "an unnamed font"; }
    codes(b) {
      if (!this.twoByte) return Array.from(b);
      if (b.length % 2) throw new Error("odd");
      const out = []; for (let k = 0; k < b.length; k += 2) out.push((b[k] << 8) | b[k + 1]); return out;
    }
    toBytes(codes) { if (!this.twoByte) return Uint8Array.from(codes); const o = new Uint8Array(codes.length * 2); codes.forEach((c, k) => { o[2 * k] = c >> 8; o[2 * k + 1] = c & 255; }); return o; }
    text(code) { return this.toText.has(code) ? this.toText.get(code) : "�"; }
    width(code) { return this.widths.has(code) ? this.widths.get(code) : this.defaultWidth; }
    /** char -> code, for characters this file can draw in this font. Asked after the whole
     * document is read: an embedded subset carries only the characters the document draws. */
    reverse() {
      if (!this._rev) {
        const rev = new Map();
        for (const [code, t] of this.toText) {
          if ([...t].length !== 1 || (this.subset && !this.used.has(code))) continue;
          const best = rev.get(t);
          if (best === undefined || (this.used.get(code) || 0) > (this.used.get(best) || 0)) rev.set(t, code);
        }
        this._rev = rev;
      }
      return this._rev;
    }
    codeFor(ch) { const c = this.reverse().get(ch); return c === undefined ? null : c; }
    charWidth(ch) { const c = this.codeFor(ch); return c === null ? null : this.width(c); }
  }

  function loadFont(ctx, ref, dict) {
    const base = nameOf(dict.lookup(N("BaseFont"))) || "";
    const font = new Font(refTag(ref) || base + Math.random(), base);
    const sub = nameOf(dict.lookup(N("Subtype")));
    try {
      if (sub === "Type0") {
        const enc = nameOf(dict.lookup(N("Encoding")));
        if (enc !== "Identity-H") { font.problem = "a font laid out in a way this tool does not write (" + (enc || "a custom map") + ")"; return font; }
        font.twoByte = true;
        const desc = arrayOf(ctx, dict.get(N("DescendantFonts")))[0];
        font.defaultWidth = numOf(desc.lookup(N("DW")), 1000);
        const w = arrayOf(ctx, desc.get(N("W"))) || [];
        for (let i = 0; i < w.length;) {
          const first = numOf(w[i], 0), next = w[i + 1];
          if (isA(next, "PDFArray")) { arrayOf(ctx, next).forEach((x, k) => font.widths.set(first + k, numOf(x, 0))); i += 2; }
          else { const last = numOf(next, first), wd = numOf(w[i + 2], 0); for (let c = first; c <= last && c - first < 65536; c++) font.widths.set(c, wd); i += 3; }
        }
        const tu = dict.lookup(N("ToUnicode"));
        if (!tu) { font.problem = "a font with no character map, so its text cannot be read"; return font; }
        font.toText = parseToUnicode(streamBytes(tu));
      } else if (sub === "Type1" || sub === "TrueType" || sub === "MMType1") {
        const label = font.label;
        if (label === "Symbol" || label === "ZapfDingbats") { font.problem = "a symbol font"; return font; }
        const desc = dict.lookup(N("FontDescriptor"));
        const flags = desc ? numOf(desc.lookup(N("Flags")), 0) : 0;
        const enc = dict.lookup(N("Encoding"));
        let base = "std", diffs = null;
        if (!enc) {
          base = sub === "TrueType" ? "win" : "std";
          if ((flags & 4) && !dict.lookup(N("ToUnicode"))) { font.problem = "a symbol font with no character map"; return font; }
        } else if (isA(enc, "PDFName")) base = { WinAnsiEncoding: "win", MacRomanEncoding: "mac", StandardEncoding: "std", PDFDocEncoding: "pdf" }[nameOf(enc)] || "std";
        else { base = { WinAnsiEncoding: "win", MacRomanEncoding: "mac", StandardEncoding: "std" }[nameOf(enc.lookup(N("BaseEncoding")))] || "std"; diffs = arrayOf(ctx, enc.get(N("Differences"))); }
        const t = new Map(table(base));
        if (diffs) { let code = 0; for (const it of diffs) { if (isA(it, "PDFNumber")) code = it.asNumber(); else if (isA(it, "PDFName")) { const ch = glyphToChar(it.decodeText()); if (ch) t.set(code, ch); else t.delete(code); code++; } } }
        const tu = dict.lookup(N("ToUnicode"));
        if (tu) for (const [k, v] of parseToUnicode(streamBytes(tu))) t.set(k, v);
        font.toText = t;
        const ws = arrayOf(ctx, dict.get(N("Widths")));
        if (ws) {
          const fc = numOf(dict.lookup(N("FirstChar")), 0);
          ws.forEach((x, k) => font.widths.set(fc + k, numOf(x, 0)));
          font.defaultWidth = desc ? numOf(desc.lookup(N("MissingWidth")), 0) : 0;
        } else {
          const std = PDFSWAP_DATA.widths[PDFSWAP_DATA.aliases[label] || label];
          if (!std) { font.problem = REASONS.widths; return font; }
          for (const [code, ch] of t) if (std[ch] !== undefined) font.widths.set(code, std[ch]);
        }
      } else font.problem = "a kind of font this tool does not write in (" + (sub || "unknown") + ")";
    } catch (e) {
      font.problem = "a font whose description could not be read";
    }
    return font;
  }

  // ------------------------------------------------------------------ reading a document
  class Model {
    constructor(doc) { this.doc = doc; this.ctx = doc.context; this.parts = []; this.byKey = new Map(); this.fonts = new Map(); this.pages = doc.getPages(); this.images = []; }
    font(resources, name) {
      if (!resources) return null;
      const fonts = resources.lookup(N("Font"));
      if (!isA(fonts, "PDFDict")) return null;
      const ref = fonts.get(N(name));
      if (!ref) return null;
      const dict = isA(ref, "PDFRef") ? this.ctx.lookup(ref) : ref;
      if (!isA(dict, "PDFDict")) return null;
      const key = refTag(ref) || dict;
      if (!this.fonts.has(key)) this.fonts.set(key, loadFont(this.ctx, ref, dict));
      return this.fonts.get(key);
    }
  }

  function newPart(model, key, where, label, page, data, write, resources, rect) {
    const part = { key, where, label, page, data, write, resources, rect, ops: [], glyphs: [], uses: [], problem: null, codes: new Map(), corrections: new Map(), deletes: new Set(), inserts: new Map() };
    try { part.ops = parse(data); } catch (e) { part.problem = REASONS.unreadable; }
    model.parts.push(part); model.byKey.set(key, part);
    return part;
  }

  /** Every object nothing in the document points to any more is left out of the copy: the old
   * pieces of a page now written as one stream, and whatever the file already carried unused (an
   * earlier edit's text). Kept, they would hold the original text inside the file, unseen. */
  function dropUnreferenced(doc) {
    const ctx = doc.context, seen = new Set(), todo = [];
    const visit = (o) => {
      if (!o) return;
      if (isA(o, "PDFRef")) { if (!seen.has(o.tag)) { seen.add(o.tag); todo.push(ctx.lookup(o)); } return; }
      todo.push(o);
    };
    const t = ctx.trailerInfo;
    [t.Root, t.Info, t.Encrypt, t.ID].forEach(visit);
    while (todo.length) {
      const o = todo.pop();
      if (!o) continue;
      if (isA(o, "PDFDict")) for (const [, v] of o.entries()) visit(v);
      else if (isA(o, "PDFArray")) for (const v of o.asArray()) visit(v);
      else if (o.dict && isA(o.dict, "PDFDict")) for (const [, v] of o.dict.entries()) visit(v);
    }
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
  }
  async function newStream(model, bytes) {
    const dict = model.ctx.obj({});
    let data = bytes;
    const packed = await deflate(bytes);
    if (packed) { data = packed; dict.set(N("Filter"), N("FlateDecode")); }
    return model.ctx.register(P().PDFRawStream.of(dict, data));
  }
  function streamWriter(model, ref) {
    return async (bytes) => {
      const ctx = model.ctx, old = ctx.lookup(ref);
      const dict = old.dict.clone(ctx);
      for (const k of ["Filter", "DecodeParms", "Length", "DL"]) dict.delete(N(k));
      let data = bytes;
      const packed = await deflate(bytes);
      if (packed) { data = packed; dict.set(N("Filter"), N("FlateDecode")); }
      ctx.assign(ref, P().PDFRawStream.of(dict, data));
    };
  }
  async function deflate(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    const cs = new CompressionStream("deflate");
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(await out);
  }

  function interpret(model, part, ctm0, page, depth) {
    const first = part.uses.length === 0;
    const geo = [];
    part.uses.push({ page, geo });
    if (part.problem) return;
    let gs = { ctm: ctm0, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0 };
    const stack = [];
    let tm = I, tlm = I;
    const nums = (args) => args.map((a) => (a && a.t === "n" ? a.v : NaN));
    const show = (idx, items) => {
      const f = gs.font;
      if (!f) return;
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it && it.t === "n") { tm = mul([1, 0, 0, 1, (-it.v / 1000) * gs.size * gs.th, 0], tm); continue; }
        if (!it || it.t !== "s") continue;
        let codes;
        try { codes = f.codes(it.v); } catch (e) { continue; }
        for (let p = 0; p < codes.length; p++) {
          const code = codes[p];
          if (first) {
            f.used.set(code, (f.used.get(code) || 0) + 1);
            part.glyphs.push({ code, text: f.text(code), font: f, op: idx, item: k, pos: p, size: gs.size, tw: gs.tw, tc: gs.tc, tr: gs.tr });
          }
          const w = f.width(code) ?? 0;
          const scale = [gs.size * gs.th, 0, 0, gs.size, 0, gs.rise];
          const trm = mul(scale, mul(tm, gs.ctm));
          const o = at(trm, 0, 0), e = at(trm, w / 1000, 0);
          const adv = ((w / 1000) * gs.size + gs.tc + (!f.twoByte && code === 32 ? gs.tw : 0)) * gs.th;
          tm = mul([1, 0, 0, 1, adv, 0], tm);
          const nx = at(mul(scale, mul(tm, gs.ctm)), 0, 0);
          const corners = [at(trm, 0, -0.22), at(trm, w / 1000, -0.22), at(trm, 0, 0.92), at(trm, w / 1000, 0.92)];
          const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
          const len = Math.hypot(trm[0], trm[1]) || 1;
          geo.push({ x: o[0], y: o[1], ex: e[0], ey: e[1], nx: nx[0], ny: nx[1], ux: trm[0] / len, uy: trm[1] / len, em: Math.hypot(trm[2], trm[3]) || 1, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
        }
      }
    };
    for (let idx = 0; idx < part.ops.length; idx++) {
      const { op, args } = part.ops[idx];
      switch (op) {
        case "q": stack.push({ ...gs }); break;
        case "Q": if (stack.length) gs = stack.pop(); break;
        case "cm": { const m = nums(args); if (m.length === 6 && m.every(Number.isFinite)) gs.ctm = mul(m, gs.ctm); break; }
        case "BT": tm = tlm = I; break;
        case "Tf": if (args.length >= 2 && args[0].t === "name" && args[1].t === "n") { gs.font = model.font(part.resources, args[0].v); gs.size = args[1].v; } break;
        case "Tc": if (args[0]?.t === "n") gs.tc = args[0].v; break;
        case "Tw": if (args[0]?.t === "n") gs.tw = args[0].v; break;
        case "Tz": if (args[0]?.t === "n") gs.th = args[0].v / 100; break;
        case "TL": if (args[0]?.t === "n") gs.tl = args[0].v; break;
        case "Ts": if (args[0]?.t === "n") gs.rise = args[0].v; break;
        case "Tr": if (args[0]?.t === "n") gs.tr = args[0].v; break;
        case "Td": case "TD": { const [tx, ty] = nums(args); if (Number.isFinite(tx) && Number.isFinite(ty)) { if (op === "TD") gs.tl = -ty; tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; } break; }
        case "Tm": { const m = nums(args); if (m.length === 6 && m.every(Number.isFinite)) tm = tlm = m; break; }
        case "T*": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
        case "Tj": show(idx, args.slice(-1)); break;
        case "TJ": show(idx, Array.isArray(args[0]) ? args[0] : []); break;
        case "'": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; show(idx, args.slice(-1)); break;
        case '"': if (args.length >= 3) { gs.tw = args[0].v; gs.tc = args[1].v; } tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; show(idx, args.slice(2, 3)); break;
        case "Do": if (args[0]?.t === "name" && depth < 12) doForm(model, part, args[0].v, gs.ctm, page, depth); break;
      }
    }
  }

  function doForm(model, parent, name, ctm, page, depth) {
    const xo = parent.resources && parent.resources.lookup(N("XObject"));
    if (!isA(xo, "PDFDict")) return;
    const ref = xo.get(N(name));
    if (!isA(ref, "PDFRef")) return;
    const obj = model.ctx.lookup(ref);
    if (!isA(obj, "PDFRawStream")) return;
    const sub = nameOf(obj.dict.lookup(N("Subtype")));
    // a picture drawn on the page, and where: a scan is read and painted over by the OCR step
    if (sub === "Image") { if (!obj.dict.lookup(N("ImageMask"))?.asBoolean?.()) model.images.push({ ref, page, ctm }); return; }
    if (sub !== "Form") return;
    const key = ref.tag;
    let part = model.byKey.get(key);
    if (!part) {
      let data; try { data = streamBytes(obj); } catch (e) { return; }
      const res = obj.dict.lookup(N("Resources")) || parent.resources;
      part = newPart(model, key, parent.where, parent.label + " (a block drawn on the page)", page, data, streamWriter(model, ref), res, parent.rect);
    }
    if (part.uses.length > 64) return;
    const m = arrayOf(model.ctx, obj.dict.get(N("Matrix")));
    const matrix = m && m.length === 6 ? m.map((x) => numOf(x, 0)) : I;
    interpret(model, part, mul(matrix, ctm), page, depth + 1);
  }

  function fieldName(ctx, annot) {
    let node = annot, guard = 0;
    while (node && guard++ < 20) {
      const t = textOf(node.lookup(N("T")));
      if (t) return t;
      node = node.lookup(N("Parent"));
    }
    return "(unnamed)";
  }

  function appearanceMatrix(ctx, stream, rect) {
    const bb = (arrayOf(ctx, stream.dict.get(N("BBox"))) || []).map((x) => numOf(x, 0));
    const mm = arrayOf(ctx, stream.dict.get(N("Matrix")));
    const matrix = mm && mm.length === 6 ? mm.map((x) => numOf(x, 0)) : I;
    if (bb.length !== 4) return [1, 0, 0, 1, rect[0], rect[1]];
    const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map((p) => at(matrix, p[0], p[1]));
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    const sx = x1 - x0 ? (rect[2] - rect[0]) / (x1 - x0) : 1, sy = y1 - y0 ? (rect[3] - rect[1]) / (y1 - y0) : 1;
    return mul(matrix, [sx, 0, 0, sy, rect[0] - x0 * sx, rect[1] - y0 * sy]);
  }

  function read(doc, { forms = true } = {}) {
    const model = new Model(doc), ctx = model.ctx;
    const acro = doc.catalog.lookup(N("AcroForm"));
    const dr = isA(acro, "PDFDict") ? acro.lookup(N("DR")) : null;
    model.pages.forEach((page, pi) => {
      const node = page.node;
      const res = node.Resources();
      let contents = node.get(N("Contents"));
      if (isA(contents, "PDFRef") && isA(ctx.lookup(contents), "PDFRawStream")) {
        const ref = contents;
        let part = model.byKey.get(ref.tag);
        if (!part) {
          let data = new Uint8Array(0);
          try { data = streamBytes(ctx.lookup(ref)); } catch (e) { /* a stream that will not decode draws no text we can read */ }
          part = newPart(model, ref.tag, "page text", "page " + (pi + 1), pi, data, streamWriter(model, ref), res, null);
        }
        interpret(model, part, I, pi, 0);
      } else {
        if (isA(contents, "PDFRef")) contents = ctx.lookup(contents);
        const refs = isA(contents, "PDFArray") ? contents.asArray().filter((r) => isA(r, "PDFRef")) : [];
        if (refs.length) {
          // the page's pieces are read as one stream and written back as a new stream of its own:
          // a piece another page also draws (a running header) keeps what it had
          const chunks = [];
          for (const r of refs) { try { chunks.push(streamBytes(ctx.lookup(r)), "\n"); } catch (e) { /* skip a piece that will not decode */ } }
          const part = newPart(model, "contents:" + page.ref.tag, "page text", "page " + (pi + 1), pi, concat(chunks),
            async (b) => { node.set(N("Contents"), await newStream(model, b)); }, res, null);
          interpret(model, part, I, pi, 0);
        }
      }
      const annots = arrayOf(ctx, node.get(N("Annots"))) || [];
      for (const annot of annots) {
        if (!isA(annot, "PDFDict")) continue;
        const widget = nameOf(annot.lookup(N("Subtype"))) === "Widget";
        const ap = annot.lookup(N("AP"));
        if ((widget && !forms) || !isA(ap, "PDFDict")) continue;
        const r = (arrayOf(ctx, annot.get(N("Rect"))) || []).map((x) => numOf(x, 0));
        if (r.length !== 4) continue;
        const rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
        const where = widget ? "form field appearance" : "note on the page";
        const label = widget ? "page " + (pi + 1) + ", field " + fieldName(ctx, annot) : "page " + (pi + 1) + ", note";
        for (const key of ["N", "R", "D"]) {
          const entry = ap.get(N(key));
          if (!entry) continue;
          const obj = isA(entry, "PDFRef") ? ctx.lookup(entry) : entry;
          const refs = isA(obj, "PDFRawStream") ? [entry] : isA(obj, "PDFDict") ? obj.values() : [];
          for (const ref of refs) {
            if (!isA(ref, "PDFRef")) continue;
            const s = ctx.lookup(ref);
            if (!isA(s, "PDFRawStream") || model.byKey.has(ref.tag)) continue;
            let data; try { data = streamBytes(s); } catch (e) { continue; }
            const sres = s.dict.lookup(N("Resources")) || dr;
            const part = newPart(model, ref.tag, where, label, pi, data, streamWriter(model, ref), sres, rect);
            interpret(model, part, appearanceMatrix(ctx, s, rect), pi, 0);
          }
        }
      }
    });
    return model;
  }

  // ------------------------------------------------------------------ text with gaps and lines
  /** The text a part draws, with a space where a gap is drawn as a move and a line break where
   * the line changes. owner[j] is the glyph behind character j, or -1 for a gap or a break. */
  function textOfPart(part) {
    if (part.cache) return part.cache;
    const geo = part.uses[0] ? part.uses[0].geo : [];
    let text = "";
    const owner = [];
    part.glyphs.forEach((g, gi) => {
      if (gi > 0 && geo[gi] && geo[gi - 1]) {
        const a = geo[gi - 1], b = geo[gi];
        const dx = b.x - a.nx, dy = b.y - a.ny;
        const along = dx * a.ux + dy * a.uy, perp = -dx * a.uy + dy * a.ux;
        let sep = "";
        if (Math.abs(perp) > 0.5 * a.em || along < -0.6 * a.em) sep = "\n";
        else if (along > 0.15 * a.em && g.text !== " " && part.glyphs[gi - 1].text !== " ") sep = " ";
        if (sep) { text += sep; owner.push(-1); }
      }
      for (const ch of g.text) { text += ch; owner.push(gi); }
    });
    part.cache = { text, owner };
    return part.cache;
  }

  // ------------------------------------------------------------------ matching
  /** A map row: { id, find, replace }. Rows are found by their first word or number, and a row
   * whose find begins or ends with a letter or digit matches only whole words there. */
  function prepareRows(rows) {
    const index = new Map();
    for (const row of rows) {
      const m = /[\p{L}\p{N}]+/u.exec(row.find);
      if (!m) continue;
      row._key = m[0]; row._off = m.index;
      row._spacesBefore = (row.find.slice(0, m.index).match(/ /g) || []).length;
      row._re = new RegExp(Array.from(row.find, (ch) => (ch === " " ? " ?" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(""), "uy");
      if (!index.has(m[0])) index.set(m[0], []);
      index.get(m[0]).push(row);
    }
    return { rows, index };
  }
  function findMatches(text, prepared) {
    const cands = [];
    const tok = /[\p{L}\p{N}]+/gu;
    let t;
    while ((t = tok.exec(text))) {
      const rows = prepared.index.get(t[0]);
      if (!rows) continue;
      for (const row of rows) {
        for (let s = t.index - row._off; s <= t.index - row._off + row._spacesBefore; s++) {
          if (s < 0) continue;
          row._re.lastIndex = s;
          const m = row._re.exec(text);
          if (!m) continue;
          const e = s + m[0].length;
          if (ALNUM.test(row.find[0]) && s > 0 && ALNUM.test(text[s - 1])) continue;
          if (ALNUM.test(row.find[row.find.length - 1]) && e < text.length && ALNUM.test(text[e])) continue;
          // a number is never part of a longer number: a ZIP is not the whole dollars of 85718.25,
          // nor the thousands of 85,718; a comma between two values (a CSV) is not a number's
          if (/\d/.test(row.find[0]) && s > 1 && /\d/.test(text[s - 2]) && (text[s - 1] === "." || (text[s - 1] === "," && /^\d{3}$/.test(row.find)))) continue;
          if (/\d/.test(row.find[row.find.length - 1]) && (/^\.\d/.test(text.slice(e, e + 2)) || (/^,\d{3}(?!\d)/.test(text.slice(e, e + 5)) && /(?:^|\D)\d{1,3}$/.test(row.find)))) continue;
          cands.push([s, e, row]);
          break;
        }
      }
    }
    cands.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]) || String(a[2].id).localeCompare(String(b[2].id)));
    const chosen = []; let last = 0;
    for (const c of cands) if (c[0] >= last) { chosen.push(c); last = c[1]; }
    return chosen;
  }
  /** For one match: [index in text, new character] for each character that changes. A space in
   * the find text that is no character on the page needs a space in the replacement. */
  function align(text, owner, s, e, row) {
    const changes = []; let j = s;
    for (let i = 0; i < row.find.length; i++) {
      const old = row.find[i], neu = row.replace[i];
      if (old === " ") {
        if (j < e && text[j] === " " && owner && owner[j] >= 0) { if (neu !== " ") changes.push([j, neu]); j++; continue; }
        if (j < e && text[j] === " ") { j++; }
        if (neu !== " ") return [null, REASONS.space];
        continue;
      }
      if (neu !== old) changes.push([j, neu]);
      j++;
    }
    return [changes, null];
  }
  /** What a match becomes: the stand-in's words, with a space wherever the text has one between
   * the old words (a space in the find text may be no character in the text). */
  function replacementFor(text, s, e, row) {
    const fw = row.find.split(" "), rw = row.replace.split(" ");
    if (fw.length !== rw.length) return row.replace;
    const seps = [];
    let j = s;
    for (let w = 0; w < fw.length; w++) {
      j += fw[w].length;
      if (w < fw.length - 1) { if (j < e && text[j] === " ") { seps.push(" "); j++; } else seps.push(""); }
    }
    return rw.map((x, k) => x + (k < seps.length ? seps[k] : "")).join("");
  }
  /** Exact replacement in a plain string (a field value, a title, a file name, a text file). */
  function swapPlain(value, prepared) {
    if (!value) return [value, []];
    const hits = [], pieces = [];
    let last = 0;
    for (const [s, e, row] of findMatches(value, prepared)) {
      pieces.push(value.slice(last, s), replacementFor(value, s, e, row));
      last = e;
      hits.push(row);
    }
    if (!hits.length) return [value, hits];
    pieces.push(value.slice(last));
    return [pieces.join(""), hits];
  }

  // ------------------------------------------------------------------ planning and writing
  /** For one match, word by word: the glyph behind each of the old word's characters, and the
   * new word. null when the text has a different number of words. */
  function wordsOf(text, owner, s, e, row) {
    const fw = row.find.split(" "), rw = row.replace.split(" ");
    if (fw.length !== rw.length) return null;
    const out = [];
    let j = s;
    for (let w = 0; w < fw.length; w++) {
      const at = [];
      for (let k = 0; k < fw[w].length; k++) at.push(j++);
      out.push({ at: at.map((x) => owner[x]), chars: at.map((x) => text[x]), neu: rw[w] });
      if (w < fw.length - 1 && j < e && text[j] === " ") j++;
    }
    return out;
  }
  function plan(part, prepared, spacing = "spread", painted = null) {
    const { text, owner } = textOfPart(part);
    const found = [];
    for (const [s, e, row] of findMatches(text, prepared)) {
      const occ = { page: part.page, where: part.where, label: part.label, row, replaced: false, reason: "", widthChange: 0, font: "", part: part.key, span: [], ins: [] };
      const span = [...new Set(owner.slice(s, e).filter((g) => g >= 0))].sort((a, b) => a - b);
      occ.span = span;
      occ.font = [...new Set(span.map((g) => part.glyphs[g].font.label))].join(", ");
      const words = wordsOf(text, owner, s, e, row);
      let reason = words ? null : REASONS.words;
      if (part.problem) reason = part.problem;
      // invisible text over a scan is swapped only where the same value was painted over in the
      // picture of that page: otherwise the page would still show what its search text no longer says
      const hidden = span.some((g) => INVISIBLE.has(part.glyphs[g].tr));
      const hiddenOk = hidden && painted && span.every((g) => INVISIBLE.has(part.glyphs[g].tr)) && part.uses.every((u) => painted.get(u.page)?.has(row.id));
      if (!reason && hidden && !hiddenOk) reason = painted && painted.size ? REASONS.hiddenUnpainted : REASONS.hidden;
      const codes = new Map(), dels = new Set(), ins = new Map(), shift = new Map(), newChar = new Map();
      let widthChange = 0;
      // a code for a character in a glyph's font, or a reason it has none
      const codeIn = (g, ch) => {
        let code = g.font.codeFor(ch);
        // a hidden search text in a font that cannot spell the stand-in: a space (or a letter of
        // the same kind the font has) holds its place, so it never keeps the original
        if (code === null && hiddenOk) { code = g.font.codeFor(" ") ?? stand(g.font, ch); occ.approx = true; }
        return code;
      };
      const advance = (g, code) => g.font.width(code) + (g.size ? (1000 * (g.tc || 0)) / g.size : 0);
      for (const wd of reason ? [] : words) {
        // every character of a word that changes length is its own glyph, or the word cannot be cut
        if (wd.at.some((gi) => gi < 0) || new Set(wd.at).size !== wd.at.length) { reason = REASONS.ligature; break; }
        const n = wd.at.length, m = [...wd.neu].length, neu = [...wd.neu];
        for (let k = 0; k < Math.max(n, m) && !reason; k++) {
          const gi = wd.at[Math.min(k, n - 1)], g = part.glyphs[gi];
          if ([...g.text].length !== 1) { reason = REASONS.ligature; break; }
          if (g.font.problem) { reason = "the text is drawn in " + g.font.problem; break; }
          if (k < n && k < m && neu[k] === wd.chars[k]) continue;
          const ow = g.font.width(g.code);
          if (ow === null) { reason = REASONS.widths; break; }
          if (k >= m) {
            // the new word is shorter: this character is taken out
            dels.add(gi);
            shift.set(g.op, (shift.get(g.op) || 0) - advance(g, g.code));
            widthChange -= (advance(g, g.code) / 1000) * g.size;
            continue;
          }
          const code = codeIn(g, neu[k]);
          if (code === null) { reason = "the font this text is drawn in (" + g.font.label + ") does not carry '" + neu[k] + "'"; break; }
          const nw = g.font.width(code);
          if (nw === null) { reason = REASONS.widths; break; }
          if (k >= n) {
            // the new word is longer: the character is added after the old word's last one
            if (!ins.has(gi)) ins.set(gi, []);
            ins.get(gi).push(code);
            shift.set(g.op, (shift.get(g.op) || 0) + advance(g, code));
            widthChange += (advance(g, code) / 1000) * g.size;
            continue;
          }
          let adjust = nw - ow;
          if (!g.font.twoByte && g.tw && (code === 32) !== (g.code === 32)) {
            if (!g.size) { reason = REASONS.size; break; }
            adjust += (1000 * g.tw / g.size) * ((code === 32) - (g.code === 32));
          }
          codes.set(gi, code);
          newChar.set(gi, neu[k]);
          shift.set(g.op, (shift.get(g.op) || 0) + adjust);
          widthChange += ((nw - ow) / 1000) * g.size;
        }
        if (reason) break;
      }
      if (reason) occ.reason = reason;
      else {
        for (const [gi, c] of codes) part.codes.set(gi, c);
        for (const gi of dels) part.deletes.add(gi);
        for (const [gi, list] of ins) { part.inserts.set(gi, (part.inserts.get(gi) || []).concat(list)); occ.ins.push([gi, list.length]); }
        const inOp = new Map();
        for (const gi of span) { if (dels.has(gi)) continue; const op = part.glyphs[gi].op; if (!inOp.has(op)) inOp.set(op, []); inOp.get(op).push(gi); }
        const add = (gi, v) => part.corrections.set(gi, (part.corrections.get(gi) || 0) + v);
        for (const [op, total] of shift) {
          if (Math.abs(total) <= 1e-9) continue;
          // a stretch of the value drawn by its own operator: the correction after its last letter
          const letters = inOp.get(op) || span.filter((gi) => part.glyphs[gi].op === op);
          // only the gaps between two letters of a word: a space keeps its width, because a
          // reader takes a narrower one for no space at all (justified text keeps them tight)
          const spaceAt = (gi) => /\s/.test(newChar.has(gi) ? newChar.get(gi) : part.glyphs[gi].text);
          const gaps = letters.slice(0, -1).filter((gi, k) => !spaceAt(gi) && !spaceAt(letters[k + 1])), last = letters[letters.length - 1];
          if (spacing !== "spread" || !gaps.length) { add(last, total); continue; }
          let each = total / gaps.length;
          // as tight or as loose as reads naturally, the rest after the last letter
          if (each > TIGHTEN_LIMIT) each = TIGHTEN_LIMIT;
          if (each < -LOOSEN_LIMIT) each = -LOOSEN_LIMIT;
          for (const gi of gaps) add(gi, each);
          const rest = total - each * gaps.length;
          if (Math.abs(rest) > 1e-9) add(last, rest);
        }
        occ.replaced = true; occ.widthChange = widthChange;
      }
      found.push(occ);
    }
    return found;
  }
  /** Where each glyph of a part is once its edits are written: old index -> new index (-1 for one
   * taken out), and how many glyphs the part draws then. An added character follows the glyph it
   * was added after. */
  function glyphMap(part) {
    const map = new Array(part.glyphs.length);
    let n = 0;
    for (let gi = 0; gi < part.glyphs.length; gi++) {
      map[gi] = part.deletes.has(gi) ? -1 : n++;
      n += (part.inserts.get(gi) || []).length;
    }
    return { map, count: n };
  }

  function stand(font, ch) {
    const kind = /\d/.test(ch) ? /\d/ : /[A-Z]/.test(ch) ? /[A-Z]/ : /[a-z]/.test(ch) ? /[a-z]/ : /./;
    for (const [c, code] of font.reverse()) if (kind.test(c) && c !== ch) return code;
    return null;
  }
  function rawOf(v) { if (Array.isArray(v)) return concat(["[", ...v.flatMap((x, k) => (k ? [" ", rawOf(x)] : [rawOf(x)])), "]"]); return v.raw; }
  function itemsOf(op) { if (op.op === "TJ") return Array.isArray(op.args[0]) ? op.args[0] : []; if (op.op === '"') return op.args.slice(2, 3); return op.args.slice(-1); }
  function rebuild(op, changes) {
    const out = []; let split = false;
    itemsOf(op).forEach((item, k) => {
      const mine = changes.get(k);
      if (!mine || !item || item.t !== "s") { out.push(rawOf(item)); return; }
      const font = mine.font; let chunk = [], wrote = false;
      font.codes(item.v).forEach((code, p) => {
        const c = mine.at.get(p);
        if (!(c && c.del)) chunk.push(c && c.code !== undefined ? c.code : code);
        if (c && c.ins) chunk.push(...c.ins);
        if (c && Math.abs(c.corr || 0) > 1e-9) { if (chunk.length) out.push(encodeString(font.toBytes(chunk), item.hex)); out.push(formatNumber(c.corr)); chunk = []; split = wrote = true; }
      });
      // a string every character of which was taken out is still a string, so the operator stands
      if (chunk.length || !wrote) out.push(encodeString(font.toBytes(chunk), item.hex));
    });
    const join = (xs) => concat(xs.flatMap((x, k) => (k ? [" ", x] : [x])));
    if (op.op === "TJ" || split) {
      let prefix = "";
      if (op.op === "'") prefix = "T* ";
      else if (op.op === '"') prefix = concat([op.args[0].raw, " Tw ", op.args[1].raw, " Tc T* "]);
      return concat([prefix, "[", join(out), "] TJ"]);
    }
    if (op.op === '"') return concat([op.args[0].raw, " ", op.args[1].raw, " ", out[0], ' "']);
    return concat([out[0], " ", op.op]);
  }
  async function apply(part) {
    if (!part.codes.size && !part.deletes.size && !part.inserts.size) return false;
    const byOp = new Map();
    for (const gi of new Set([...part.codes.keys(), ...part.corrections.keys(), ...part.deletes, ...part.inserts.keys()])) {
      const g = part.glyphs[gi];
      if (!byOp.has(g.op)) byOp.set(g.op, new Map());
      const items = byOp.get(g.op);
      if (!items.has(g.item)) items.set(g.item, { font: g.font, at: new Map() });
      items.get(g.item).at.set(g.pos, { code: part.codes.get(gi), corr: part.corrections.get(gi) || 0, del: part.deletes.has(gi), ins: part.inserts.get(gi) || null });
    }
    const pieces = []; let last = 0;
    for (const idx of [...byOp.keys()].sort((a, b) => a - b)) {
      const op = part.ops[idx];
      pieces.push(part.data.subarray(last, op.start), rebuild(op, byOp.get(idx)));
      last = op.end;
    }
    pieces.push(part.data.subarray(last));
    await part.write(concat(pieces));
    return true;
  }

  // ------------------------------------------------------------------ text kept off the page
  function otherText(doc, prepared, { forms = true, metadata = true } = {}) {
    const ctx = doc.context, found = [], P_ = P();
    const record = (hits, where, label) => hits.forEach((row) => found.push({ page: null, where, label, row, replaced: true, reason: "", widthChange: 0, font: "" }));
    const xmlRows = (() => {
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return prepareRows(prepared.rows.map((r) => ({ ...r, find: esc(r.find), replace: esc(r.replace) })));
    })();
    const setText = (dict, key, value) => dict.set(N(key), /^[\x20-\x7e]*$/.test(value) ? P_.PDFString.of(value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")) : P_.PDFHexString.fromText(value));
    const swapStream = async (ref, where, label) => {
      const s = ctx.lookup(ref);
      if (!isA(s, "PDFRawStream")) return;
      let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(streamBytes(s)); } catch (e) { return; }
      const [neu, hits] = swapPlain(text, xmlRows);
      if (hits.length) { await streamWriter({ ctx }, ref)(new TextEncoder().encode(neu)); record(hits, where, label); }
    };
    const jobs = [];
    const acro = doc.catalog.lookup(N("AcroForm"));
    if (forms && isA(acro, "PDFDict")) {
      // where each widget is drawn, so the picture check knows which boxes may change
      const pageOf = new Map();
      doc.getPages().forEach((page, pi) => { for (const r of (isA(page.node.get(N("Annots")), "PDFArray") ? page.node.get(N("Annots")).asArray() : [])) if (isA(r, "PDFRef")) pageOf.set(r.tag, pi); });
      const boxesOf = (ref, node) => {
        const out = [];
        const add = (r, n) => { const rc = (arrayOf(ctx, n.get(N("Rect"))) || []).map((x) => numOf(x, 0)); if (rc.length === 4 && pageOf.has(r && r.tag)) out.push([pageOf.get(r.tag), [Math.min(rc[0], rc[2]), Math.min(rc[1], rc[3]), Math.max(rc[0], rc[2]), Math.max(rc[1], rc[3])]]); };
        if (node.get(N("Rect"))) add(ref, node);
        for (const k of (isA(node.get(N("Kids")), "PDFArray") ? node.get(N("Kids")).asArray() : [])) { const kn = ctx.lookup(k); if (isA(kn, "PDFDict") && kn.get(N("Rect"))) add(k, kn); }
        return out;
      };
      const seen = new Set();
      const visit = (ref, prefix) => {
        const node = isA(ref, "PDFRef") ? ctx.lookup(ref) : ref;
        if (!isA(node, "PDFDict") || seen.has(node)) return; seen.add(node);
        const t = textOf(node.lookup(N("T")));
        const name = [prefix, t].filter(Boolean).join(".");
        for (const [key, where] of [["V", "form field value"], ["DV", "form field default value"]]) {
          const v = textOf(node.lookup(N(key)));
          if (v === null) continue;
          const [neu, hits] = swapPlain(v, prepared);
          if (hits.length) {
            setText(node, key, neu); record(hits, where, "field " + (t || "(unnamed)"));
            const boxes = boxesOf(ref, node);
            for (let k = found.length - hits.length; k < found.length; k++) found[k].boxes = boxes;
          }
        }
        for (const kid of (isA(node.get(N("Kids")), "PDFArray") ? node.get(N("Kids")).asArray() : [])) visit(kid, name);
      };
      for (const f of (isA(acro.lookup(N("Fields")), "PDFArray") ? acro.lookup(N("Fields")).asArray() : [])) visit(f, "");
      const xfa = acro.get(N("XFA"));
      if (isA(xfa, "PDFRef")) jobs.push(swapStream(xfa, "form data", "the form's data"));
      else if (isA(xfa, "PDFArray")) { const a = xfa.asArray(); for (let i = 0; i + 1 < a.length; i += 2) if (textOf(a[i]) === "datasets" && isA(a[i + 1], "PDFRef")) jobs.push(swapStream(a[i + 1], "form data", "the form's data")); }
    }
    if (metadata) {
      const infoRef = ctx.trailerInfo.Info;
      const info = infoRef ? ctx.lookup(infoRef) : null;
      if (isA(info, "PDFDict")) for (const [k] of info.entries()) {
        const v = textOf(info.lookup(k));
        if (v === null) continue;
        const [neu, hits] = swapPlain(v, prepared);
        if (hits.length) { setText(info, k.decodeText(), neu); record(hits, "document details", "document " + k.decodeText()); }
      }
      const meta = doc.catalog.get(N("Metadata"));
      if (isA(meta, "PDFRef")) jobs.push(swapStream(meta, "document details", "the document's XMP"));
    }
    const outlines = doc.catalog.lookup(N("Outlines"));
    if (isA(outlines, "PDFDict")) {
      const stack = [outlines.lookup(N("First"))], seen = new Set();
      while (stack.length) {
        const item = stack.pop();
        if (!isA(item, "PDFDict") || seen.has(item)) continue; seen.add(item);
        const title = textOf(item.lookup(N("Title")));
        if (title !== null) { const [neu, hits] = swapPlain(title, prepared); if (hits.length) { setText(item, "Title", neu); record(hits, "bookmark", "a bookmark"); } }
        stack.push(item.lookup(N("Next")), item.lookup(N("First")));
      }
    }
    doc.getPages().forEach((page, pi) => {
      for (const annot of arrayOf(ctx, page.node.get(N("Annots"))) || []) {
        if (!isA(annot, "PDFDict") || nameOf(annot.lookup(N("Subtype"))) === "Widget") continue;
        for (const key of ["Contents", "T"]) {
          const v = textOf(annot.lookup(N(key)));
          if (v === null) continue;
          const [neu, hits] = swapPlain(v, prepared);
          if (hits.length) { setText(annot, key, neu); record(hits, "comment", "page " + (pi + 1) + ", a comment"); }
        }
      }
    });
    return Promise.all(jobs).then(() => found);
  }

  // ------------------------------------------------------------------ whole files
  async function load(bytes) {
    return P().PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  }
  function signed(doc) {
    const acro = doc.catalog.lookup(N("AcroForm"));
    if (!isA(acro, "PDFDict")) return false;
    const ctx = doc.context, seen = new Set();
    const visit = (node) => {
      if (!isA(node, "PDFDict") || seen.has(node)) return false; seen.add(node);
      if (nameOf(node.lookup(N("FT"))) === "Sig" && node.get(N("V"))) return true;
      return (arrayOf(ctx, node.get(N("Kids"))) || []).some(visit);
    };
    return (arrayOf(ctx, acro.get(N("Fields"))) || []).some(visit);
  }
  async function open(bytes, opts = {}) {
    let doc;
    try { doc = await load(bytes); }
    catch (e) {
      const msg = String(e && e.message || e);
      return { skipped: /encrypt/i.test(msg) ? "the file is password protected or restricted, and this tool does not open those" : "the file could not be opened as a PDF" };
    }
    if (doc.isEncrypted) return { skipped: "the file is password protected or restricted, and this tool does not open those" };
    if (signed(doc)) return { skipped: "the file is digitally signed, and any change would break the signature", doc };
    const model = read(doc, opts);
    return { doc, model };
  }
  /** Lines of text the file holds, for finding what to swap: page text, form field values,
   * document details. Each line is { text, page, where }. */
  function lines(model) {
    const out = [];
    for (const part of model.parts) for (const t of textOfPart(part).text.split("\n")) if (t.trim()) out.push({ text: t, page: part.page, where: part.where });
    const ctx = model.ctx, acro = model.doc.catalog.lookup(N("AcroForm"));
    if (isA(acro, "PDFDict")) {
      const seen = new Set();
      const visit = (node) => {
        if (!isA(node, "PDFDict") || seen.has(node)) return; seen.add(node);
        const v = textOf(node.lookup(N("V")));
        if (v) for (const t of v.split(/\r\n|\r|\n/)) if (t.trim()) out.push({ text: t, page: null, where: "form field value" });
        for (const kid of arrayOf(ctx, node.get(N("Kids"))) || []) visit(kid);
      };
      for (const f of arrayOf(ctx, acro.get(N("Fields"))) || []) visit(f);
    }
    return out;
  }
  /** How many glyphs the file draws, for telling a scan (pictures of pages) from text. */
  function glyphCount(model) { return model.parts.reduce((n, p) => n + p.glyphs.filter((g) => g.text.trim()).length, 0); }

  /** Swap every row that applies, write the whole file again, and check the result. */
  async function swap(bytes, rows, { spacing = "spread", forms = true, metadata = true, paint = null } = {}) {
    const opened = await open(bytes, { forms });
    if (opened.skipped) return { skipped: opened.skipped, occurrences: [] };
    const { doc, model } = opened;
    const prepared = prepareRows(rows.map((r) => ({ ...r })));
    // pictures of pages first (the OCR step paints the values over in them), so the hidden search
    // text over a scan is swapped only where its picture was
    const painted = paint ? await paint({ doc, model, prepared, rows }) : null;
    let occurrences = [];
    for (const part of model.parts) occurrences = occurrences.concat(plan(part, prepared, spacing, painted ? painted.rowsByPage : null));
    occurrences = occurrences.concat(await otherText(doc, prepared, { forms, metadata }));
    if (painted) occurrences = occurrences.concat(painted.occurrences);
    // where every glyph will be once the edits are written: a value of another length moves the
    // glyphs after it in the stream (never on the page), and the checks follow them by this map
    const before = model.parts.map((p) => { const gm = glyphMap(p); return { key: p.key, where: p.where, uses: p.uses.map((u) => ({ page: u.page, geo: u.geo })), glyphs: p.glyphs.length, map: gm.map, count: gm.count, rect: p.rect }; });
    const mapOf = new Map(before.map((b) => [b.key, b.map]));
    const swappedSpans = new Map();
    for (const o of occurrences) if (o.replaced && o.part) {
      const map = mapOf.get(o.part);
      o.spanAfter = o.span.map((g) => map[g]).filter((g) => g >= 0);
      for (const [gi, k] of o.ins || []) for (let q = 1; q <= k; q++) o.spanAfter.push(map[gi] + q);
      o.spanAfter.sort((a, b) => a - b);
      if (!swappedSpans.has(o.part)) swappedSpans.set(o.part, []);
      swappedSpans.get(o.part).push(o);
    }
    let changed = occurrences.some((o) => o.replaced && !o.part);
    for (const part of model.parts) if (await apply(part)) changed = true;
    const textApprox = new Set(occurrences.filter((o) => o.approx).map((o) => o.page));
    const result = { occurrences, output: null, before, swappedSpans, pageCount: model.pages.length, textApprox, pictureChecks: painted ? painted.checks : [], warnings: painted ? painted.warnings : [], extraAllowed: painted ? painted.extraAllowed || [] : [] };
    if (painted && painted.changed) {
      changed = true;
      // a page's thumbnail is a small picture of the page as it was
      for (const page of model.pages) page.node.delete(N("Thumb"));
      // and so is a preview a scanner leaves in the document's XMP
      const meta = doc.catalog.get(N("Metadata"));
      if (isA(meta, "PDFRef") && isA(model.ctx.lookup(meta), "PDFRawStream")) {
        let xml = null; try { xml = new TextDecoder("utf-8", { fatal: true }).decode(streamBytes(model.ctx.lookup(meta))); } catch (e) { /* a packet that is not text holds no preview we can find */ }
        if (xml && /<xmp:Thumbnails\b/.test(xml)) await streamWriter(model, meta)(new TextEncoder().encode(xml.replace(/<xmp:Thumbnails\b[\s\S]*?<\/xmp:Thumbnails>/g, "")));
      }
    }
    if (!changed) return result;
    dropUnreferenced(doc);
    result.output = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    return result;
  }

  /** The checks this engine can make on its own output (the picture and the page text are
   * checked against a renderer in the page). */
  async function selfCheck(original, res, rows, { forms = true, metadata = true } = {}) {
    const checks = [];
    const after = await open(res.output, { forms });
    if (after.skipped) return [{ name: "structure", passed: false, detail: "the output could not be opened again" }];
    const beforeOpen = await open(original, { forms });
    const pb = beforeOpen.model.pages, pa = after.model.pages;
    let structure = pb.length === pa.length ? "" : pb.length + " pages became " + pa.length;
    if (!structure) pb.forEach((p, i) => {
      const a = pa[i];
      const sb = p.getSize(), sa = a.getSize();
      if (!structure && (sb.width !== sa.width || sb.height !== sa.height || p.getRotation().angle !== a.getRotation().angle)) structure = "page " + (i + 1) + " changed size or rotation";
      const nb = (arrayOf(beforeOpen.model.ctx, p.node.get(N("Annots"))) || []).length, na = (arrayOf(after.model.ctx, a.node.get(N("Annots"))) || []).length;
      if (!structure && nb !== na) structure = "page " + (i + 1) + " gained or lost a field or note";
    });
    checks.push({ name: "structure", passed: !structure, detail: structure });
    // nothing left: rows whose find text appears in no row's replacement
    const residual = rows.filter((r) => !rows.some((o) => o.replace.includes(r.find)));
    const prepared = prepareRows(residual.map((r) => ({ ...r })));
    let left = 0;
    for (const part of after.model.parts) left += findMatches(textOfPart(part).text, prepared).length;
    for (const l of lines(after.model).filter((l) => l.where === "form field value")) left += findMatches(l.text, prepared).length;
    checks.push({ name: "nothing left", passed: left === 0, detail: left ? left + " matches remain" : "" });
    // positions and overlap, part by part
    // what is said about a failure names the place, the kind of row and the distance; never the
    // characters, which are a client's
    let moved = 0, overlaps = [], worst = 0;
    const movedAt = [], recount = [];
    const byKey = new Map(after.model.parts.map((p) => [p.key, p]));
    // a page whose text was in several pieces is one stream now; its text is found by its page
    after.model.pages.forEach((page, pi) => {
      const k = "contents:" + page.ref.tag;
      if (!byKey.has(k)) {
        const c = page.node.get(N("Contents"));
        if (c && c.tag && byKey.has(c.tag)) byKey.set(k, byKey.get(c.tag));
      }
    });
    for (const b of res.before) {
      const a = byKey.get(b.key);
      const want = b.count ?? b.glyphs, map = b.map || [...Array(b.glyphs).keys()];
      if (!a || a.glyphs.length !== want) {
        moved++;
        recount.push((a ? want + " characters were planned and " + a.glyphs.length + " are drawn" : "a stretch of text went missing") + " in " + (b.where || "a page"));
        continue;
      }
      const inside = new Set(), after1 = new Set(), insideAfter = new Set();
      for (const o of res.swappedSpans.get(b.key) || []) { o.span.forEach((g) => inside.add(g)); after1.add(o.span[o.span.length - 1] + 1); (o.spanAfter || o.span).forEach((g) => insideAfter.add(g)); }
      b.uses.forEach((use, ui) => {
        const ga = a.uses[ui] ? a.uses[ui].geo : [];
        use.geo.forEach((g, gi) => {
          const ai = map[gi];
          if (inside.has(gi) || ai < 0 || !ga[ai]) return;
          const d = Math.max(Math.abs(g.x - ga[ai].x), Math.abs(g.y - ga[ai].y));
          worst = Math.max(worst, d);
          if (d > 0.01) {
            moved++;
            if (movedAt.length < 3) movedAt.push(d.toFixed(2) + " pt on page " + (use.page + 1) + " in " + (b.where || "a page") + ", " + (after1.has(gi) ? "the character right after a swapped word" : "not next to a swapped word") + ", drawn in " + (a.glyphs[ai].font.label || "an unnamed font"));
          }
        });
      });
      for (const o of res.swappedSpans.get(b.key) || []) {
        const sp = o.spanAfter || o.span;
        if (!sp.length) continue;
        const lastG = sp[sp.length - 1];
        const ga = a.uses[0] ? a.uses[0].geo : [];
        const L = ga[lastG], F = ga[sp[0]];
        if (!L || !F) continue;
        const begin = F.x * L.ux + F.y * L.uy;
        for (let n = lastG + 1; n < ga.length; n++) {
          if (insideAfter.has(n)) break;
          const g = ga[n];
          const perp = Math.abs(-(g.x - L.x) * L.uy + (g.y - L.y) * L.ux);
          if (perp > 0.5 * L.em) break;
          if (!a.glyphs[n].text.trim()) continue;
          const end = L.ex * L.ux + L.ey * L.uy, start = g.x * L.ux + g.y * L.uy;
          // text drawn next but back at the left of the line (a form's next column) is not in
          // the way of the swapped word
          if (start < begin - 0.01) break;
          // a value the document itself already set into its neighbour (a tight column) may
          // keep that much: only what the stand-in adds is an overlap
          const ob = b.uses[0] && b.uses[0].geo[o.span[o.span.length - 1]];
          const was = ob ? Math.max(0, ob.ex * L.ux + ob.ey * L.uy - start) : 0;
          if (end - start - was > 0.01) overlaps.push("a " + (o.row.label || "swapped") + " stand-in (map row " + o.row.id + ") runs " + (end - start - was).toFixed(2) + " pt further into the next character on " + o.label);
          break;
        }
      }
    }
    checks.push({ name: "positions", passed: moved === 0, detail: moved ? moved + " characters outside the swapped text moved" + (recount.length ? "; " + [...new Set(recount)].slice(0, 3).join("; ") : "") + (movedAt.length ? "; " + movedAt.join("; ") : "") : "largest move " + worst.toFixed(4) + " pt" });
    checks.push({ name: "no overlap", passed: !overlaps.length, detail: [...new Set(overlaps)].join("; ") });
    // where the picture may change: each swapped word's box before and after, on every page it is
    // drawn on, and the box of every field whose value changed
    const allowed = new Map();
    const allow = (page, box) => { if (!allowed.has(page)) allowed.set(page, []); allowed.get(page).push(box); };
    for (const b of res.before) {
      const occs = res.swappedSpans.get(b.key) || [];
      const a = byKey.get(b.key);
      for (const o of occs) for (const [ui, use] of b.uses.entries()) for (const [geo, idx] of [[use.geo, o.span], [a && a.uses[ui] ? a.uses[ui].geo : [], o.spanAfter || o.span]]) {
        const boxes = idx.map((g) => geo[g]).filter(Boolean).map((g) => g.box);
        if (boxes.length) allow(use.page, [Math.min(...boxes.map((x) => x[0])), Math.min(...boxes.map((x) => x[1])), Math.max(...boxes.map((x) => x[2])), Math.max(...boxes.map((x) => x[3]))]);
      }
      if (b.rect && occs.length) for (const use of b.uses) allow(use.page, b.rect);
    }
    for (const o of res.occurrences) for (const [page, box] of o.boxes || []) allow(page, box);
    // writing on a scan erased by choice
    for (const [page, box] of res.extraAllowed || []) allow(page, box);
    res.allowed = allowed;
    return checks;
  }

  /** A picture's stream written again (the OCR step's painted copy), at the same size, under the
   * same reference, so every page that draws it draws the new one in the same place. */
  function replaceImage(model, ref, { bytes, filter, gray, bpc }) {
    const old = model.ctx.lookup(ref), dict = model.ctx.obj({});
    for (const [k, v] of old.dict.entries()) {
      const name = k.decodeText();
      if (["Filter", "DecodeParms", "Decode", "Length", "ColorSpace", "BitsPerComponent", "JBIG2Globals"].includes(name)) continue;
      dict.set(k, v);
    }
    dict.set(N("ColorSpace"), N(gray ? "DeviceGray" : "DeviceRGB"));
    dict.set(N("BitsPerComponent"), P().PDFNumber.of(bpc));
    dict.set(N("Filter"), N(filter));
    model.ctx.assign(ref, P().PDFRawStream.of(dict, bytes));
  }
  /** What a picture's stream says about itself: its size, how it is packed, its bit depth. */
  function imageInfo(model, ref) {
    const o = model.ctx.lookup(ref), d = o.dict;
    const f = d.lookup(N("Filter")), filters = isA(f, "PDFArray") ? f.asArray().map(nameOf) : f ? [nameOf(f)] : [];
    const raw = o.contents;
    return { w: numOf(d.lookup(N("Width")), 0), h: numOf(d.lookup(N("Height")), 0), bpc: numOf(d.lookup(N("BitsPerComponent")), 8), filters, jpeg: filters.includes("DCTDecode") && filters.length === 1 ? raw : null, smask: !!d.get(N("SMask")) };
  }

  return { parse, encodeString, prepareRows, findMatches, align, swapPlain, replacementFor, open, read, lines, glyphCount, swap, selfCheck, textOfPart, REASONS, replaceImage, imageInfo };
})();
globalThis.PDFSwapEngine = PDFSwapEngine;
if (typeof module !== "undefined") module.exports = PDFSwapEngine;
