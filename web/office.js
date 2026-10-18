/* PDF identity swap: Office files (Excel, Word, PowerPoint) swapped in place.
 *
 * An Office file is a zip of XML parts. Every part is read as it is and only text changes: the
 * text of a cell, a shared string, a paragraph, a slide, a comment, a chart's cached labels, a
 * header or footer, the document's own details (author, company, title), a sheet's name (and every
 * formula that names the sheet with it), a pivot table's remembered values. Styles, formulas,
 * column widths, layout and pictures are carried byte for byte. A word Word split across runs of
 * different formatting ("Lyn" in one run, "sey" in the next) is found across them, and the new
 * word is written into the first run. Numbers stay numbers: a ZIP code stored as a number becomes
 * another number, and no value matches inside a longer number.
 */
const PDFSwapOffice = (() => {
  "use strict";
  const E = () => globalThis.PDFSwapEngine;
  const Z = () => globalThis.fflate;
  const KINDS = /\.(xlsx|xlsm|xltx|xltm|docx|docm|dotx|dotm|pptx|pptm|potx|potm|ppsx|ppsm)$/i;
  const isOffice = (path) => KINDS.test(path);

  // ---------------------------------------------------------------- XML text, as written
  const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  const unescape = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()]));
  const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => escText(s).replace(/"/g, "&quot;");
  // runs of text in a paragraph are read as one: Word's w:t, DrawingML's a:t, a cell's t
  const RUN = new Set(["w:t", "w:delText", "a:t", "t"]);
  const PARAGRAPH = new Set(["w:p", "a:p", "si", "is", "m:oMath"]);
  // attributes that hold words a person reads: a sheet's or table's name, an author, a title, a
  // pivot table's remembered value, a picture's description
  const WORDY = new Set(["name", "displayName", "sheet", "author", "w:author", "w15:author", "title", "descr", "alt", "caption", "uniqueName", "v", "w:initials", "userName", "providerId", "userId"]);

  function decodePart(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), enc: "utf-16le" };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), enc: "utf-16be" };
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return { text: new TextDecoder("utf-8").decode(bom ? bytes.subarray(3) : bytes), enc: bom ? "utf-8-bom" : "utf-8" };
  }
  function encodePart(text, enc) {
    if (enc === "utf-16le" || enc === "utf-16be") {
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = enc === "utf-16le" ? 0xff : 0xfe; out[1] = enc === "utf-16le" ? 0xfe : 0xff;
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (enc === "utf-16le") { out[2 + 2 * i] = c & 255; out[3 + 2 * i] = c >> 8; } else { out[2 + 2 * i] = c >> 8; out[3 + 2 * i] = c & 255; } }
      return out;
    }
    const body = new TextEncoder().encode(text);
    if (enc !== "utf-8-bom") return body;
    const out = new Uint8Array(body.length + 3); out.set([0xef, 0xbb, 0xbf]); out.set(body, 3); return out;
  }

  /** An XML part as tokens: tags (with their name) and text nodes. Comments, CDATA and the
   * declaration are kept as they are. */
  function tokens(xml) {
    const out = [];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+/g;
    let m;
    while ((m = re.exec(xml))) {
      const raw = m[0];
      if (raw[0] !== "<") out.push({ type: "text", raw });
      else if (m[1]) out.push({ type: raw[1] === "/" ? "close" : m[3] ? "empty" : "open", name: m[1], attrs: m[2] || "", raw });
      else out.push({ type: "other", raw });
    }
    return out;
  }
  /** Whether every element that opens closes, in order: a part this tool writes is checked so. */
  function wellFormed(xml) {
    const stack = [];
    for (const t of tokens(xml)) {
      if (t.type === "open") stack.push(t.name);
      else if (t.type === "close" && stack.pop() !== t.name) return false;
      else if (t.type === "text" && /[<]/.test(t.raw)) return false;
    }
    return stack.length === 0;
  }

  /** The text of a part in groups: a paragraph's runs together, every other text node and wordy
   * attribute on its own. Each group is [{ tok, at, len }] over the joined text. */
  function groups(toks) {
    const out = [], stack = [];
    let para = null;
    const textOwner = () => stack[stack.length - 1];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === "open") {
        stack.push(t.name);
        if (PARAGRAPH.has(t.name)) { para = { pieces: [], depth: stack.length }; out.push(para); }
      } else if (t.type === "close") {
        if (para && stack.length === para.depth && PARAGRAPH.has(t.name)) para = null;
        stack.pop();
        if (para && stack.length < para.depth) para = null;
      } else if (t.type === "text") {
        const owner = textOwner();
        if (!owner || !t.raw.trim() && !RUN.has(owner)) continue;
        if (para && RUN.has(owner)) para.pieces.push({ i, owner, text: unescape(t.raw) });
        else out.push({ pieces: [{ i, owner, text: unescape(t.raw) }] });
      }
      if ((t.type === "open" || t.type === "empty") && t.attrs) {
        for (const m of t.attrs.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
          if (!WORDY.has(m[1])) continue;
          out.push({ attr: { i, name: m[1] }, pieces: [{ i, text: unescape(m[3] ?? m[4] ?? "") }] });
        }
      }
    }
    return out.filter((g) => g.pieces.length && g.pieces.some((p) => p.text.trim()));
  }
  const joined = (g) => g.pieces.map((p) => p.text).join("");

  /** A spreadsheet's rows as lines, cells apart by three spaces, shared strings looked up: a label
   * in one cell and the name in the next read as "Taxpayer name   Ann Lee". A cell an SSN is kept
   * in (Excel's Social Security Number format, or a column headed SSN) is also read as its own
   * line, "SSN   12345678", so one kept as a number, without its leading zero, is found. */
  const SSN_HEADER = /^\s*(?:ssn|ss ?#|ss ?no\.?|social security(?: number| no\.?| #)?|soc\.? ?sec\.?(?: ?#| no\.?)?|tin|itin|ssn ?\/ ?itin|taxpayer id(?:entification)?(?: number| no\.?)?|tax ?id(?: number| no\.?)?)\s*$/i;
  function sheetLines(xml, shared, ssnStyles = new Set()) {
    const lines = [], extra = [], ssnCols = new Set();
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = /\bt="([^"]*)"/.exec(c[1]), body = c[2] || "";
        const col = (/\br="([A-Z]+)\d+"/.exec(c[1]) || [])[1], style = (/\bs="(\d+)"/.exec(c[1]) || [])[1];
        let v = null;
        if (t && t[1] === "s") { const k = /<v>([^<]*)<\/v>/.exec(body); v = k ? shared[+k[1]] ?? "" : ""; }
        else if (t && t[1] === "inlineStr") v = [...body.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => unescape(x[1])).join("");
        else { const k = /<v>([^<]*)<\/v>/.exec(body); v = k ? unescape(k[1]) : null; }
        if (v === null || v === "") continue;
        cells.push(v);
        if (col && SSN_HEADER.test(v)) ssnCols.add(col);
        else if ((col && ssnCols.has(col)) || (style && ssnStyles.has(+style))) extra.push("SSN   " + v.trim());
      }
      if (cells.length) lines.push(cells.join("   "));
    }
    return lines.concat(extra);
  }
  /** The cell styles that print a number as an SSN (000-00-0000, Excel's own Social Security
   * Number format): their indexes in the workbook's list of cell formats. */
  function ssnStylesOf(stylesXml) {
    const ssnFmts = new Set();
    for (const m of stylesXml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) {
      const code = unescape(m[2]).replace(/[\\"]/g, "");
      if (/^0{3}-0{2}-0{4}$/.test(code)) ssnFmts.add(+m[1]);
    }
    const out = new Set(), xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (ssnFmts.size && xfs) [...xfs[1].matchAll(/<xf\b([^>]*)/g)].forEach((x, k) => { const id = /\bnumFmtId="(\d+)"/.exec(x[1]); if (id && ssnFmts.has(+id[1])) out.add(k); });
    return out;
  }

  /** Everything a finding step reads in an Office file: one text profile, a line per paragraph,
   * per row of a sheet, per other text, and the pictures inside it (for the reader). */
  // A sheet's header and footer are one text with Excel's codes in it ("&CHarrowgate 2025": &C
  // centres what follows; &P is the page number, &"Arial,Bold" a face, &12 a size, &K and six
  // figures a colour): each code reads as spaces of its own length, so the name after it is a word
  // of its own and every place in the text is where it was
  const HEADER = /^(?:odd|even|first)(?:Header|Footer)$/;
  const CODE = /&(?:"[^"]*"|K[0-9A-Fa-f]{6}|K\d\d[+-]\d{3}|\d+|[LCRPNDTFAZGBIUESXYH&])/g;
  function plainOf(g) {
    const text = joined(g);
    return !g.attr && g.pieces.every((p) => HEADER.test(p.owner || "")) ? text.replace(CODE, (m) => " ".repeat(m.length)) : text;
  }
  function read(bytes, path) {
    const files = Z().unzipSync(bytes);
    const lines = [], media = [];
    const shared = [];
    if (files["xl/sharedStrings.xml"]) {
      const { text } = decodePart(files["xl/sharedStrings.xml"]);
      for (const si of text.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push([...si[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => unescape(x[1])).join(""));
    }
    const sheets = Object.keys(files).some((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
    const ssnStyles = files["xl/styles.xml"] ? ssnStylesOf(decodePart(files["xl/styles.xml"]).text) : new Set();
    for (const [name, data] of Object.entries(files)) {
      if (/\.(png|jpe?g|gif|bmp|tiff?|webp|emf|wmf)$/i.test(name)) { media.push(name); continue; }
      if (!/\.(xml|rels|vml)$/i.test(name)) continue;
      const { text } = decodePart(data);
      const sheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name);
      if (sheet) lines.push(...sheetLines(text, shared, ssnStyles));
      // a sheet's cells are read row by row above, and its shared strings with them
      if (sheets && name === "xl/sharedStrings.xml") continue;
      for (const g of groups(tokens(text))) {
        if (sheet && !g.attr && g.pieces.every((p) => p.owner === "v" || p.owner === "t")) continue;
        lines.push(plainOf(g).replace(/\r?\n/g, " "));
      }
    }
    const prof = globalThis.PDFSwapPII.textProfile(lines.join("\n"), path);
    for (const b of prof.blocks) b.where = /\.xls/i.test(path) ? "spreadsheet text" : /\.ppt|\.pot|\.pps/i.test(path) ? "slide text" : "document text";
    return { profile: prof, media, files };
  }

  /** One part with the rows applied: a paragraph's runs as one text, the new word written into
   * the run where the old one starts; [new xml, hits]. */
  function swapPart(xml, prepared) {
    const toks = tokens(xml), hits = [];
    const changed = new Map(); // token index -> new text (or, for an attribute, a map of new values)
    for (const g of groups(toks)) {
      const text = joined(g);
      const matches = E().findMatches(plainOf(g), prepared);
      if (!matches.length) continue;
      // where each piece starts in the joined text
      const starts = [];
      let at = 0;
      for (const p of g.pieces) { starts.push(at); at += p.text.length; }
      const pieceAt = (k) => { let j = 0; while (j + 1 < starts.length && starts[j + 1] <= k) j++; return j; };
      const neu = g.pieces.map((p) => p.text.split(""));
      // later matches first, so earlier offsets stay right
      for (const [s, e, row] of matches.slice().reverse()) {
        const rep = E().replacementFor(text, s, e, row);
        const a = pieceAt(s), b = pieceAt(Math.max(s, e - 1));
        if (a === b) neu[a].splice(s - starts[a], e - s, rep);
        else {
          neu[a].splice(s - starts[a], neu[a].length - (s - starts[a]), rep);
          for (let j = a + 1; j < b; j++) neu[j] = [];
          neu[b].splice(0, e - starts[b]);
        }
        hits.push(row);
      }
      g.pieces.forEach((p, j) => {
        const v = neu[j].join("");
        if (v === p.text) return;
        if (g.attr) { if (!changed.has(p.i)) changed.set(p.i, new Map()); changed.get(p.i).set(g.attr.name, v); }
        else changed.set(p.i, v);
      });
    }
    if (!changed.size) return [xml, hits];
    const out = toks.map((t, i) => {
      if (!changed.has(i)) return t.raw;
      const v = changed.get(i);
      if (t.type === "text") return escText(v);
      // an attribute's value, in the tag as written
      return t.raw.replace(/([^\s=]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (m, name, eq) => (v.has(name) ? name + eq + '"' + escAttr(v.get(name)) + '"' : m));
    });
    // a run whose text now starts or ends with a space keeps the space only with xml:space
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== "open" || !RUN.has(t.name) || /xml:space=/.test(t.raw)) continue;
      const next = changed.get(i + 1);
      if (typeof next === "string" && /^\s|\s$/.test(next)) out[i] = t.raw.replace(/^<([\w:]+)/, '<$1 xml:space="preserve"');
    }
    return [out.join(""), hits];
  }

  /** The whole file: every XML part swapped, pictures through `paintMedia` when given, the zip
   * written again with its parts in their order. Returns { output, occurrences, checks, warnings }
   * (what each picture inside it says to look at: a value blanked out, writing nobody can read). */
  async function swap(bytes, rows, { paintMedia = null } = {}) {
    const files = Z().unzipSync(bytes);
    const prepared = E().prepareRows(rows.map((r) => ({ ...r })));
    const occurrences = [], outFiles = {}, warnings = [];
    let changed = false, badXml = [];
    for (const [name, data] of Object.entries(files)) {
      let out = data;
      if (/\.(xml|rels|vml)$/i.test(name)) {
        const { text, enc } = decodePart(data);
        const [neu, hits] = swapPart(text, prepared);
        for (const row of hits) occurrences.push({ where: "text", label: partLabel(name), row, replaced: true, reason: "" });
        if (neu !== text) {
          if (!wellFormed(neu)) badXml.push(partLabel(name));
          out = encodePart(neu, enc); changed = true;
        }
      } else if (paintMedia && /\.(png|jpe?g|webp)$/i.test(name)) {
        const got = await paintMedia(data, name);
        if (got) {
          for (const o of got.occurrences || []) occurrences.push({ ...o, label: "a picture inside it" });
          for (const w of got.warnings || []) warnings.push(w.replace(/^the picture\b/, "the picture " + name.split("/").pop() + " inside it"));
          if (got.output) { out = got.output; changed = true; }
        }
      }
      // pictures and other packed parts are stored as they are; text is packed again
      outFiles[name] = [out, { level: /\.(png|jpe?g|gif|zip|mp4|wdp)$/i.test(name) ? 0 : 6 }];
    }
    if (!changed) return { output: null, occurrences, checks: [], warnings };
    const output = Z().zipSync(outFiles);
    // checks on the written file: it opens, every part it changed is whole XML, and nothing of
    // the original is left in any text it holds
    const checks = [];
    let reopened = null;
    try { reopened = read(output, "check"); } catch (e) { reopened = null; }
    checks.push({ name: "opens", passed: !!reopened, detail: reopened ? "" : "the file written could not be opened again" });
    checks.push({ name: "parts whole", passed: !badXml.length, detail: badXml.length ? "these parts would not be whole XML: " + [...new Set(badXml)].join(", ") : "" });
    const residual = rows.filter((r) => !rows.some((o) => o.replace.includes(r.find)));
    const left = reopened ? E().findMatches(reopened.profile.parts[0].text, E().prepareRows(residual.map((r) => ({ ...r })))).length : 0;
    checks.push({ name: "nothing left", passed: !!reopened && left === 0, detail: left ? left + " original values still read in it" : "" });
    return { output, occurrences, checks, warnings };
  }
  function partLabel(name) {
    if (/^xl\/worksheets\//.test(name) || name === "xl/sharedStrings.xml") return "a cell";
    if (/^xl\/workbook\.xml$/.test(name)) return "a sheet's name";
    if (/comments|threadedComments|persons/i.test(name)) return "a comment";
    if (/^docProps\//.test(name)) return "the document's details";
    if (/chart/i.test(name)) return "a chart";
    if (/pivot/i.test(name)) return "a pivot table";
    if (/header|footer/i.test(name)) return "a header or footer";
    if (/^ppt\/slides\//.test(name)) return "a slide";
    if (/^word\/document\.xml$/.test(name)) return "the document's text";
    return "text inside the file";
  }

  return { isOffice, read, swap, swapPart, tokens, wellFormed, groups, sheetLines };
})();
globalThis.PDFSwapOffice = PDFSwapOffice;
if (typeof module !== "undefined") module.exports = PDFSwapOffice;
