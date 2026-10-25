/* Identity Swap: the page. Reads a folder, shows what will change, writes the swapped copy. */
(() => {
  "use strict";
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([document.getElementById("pdfjs-worker").textContent], { type: "text/javascript" }));
  const PII = PDFSwapPII, FOLDER = PDFSwapFolder, ENGINE = PDFSwapEngine;
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (k === "text") n.textContent = v; else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  // replaceChildren writes a null as the text "null"; an optional part of a screen is left out
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
  const fmtTime = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; };
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const nextFrame = () => new Promise((r) => setTimeout(r, 0));

  const KIND = { name: "Name", business: "Business", city: "City", state: "State", ssn: "SSN", ssn4: "SSN (masked)", ein: "EIN", phone: "Phone", email: "Email", street: "Street", unit: "Suite / unit", zip: "ZIP", zip4: "ZIP+4", acct: "Account", idnum: "ID number", dob: "Birth date", iddate: "ID date", custom: "Your swap" };
  const TABS = [["all", "All"], ["name", "Names"], ["business", "Businesses"], ["ssn", "SSNs"], ["ein", "EINs"], ["address", "Addresses and ZIPs"], ["phone", "Phones and emails"], ["acct", "Accounts and IDs"], ["dob", "Dates"], ["custom", "Your swaps"]];
  const inTab = (it, tab) => tab === "all" || it.kind === tab || (tab === "ssn" && it.kind === "ssn4") || (tab === "address" && ["street", "unit", "city", "state", "zip", "zip4"].includes(it.kind)) || (tab === "phone" && ["phone", "email"].includes(it.kind)) || (tab === "acct" && it.kind === "idnum") || (tab === "dob" && it.kind === "iddate");
  const PAGE = 100;

  const S = { files: [], root: "", profiles: null, status: null, items: null, phrases: null, custom: [], copyOther: false, verify: true, tab: "all", query: "", page: 0, running: false, stop: false, results: null, addOpen: false, marks: "keep" };

  // ------------------------------------------------------------------ the reader for scans and photos
  // Tesseract 5 and its English model ride inside this page; they start the first time a folder is
  // read, in a few workers, and nothing they do leaves the computer.
  const OCR = PDFSwapOCR;
  let reader = null;
  const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  async function ocrReader() {
    if (reader !== null) return reader || null;
    try {
      if (typeof OffscreenCanvas === "undefined" || typeof DecompressionStream === "undefined" || !WebAssembly.validate(SIMD)) throw new Error("this browser cannot run the reader");
      const b64 = (id) => { const t = atob($(id).textContent.trim()), out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; };
      const gunzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      // docling's OCR engine (PP-OCR on ONNX Runtime) reads beside Tesseract in each worker; if
      // it cannot start, Tesseract reads alone and the page says so
      let docling = null;
      try {
        const plain = (id) => $(id).textContent.replace(/<\\\/script/g, "</script").replace(/<\\!--/g, "<!--");
        docling = { ort: plain("dl-ort"), glue: plain("dl-glue"), wasm: await gunzip(b64("dl-wasm")), det: await gunzip(b64("dl-det")), rec: await gunzip(b64("dl-rec")), keys: plain("dl-keys") };
      } catch (e) { docling = null; }
      reader = OCR.browserReader({ glue: $("ocr-core").textContent, wasm: b64("ocr-wasm"), model: await gunzip(b64("ocr-model")), size, docling });
      try { S.docling = await reader.second(); } catch (e) { S.docling = { docling: false, why: String((e && e.message) || e) }; }
    } catch (e) { reader = false; }
    return reader || null;
  }
  function ocrService() {
    if (!reader) return null;
    return OCR.service({ reader, codec: PDFSwapPictures, decode: OCR.decodeFile, encode: OCR.encodeFile, deflate: OCR.deflate, renderer: OCR.glyphRenderer, marks: S.marks,
      pdfjs: (bytes) => pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise,
      // a PDF's pages drawn, for docling's reader to read as they look
      render: (bytes, dpi, want, each, most) => OCR.renderPdf((b) => pdfjsLib.getDocument({ data: b.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise, bytes, dpi, want, each, most) });
  }

  // ------------------------------------------------------------------ step 1: the folder
  // Chrome and Edge open the folder itself, which lists every folder in it, an empty one too, so
  // the copy can hold the same folders; another browser's file chooser lists only files
  $("pick").addEventListener("click", async () => {
    if (typeof window.showDirectoryPicker !== "function") { $("pickInput").click(); return; }
    let top;
    try { top = await window.showDirectoryPicker({ mode: "read", id: "identity-swap-in" }); } catch (e) { return; }
    const out = [], dirs = [];
    const walk = async (handle, prefix) => {
      dirs.push(prefix.slice(0, -1));
      for await (const [name, h] of handle.entries()) {
        if (h.kind === "file") { const file = await h.getFile(); out.push({ path: prefix + name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) }); }
        else await walk(h, prefix + name + "/");
      }
    };
    await walk(top, top.name + "/");
    if (out.length) load(out, dirs);
  });
  $("pickInput").addEventListener("change", (e) => {
    const list = [...e.target.files];
    if (!list.length) return;
    load(list.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) })));
  });
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const out = [], dirs = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) { const file = await new Promise((res, rej) => entry.file(res, rej)); out.push({ path: prefix + entry.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) }); return; }
      dirs.push(prefix + entry.name);
      const reader = entry.createReader();
      for (;;) { const batch = await new Promise((res, rej) => reader.readEntries(res, rej)); if (!batch.length) break; for (const child of batch) await walk(child, prefix + entry.name + "/"); }
    };
    for (const entry of entries) await walk(entry, "");
    if (out.length) load(out, dirs);
  });

  /** `dirs`: every folder in the one chosen, an empty one too (the file chooser cannot list them,
   * so from it only the folders that hold a file come back). */
  async function load(files, dirs = []) {
    if (S.running) return;
    files.sort((a, b) => a.path.localeCompare(b.path));
    S.files = files; S.root = files[0].path.split("/")[0];
    S.dirs = dirs.filter((d) => d.split("/")[0] === S.root);
    S.items = null; S.results = null; S.custom = [];
    $("step2").classList.add("locked"); $("step3").classList.add("locked");
    fill($("reviewOut")); fill($("runOut"));
    const out = $("readOut");
    const bar = el("i"), line = el("p", { class: "small" }, "Starting");
    fill(out, el("div", { class: "progress", role: "progressbar", "aria-label": "Reading the folder" }, bar), line);
    const total = files.reduce((n, f) => n + f.size, 0), t0 = Date.now();
    let bytes = 0;
    // every kind the reader reads: a PDF's pages and pictures, every picture kind, the pictures
    // inside an Office file, and whatever a zip archive holds
    const pictures = files.some((f) => /^(pdf|picture|office|zip)$/.test(FOLDER.kindOf(f.path)));
    if (pictures) { line.textContent = "Starting the reader for scans and photos"; await ocrReader(); }
    const sizes = new Map(files.map((f) => [f.path, f.size]));
    const { profiles, status } = await FOLDER.analyze(files, {
      ocr: ocrService(),
      onProgress: (done, n, path) => {
        bytes += sizes.get(path) || 0;
        bar.style.width = (100 * bytes / Math.max(1, total)).toFixed(1) + "%";
        const eta = bytes ? ((Date.now() - t0) / bytes) * (total - bytes) : 0;
        line.textContent = "Reading " + done + " of " + n + " (" + fmtBytes(bytes) + " of " + fmtBytes(total) + ")" + (done < n && eta > 2000 ? ", about " + fmtTime(eta) + " left" : "") + (reader ? ". Scanned pages and photos are read letter by letter, a few seconds a page." : "");
      },
    });
    S.profiles = profiles; S.status = status;
    line.textContent = "Finding what to swap";
    await nextFrame();
    const plan = FOLDER.plan(profiles, files.map((f) => f.path));
    S.items = plan.items; S.phrases = plan.phrases; S.clients = plan.clients;
    showSummary(total, Date.now() - t0);
    $("step2").classList.remove("locked"); $("step3").classList.remove("locked");
    renderReview(); renderRun();
  }

  function counts() {
    const c = { pdf: 0, office: 0, text: 0, picture: 0, zip: 0, scanned: 0, unread: 0, scan: 0, unreadable: 0, other: 0, skipped: 0 };
    for (const st of S.status.values()) {
      if (st.state === "ok") { c[st.kind in c ? st.kind : "pdf"]++; c.scanned += st.scanned || 0; if (st.notes && st.notes.length) c.unread++; }
      else if (st.state === "scan") c.scan++;
      else if (st.state === "unreadable") c.unreadable++;
      else if (st.state === "skipped") c.skipped++;
      else if (st.kind !== "system") c.other++;
    }
    return c;
  }
  function showSummary(total, ms) {
    const c = counts(), items = [...S.items.values()];
    const stat = (n, label) => el("div", { class: "stat" }, el("b", { text: n }), el("span", { text: label }));
    const kinds = (k) => items.filter((i) => k.includes(i.kind)).length;
    fill($("readOut"),
      el("p", { class: "small" }, "Read " + plural(S.files.length, "file") + " (" + fmtBytes(total) + ") in " + fmtTime(ms) + ". " + (S.clients.length ? plural(S.clients.length, "client folder") + " found." : "")),
      el("div", { class: "stats" },
        stat(c.pdf, "PDFs"), stat(c.office, "spreadsheets and documents"), stat(c.scanned, "scanned pages and photos read"), stat(c.text, "text files"), c.zip ? stat(c.zip, "zip archives opened") : null, stat(kinds(["name"]), "names"), stat(kinds(["business"]), "businesses"), stat(kinds(["ssn", "ssn4"]), "SSNs"), stat(kinds(["ein"]), "EINs"),
        stat(kinds(["street", "unit", "city", "state", "zip", "zip4"]), "addresses and ZIPs"), stat(kinds(["phone", "email"]), "phones and emails"), stat(kinds(["acct", "idnum", "dob", "iddate"]), "accounts, IDs and dates")),
      c.scan + c.unreadable + c.other + c.skipped ? el("p", { class: "note warn" }, plural(c.scan + c.unreadable + c.other + c.skipped, "file") + " cannot be changed (" +
        [c.scan && plural(c.scan, "picture") + " with no text the reader could find", c.unreadable && plural(c.unreadable, "PDF") + " whose text cannot be read", c.other && plural(c.other, "file") + " of other kinds", c.skipped && plural(c.skipped, "locked or unreadable file")].filter(Boolean).join(", ") +
        "). Step 3 lists them and leaves them out unless you choose to copy them unchanged.") : null,
      reader === false ? el("p", { class: "note warn" }, "This browser cannot run the reader for scans and photos, so they are left out. Chrome or Edge can.") : null,
      reader && S.docling && !S.docling.docling ? el("p", { class: "note warn" }, "Docling's OCR engine could not start in this browser" + (S.docling.why ? " (" + S.docling.why + ")" : "") + ", so scans and photos were read by Tesseract alone, which misses more. Chrome or Edge can run both.") : null,
      c.unread ? el("p", { class: "note warn" }, plural(c.unread, "file") + " also " + (c.unread === 1 ? "holds" : "hold") + " marks on a scan or picture the reader could not make out as words (handwriting, a signature, a stamp, or a picture's own artwork). Step 3 asks what to do with them.") : null);
  }

  // ------------------------------------------------------------------ step 2: what will change
  function renderReview() {
    const out = $("reviewOut");
    const items = [...S.items.values()].concat(S.custom);
    const q = S.query.trim().toLowerCase();
    const shown = items.filter((it) => inTab(it, S.tab) && (!q || it.display.toLowerCase().includes(q) || String(it.replacement || "").toLowerCase().includes(q) || (it.context || "").toLowerCase().includes(q)));
    shown.sort((a, b) => (a.kind === b.kind ? 0 : Object.keys(KIND).indexOf(a.kind) - Object.keys(KIND).indexOf(b.kind)) || b.count - a.count || a.display.localeCompare(b.display));
    const pages = Math.max(1, Math.ceil(shown.length / PAGE));
    S.page = Math.min(S.page, pages - 1);
    const tabs = el("div", { class: "tabs", role: "group", "aria-label": "Show" }, TABS.map(([k, label]) => el("button", { type: "button", "aria-pressed": String(S.tab === k), onclick: () => { S.tab = k; S.page = 0; renderReview(); } }, label + " (" + items.filter((i) => inTab(i, k)).length + ")")));
    const search = el("input", { type: "search", placeholder: "Search what was found", "aria-label": "Search what was found", value: S.query, oninput: (e) => { S.query = e.target.value; S.page = 0; renderReview(); const s = $("reviewSearch"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    search.id = "reviewSearch";
    const rows = shown.slice(S.page * PAGE, S.page * PAGE + PAGE).map(rowFor);
    const table = el("div", { class: "tablewrap" }, el("table", null,
      el("thead", null, el("tr", null, el("th", { text: "Swap" }), el("th", { text: "Kind" }), el("th", { text: "Found" }), el("th", { text: "Becomes" }), el("th", { text: "" }), el("th", { text: "Seen" }))),
      el("tbody", null, rows.length ? rows : el("tr", null, el("td", { colspan: 6, class: "small", text: "Nothing here." })))));
    const pager = pages > 1 ? el("div", { class: "pager" },
      el("button", { type: "button", class: "secondary", disabled: S.page === 0, onclick: () => { S.page--; renderReview(); } }, "Previous"),
      el("span", { class: "small", text: "Page " + (S.page + 1) + " of " + pages }),
      el("button", { type: "button", class: "secondary", disabled: S.page >= pages - 1, onclick: () => { S.page++; renderReview(); } }, "Next")) : null;
    fill(out, el("div", { class: "row" }, search, el("span", { class: "small", text: plural(shown.length, "value") + " shown" })), tabs, table, pager, addForms());
  }

  function rowFor(it) {
    const tr = el("tr", { class: it.checked ? "" : "off" });
    const box = el("input", { type: "checkbox", "aria-label": "Swap " + it.display, onchange: (e) => {
      it.checked = e.target.checked; tr.className = it.checked ? "" : "off";
      // moving a state moves its cities and their ZIPs; swapping a city again picks its ZIPs again
      if (it.kind === "state" || it.kind === "city") { follow(it); renderReview(); }
      renderRun();
    } });
    box.checked = it.checked;
    const badge = el("span", { class: "count" });
    const input = el("input", { type: "text", class: "mono", value: it.replacement || "", size: Math.max(8, it.display.length + 4), "aria-label": "Stand-in for " + it.display, spellcheck: "false" });
    const sync = () => {
      const kept = it.kept && input.value === it.display;
      // any length; as many words as the original, so each word is written over its own
      const ok = !!input.value.trim() && words(input.value) === words(it.display) && (input.value !== it.display || kept);
      badge.textContent = ok ? "fits" : words(input.value) !== words(it.display) ? plural(words(it.display), "word") : "new";
      badge.className = "count" + (ok ? "" : " bad");
      badge.removeAttribute("title");
      // a stand-in can be wider than its original where it is printed, or use a letter the
      // document's font lacks; either way the run refuses that file, so say it here
      const f = ok && it.kind !== "custom" ? PII.fit(it, input.value) : 0;
      const st = it.kind === "city" ? (S.items.get("state:" + it.state) || {}) : null;
      const where = st ? (st.checked && st.replacement ? st.replacement : it.state) : null;
      if (kept) {
        badge.textContent = "kept";
        badge.title = it.kind === "city" ? "No real city in " + it.state + " fits where it is printed, so the city stays as it is and the address stays a real place." : "Its city is kept and has no other ZIP of its own, so the ZIP stays too.";
      } else if (ok && st && where && !PII.realCity(where, input.value)) {
        badge.textContent = "not a real city in " + where;
        badge.className = "count warn";
        badge.title = "Swaps still work, but this is not a city the post office lists in " + where + ", so the address will not check out.";
      } else if (f === null || f > PII.FITS) {
        badge.textContent = f === null ? "font lacks a letter" : "too wide";
        badge.className = "count warn";
        badge.title = f === null ? "A document prints this in a font that does not have one of these letters, so those files would not be written. Try New, or other letters."
          : "This is noticeably wider than the original in the document's font and may touch the next word, in which case that file is not written. Try New, or narrower letters.";
      }
      input.className = "mono" + (ok ? "" : " bad");
      return ok;
    };
    input.addEventListener("input", () => {
      if (sync()) { it.replacement = input.value; it.edited = true; it.kept = input.value === it.display; follow(it); renderRun(); }
    });
    sync();
    const dice = it.kind === "custom" ? el("button", { type: "button", class: "link", onclick: () => { S.custom = S.custom.filter((c) => c !== it); renderReview(); renderRun(); } }, "Remove")
      : el("button", { type: "button", class: "link", title: "A new stand-in", "aria-label": "A new stand-in for " + it.display, onclick: () => { PII.regenerate(S.items, it); renderReview(); renderRun(); } }, "New");
    const seen = it.kind === "custom" ? it.count + " times" : plural(it.count, "time") + (it.files.size ? ", " + plural(it.files.size, "file") : "");
    const ctx = it.kind === "name" || it.kind === "business" ? (it.mode && it.mode !== "everywhere" ? "Swapped inside names only for some capitals: it is also an everyday word here. " : "") + (it.context ? "In: " + it.context : "")
      : it.kind === "state" ? "Kept unless ticked. Ticked, its addresses move to this state (cities and ZIPs too); the state's own forms keep its name."
      : it.kind === "city" ? (it.kept ? "Kept: no real city in " + it.state + " fits where it is printed, so the address stays a real place." : "A real city in " + (it.state || "the same state") + ", with a real ZIP of its own." + (it.risky ? " Also an everyday word or a name here, so only swapped beside its state code." : ""))
      : it.kind === "zip" && it.kept ? "Kept: its city is kept and has no other ZIP of its own."
      : [...(it.sources || [])].join(", ");
    tr.append(
      el("td", null, box), el("td", null, el("span", { class: "kind", text: KIND[it.kind] || it.kind })),
      el("td", { class: "mono" }, it.display, ctx ? el("span", { class: "ctx", title: ctx, text: ctx }) : null),
      el("td", null, el("div", { class: "row" }, input, badge)), el("td", null, dice), el("td", { class: "small", text: seen }));
    return tr;
  }
  /** How many words a value has: a stand-in has as many, so each is written over its own. */
  function words(v) { return String(v || "").trim().split(/\s+/).filter(Boolean).length; }
  /** A changed SSN carries its masked copies and accounts; a changed ZIP its ZIP+4. */
  function follow(it) { PII.follow(S.items, it); }

  function addForms() {
    // your own swap
    const find = el("input", { type: "text", class: "mono", placeholder: "Text as printed, e.g. Mo Omar", "aria-label": "Find" });
    const rep = el("input", { type: "text", class: "mono", placeholder: "e.g. Om Sharma", "aria-label": "Replace with" });
    const badge = el("span", { class: "count" }, "");
    const msg = el("span", { class: "small" });
    const valid = () => !!find.value.trim() && !!rep.value.trim() && words(find.value) === words(rep.value) && find.value !== rep.value && /[\p{L}\p{N}]/u.test(find.value);
    const sync = () => { badge.textContent = !find.value ? "" : words(find.value) !== words(rep.value) ? plural(words(find.value), "word") : valid() ? "ok" : ""; badge.className = "count" + (valid() || !find.value ? "" : " bad"); add.disabled = !valid(); };
    const suggest = el("button", { type: "button", class: "secondary", onclick: () => {
      rep.value = find.value.replace(/[A-Za-z]+/g, (w) => PII.copyCase(w, PII.pseudo(w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))).replace(/\d/g, () => String(Math.floor(Math.random() * 10)));
      sync();
    } }, "Suggest");
    const add = el("button", { type: "button", class: "teal", disabled: true, onclick: () => {
      const f = find.value, r = rep.value;
      if (S.custom.some((c) => c.display === f)) { msg.textContent = "Already in the list."; return; }
      const n = occurrences(f);
      S.custom.push({ key: "custom:" + f, kind: "custom", display: f, replacement: r, checked: true, count: n.count, files: new Set(n.files), sources: new Set(["added by you"]) });
      msg.textContent = n.count ? "Added. Found " + plural(n.count, "time") + " in " + plural(n.files.length, "file") + "." : "Added. It was not found in the page text of any file; it still applies to names and form values.";
      find.value = rep.value = ""; sync(); renderRun();
      setTimeout(renderReview, 1200);
    } }, "Add");
    find.addEventListener("input", sync); rep.addEventListener("input", sync);
    // a name the folder did not show as a name
    const name = el("input", { type: "text", placeholder: "A full name, e.g. Mateo Rivera", "aria-label": "Add a name" });
    const nameMsg = el("span", { class: "small" });
    const addName = el("button", { type: "button", class: "teal", onclick: () => {
      const toks = PII.nameTokens(name.value, { strict: false });
      if (!toks) { nameMsg.textContent = "That does not read as a name (letters only, no digits)."; return; }
      let added = 0;
      for (const { t, role } of toks) {
        const key = "name:" + t.toUpperCase();
        let it = S.items.get(key);
        if (!it) {
          const display = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
          it = { key, kind: "name", display, variants: new Set([t]), sources: new Set(["added by you"]), files: new Set(), checked: true, replacement: null, count: 0, context: name.value.trim(), roles: new Set(), mode: "everywhere", phraseOnly: new Set() };
          it.forms = new Map([[display, {}], [display.toUpperCase(), {}], [display.toLowerCase(), {}], [t, {}]]);
          S.items.set(key, it); added++;
        }
        it.checked = true; it.roles.add(role);
      }
      S.phrases.set(name.value.trim(), { files: new Set(), source: "added by you" });
      PII.attachContexts(S.items, S.profiles); PII.generate(S.items);
      nameMsg.textContent = added ? "Added " + plural(added, "name") + "." : "Already in the list; it is checked.";
      name.value = ""; S.tab = "name"; renderReview(); renderRun();
    } }, "Add name");
    const box = el("details", { open: S.addOpen || null, style: "margin-top:16px", ontoggle: (e) => { S.addOpen = e.target.open; } },
      el("summary", null, "Add something the folder did not show"),
      el("p", { class: "small" }, "Text is matched exactly, capitals included, and only as whole words: \"Mo\" never matches inside \"Mortgage\". A name you add here is also swapped in capitals and in lower case."),
      el("div", { class: "row" }, find, el("span", { "aria-hidden": "true", text: "becomes" }), rep, badge, suggest, add, msg),
      el("div", { class: "row", style: "margin-top:10px" }, name, addName, nameMsg));
    return box;
  }
  function occurrences(find) {
    const prepared = ENGINE.prepareRows([{ id: 1, find, replace: find }]);
    let count = 0; const files = new Set();
    for (const p of S.profiles) for (const part of p.parts) { const n = ENGINE.findMatches(part.text, prepared).length; if (n) { count += n; files.add(p.path); } }
    return { count, files: [...files] };
  }

  // ------------------------------------------------------------------ step 3: the copy
  function plannedRows() { return PII.allRows(S.items, S.phrases, S.custom.filter((c) => c.checked).map((c) => ({ find: c.display, replace: c.replacement }))); }
  function problems() {
    const bad = [...S.items.values()].concat(S.custom).filter((i) => i.checked && (!i.replacement || words(i.replacement) !== words(i.display)));
    return bad;
  }
  function renderRun() {
    if (S.running || !S.items) return;
    if (!$("runControls")) fill($("runOut"), el("div", { id: "runControls" }), el("div", { id: "runProgress" }), el("div", { id: "runResults" }));
    const out = $("runControls"), c = counts();
    const unchangeable = [...S.status].filter(([, st]) => st.state !== "ok" && st.kind !== "system");
    const bad = problems();
    const fsApi = typeof window.showDirectoryPicker === "function";
    const copy = el("input", { type: "checkbox", id: "copyOther", onchange: (e) => { S.copyOther = e.target.checked; } });
    copy.checked = S.copyOther;
    const verify = el("input", { type: "checkbox", id: "verifyPages", onchange: (e) => { S.verify = e.target.checked; } });
    verify.checked = S.verify;
    const start = el("button", { type: "button", class: "teal", disabled: bad.length > 0, onclick: () => run(fsApi ? "folder" : "zip") }, fsApi ? "Choose where to save, then start" : "Start and download as a .zip");
    fill(out,
      el("p", null, [plural(c.pdf, "PDF"), c.office && plural(c.office, "spreadsheet or document", "spreadsheets and documents"), c.picture && plural(c.picture, "picture"), plural(c.text, "text file")].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1") + (c.zip ? " (" + plural(c.zip, "zip archive") + " among them, opened and packed again)" : "") + " will be swapped" + (c.scanned ? " (" + plural(c.scanned, "scanned page or photo", "scanned pages and photos") + " painted over with the document's own letters, then read again to prove it)" : "") + "; " + plural(plannedRows().length, "find-and-replace rule") + " in all, including every capitalization."),
      c.unread ? el("fieldset", { class: "choice" }, el("legend", null, "Marks on scans and pictures the reader could not make out as words (handwriting, signatures, stamps, artwork) in " + plural(c.unread, "file")),
        [["keep", "Copy it as it is, and list it in the report"], ["erase", "Erase it (the page keeps its printed text and lines)"], ["hold", "Leave those files out"]].map(([v, label]) => el("label", { class: "row" },
          el("input", { type: "radio", name: "marks", value: v, checked: S.marks === v || null, onchange: () => { S.marks = v; } }), label))) : null,
      bad.length ? el("p", { class: "note bad" }, plural(bad.length, "value") + " checked in step 2 " + (bad.length === 1 ? "has" : "have") + " no stand-in with as many words: " + bad.slice(0, 5).map((b) => b.display).join(", ") + (bad.length > 5 ? " and more" : "") + ". Type one, press New, or uncheck it.") : null,
      unchangeable.length ? el("details", null, el("summary", null, plural(unchangeable.length, "file") + " cannot be changed"),
        el("ul", { class: "small" }, unchangeable.slice(0, 200).map(([path, st]) => el("li", null, path + ": " + st.why))),
        unchangeable.length > 200 ? el("p", { class: "small", text: "and " + (unchangeable.length - 200) + " more" }) : null) : null,
      unchangeable.length ? el("p", { class: "row" }, copy, el("label", { for: "copyOther" }, "Copy these unchanged (they keep whatever they show; their file names are still swapped)")) : null,
      el("p", { class: "row" }, verify, el("label", { for: "verifyPages" }, "Draw every changed page before and after and compare them (recommended; slower)")),
      el("div", { class: "row" }, start, fsApi ? null : el("span", { class: "small", text: "In Chrome or Edge the copy is written straight into a folder you choose, which suits a large folder." })));
  }

  async function run(mode) {
    const rows = plannedRows();
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const prepared = ENGINE.prepareRows(rows.map((r) => ({ ...r })));
    const newRoot = PII.renamePath(S.root, prepared) + " (swapped " + stamp + ")";
    let writer;
    // a .zip cannot hold 4 GB; say so before the run rather than partway through it
    const inputBytes = S.files.reduce((n, f) => n + f.size, 0);
    if (mode !== "folder" && inputBytes > 3.9e9) {
      fill($("runProgress"), el("p", { class: "small" }, "This folder is " + (inputBytes / 1e9).toFixed(1) + " GB, more than a .zip can hold. Open this page in Chrome or Edge, which write the copy straight into a folder."));
      return;
    }
    if (mode === "folder") {
      let parent;
      try { parent = await window.showDirectoryPicker({ mode: "readwrite", id: "identity-swap-out" }); } catch (e) { return; }
      const top = await parent.getDirectoryHandle(newRoot, { create: true });
      writer = folderWriter(top, parent);
    } else writer = zipWriter(newRoot);
    S.running = true; S.stop = false;
    for (const id of ["step1", "step2"]) $(id).classList.add("locked");
    const prog = $("runProgress"), bar = el("i"), line = el("p", { class: "small" });
    const stop = el("button", { type: "button", class: "secondary", onclick: () => { S.stop = true; stop.disabled = true; line.textContent = "Stopping after this file"; } }, "Stop");
    fill(prog, el("div", { class: "progress", role: "progressbar", "aria-label": "Making the copy" }, bar), el("div", { class: "row" }, line, stop));
    const t0 = Date.now(), total = S.files.reduce((n, f) => n + f.size, 0);
    let bytes = 0;
    const files = S.files.map((f) => ({ ...f, read: async () => { if (S.stop) throw new Error("stopped"); return f.read(); } }));
    const sizes = new Map(files.map((f) => [f.path, f.size]));
    const results = await FOLDER.run(files, rows, S.status, {
      ocr: ocrService(),
      write: async (path, data) => writer.write(path.split("/").slice(1).join("/"), data),
      check: S.verify ? (original, output, res, rs) => PDFSwapCheck.check(original, output, res, rs) : null,
      include: () => S.copyOther,
      onProgress: (done, n, path) => {
        bytes += sizes.get(path) || 0;
        bar.style.width = (100 * bytes / Math.max(1, total)).toFixed(1) + "%";
        const eta = bytes ? ((Date.now() - t0) / bytes) * (total - bytes) : 0;
        if (!S.stop) line.textContent = "File " + done + " of " + n + (done < n && eta > 2000 ? ", about " + fmtTime(eta) + " left" : "");
      },
    });
    // every folder the original holds comes back, an empty one too, under its swapped name
    for (const d of FOLDER.folders(S.dirs || [], rows)) {
      const rel = d.split("/").slice(1).join("/");
      if (rel) await writer.mkdir(rel);
    }
    // the report sits beside the copy, so the copy holds what the folder holds and nothing else
    const report = FOLDER.report(results);
    await writer.beside(newRoot + " - Identity Swap report.csv", new TextEncoder().encode(report));
    await writer.close();
    S.running = false; S.results = results;
    for (const id of ["step1", "step2"]) $(id).classList.remove("locked");
    stop.remove();
    line.textContent = (S.stop ? "Stopped. " : "Done in " + fmtTime(Date.now() - t0) + ". ") + (mode === "folder" ? "The copy is in the folder you chose, as “" + newRoot + "”, with its report beside it." : "The .zip is downloading, with the report beside the copy inside it.");
    showResults(results, report);
  }

  function showResults(results, report) {
    const by = (r) => results.filter((x) => x.result === r).length;
    const lookAt = results.filter((r) => r.result === "swapped" && r.warnings && r.warnings.length).length;
    // of those, the ones whose note is writing the reader could not make out
    const unreadAt = results.filter((r) => r.result === "swapped" && (r.warnings || []).some((w) => /could not be read|not made out|could not make out|erased/.test(w))).length;
    const notWritten = results.filter((r) => r.result === "not written" || r.result === "skipped");
    const stat = (n, label) => el("div", { class: "stat" }, el("b", { text: n }), el("span", { text: label }));
    const cls = (r) => (r === "swapped" ? "result-swapped" : r === "not written" || r === "skipped" ? "result-bad" : "result-plain");
    const hidden = results.filter((r) => r.kind === "system").length;
    const sorted = results.filter((r) => r.kind !== "system").sort((a, b) => (cls(a.result) === "result-bad" ? -1 : 0) - (cls(b.result) === "result-bad" ? -1 : 0));
    const save = el("button", { type: "button", class: "secondary", onclick: () => download(new Blob([report], { type: "text/csv" }), "Identity Swap report.csv") }, "Save the report again");
    fill($("runResults"), 
      el("div", { class: "stats" }, stat(by("swapped"), "swapped and checked"), stat(by("copied"), "copied, nothing to swap"), stat(by("copied unchanged"), "copied unchanged"), stat(by("left out") - hidden, "left out"), stat(notWritten.length, "not written"), lookAt ? stat(lookAt, "to look at") : null),
      lookAt ? el("p", { class: "note warn" }, plural(lookAt, "swapped file has", "swapped files have") + " a note to look at" + (unreadAt ? " (" + plural(unreadAt, "holds", "hold") + " marks on a scan or picture the reader could not make out as words, " + (S.marks === "erase" ? "erased, as chosen" : "copied as they are") + ")" : "") + ". The table and the report say what and where.") : null,
      hidden ? el("p", { class: "small", text: plural(hidden, "hidden system file") + " (a Mac's ._ files and the like) left out: they are not documents, and can say where a file was downloaded from." }) : null,
      notWritten.length ? el("p", { class: "note bad" }, plural(notWritten.length, "file was", "files were") + " not written, so no copy carries an unchecked change. The table says why.") : el("p", { class: "note ok" }, "Every file that holds text was swapped and passed every check."),
      el("div", { class: "tablewrap" }, el("table", null,
        el("thead", null, el("tr", null, el("th", { text: "File" }), el("th", { text: "Saved as" }), el("th", { text: "Result" }), el("th", { text: "Swaps" }), el("th", { text: "Why / checks" }))),
        el("tbody", null, sorted.slice(0, 500).map((r) => el("tr", null,
          el("td", { class: "small", text: r.path }), el("td", { class: "small", text: r.result === "left out" ? "" : r.outPath.split("/").slice(1).join("/") }),
          el("td", null, el("span", { class: cls(r.result), text: r.result })), el("td", { text: r.found ? r.swapped + " of " + r.found : "" }),
          el("td", { class: "small", text: [r.why || r.checks.filter((c) => !c.passed).map((c) => c.name + ": " + c.detail).join("; "), (r.warnings || []).length ? "Look at: " + r.warnings.join("; ") : ""].filter(Boolean).join(" ") })))))),
      results.length > 500 ? el("p", { class: "small", text: "The report lists all " + results.length + " files." }) : null,
      el("p", { class: "row" }, save, el("span", { class: "small", text: "The report names files only by their new names and shows values only by their last four characters. A copy of it is saved beside the copy of the folder." })));
    renderRun();
  }

  // ------------------------------------------------------------------ writing the copy
  function folderWriter(top, parent) {
    const dirs = new Map([["", top]]), written = new Set();
    const dir = async (path) => {
      if (dirs.has(path)) return dirs.get(path);
      const i = path.lastIndexOf("/");
      const parent = await dir(i < 0 ? "" : path.slice(0, i));
      const d = await parent.getDirectoryHandle(path.slice(i + 1), { create: true });
      dirs.set(path, d); return d;
    };
    return {
      async write(path, data) {
        let p = path, k = 2;
        while (written.has(p.toLowerCase())) p = path.replace(/(\.[^./]+)?$/, (ext) => " (" + k++ + ")" + ext);
        written.add(p.toLowerCase());
        const i = p.lastIndexOf("/");
        const d = await dir(i < 0 ? "" : p.slice(0, i));
        const fh = await d.getFileHandle(p.slice(i + 1), { create: true });
        const w = await fh.createWritable(); await w.write(data); await w.close();
      },
      async mkdir(path) { await dir(path); },
      async beside(name, data) {
        const fh = await parent.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(data); await w.close();
      },
      async close() {},
    };
  }
  /** A .zip with every file stored as it is (PDFs are already compressed). Up to 4 GB. */
  function zipWriter(root) {
    const parts = [], central = [];
    let offset = 0, count = 0;
    const enc = new TextEncoder();
    const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc32 = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    const add = (full, data, dir) => {
      const name = enc.encode(full), crc = crc32(data);
      if (offset + data.length > 0xfffff000) throw new Error("the copy is over 4 GB, which a .zip cannot hold; use Chrome or Edge, which write a folder");
      const head = Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
      // a folder's entry is marked as one (MS-DOS attribute 0x10), so an empty one unpacks as a folder
      central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(dir ? 0x10 : 0), ...u32(offset)]), name);
      parts.push(head, name, new Blob([data]));
      offset += head.length + name.length + data.length; count++;
    };
    return {
      async mkdir(path) { add(root + "/" + path + "/", new Uint8Array(0), true); },
      async beside(name, data) { add(name, data, false); },
      async write(path, data) { add(root + "/" + path, data, false); },
      async close() {
        const size = central.reduce((n, c) => n + c.length, 0);
        const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(size), ...u32(offset), ...u16(0)]);
        download(new Blob([...parts, ...central, end], { type: "application/zip" }), root + ".zip");
      },
    };
  }
  function download(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
})();
