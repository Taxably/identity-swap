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
  const WORDY = new Set(["name", "displayName", "sheet", "author", "w:author", "w15:author", "title", "descr", "alt", "caption", "uniqueName", "v", "w:initials", "userName", "providerId", "userId",
    // a link's hover text, the text it shows, and where in the file it points (a sheet's name)
    "tooltip", "w:tooltip", "display", "location", "w:anchor"]);

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
  function sheetLines(xml, shared, ssnStyles = new Set(), dateStyles = new Set()) {
    const lines = [], extra = [], ssnCols = new Set(), dobCols = new Set(), labelCols = new Map();
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
        // a number Excel shows as a date is read as the date it shows ("3/14/1984", not 30755)
        const date = (!t || t[1] === "n") && style && dateStyles.has(+style) ? serialDate(v) : null;
        if (date) v = date;
        cells.push(v);
        if (col && SSN_HEADER.test(v)) ssnCols.add(col);
        else if (col && DOB_HEADER.test(v)) dobCols.add(col);
        else if (col && LABELLED.some(([re]) => re.test(v))) labelCols.set(col, LABELLED.find(([re]) => re.test(v))[1]);
        else if (col && labelCols.has(col)) extra.push(labelCols.get(col) + "   " + v.trim());
        else if ((col && ssnCols.has(col)) || (style && ssnStyles.has(+style))) extra.push("SSN   " + v.trim());
        else if (col && dobCols.has(col) && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v.trim())) extra.push("DOB   " + v.trim());
      }
      if (cells.length) lines.push(cells.join("   "));
    }
    return lines.concat(extra);
  }
  /** A workbook's own number formats, [id, format code], whichever order their attributes come in. */
  function numFmts(stylesXml) {
    return [...stylesXml.matchAll(/<numFmt\b([^>]*)/g)].map((m) => [(/\bnumFmtId="(\d+)"/.exec(m[1]) || [])[1], (/\bformatCode="([^"]*)"/.exec(m[1]) || [])[1]]).filter(([id, code]) => id && code !== undefined);
  }
  // a column whose header names what its cells hold: each cell is also read with that name, so a
  // number no rule would know by its shape alone ("5205550142" under Phone) is found
  const LABELLED = [
    [/^\s*(?:phone|telephone|tel\.?|cell|mobile|home phone|work phone|phone (?:no\.?|number|#))\s*$/i, "Phone"],
    [/^\s*(?:account|acct\.?|account (?:no\.?|number|#)|acct (?:no\.?|#)|bank account|routing and account)\s*$/i, "Account number"],
    [/^\s*(?:ein|fein|employer id(?:entification)?(?: number| no\.?)?)\s*$/i, "EIN"],
  ];
  const DOB_HEADER = /^\s*(?:dob|d\.o\.b\.?|date of birth|birth ?date|birthday|born)\s*$/i;
  /** An Excel date number as the date it stands for, M/D/YYYY ("30755" is 3/14/1984); null for a
   * number no date could be (a time of day alone, or past the year 9999). */
  function serialDate(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n >= 2958466) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 864e5);
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + d.getUTCFullYear();
  }
  /** The cell styles that print a number as a date: Excel's own date formats (14 to 22, 27 to 36,
   * 45 to 47, 50 to 58) and any format of the workbook's own that shows a day, a month or a year. */
  function dateStylesOf(stylesXml) {
    const builtIn = (id) => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
    const custom = new Set();
    for (const [id, raw] of numFmts(stylesXml)) {
      const m = [null, id, raw];
      // a format's quoted words and escaped letters are not codes
      const code = unescape(m[2]).replace(/"[^"]*"|\\./g, "").replace(/\[[^\]]*\]/g, "");
      if (/[dy]/i.test(code) || /m/i.test(code) && !/[hs]/i.test(code)) custom.add(+m[1]);
    }
    const out = new Set(), xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (xfs) [...xfs[1].matchAll(/<xf\b([^>]*)/g)].forEach((x, k) => { const id = /\bnumFmtId="(\d+)"/.exec(x[1]); if (id && (builtIn(+id[1]) || custom.has(+id[1]))) out.add(k); });
    return out;
  }

  /** The cell styles that print a number as an SSN (000-00-0000, Excel's own Social Security
   * Number format): their indexes in the workbook's list of cell formats. */
  function ssnStylesOf(stylesXml) {
    const ssnFmts = new Set();
    for (const [id, raw] of numFmts(stylesXml)) {
      const m = [null, id, raw];
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
    const dateStyles = files["xl/styles.xml"] ? dateStylesOf(decodePart(files["xl/styles.xml"]).text) : new Set();
    for (const [name, data] of Object.entries(files)) {
      if (/\.(png|jpe?g|gif|bmp|tiff?|webp|emf|wmf)$/i.test(name)) { media.push(name); continue; }
      if (!/\.(xml|rels|vml)$/i.test(name)) continue;
      const { text } = decodePart(data);
      const sheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name);
      if (sheet) lines.push(...sheetLines(text, shared, ssnStyles, dateStyles));
      // a sheet's cells are read row by row above, and its shared strings with them
      if (sheets && name === "xl/sharedStrings.xml") continue;
      for (const g of groups(tokens(text))) {
        if (sheet && !g.attr && g.pieces.every((p) => p.owner === "v" || p.owner === "t")) continue;
        lines.push(plainOf(g).replace(/\r?\n/g, " "));
      }
      // the addresses of external links, so what a link holds is found and checked like the rest
      if (/\.rels$/i.test(name)) for (const m of text.matchAll(/<Relationship\b[^>]*>/g)) {
        if (!/\bTargetMode="External"/.test(m[0])) continue;
        let target = unescape((/\bTarget="([^"]*)"/.exec(m[0]) || [])[1] || "");
        try { target = decodeURI(target); } catch (e) { /* as written */ }
        if (target) lines.push(target);
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
    const dateStyles = files["xl/styles.xml"] ? dateStylesOf(decodePart(files["xl/styles.xml"]).text) : new Set();
    const prepared = E().prepareRows(rows.map((r) => ({ ...r })));
    const occurrences = [], outFiles = {}, warnings = [];
    let changed = false, badXml = [];
    for (const [name, data] of Object.entries(files)) {
      let out = data;
      if (/\.(xml|rels|vml)$/i.test(name)) {
        const { text, enc } = decodePart(data);
        const sheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name);
        // a date cell whose date is swapped: the number Excel keeps for it is not the text found
        const [dated, dateHits] = sheet ? swapDateCells(text, rows, dateStyles) : [text, []];
        let [neu, hits] = swapPart(dated, prepared);
        hits = hits.concat(dateHits);
        // a number cell that took a stand-in that is not a number is written as text
        if (sheet) neu = textInNumberCells(neu);
        // a link's address ("mailto:ann@example.com", a web address with a name in it) is kept apart
        // from the text that shows it, in the part's relationships
        if (/\.rels$/i.test(name)) { const [linked, linkHits] = swapLinks(neu, prepared); neu = linked; hits = hits.concat(linkHits); }
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
    // a sheet or table name a swap made invalid for Excel is made valid, with every reference to it
    if (outFiles["xl/workbook.xml"]) validNames(outFiles, warnings);
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
  /** Date cells (a number in a date format) whose date a row swaps, M/D/YYYY as the finder read
   * it: a stand-in date becomes the number Excel keeps for it; anything else (a tag) becomes text. */
  function swapDateCells(xml, rows, dateStyles) {
    if (!dateStyles.size) return [xml, []];
    const byDate = new Map();
    for (const r of rows) if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r.find)) byDate.set(r.find, r);
    if (!byDate.size) return [xml, []];
    const hits = [];
    const out = xml.replace(/<c\b([^>]*?)>((?:(?!<\/c>)[\s\S])*)<\/c>/g, (all, attrs, body) => {
      const style = (/\bs="(\d+)"/.exec(attrs) || [])[1], v = /<v>([^<]*)<\/v>/.exec(body);
      if (/\bt="(?!n")/.test(attrs) || !style || !dateStyles.has(+style) || !v || /<f\b/.test(body)) return all;
      const row = byDate.get(serialDate(v[1]));
      if (!row) return all;
      hits.push(row);
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(row.replace);
      if (m) return "<c" + attrs + ">" + body.replace(v[0], "<v>" + (Date.UTC(+m[3], +m[1] - 1, +m[2]) - Date.UTC(1899, 11, 30)) / 864e5 + "</v>") + "</c>";
      return "<c" + attrs.replace(/\s*\bt="n"/, "") + ' t="inlineStr"><is><t xml:space="preserve">' + escText(row.replace) + "</t></is></c>";
    });
    return [out, hits];
  }
  /** The addresses of a part's external links (TargetMode="External"), swapped as text: read as
   * written (XML and %-escapes undone), swapped, written back escaped. A link to a part inside the
   * file is a path, never a value, and is left alone. */
  function swapLinks(xml, prepared) {
    const hits = [];
    const out = xml.replace(/<Relationship\b[^>]*>/g, (tag) => {
      if (!/\bTargetMode="External"/.test(tag)) return tag;
      return tag.replace(/\bTarget="([^"]*)"/, (all, raw) => {
        let target = unescape(raw);
        try { target = decodeURI(target); } catch (e) { /* an address with a stray % stays as written */ }
        const [neu, found] = E().swapPlain(target, prepared);
        if (!found.length) return all;
        hits.push(...found);
        return 'Target="' + escAttr(neu) + '"';
      });
    });
    return [out, hits];
  }

  /** A cell Excel keeps as a number (no type, or type n) whose value a swap made text: written as
   * Excel writes text, an inline string, or, where a formula makes it, a formula with a text result.
   * A number cell holding text is a file Excel calls damaged. */
  function textInNumberCells(xml) {
    return xml.replace(/<c\b([^>]*?)>((?:(?!<\/c>)[\s\S])*)<\/c>/g, (all, attrs, body) => {
      const t = /\bt="([^"]*)"/.exec(attrs);
      if (t && t[1] !== "n") return all;
      const v = /<v>([^<]*)<\/v>/.exec(body);
      if (!v || /^\s*-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/.test(v[1])) return all;
      const a = attrs.replace(/\s*\bt="n"/, "");
      if (/<f\b/.test(body)) return "<c" + a + ' t="str">' + body + "</c>";
      return "<c" + a + ' t="inlineStr">' + body.replace(v[0], '<is><t xml:space="preserve">' + v[1] + "</t></is>") + "</c>";
    });
  }

  /** Excel's own rules for names, applied after a swap. A sheet's name may not hold [ ] : * ? / \
   * and runs to 31 characters at most; a table's name is letters, digits, "_" and "." and starts
   * with a letter or "_". A swap whose stand-in breaks a rule (a tag such as "[PERSON-1-LAST]" in a
   * sheet named for the client) would leave a workbook Excel repairs or refuses, and a formula in
   * which "[...]" means another workbook. Each such name takes its nearest valid form
   * ("PERSON-1-LAST 2025"), and every formula, defined name, pivot source and property that names it
   * follows: a quoted reference ('Name'!A1), an unquoted one (Name!A1), a sheet attribute, the
   * list of sheet titles in the document's details, a table's structured references (Name[Col]). */
  function validNames(outFiles, warnings) {
    const dec = (n) => decodePart(outFiles[n][0]);
    const put = (n, text, enc) => { outFiles[n] = [encodePart(text, enc), outFiles[n][1]]; };
    const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sheets = new Map(), tables = new Map(), taken = new Set();
    const wb = dec("xl/workbook.xml");
    for (const m of wb.text.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) taken.add(unescape(m[1]).toLowerCase());
    for (const m of wb.text.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) {
      const name = unescape(m[1]);
      if (!/[[\]:*?/\\]/.test(name) && name.length <= 31 && !/^'|'$/.test(name)) continue;
      let good = name.replace(/[[\]:*?/\\]/g, "").replace(/^'+|'+$/g, "").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
      for (let k = 2; taken.has(good.toLowerCase()); k++) good = good.slice(0, 31 - String(k).length - 3) + " (" + k + ")";
      taken.add(good.toLowerCase());
      sheets.set(name, good);
    }
    for (const n of Object.keys(outFiles)) {
      if (!/^xl\/tables\/[^/]+\.xml$/.test(n)) continue;
      const m = /<table\b[^>]*\bdisplayName="([^"]*)"/.exec(dec(n).text);
      if (!m) continue;
      const name = unescape(m[1]);
      if (/^[A-Za-z_\\][A-Za-z0-9_.]*$/.test(name)) continue;
      let good = name.replace(/[^A-Za-z0-9_.]+/g, "_").replace(/^_+(?=.)/, "").replace(/^(?=[0-9.])/, "_") || "Table";
      while ([...tables.values()].includes(good)) good += "_";
      tables.set(name, good);
    }
    if (!sheets.size && !tables.size) return;
    for (const n of Object.keys(outFiles)) {
      if (!/\.(xml|rels)$/i.test(n)) continue;
      const { text, enc } = dec(n);
      let t = text;
      for (const [bad, good] of sheets) {
        const q = "'" + good.replace(/'/g, "''") + "'!";
        for (const form of [bad, escText(bad)]) {
          // quoted references, the apostrophe written as itself or as &apos;
          for (const ap of ["'", "&apos;"]) t = t.split(ap + form.replace(/'/g, ap + ap) + ap + "!").join(q.replace(/'/g, ap));
          // unquoted references, where a swap left no quotes around a name that now needs them
          t = t.replace(new RegExp("(^|[^A-Za-z0-9_.'\\]])" + esc(form) + "!", "g"), (m0, pre) => pre + q);
        }
        // the sheet's own entry, a pivot table's source, the titles in the document's details
        t = t.replace(new RegExp('(<sheet\\b[^>]*\\bname="|\\bsheet=")' + esc(escAttr(bad)) + '"', "g"), (m0, pre) => pre + escAttr(good) + '"');
        t = t.split("<vt:lpstr>" + escText(bad) + "</vt:lpstr>").join("<vt:lpstr>" + escText(good) + "</vt:lpstr>");
      }
      for (const [bad, good] of tables) {
        t = t.replace(new RegExp('(\\b(?:displayName|name)=")' + esc(escAttr(bad)) + '"', "g"), (m0, pre) => pre + good + '"');
        t = t.split(escText(bad) + "[").join(good + "[");
      }
      if (t !== text) put(n, t, enc);
    }
    const names = [...sheets.values(), ...tables.values()];
    warnings.push((names.length === 1 ? "a sheet or table name" : names.length + " sheet or table names") + " written as " + names.map((v) => "“" + v + "”").join(", ") + ": Excel does not allow the brackets of a tag there");
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
