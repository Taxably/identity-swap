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
  async function read(name, bytes) {
    const kind = F().kindOf(name);
    const att = { name, bytes, kind, text: "", pages: [], problem: null, status: null };
    if (!/^(pdf|office|text)$/.test(kind)) {
      att.problem = kind === "picture" ? "a picture: photos and scans are read by the folder swap, which paints realistic stand-ins over them" : "not a kind of file this can change (PDF, Word, Excel, PowerPoint or a text file)";
      return att;
    }
    const file = { path: name, size: bytes.length, read: async () => bytes };
    const { profiles, status } = await F().analyze([file], {});
    att.status = status;
    const st = status.get(name) || {};
    if (st.state !== "ok") {
      att.problem = st.state === "scan" ? "its pages are pictures (a scan), with no text to swap; run it through the folder swap, which reads scans" : st.why || "it could not be read";
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
    const rows = H().rowsFor(att.text, plan);
    if (!rows.length) return { bytes: att.bytes, name: nameFor(att, plan), how: "nothing to swap", count: 0, notes: [] };
    let made = null;
    if (att.kind === "pdf") {
      // the engine swaps word for word: a name of three words becomes its tag and two empty words
      const padded = rows.map((r) => ({ ...r, replace: r.replace + " ".repeat(r.find.split(" ").length - 1) }));
      const inPlace = await runEngine(att, padded);
      if (inPlace.bytes) made = { bytes: inPlace.bytes, how: "layout kept", ext: ".pdf" };
      else made = { bytes: await textPdf(att, plan), how: "text only", ext: ".pdf", why: inPlace.why };
    } else if (att.kind === "office") {
      const got = await runEngine(att, rows);
      if (!got.bytes) return { problem: "it could not be swapped: " + got.why };
      made = { bytes: got.bytes, how: "layout kept" };
    } else {
      const enc = (att.status.get(att.name) || {}).enc || "utf-8";
      const text = F().decodeText(att.bytes).text;
      made = { bytes: F().encodeText(H().hush(text, plan, H().newKey()).text, enc), how: "layout kept" };
    }
    // read back: no hidden value may be left anywhere in what is offered
    const back = await read(att.name, made.bytes);
    if (back.problem && !back.text) return { problem: "the swapped copy could not be read back to check it (" + back.problem + "), so it is not offered" };
    const left = H().leaks(back.text, plan.filter((p) => p.checked));
    const stuck = left.filter((l) => l.tag);
    if (stuck.length) return { problem: "the swapped copy still held " + stuck.map((l) => "[" + l.tag + "]").join(", ") + ", so it is not offered" };
    const notes = [];
    if (made.how === "text only") notes.push("The PDF's own fonts could not show the tags in place (" + made.why + "), so this is a text PDF of its pages: the words are all there, the layout is not.");
    const still = left.filter((l) => !l.tag);
    if (still.length) notes.push("Still reads as personal: " + [...new Set(still.map((l) => l.value))].slice(0, 6).join(", ") + ". Add it to the words to always hide, or leave it if it is not.");
    return { bytes: made.bytes, name: nameFor(att, plan, made.ext), how: made.how, count: rows.length, notes };
  }

  /** The folder swap's own engine on one file: the swapped bytes, or why not. */
  async function runEngine(att, rows) {
    let out = null;
    const file = { path: att.name, size: att.bytes.length, read: async () => att.bytes };
    const [r] = await F().run([file], rows, att.status, { include: () => false, write: async (_, b) => { out = b; } });
    return r && r.result === "swapped" && out ? { bytes: out } : { why: (r && r.why) || "the engine did not write it" };
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

  return { read, swap, nameFor, textPdf };
})();
globalThis.PDFSwapAttach = PDFSwapAttach;
if (typeof module !== "undefined") module.exports = PDFSwapAttach;
