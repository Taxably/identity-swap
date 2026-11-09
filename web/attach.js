/* Identity Swap: attachments for an AI chat. A PDF, Word, Excel, PowerPoint or text file in, the
 * same file out with every personal value replaced by the tag the text swap gave it, so the
 * attachment and the message read as one: [PERSON-1] in the email is [PERSON-1] in the W-2.
 *
 * Word, Excel and PowerPoint files are changed inside their own parts by the folder swap's Office
 * engine: formulas, numbers, tables and layout stay. A PDF is first changed in place by the folder
 * swap's PDF engine, in the PDF's own fonts, and kept only when every value was replaced and the
 * engine's checks pass (nothing of the original left, no word running into the next). When it
 * cannot be (a font that lacks "[" or "]", which most embedded fonts do, or a tag too wide for
 * where its value is printed), the PDF comes back as a text PDF: its text, page by page, with the
 * tags, set in Helvetica. An AI reads a PDF's text either way; the text PDF says on each page
 * that it is one.
 *
 * Every file is read back after it is made and searched for every value hidden. A file that still
 * holds one is never offered. Nothing here touches the network.
 */
const PDFSwapAttach = (() => {
  "use strict";
  const F = () => globalThis.PDFSwapFolder, H = () => globalThis.PDFSwapHush, E = () => globalThis.PDFSwapEngine, P = () => globalThis.PDFSwapPII;

  /** What a file is and what it says. `problem` is set when it cannot be swapped here. */
  // older spreadsheets, opened by SheetJS and written as .xlsx before they are swapped
  const LEGACY_SHEET = /\.(xls|xlsb|xlw|ods|fods|numbers|wk[1-4]|wks|dbf|sylk|slk|dif)$/i;
  // older documents and decks no browser can open; Word or PowerPoint save them as .docx and .pptx
  const LEGACY_DOC = /\.(doc|dot|wps|odt|ott|ppt|pps|pot|odp|otp|wpd|pages|key)$/i;

  /** SheetJS writes a "level" attribute on each column that Excel's format does not have (its name
   * is outlineLevel, also written), and Excel offers to repair a file that carries it: taken out. */
  function cleanSheetJs(bytes) {
    const Z = globalThis.fflate, files = Z.unzipSync(bytes);
    for (const n of Object.keys(files)) {
      if (!/^xl\/worksheets\/[^/]+\.xml$/.test(n)) continue;
      const xml = new TextDecoder().decode(files[n]);
      const neu = xml.replace(/<col\b[^>]*>/g, (tag) => tag.replace(/\s+level="\d+"/, ""));
      if (neu !== xml) files[n] = new TextEncoder().encode(neu);
    }
    return Z.zipSync(files);
  }

  async function read(name, bytes, { ocr = null } = {}) {
    let converted = null;
    const source = name;
    if (LEGACY_SHEET.test(name) && globalThis.XLSX) {
      try {
        // number formats kept (cellNF), so a date column still reads as dates once written again
        const wb = globalThis.XLSX.read(bytes, { type: "array", cellNF: true, cellDates: false, cellStyles: true, WTF: false });
        bytes = cleanSheetJs(new Uint8Array(globalThis.XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true, cellStyles: true })));
        converted = name.slice(name.lastIndexOf("."));
        name = name.replace(/\.[^.]+$/, ".xlsx");
      } catch (e) {
        return { name, bytes, kind: "other", text: "", pages: [], status: null, ocr, problem: "it could not be opened as a spreadsheet (" + ((e && e.message) || e) + "); it may be damaged, or locked with a password" };
      }
    }
    const kind = F().kindOf(name);
    const att = { name, source, bytes, kind, text: "", pages: [], problem: null, status: null, ocr, converted };
    if (!/^(pdf|office|text)$/.test(kind) && !(kind === "picture" && ocr && ocr.canRead(name))) {
      att.problem = kind === "picture" ? "a picture, and the reader for scans and photos is not available here: the folder swap in Chrome or Edge reads them"
        : LEGACY_DOC.test(name) ? "an older document or deck no browser can open: save it as .docx or .pptx in Word or PowerPoint and attach that, or swap it with the companion (companion/swap_attachments.py), which opens it with LibreOffice"
          : "not a kind of file this can change (PDF, Word, Excel, PowerPoint, an older spreadsheet, text, or a scan or photo)";
      return att;
    }
    const file = { path: name, size: bytes.length, read: async () => bytes };
    const { profiles, status } = await F().analyze([file], { ocr });
    att.status = status;
    const st = status.get(name) || {};
    if (st.state !== "ok") {
      att.problem = st.state === "scan" ? (ocr ? "a picture with no text the reader could find" : "its pages are pictures (a scan), and the reader for scans is not available here: the folder swap in Chrome or Edge reads them") : st.why || "it could not be read";
      return att;
    }
    const byPage = new Map();
    for (const prof of profiles) for (const part of prof.parts) {
      const k = part.page ?? 0;
      if (!byPage.has(k)) byPage.set(k, []);
      byPage.get(k).push(part.text);
    }
    att.pages = [...byPage].sort((a, b) => a[0] - b[0]).map(([page, texts]) => ({ page, text: texts.join("\n") }));
    att.text = att.pages.map((p) => p.text).join("\n");
    if (!att.text.trim()) att.problem = "no text could be read from it";
    return att;
  }

  /** The tagged file's name: its own name with the plan's tags ("Quillfeather W2.pdf" becomes
   * "[PERSON-1-LAST] W2 (swapped).pdf"), "(swapped)" before the kind. A name written with
   * underscores is read with spaces and written with underscores again. */
  function nameFor(att, plan, ext) {
    const dot = att.name.lastIndexOf(".");
    const stem = dot > 0 ? att.name.slice(0, dot) : att.name, kind = dot > 0 ? att.name.slice(dot) : "";
    const under = stem.includes("_") && !stem.includes(" ");
    let neu = H().hush(under ? stem.replace(/_/g, " ") : stem, plan, H().newKey()).text;
    if (under) neu = neu.replace(/ /g, "_");
    return neu + " (swapped)" + (ext || kind);
  }

  /** The file with every ticked value of `plan` replaced by its tag:
   * { bytes, name, how: "layout kept" | "text only" | "nothing to swap", count, notes } or
   * { problem } when no safe copy could be made. */
  async function swap(att, plan) {
    if (att.problem) return { problem: att.problem };
    // text read from a picture (a scan, a photo, a picture on a PDF's page) may have lost spaces
    const rows = H().rowsFor(att.text, plan, { loose: !!att.ocr && att.kind !== "office" });
    if (!rows.length) return { bytes: att.bytes, name: nameFor(att, plan), how: "nothing to swap", count: 0, notes: [] };
    let made = null;
    if (att.kind === "pdf") {
      // first in the PDF's own fonts; then, for a font that cannot draw a tag, by taking the value
      // out and drawing its tag over the gap; only when neither can, a text PDF of its pages
      // text is swapped word for word (a name of three words becomes its tag and two empty words);
      // a scanned page is painted, and a tag laid across the whole value paints best there
      const scanned = ((att.status.get(att.name) || {}).scanned || 0) > 0;
      const padded = scanned ? rows : rows.map((r) => ({ ...r, replace: r.replace + " ".repeat(r.find.split(" ").length - 1) }));
      const inPlace = await runEngine(att, padded);
      const over = inPlace.bytes ? null : await overlay(att, rows).catch((e) => ({ why: e.message }));
      if (inPlace.bytes) made = { bytes: inPlace.bytes, how: "layout kept", ext: ".pdf", warnings: inPlace.warnings };
      else if (over && over.bytes) made = { bytes: over.bytes, how: "layout kept", ext: ".pdf", drawn: true };
      else made = { bytes: await textPdf(att, plan), how: "text only", ext: ".pdf", why: (over && over.why) || inPlace.why };
    } else if (att.kind === "office") {
      const got = await runEngine(att, rows);
      if (!got.bytes) return { problem: "it could not be swapped: " + got.why };
      made = { bytes: got.bytes, how: "layout kept", warnings: got.warnings };
    } else if (att.kind === "picture") {
      // a scan or photo: each value painted over with its tag, as the folder swap paints a stand-in
      const got = await runEngine(att, rows);
      if (!got.bytes) return { problem: "it could not be swapped: " + got.why };
      made = { bytes: got.bytes, how: "layout kept", ext: got.ext, warnings: got.warnings };
    } else {
      const enc = (att.status.get(att.name) || {}).enc || "utf-8";
      const text = F().decodeText(att.bytes).text;
      made = { bytes: F().encodeText(H().hush(text, plan, H().newKey()).text, enc), how: "layout kept" };
    }
    // read back: no hidden value may be left anywhere in what is offered
    const backName = made.ext ? att.name.replace(/\.[^./]+$/, made.ext) : att.name;
    const back = await read(backName, made.bytes, { ocr: att.ocr || null });
    if (back.problem && !back.text) return { problem: "the swapped copy could not be read back to check it (" + back.problem + "), so it is not offered" };
    const left = H().leaks(back.text, plan.filter((p) => p.checked));
    const stuck = left.filter((l) => l.tag);
    if (stuck.length) return { problem: "the swapped copy still held " + stuck.map((l) => "[" + l.tag + "]").join(", ") + ", so it is not offered" };
    const notes = (made.warnings || []).map((w) => "Look at: " + w);
    if (att.converted) notes.push("Opened from " + att.converted + " and written as .xlsx: values, formulas, sheets and number formats are kept; colours, borders and fonts may be simpler.");
    if (made.drawn) notes.push("The PDF's own fonts could not draw the tags, so each value was taken out and its tag drawn in its place; the page is otherwise as it was.");
    if (made.how === "text only") notes.push("The PDF's own fonts could not show the tags in place (" + made.why + "), so this is a text PDF of its pages: the words are all there, the layout is not.");
    const still = left.filter((l) => !l.tag);
    if (still.length) notes.push("Still reads as personal: " + [...new Set(still.map((l) => l.value))].slice(0, 6).join(", ") + ". Add it to the words to always hide, or leave it if it is not.");
    return { bytes: made.bytes, name: nameFor(att, plan, made.ext), how: made.how, count: rows.length, notes };
  }

  /** The folder swap's own engine on one file: the swapped bytes, or why not. */
  async function runEngine(att, rows) {
    let out = null;
    const file = { path: att.name, size: att.bytes.length, read: async () => att.bytes };
    let ext = null;
    const [r] = await F().run([file], rows, att.status, { include: () => false, ocr: att.ocr || null, write: async (p, b) => { out = b; ext = /\.[^./]+$/.exec(p)?.[0] || null; } });
    return r && r.result === "swapped" && out ? { bytes: out, ext, warnings: r.warnings || [] } : { why: (r && r.why) || "the engine did not write it" };
  }

  // ---------------------------------------------------------------- restoring a file the AI gave back
  /** A file an AI handed back, with every tag the key knows replaced by its real value: Word, Excel
   * and PowerPoint inside their own parts, a PDF in its own fonts or with the value drawn where the
   * tag was, a text file as text. Read back after: no tag the key knows may be left.
   * { bytes, name, count, notes } or { problem }. */
  async function restoreFile(att, key) {
    if (att.problem) return { problem: att.problem };
    const byTag = new Map(key.entries.map((e) => ["[" + e.tag + "]", e.value]));
    const pairs = [...byTag].filter(([tag]) => att.text.includes(tag));
    // a sheet's name holds a tag without its brackets, which Excel does not allow there ("PERSON-1-LAST 2025")
    // Only a tag of the shape this page makes (capitals, digits, hyphens) is looked for bare: a key
    // opened from a file may hold anything, and its tags are matched as text, never read as a pattern
    const unbracketed = att.kind === "office" ? att.text.replace(/\[[^\]]*\]/g, " ") : "";
    if (att.kind === "office") for (const [tag, value] of byTag) {
      const bare = tag.slice(1, -1);
      if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(bare)) continue;
      if (new RegExp("(^|[^A-Z0-9-])" + bare.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "(?![A-Z0-9-])").test(unbracketed)) pairs.push([bare, value]);
    }
    const rows = pairs.sort((a, b) => b[0].length - a[0].length).map(([find, replace], i) => ({ id: i + 1, find, replace, label: "restore" }));
    const restoredName = (ext) => {
      const dot = att.name.lastIndexOf(".");
      const stem = H().restore(dot > 0 ? att.name.slice(0, dot) : att.name, key).text.replace(/ \(swapped\)$/, "");
      return stem + " (restored)" + (ext || (dot > 0 ? att.name.slice(dot) : ""));
    };
    if (!rows.length) return { problem: "no tag this key knows is in it: open the key that swapped its text first" };
    let bytes = null, notes = [];
    if (att.kind === "office") {
      const got = await runEngine(att, rows);
      if (!got.bytes) return { problem: "it could not be restored: " + got.why };
      bytes = got.bytes;
    } else if (att.kind === "pdf") {
      const padded = rows.map((r) => ({ ...r, replace: r.replace.split(" ").length === r.find.split(" ").length ? r.replace : r.replace.replace(/ /g, "\u00a0") }));
      const inPlace = await runEngine(att, padded);
      if (inPlace.bytes) bytes = inPlace.bytes;
      else {
        const over = await overlay(att, rows, { fit: false }).catch((e) => ({ why: e.message }));
        if (!over.bytes) return { problem: "it could not be restored: " + over.why };
        bytes = over.bytes;
        notes.push("Its fonts could not write the real values, so each tag was taken out and its value drawn in its place.");
      }
    } else {
      const enc = (att.status.get(att.name) || {}).enc || "utf-8";
      bytes = F().encodeText(H().restore(F().decodeText(att.bytes).text, key).text, enc);
    }
    const back = await read(att.name, bytes);
    const still = rows.filter((r) => back.text.includes(r.find)).map((r) => r.find);
    if (still.length) return { problem: "the restored copy still held " + still.join(", ") + ", so it is not offered" };
    const unknown = [...new Set((att.text.match(/\[[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\]/g) || []).filter((t) => !byTag.has(t)))];
    if (unknown.length) notes.push("This key does not know " + unknown.join(", ") + ", so " + (unknown.length === 1 ? "it is" : "they are") + " left as written.");
    return { bytes, name: restoredName(), count: rows.length, notes };
  }

  // ---------------------------------------------------------------- tags drawn over the page
  /** The PDF with each value taken out by the engine (taking a letter out needs no letter the font
   * lacks, and the text after it stays where it was) and its tag drawn where the value began, on
   * its baseline, in Helvetica, at the value's size or smaller so it fits the value's width. The
   * engine's own checks must pass: every value out, nothing else moved. { bytes } or { why }. */
  async function overlay(att, rows, { fit = true } = {}) {
    const L = globalThis.PDFLib;
    // every word of the value emptied: the tag is drawn, not written into the font's text
    const blanks = rows.map((r) => ({ ...r, replace: r.find.split(" ").map(() => "").join(" ") }));
    const res = await E().swap(att.bytes, blanks, { forms: true, metadata: true });
    if (res.skipped) return { why: res.skipped };
    const missed = res.occurrences.filter((o) => !o.replaced);
    if (missed.length) return { why: missed.length + " of " + res.occurrences.length + " could not be taken out: " + [...new Set(missed.map((o) => o.reason))].join("; ") };
    if (!res.output) return { why: "the engine wrote nothing" };
    const checks = await E().selfCheck(att.bytes, res, blanks, { forms: true, metadata: true });
    const failed = checks.filter((c) => !c.passed);
    if (failed.length) return { why: "check failed: " + failed.map((c) => c.name + (c.detail ? " (" + c.detail + ")" : "")).join("; ") };
    // the page's own text as it was, to measure the room after a value up to the next word on its line
    const before = fit ? null : (await E().open(att.bytes, { forms: true })).model;
    const roomAfter = (pageIx, g0, along, skip) => {
      let best = Infinity;
      for (const part of before.parts) for (const use of part.uses) {
        if (use.page !== pageIx) continue;
        use.geo.forEach((x, i) => {
          if (skip.has(part.key + ":" + i) || !part.glyphs[i]) return;
          const d = along(x.x, x.y), off = Math.abs((x.y - g0.y) * g0.ux - (x.x - g0.x) * g0.uy);
          if (d > 0.5 && off < g0.em * 0.5 && d < best) best = d;
        });
      }
      return best;
    };
    const doc = await L.PDFDocument.load(res.output, { updateMetadata: false });
    const font = await doc.embedFont(L.StandardFonts.Helvetica);
    const pages = doc.getPages();
    const byKey = new Map(res.before.map((b) => [b.key, b]));
    let drawn = 0;
    for (const o of res.occurrences) {
      if (!o.part) continue;
      let tag = rows.find((r) => r.id === o.row.id)?.replace;
      const b = byKey.get(o.part);
      if (!b || !tag) continue;
      for (const use of b.uses) {
        const g = o.span.map((i) => use.geo[i]).filter(Boolean);
        if (!g.length) continue;
        // the value's first line: a value wrapped onto a second line keeps its tag on the first
        const line = g.filter((x) => Math.abs((x.y - g[0].y) * g[0].ux - (x.x - g[0].x) * g[0].uy) < g[0].em * 0.5);
        const along = (x, y) => (x - g[0].x) * g[0].ux + (y - g[0].y) * g[0].uy;
        const width = Math.max(...line.map((x) => along(x.ex, x.ey)));
        // the spaces between the value's words stay in the page's text, where its first word began:
        // the tag starts after them, so a reader meets the spaces, then the tag whole
        const find = o.row.find;
        const lead = o.span.length === find.length ? [...find].reduce((n, ch, i) => n + (ch === " " && g[i] ? along(g[i].ex, g[i].ey) - along(g[i].x, g[i].y) : 0), 0) : 0;
        const pageIx = typeof use.page === "number" ? use.page : o.page;
        // a tag fits where its value was; a restored value fits up to the next word on its line
        const skip = new Set(o.span.map((i) => o.part + ":" + i));
        const room = fit ? Math.max(1, width - lead) : Math.max(1, Math.min(roomAfter(pageIx, g[0], along, skip), 2000) - g[0].em * 0.25);
        // never below 4 pt, and a restored value never below 60% of its line's size: it is read by a person
        const size = Math.max(fit ? 4 : g[0].em * 0.6, Math.min(g[0].em, g[0].em * room / Math.max(1, font.widthOfTextAtSize(tag, g[0].em))));
        const page = pages[pageIx];
        if (!page) continue;
        // Helvetica writes Windows-1252; a letter outside it is written as "?"
        tag = [...tag].map((ch) => { try { font.encodeText(ch); return ch; } catch (e) { return "?"; } }).join("");
        page.drawText(tag, { x: g[0].x + lead * g[0].ux, y: g[0].y + lead * g[0].uy, size, font, color: L.rgb(0, 0, 0), rotate: L.degrees(Math.atan2(g[0].uy, g[0].ux) * 180 / Math.PI) });
        drawn++;
      }
    }
    if (!drawn) return { why: "no tag could be placed" };
    return { bytes: await doc.save({ useObjectStreams: false }) };
  }

  // ---------------------------------------------------------------- the text PDF
  const PAGE = [612, 792], MARGIN = 54, SIZE = 10, LEAD = 13.5;
  /** The PDF's text, tagged, page by page in Helvetica. Each page of the original starts a page of
   * its own (and runs on to more when it is long), headed with where it came from. */
  async function textPdf(att, plan) {
    const L = globalThis.PDFLib;
    const doc = await L.PDFDocument.create();
    const font = await doc.embedFont(L.StandardFonts.Helvetica), bold = await doc.embedFont(L.StandardFonts.HelveticaBold);
    // a character Helvetica cannot write (outside Windows-1252) is written as "?"
    const safe = (s) => [...s].map((ch) => { try { font.encodeText(ch); return ch; } catch (e) { return "?"; } }).join("");
    const width = PAGE[0] - 2 * MARGIN;
    const wrap = (line) => {
      const out = [];
      let cur = "";
      for (const w of line.split(/(\s+)/)) {
        if (font.widthOfTextAtSize(cur + w, SIZE) <= width) { cur += w; continue; }
        if (cur.trim()) out.push(cur.trimEnd());
        cur = w.trimStart();
        // one word wider than the page is cut where it must be
        while (font.widthOfTextAtSize(cur, SIZE) > width) {
          let k = cur.length;
          while (k > 1 && font.widthOfTextAtSize(cur.slice(0, k), SIZE) > width) k--;
          out.push(cur.slice(0, k)); cur = cur.slice(k);
        }
      }
      out.push(cur.trimEnd());
      return out;
    };
    const total = att.pages.length;
    for (const pg of att.pages) {
      const tagged = H().hush(pg.text, plan, H().newKey()).text;
      const lines = tagged.split(/\r\n|\r|\n/).map(safe).flatMap(wrap);
      let page = null, y = 0, cont = false;
      const start = () => {
        page = doc.addPage(PAGE);
        y = PAGE[1] - MARGIN;
        page.drawText("Page " + (pg.page + 1) + " of " + total + (cont ? ", continued" : "") + ". Text only: personal details are replaced by tags.", { x: MARGIN, y, size: 8.5, font: bold, color: L.rgb(0.31, 0.37, 0.47) });
        y -= LEAD * 1.8;
        cont = true;
      };
      start();
      for (const line of lines) {
        if (y < MARGIN) start();
        if (line) page.drawText(line, { x: MARGIN, y, size: SIZE, font, color: L.rgb(0.08, 0.13, 0.24) });
        y -= LEAD;
      }
    }
    // nothing about the original in the file's own details: no title, author or dates of its
    doc.setProducer("Identity Swap"); doc.setCreator("Identity Swap");
    return await doc.save({ useObjectStreams: false });
  }

  return { read, swap, restoreFile, nameFor, textPdf, overlay };
})();
globalThis.PDFSwapAttach = PDFSwapAttach;
if (typeof module !== "undefined") module.exports = PDFSwapAttach;
