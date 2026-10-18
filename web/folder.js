/* PDF identity swap: a whole folder in, the same tree out, with every swap and rename applied.
 * No browser objects here, so the same steps run in the page and in a test. Files are read one
 * at a time, so a 3 GB folder never sits in memory. A zip archive is opened and every file inside
 * it is handled as if it were in the folder, then packed again under its swapped name. */
const PDFSwapFolder = (() => {
  "use strict";
  const E = () => globalThis.PDFSwapEngine, PII = () => globalThis.PDFSwapPII, OFF = () => globalThis.PDFSwapOffice;
  const TEXT_KINDS = /\.(txt|csv|tsv|md|json|xml|html?|rtf|eml|ofx|qfx|qbo|iif|log|ini|ya?ml|vcf|ics|tab|prn)$/i;
  const PICTURE_KINDS = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i;

  function kindOf(path) {
    // a Mac's ._ companion files and __MACOSX folders, Finder's and Explorer's own files: they hold
    // the system's notes about a file (sometimes where it was downloaded from), never a document
    if (/(^|\/)(\.ds_store|thumbs\.db|desktop\.ini|icon\r)$/i.test(path) || /(^|\/)\._[^/]*$/.test(path) || /(^|\/)__MACOSX\//.test(path)) return "system";
    if (/\.pdf$/i.test(path)) return "pdf";
    if (OFF() && OFF().isOffice(path)) return "office";
    if (/\.zip$/i.test(path)) return "zip";
    if (TEXT_KINDS.test(path)) return "text";
    if (PICTURE_KINDS.test(path)) return "picture";
    return "other";
  }

  /** A text file's characters and how they were written: UTF-16 by its mark, UTF-8 when it
   * reads as UTF-8, otherwise Windows-1252 (what Excel and older tax software write). */
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), enc: "utf-16le" };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), enc: "utf-16be" };
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes), enc: bom ? "utf-8-bom" : "utf-8" }; }
    catch (e) { return { text: new TextDecoder("windows-1252").decode(bytes), enc: "windows-1252" }; }
  }
  const CP1252 = new Map([[0x20ac, 0x80], [0x201a, 0x82], [0x192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x2c6, 0x88], [0x2030, 0x89], [0x160, 0x8a], [0x2039, 0x8b], [0x152, 0x8c], [0x17d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x2dc, 0x98], [0x2122, 0x99], [0x161, 0x9a], [0x203a, 0x9b], [0x153, 0x9c], [0x17e, 0x9e], [0x178, 0x9f]]);
  function encodeText(text, enc) {
    if (enc === "utf-16le" || enc === "utf-16be") {
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = enc === "utf-16le" ? 0xff : 0xfe; out[1] = enc === "utf-16le" ? 0xfe : 0xff;
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i), [a, b] = enc === "utf-16le" ? [c & 255, c >> 8] : [c >> 8, c & 255]; out[2 + 2 * i] = a; out[3 + 2 * i] = b; }
      return out;
    }
    if (enc === "windows-1252") return Uint8Array.from(text, (ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : CP1252.get(c) ?? 63; });
    const body = new TextEncoder().encode(text);
    if (enc !== "utf-8-bom") return body;
    const out = new Uint8Array(body.length + 3); out.set([0xef, 0xbb, 0xbf]); out.set(body, 3); return out;
  }

  /** The folders that are the clients: the level under the chosen folder whose names read most
   * like people's names ("Last, First", "First Last"). */
  function clientFolders(paths) {
    let best = null;
    // the chosen folder itself is the client when its own name is one ("Last, First M") and the
    // folders inside it are not
    const root = paths.length ? paths[0].split("/")[0] : "";
    if (root && PII().folderName(root)) best = { depth: 0, share: 0.5, groups: [{ name: root, files: paths.filter((p) => p.split("/")[0] === root) }] };
    for (const depth of [1, 2, 3]) {
      const groups = new Map();
      for (const p of paths) {
        const segs = p.split("/");
        if (segs.length <= depth + 1) continue;
        const key = segs.slice(0, depth + 1).join("/");
        if (!groups.has(key)) groups.set(key, { name: segs[depth], files: [] });
        groups.get(key).files.push(p);
      }
      const named = [...groups.values()].filter((g) => PII().folderName(g.name));
      const share = groups.size ? named.length / groups.size : 0;
      if (named.length && (!best || share > best.share)) best = { depth, share, groups: named };
    }
    return best ? best.groups : [];
  }

  /** Files in order, a few at a time where pictures are read (the reader runs in several workers
   * at once); everything else one at a time, as it always was. */
  async function each(files, limit, heavy, fn) {
    const running = new Set();
    for (let i = 0; i < files.length; i++) {
      if (limit > 1 && heavy(files[i])) {
        while (running.size >= limit) await Promise.race(running);
        const p = fn(files[i], i).finally(() => running.delete(p));
        running.add(p);
      } else await fn(files[i], i);
    }
    await Promise.all(running);
  }
  const SCANNED = "scanned page";
  /** The pictures OCR read, as lines of text a finding step can read like any other. A scanned
   * line has no font to look up, so its width is judged by a standard one of its kind (any letter
   * can be drawn on a picture, so none is ever missing). */
  function addPictures(prof, pictures) {
    if (!pictures.some((p) => p.res)) return prof;
    const W = globalThis.PDFSWAP_DATA.widths, at = prof.fonts.length;
    const pseudo = (label, std) => ({ label, problem: null, any: true, widths: new Map(Object.entries(std)) });
    prof.fonts.push(pseudo("a scanned page", W.Helvetica), pseudo("a scanned page, typewriter letters", W.Courier));
    for (const pic of pictures) {
      if (!pic.res) continue;
      const { part, block } = globalThis.PDFSwapOCR.profileParts(pic.res, pic.page, SCANNED, [at, at + 1]);
      // an ID card's text is searched for its numbers and dates by the labels only cards print
      block.idCard = !!pic.res.idCard;
      prof.parts.push(part); prof.blocks.push(block);
    }
    return prof;
  }
  /** The files inside a zip archive, each as a file of the folder ("Docs.zip/2024/W2.pdf"). */
  function entries(path, bytes) {
    const files = globalThis.fflate.unzipSync(bytes);
    return Object.entries(files).filter(([name]) => !name.endsWith("/")).map(([name, data]) => ({ path: path + "/" + name, inner: name, size: data.length, read: async () => data }));
  }
  const heavyKind = (path) => /^(pdf|picture)$/.test(kindOf(path));

  /** First pass: read every file, keep what finding and choosing need, and say what each is.
   * `ocr` (optional) reads pictures of pages: scans, photos, a photo set on a PDF's page. */
  async function analyze(files, { onProgress = () => {}, forms = true, ocr = null } = {}) {
    const slots = [], status = new Map(), extra = [];
    let done = 0;
    const unreadNote = "its pages are pictures (a scan or photo), so there is no text to swap, and what the pictures show is unchanged";
    const one = async (f, put) => {
      const kind = kindOf(f.path);
      try {
        if (kind === "pdf") {
          const bytes = await f.read();
          const opened = await E().open(bytes, { forms });
          if (opened.skipped) status.set(f.path, { kind, state: "skipped", why: opened.skipped });
          else {
            const prof = PII().profile(opened.model, f.path);
            const pages = opened.model.pages.length;
            let pictures = [], read = 0;
            if (ocr) { const got = await ocr.readPdf(bytes, opened.model); pictures = got.pictures; read = got.symbols; }
            addPictures(prof, pictures);
            put(prof);
            const failed = pictures.filter((p) => p.failed).map((p) => p.failed);
            const notes = pictures.map((p) => p.res && globalThis.PDFSwapOCR.pictureNote(p.res, p.inset ? "a picture on page " + (p.page + 1) : "page " + (p.page + 1) + " (scanned)", !!p.inset)).filter(Boolean);
            // text a font gives no letters for cannot be searched for names, so a copy of it could
            // carry them unseen: it is held back like a scan, never copied as if it were clean
            status.set(f.path, failed.length
              ? { kind, state: "skipped", pages, why: failed.join("; ") + ", so it cannot be searched for names and numbers" }
              : prof.glyphs === 0 && !read
                ? { kind, state: "scan", pages, why: ocr ? "its pages are pictures that hold no text the reader could find" : unreadNote }
                : prof.unreadable > 0.2
                  ? { kind, state: "unreadable", pages, why: "most of its text is drawn in a font that gives no letters back, so it cannot be read to find names and numbers in it; its copy could still carry them" }
                  : { kind, state: "ok", pages, pictures, scanned: pictures.filter((p) => p.res).length, notes });
          }
        } else if (kind === "office") {
          let got;
          try { got = OFF().read(await f.read(), f.path); }
          catch (e) { status.set(f.path, { kind, state: "skipped", why: "it could not be opened as a spreadsheet, a document or a slide deck (it may be damaged, or not the kind its name says)" }); return; }
          put(got.profile);
          status.set(f.path, { kind, state: "ok", media: got.media.length });
        } else if (kind === "zip") {
          let inner;
          try { inner = entries(f.path, await f.read()); }
          catch (e) { status.set(f.path, { kind, state: "skipped", why: "it could not be opened as a zip archive (it may be damaged, or locked with a password)" }); return; }
          status.set(f.path, { kind, state: "ok", entries: inner.map((e) => e.path) });
          for (const e of inner) { extra.push(e.path); await one(e, put); }
        } else if (kind === "picture" && ocr && ocr.canRead(f.path)) {
          const got = await ocr.readPicture(await f.read(), f.path);
          if (got.notText) status.set(f.path, { kind, state: "scan", why: "it is a picture of something other than a page of text, so it was not read and is left as it is" });
          else {
            put(addPictures({ path: f.path, parts: [], fonts: [], blocks: [], glyphs: got.symbols }, got.pictures));
            const notes = got.pictures.map((p) => globalThis.PDFSwapOCR.pictureNote(p.res, got.pictures.length > 1 ? "page " + (p.page + 1) : "the picture")).filter(Boolean);
            status.set(f.path, { kind, state: "ok", pictures: got.pictures, scanned: got.pictures.length, notes });
          }
        } else if (kind === "text") {
          const { text, enc } = decodeText(await f.read());
          put(PII().textProfile(text, f.path));
          status.set(f.path, { kind, state: "ok", enc });
        } else status.set(f.path, { kind, state: "other", why: kind === "system" ? "a hidden file the system keeps beside a document; it is not a document" : kind === "picture" ? "a picture, and the reader for pictures is not available in this browser" : "a kind of file this tool cannot change" });
      } catch (e) {
        status.set(f.path, { kind, state: "skipped", why: "the file could not be read" + (e && e.message ? " (" + e.message + ")" : "") });
      }
    };
    await each(files, ocr ? ocr.parallel : 1, (f) => heavyKind(f.path), async (f, i) => {
      const mine = [];
      await one(f, (p) => mine.push(p));
      slots[i] = mine;
      onProgress(++done, files.length, f.path);
    });
    return { profiles: slots.flat().filter(Boolean), status, inside: extra };
  }

  /** Finding and choosing, over every file at once, so one value gets one stand-in. */
  function plan(profiles, paths) {
    const clients = clientFolders(paths);
    const { items, phrases } = PII().detect(profiles, { clientFolders: clients });
    PII().attachContexts(items, profiles);
    PII().generate(items);
    return { items, phrases, clients };
  }

  /** Second pass: every file swapped, checked and written under its renamed path.
   * `check(original, output, info)` is the page's picture and text check (optional here).
   * `include(path, status)` decides whether a file that could not be changed is copied. */
  async function run(files, rows, status, { write, check, include, onProgress = () => {}, forms = true, metadata = true, spacing = "spread", stamp, ocr = null }) {
    const prepared = E().prepareRows(rows.map((r) => ({ ...r })));
    const slots = [];
    let done = 0;
    const verdict = (r) => {
      const ok = r.checks.every((c) => c.passed) && r.swapped === r.found;
      if (!ok) r.why = r.swapped < r.found
        ? (r.found - r.swapped) + " of " + r.found + " could not be swapped: " + [...new Set(r.occurrences.filter((o) => !o.replaced).map((o) => o.reason))].join("; ")
        : "check failed: " + r.checks.filter((c) => !c.passed).map((c) => c.name + (c.detail ? " (" + c.detail + ")" : "")).join("; ");
      return ok;
    };
    // one file, its result in `out`; `put(bytes)` writes it (into the folder, or into its archive)
    const one = async (f, out, put) => {
      const st = status.get(f.path) || { kind: kindOf(f.path), state: "other" };
      const r = { path: f.path, outPath: PII().renamePath(f.path, prepared), kind: st.kind, result: "", why: st.why || "", found: 0, swapped: 0, checks: [], occurrences: [], warnings: ocr && ocr.marks === "erase" ? [] : (st.notes || []).slice() };
      out.push(r);
      try {
        // writing on a scan that could not be read is held back, when that is what was chosen
        if (ocr && ocr.marks === "hold" && r.warnings.length && st.state === "ok") { r.result = "not written"; r.why = "it holds writing that could not be read (" + r.warnings.join("; ") + ")"; }
        else if (st.kind === "pdf" && st.state === "ok") {
          const bytes = await f.read();
          const paint = ocr && st.pictures && st.pictures.length ? (ctx) => ocr.paintPdf(ctx, bytes, st.pictures) : null;
          const res = await E().swap(bytes, rows, { forms, metadata, spacing, paint });
          r.found = res.occurrences.length; r.swapped = res.occurrences.filter((o) => o.replaced).length; r.occurrences = res.occurrences;
          if (res.warnings) r.warnings = [...new Set(r.warnings.concat(res.warnings))];
          if (res.skipped) { r.result = "skipped"; r.why = res.skipped; }
          else if (!res.output) {
            if (r.found > r.swapped) { r.result = "not written"; verdict(r); }
            else { r.result = "copied"; r.why = r.found ? r.why : "nothing to swap in it"; await put(bytes); }
          } else {
            r.checks = (res.pictureChecks || []).concat(await E().selfCheck(bytes, res, rows, { forms, metadata }));
            if (check) r.checks = r.checks.concat(await check(bytes, res.output, res, rows));
            const ok = verdict(r);
            r.result = ok ? "swapped" : "not written";
            if (ok) await put(res.output);
          }
        } else if (st.kind === "office" && st.state === "ok") {
          const bytes = await f.read();
          const paintMedia = ocr ? async (data, name) => {
            const pics = await ocr.readPicture(data, name).catch(() => null);
            if (!pics || pics.notText || !pics.pictures) return null;
            return ocr.paintPicture(data, name, pics.pictures, rows);
          } : null;
          const res = await OFF().swap(bytes, rows, { paintMedia });
          r.found = res.occurrences.length; r.swapped = res.occurrences.filter((o) => o.replaced).length; r.occurrences = res.occurrences; r.checks = res.checks;
          r.warnings.push(...(res.warnings || []));
          if (!res.output) { r.result = "copied"; r.why = "nothing to swap in it"; await put(bytes); }
          else { const ok = verdict(r); r.result = ok ? "swapped" : "not written"; if (ok) await put(res.output); }
        } else if (st.kind === "zip" && st.state === "ok") {
          // every file inside, handled as if it were in the folder, packed again under its new name
          const packed = {}, inner = [];
          for (const e of entries(f.path, await f.read())) {
            await one(e, inner, async (b, ext) => {
              const name = PII().renamePath(e.inner, prepared);
              packed[ext ? name.replace(/\.[^./]+$/, ext) : name] = [b, { level: /\.(jpe?g|png|gif|zip|heic|webp)$/i.test(e.inner) ? 0 : 6 }];
            });
          }
          out.push(...inner);
          const bad = inner.filter((x) => x.result === "not written");
          if (bad.length) { r.result = "not written"; r.why = bad.length + " of the files inside it could not be written, so the archive is not either"; }
          else { r.found = inner.reduce((n, x) => n + x.found, 0); r.swapped = inner.reduce((n, x) => n + x.swapped, 0); r.result = r.found ? "swapped" : "copied"; await put(globalThis.fflate.zipSync(packed)); }
        } else if (st.kind === "picture" && st.state === "ok" && ocr) {
          const bytes = await f.read();
          const res = await ocr.paintPicture(bytes, f.path, st.pictures, rows);
          r.found = res.occurrences.length; r.swapped = res.occurrences.filter((o) => o.replaced).length; r.occurrences = res.occurrences; r.checks = res.checks;
          r.warnings = [...new Set(r.warnings.concat(res.warnings || []))];
          // a picture written in another kind than it came (a HEIC as a JPEG) is named for it
          if (res.ext) r.outPath = r.outPath.replace(/\.[^./]+$/, res.ext);
          if (!r.found && !res.output) { r.result = "copied"; r.why = "nothing to swap in it"; await put(bytes); }
          else { const ok = verdict(r) && !!res.output; r.result = ok ? "swapped" : "not written"; if (ok) await put(res.output, res.ext); }
        } else if (st.kind === "text" && st.state === "ok") {
          const { text, enc } = decodeText(await f.read());
          const [neu, hits] = E().swapPlain(text, prepared);
          r.found = r.swapped = hits.length;
          r.occurrences = hits.map((row) => ({ where: "text", label: "text", row, replaced: true }));
          await put(encodeText(neu, enc));
          r.result = hits.length ? "swapped" : "copied";
        } else if (st.kind !== "system" && include(f.path, st)) {
          await put(await f.read());
          r.result = "copied unchanged";
        } else r.result = "left out";
      } catch (e) {
        r.result = "not written"; r.why = "an error stopped this file: " + (e && e.message ? e.message : e);
      }
      return r;
    };
    await each(files, ocr ? ocr.parallel : 1, (f) => !!(status.get(f.path) || {}).pictures, async (f, i) => {
      const out = [];
      const r = await one(f, out, async (bytes, ext) => write(ext ? PII().renamePath(f.path, prepared).replace(/\.[^./]+$/, ext) : PII().renamePath(f.path, prepared), bytes));
      slots[i] = out;
      onProgress(++done, files.length, f.path, r);
    });
    return slots.flat().filter(Boolean);
  }

  /** The report a run leaves beside the copy. It names files only by their new names, because
   * the original names carry the clients' names, and shows values only by their last four. */
  /** Every folder of the original under its swapped name, by the rule every file's path follows
   * (an empty folder too, which no file's path names), so the copy holds the same folders. A Mac's
   * __MACOSX folder is the system's, and is not one of them. */
  function folders(dirs, rows) {
    const prepared = E().prepareRows(rows.map((r) => ({ ...r })));
    return [...new Set(dirs.filter((d) => d && !/(^|\/)__MACOSX(\/|$)/.test(d)).map((d) => PII().renamePath(d, prepared)))].sort();
  }
  function report(results) {
    const mask = (v) => (v.length <= 4 ? "*".repeat(v.length) : "*".repeat(v.length - 4) + v.slice(-4));
    const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const lines = [["file (new name)", "result", "why", "found", "swapped", "checks", "look at"].join(",")];
    for (const r of results) lines.push([r.outPath, r.result, r.why, r.found, r.swapped, r.checks.map((c) => c.name + ": " + (c.passed ? "passed" : "FAILED " + c.detail)).join("; "), (r.warnings || []).join("; ")].map(q).join(","));
    lines.push("", ["file (new name)", "where", "map row", "kind", "found (last four)", "became (last four)", "result", "reason"].join(","));
    for (const r of results) for (const o of r.occurrences) lines.push([r.outPath, o.label, o.row.id, o.row.label || "", mask(o.row.find), mask(o.row.replace), o.replaced ? "swapped" : "not swapped", o.reason || ""].map(q).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  return { kindOf, clientFolders, analyze, plan, run, folders, report, decodeText, encodeText };
})();
globalThis.PDFSwapFolder = PDFSwapFolder;
if (typeof module !== "undefined") module.exports = PDFSwapFolder;
