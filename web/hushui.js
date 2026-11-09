/* Identity Swap: the page's second mode. Swap text for an AI chat, restore the answer, keep or
 * lock the key, and check for yourself that the page reaches no network. */
(() => {
  "use strict";
  const H = PDFSwapHush;
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
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const clone = (key) => JSON.parse(JSON.stringify(key));
  const KIND = { name: "Name", business: "Business", ssn: "SSN", ssn4: "SSN", ein: "EIN", phone: "Phone", email: "Email", street: "Street", unit: "Suite / unit", city: "City", zip: "ZIP", zip4: "ZIP+4", acct: "Account", idnum: "ID number", dob: "Birth date", iddate: "Date", custom: "Your list" };

  // the key lives here, in this tab's memory, and nowhere else unless it is saved locked
  const S = { key: H.newKey(), alwaysHide: [], clients: [], plan: [], off: new Set(), result: null, timer: 0 };

  // ------------------------------------------------------------------ the two modes
  for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => mode(b.dataset.mode));
  function mode(m) {
    for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-selected", String(b.dataset.mode === m));
    $("swapMode").hidden = m !== "swap";
    $("hushMode").hidden = m !== "hush";
    // the folder swap's long description is for the folder swap only
    $("swapLede").hidden = m !== "swap";
  }

  // ------------------------------------------------------------------ hushing
  const source = $("hushIn");
  source.addEventListener("input", () => { clearTimeout(S.timer); S.timer = setTimeout(run, 250); });
  // attachments: read once when added, swapped again whenever the plan changes
  const A = PDFSwapAttach;
  S.atts = [];
  $("hushFile").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    for (const f of files) {
      if (S.atts.some((a) => a.att.name === f.name)) continue;
      if (f.size > 50e6) { S.atts.push({ att: { name: f.name, problem: "over 50 MB; swap it with the folder swap, which writes one file at a time" }, out: null }); continue; }
      fill($("hushFileMsg"), "Reading " + f.name);
      // a scan or photo, or a PDF that may hold one, is read by the page's OCR, started on first use
      const ocr = /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i.test(f.name) && globalThis.PDFSwapScanReader
        ? await (fill($("hushFileMsg"), "Starting the reader for scans and photos"), globalThis.PDFSwapScanReader()).catch(() => null) : null;
      fill($("hushFileMsg"), "Reading " + f.name + (ocr ? ", letter by letter where it is a scan" : ""));
      const att = await A.read(f.name, new Uint8Array(await f.arrayBuffer()), { ocr }).catch((err) => ({ name: f.name, problem: "it could not be read (" + err.message + ")" }));
      S.atts.push({ att, out: null });
    }
    fill($("hushFileMsg"));
    run();
  });
  function renderAtts() {
    fill($("attList"), S.atts.map((a, i) => el("div", { class: "att" },
      el("div", { class: "grow" }, el("span", { class: "name", text: a.att.name }),
        el("div", { class: "small", text: a.att.problem ? "Cannot be swapped here: " + a.att.problem + "." : a.att.kind === "pdf" ? plural(a.att.pages.length, "page") + " of text read" : "Text read" })),
      el("button", { type: "button", class: "link", onclick: () => { S.atts.splice(i, 1); run(); } }, "Remove"))));
    const ready = S.atts.filter((a) => !a.att.problem);
    fill($("attOut"), ready.length ? [el("h2", { style: "margin:18px 0 4px" }, "Swapped attachments"),
      el("p", { class: "small", text: "Each file is read back after it is made and searched for every hidden value; one that still holds any is not offered." }),
      ...ready.map((a) => {
        const o = a.out;
        const badge = !o ? el("span", { class: "count", text: "swapping" }) : o.problem ? el("span", { class: "count bad", text: "not offered" })
          : el("span", { class: "count" + (o.how === "text only" ? " warn" : ""), text: o.how === "text only" ? "text PDF" : o.how === "layout kept" ? "layout kept" : "nothing to swap" });
        return el("div", { class: "att" },
          el("div", { class: "grow" }, el("span", { class: "name", text: o && o.name ? o.name : a.att.name }), " ", badge,
            o && o.problem ? el("div", { class: "small result-bad", text: o.problem }) : null,
            o && o.count ? el("div", { class: "small", text: plural(o.count, "value") + " swapped for tags" }) : null,
            o && o.notes ? o.notes.map((n) => el("div", { class: "small", text: n })) : null),
          o && o.bytes ? el("button", { type: "button", class: "teal", onclick: () => { commit(); save(o.bytes, o.name); } }, "Download swapped file") : null);
      })] : null);
  }
  function save(bytes, name) {
    const link = el("a", { href: URL.createObjectURL(new Blob([bytes])), download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }
  // each plan swaps every attachment again; a newer plan makes an older run's results stale
  let generation = 0;
  async function swapAtts() {
    const mine = ++generation;
    for (const a of S.atts) a.out = null;
    renderAtts();
    for (const a of S.atts) {
      if (a.att.problem) continue;
      const out = await A.swap(a.att, S.plan).catch((err) => ({ problem: "it could not be swapped (" + err.message + ")" }));
      if (mine !== generation) return;
      a.out = out;
      renderAtts();
    }
  }
  // the firm's client list: read in this tab, kept in its memory (and in a locked key if one is saved)
  $("clientList").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const got = H.clientList(await f.text());
    for (const c of got) if (!S.clients.some((x) => x[0] === c[0] && x[1] === c[1])) S.clients.push(c);
    fill($("clientMsg"), got.length ? plural(S.clients.length, "client") + " known by name, from " + f.name + ". The list stays in this tab." : "No names found in " + f.name + ": it needs a Name, Client, First or Last column, or one name per line.");
    renderKey(); run();
  });
  $("hushList").addEventListener("input", (e) => {
    S.alwaysHide = e.target.value.split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
    clearTimeout(S.timer); S.timer = setTimeout(run, 250);
  });

  function run() {
    const text = source.value;
    // the message and every attachment (its name too) are read as one, so a person has one tag
    // an attachment's text is read with the spaces OCR loses put back, as the companion reads it
    const all = [text, ...S.atts.filter((a) => !a.att.problem).flatMap((a) => [a.att.name.replace(/_/g, " ").replace(/\.[^.]+$/, ""), H.ocrText(a.att.text)])].join("\n\n");
    if (!all.trim()) { S.plan = []; S.result = null; render(); renderAtts(); return; }
    S.plan = H.find(all, { key: S.key, alwaysHide: S.alwaysHide, clients: S.clients });
    for (const p of S.plan) if (S.off.has(p.value.toUpperCase())) p.checked = false;
    // a preview: the key grows only when the swapped text is copied, a file is downloaded or an
    // answer is restored
    S.result = text.trim() ? H.hush(text, S.plan, clone(S.key)) : null;
    render();
    clearTimeout(S.attTimer); S.attTimer = setTimeout(swapAtts, 300);
  }
  function commit() {
    if (!S.plan.length) return;
    H.hush(source.value, S.plan, S.key);
    renderKey();
  }

  function render() {
    const plan = S.plan, r = S.result;
    $("hushOut").value = r ? r.text : "";
    $("hushCopy").disabled = !r;
    fill($("hushCount"), r ? plural(plan.filter((p) => p.checked).length, "value") + " hidden, " + plural(r.count, "place") + " in the text" : "");
    const rows = plan.map((p) => {
      const box = el("input", { type: "checkbox", "aria-label": "Hide " + p.value, onchange: (e) => {
        p.checked = e.target.checked;
        if (p.checked) S.off.delete(p.value.toUpperCase()); else S.off.add(p.value.toUpperCase());
        run();
      } });
      box.checked = p.checked;
      const tag = el("input", { type: "text", class: "mono", value: p.tag, size: Math.max(10, p.tag.length + 2), "aria-label": "Tag for " + p.value, spellcheck: "false" });
      const msg = el("span", { class: "small" });
      tag.addEventListener("change", () => {
        // the tag is kept in the key, so the next paste and the restore use the new name
        commit();
        const bad = H.renameTag(S.plan, S.key, p.tag, tag.value);
        if (bad) { msg.textContent = bad; tag.value = p.tag; return; }
        run();
      });
      return el("tr", { class: p.checked ? "" : "off" },
        el("td", null, box), el("td", null, el("span", { class: "kind", text: KIND[p.kind] || p.kind })),
        el("td", { class: "mono" }, p.value, p.forms.length > 1 ? el("span", { class: "ctx", text: "Also as: " + p.forms.filter((f) => f !== p.value).slice(0, 4).join(", ") }) : null),
        el("td", null, el("div", { class: "row" }, el("span", { "aria-hidden": "true" }, "["), tag, el("span", { "aria-hidden": "true" }, "]"), msg)),
        el("td", { class: "small", text: p.reused ? "in the key" : p.source === "your list" ? "your list" : "" }));
    });
    fill($("hushTable"), plan.length ? el("div", { class: "tablewrap" }, el("table", null,
      el("thead", null, el("tr", null, el("th", { text: "Hide" }), el("th", { text: "Kind" }), el("th", { text: "Found" }), el("th", { text: "Tag the AI sees" }), el("th", { text: "" }))),
      el("tbody", null, rows))) : el("p", { class: "small", text: source.value.trim() ? "Nothing personal found. Read the text before you send it; add anything missed to the list of words to always hide." : "Paste text or attach files above to see what will be hidden." }));
    // the hushed text searched again: no hidden value may be left, and anything that still
    // reads as personal is shown with a way to hide it
    const left = r ? r.leaks : [];
    const still = left.filter((l) => !l.tag), stuck = left.filter((l) => l.tag);
    fill($("hushCheck"),
      !r ? null : stuck.length ? el("p", { class: "note bad" }, plural(stuck.length, "hidden value") + " could still be read in the swapped text: " + stuck.map((l) => "[" + l.tag + "]").join(", ") + ". Do not send it.")
        : el("p", { class: "note ok" }, "Searched again: none of the hidden values is left in the swapped text."),
      still.length ? el("div", { class: "note warn" }, el("p", { style: "margin:0 0 6px" }, "This still reads as personal. Hide it, or leave it if it is not:"),
        el("div", { class: "row" }, still.map((l) => el("button", { type: "button", class: "secondary", title: l.why, onclick: () => addToList(l.value) }, "Hide “" + l.value + "”")))) : null,
      r ? el("p", { class: "small" }, "The AI still receives everything that is not hidden: a rare condition, an unusual job or a small town can point to a person. Read the swapped text before you send it.") : null);
  }
  function addToList(v) {
    if (!S.alwaysHide.includes(v)) S.alwaysHide.push(v);
    $("hushList").value = S.alwaysHide.join("\n");
    $("hushListBox").open = true;
    run();
  }

  $("hushCopy").addEventListener("click", async () => {
    commit();
    try { await navigator.clipboard.writeText($("hushOut").value); fill($("hushCopyMsg"), "Swapped! Copied. Paste it into the AI chat."); }
    catch (e) { $("hushOut").select(); fill($("hushCopyMsg"), "Swapped! Selected; press Ctrl+C to copy."); }
  });

  // ------------------------------------------------------------------ restoring
  const answer = $("restoreIn");
  answer.addEventListener("input", restore);
  $("restorePaste").addEventListener("click", async () => {
    try { answer.value = await navigator.clipboard.readText(); restore(); }
    catch (e) { answer.focus(); fill($("restoreMsg"), "This browser did not allow reading the clipboard; paste with Ctrl+V."); }
  });
  function restore() {
    commit();
    if (!answer.value.trim()) { $("restoreOut").value = ""; fill($("restoreMsg")); return; }
    const r = H.restore(answer.value, S.key);
    $("restoreOut").value = r.text;
    const n = r.restored.reduce((a, x) => a + x.n, 0);
    fill($("restoreMsg"),
      el("p", { class: n ? "note ok" : "note warn" }, n ? "Restored " + plural(n, "tag") + ", " + plural(r.restored.length, "value") + " in all." : "No tag this key knows is in the answer."),
      r.unknown.length ? el("p", { class: "note warn" }, "This key does not know " + r.unknown.map((t) => "[" + t + "]").join(", ") + ", so " + (r.unknown.length === 1 ? "it is" : "they are") + " left as written. Open the key that swapped that text, or check whether the AI invented the tag.") : null);
  }
  $("restoreCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("restoreOut").value); fill($("restoreCopyMsg"), "Copied."); }
    catch (e) { $("restoreOut").select(); fill($("restoreCopyMsg"), "Selected; press Ctrl+C to copy."); }
  });

  // files the AI gave back: each tag the key knows put back inside the file itself
  $("restoreFile").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    commit();
    for (const f of files) {
      const row = el("div", { class: "att" }, el("div", { class: "grow" }, el("span", { class: "name", text: f.name }), " ", el("span", { class: "count", text: "restoring" })));
      $("restoreFiles").append(row);
      const att = await A.read(f.name, new Uint8Array(await f.arrayBuffer())).catch((err) => ({ name: f.name, problem: "it could not be read (" + err.message + ")" }));
      const r = await A.restoreFile(att, S.key).catch((err) => ({ problem: "it could not be restored (" + err.message + ")" }));
      fill(row, el("div", { class: "grow" }, el("span", { class: "name", text: r.name || f.name }), " ",
        r.problem ? el("span", { class: "count bad", text: "not restored" }) : el("span", { class: "count", text: plural(r.count, "tag") + " restored" }),
        r.problem ? el("div", { class: "small result-bad", text: r.problem }) : null,
        (r.notes || []).map((n) => el("div", { class: "small", text: n }))),
        r.bytes ? el("button", { type: "button", class: "teal", onclick: () => save(r.bytes, r.name) }, "Download restored file") : null);
    }
  });

  // ------------------------------------------------------------------ the key
  function renderKey() {
    const n = S.key.entries.length;
    fill($("keyState"), n ? "This tab holds a key of " + plural(n, "tag") + ". Closing the tab forgets it." : "No key yet. It is made when you copy swapped text, and lives only in this tab.");
    $("keySave").disabled = !n && !S.alwaysHide.length && !S.clients.length;
    $("keyForget").disabled = !n;
  }
  // forgetting takes everything that holds a client out of the tab: the key, the pasted text, the
  // attachments and the answers. Left in place, the pasted text would make the key again on the
  // next copy or restore. The words to always hide and the client list stay: they are settings
  $("keyForget").addEventListener("click", () => {
    S.key = H.newKey(); S.off.clear(); S.atts = []; S.plan = []; S.result = null;
    source.value = ""; answer.value = ""; $("restoreOut").value = "";
    fill($("restoreFiles")); fill($("restoreMsg")); fill($("hushCopyMsg")); fill($("hushFileMsg"));
    fill($("keyMsg"), "Forgotten: the key, the pasted text, the attachments and the answers are gone from this tab. Answers to text swapped before now can no longer be restored here." + (S.alwaysHide.length || S.clients.length ? " Your words to always hide and your client list stay." : ""));
    run(); renderKey();
  });
  $("keySave").addEventListener("click", async () => {
    const a = $("keyPass").value, b = $("keyPass2").value;
    if (a !== b) { fill($("keyMsg"), el("span", { class: "result-bad" }, "The two passphrases differ.")); return; }
    try {
      fill($("keyMsg"), "Locking");
      const file = await H.lock(S.key, S.alwaysHide, a, S.clients);
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
      const link = el("a", { href: URL.createObjectURL(new Blob([file], { type: "application/json" })), download: "Swap key " + stamp + ".swapkey" });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      $("keyPass").value = $("keyPass2").value = "";
      fill($("keyMsg"), "Saved, locked with your passphrase (AES-256-GCM). It holds the real values: keep it with the client's file, and keep the passphrase apart from it. Without the passphrase it cannot be opened, by you or anyone.");
    } catch (e) { fill($("keyMsg"), el("span", { class: "result-bad" }, e.message)); }
  });
  $("keyOpen").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const got = await H.unlock(await f.text(), $("keyOpenPass").value);
      // a saved key joins the one in this tab: its tags keep their meaning
      for (const ent of got.key.entries) if (!S.key.entries.some((k) => k.tag === ent.tag)) S.key.entries.push(ent);
      for (const [b, n] of Object.entries(got.key.counters)) S.key.counters[b] = Math.max(S.key.counters[b] || 0, n);
      for (const w of got.alwaysHide) if (!S.alwaysHide.includes(w)) S.alwaysHide.push(w);
      for (const c of got.clients) if (!S.clients.some((x) => x[0] === c[0] && x[1] === c[1])) S.clients.push(c);
      $("hushList").value = S.alwaysHide.join("\n");
      $("keyOpenPass").value = "";
      fill($("keyMsg"), "Opened " + f.name + ": " + plural(got.key.entries.length, "tag") + ", " + plural(got.alwaysHide.length, "word") + " to always hide.");
      run(); restore(); renderKey();
    } catch (err) { fill($("keyMsg"), el("span", { class: "result-bad" }, err.message)); }
  });
  renderKey();

  // ------------------------------------------------------------------ check it yourself
  // Every request the page makes is counted: what the browser fetched (anything not built into
  // the page) and what the page's own rules refused.
  const seen = { fetched: 0, refused: 0 };
  const external = (u) => !/^(data|blob|about|chrome-extension):/.test(u);
  try {
    for (const e of performance.getEntriesByType("resource")) if (external(e.name)) seen.fetched++;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (external(e.name)) seen.fetched++; showCheck(); }).observe({ type: "resource", buffered: false });
  } catch (e) { /* an old browser lists nothing; the counter stays at what it saw */ }
  document.addEventListener("securitypolicyviolation", () => { seen.refused++; showCheck(); });
  function showCheck() {
    fill($("checkCounts"),
      el("div", { class: "stat" }, el("b", { text: seen.fetched }), el("span", { text: "requests that left this page" })),
      el("div", { class: "stat" }, el("b", { text: seen.refused }), el("span", { text: "requests the page refused" })));
  }
  $("checkTry").addEventListener("click", async () => {
    fill($("checkMsg"), "Trying to reach example.com");
    try {
      await fetch("https://example.com/", { cache: "no-store" });
      fill($("checkMsg"), el("span", { class: "result-bad" }, "The request went through. This copy of the page is not locked; do not use it with client data."));
    } catch (e) {
      fill($("checkMsg"), el("span", { class: "result-swapped" }, "Refused. The page's own rules stopped it before it left the browser."));
    }
  });
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  $("checkRules").textContent = csp ? csp.content : "No rules found: do not use this copy with client data.";
  showCheck();
})();
