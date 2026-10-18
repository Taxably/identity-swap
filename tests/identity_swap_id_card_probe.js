// Drives web/ in node over a folder holding a drawn ID card, through the page's
// own three steps (read, find and choose, swap and check), with the OCR engine, its model and the
// face detector taken out of the built page. The written copy is then read again and searched for
// a face, apart from the page's own checks. Prints one JSON object for
// test_the_identity_swap_replaces_an_id_cards_photo_and_details.py to judge.
//
//   node identity_swap_id_card_probe.js <page.html> <in folder> <out folder>
const fs = require("fs"), path = require("path"), vm = require("vm"), zlib = require("zlib");
const { reader, pngDecode, pngEncode, O } = require("./identity_swap_ocr_probe.js");
const W = path.join(__dirname, "..", "web");

const [pagePath, inDir, outDir] = process.argv.slice(2);
const page = fs.readFileSync(pagePath, "utf8");
// the face detector and its cascade, as the page carries them
globalThis.window = globalThis;
const blocks = [...page.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1].replace(/<\\\/script/g, "</script").replace(/<\\!--/g, "<!--"));
for (const [sign, name] of [["ViolaJones.detect", "the face detector"], ["classifiers.face", "the face cascade"]]) {
  const src = blocks.find((b) => b.includes(sign) && !b.includes("PDFSwapFaces"));
  if (!src) throw Error("the page carries no " + name);
  vm.runInThisContext(src, { filename: name + ".js" });
}
// the stand-ins come from a fixed sequence here, so a run can be repeated: the page draws them
// from the browser's secure random source, and in node there is no font to draw a letter the card
// does not print, so not every stand-in can be painted the way the page would paint it
let seed = Number(process.env.ID_CARD_SEED || 7) >>> 0;
const next = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) >>> 0; };
Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = next(); return a; } }, configurable: true });
for (const f of ["data.js", "places.js", "names.js"]) require(path.join(W, f));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
globalThis.PDFSwapOCR = O;
const Faces = require(path.join(W, "faces.js"));
const Folder = require(path.join(W, "folder.js"));
const P = globalThis.PDFSwapPII;

(async () => {
  const rd = await reader(pagePath);
  const svc = O.service({ reader: rd, faces: Faces, decode: async (b) => pngDecode(Buffer.from(b)), encode: async (img) => pngEncode(img), deflate: async (b) => new Uint8Array(zlib.deflateSync(b)), renderer: null, marks: "keep" });
  const files = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push({ path: path.relative(path.dirname(inDir), p).split(path.sep).join("/"), size: fs.statSync(p).size, read: async () => new Uint8Array(fs.readFileSync(p)) });
    }
  };
  walk(inDir);
  const { profiles, status } = await Folder.analyze(files, { ocr: svc });
  const { items, phrases } = Folder.plan(profiles, files.map((f) => f.path));
  const rows = P.allRows(items, phrases);
  const written = {};
  const results = await Folder.run(files, rows, status, {
    include: () => false, ocr: svc,
    write: async (rel, bytes) => { const dest = path.join(outDir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); written[rel] = dest; },
  });
  const cards = [];
  for (const f of files) {
    const st = status.get(f.path);
    if (!st || !st.pictures) continue;
    const pic = st.pictures[0];
    const r = results.find((x) => x.path === f.path);
    const out = { path: f.path, idCard: !!pic.res.idCard, photos: (pic.res.photos || []).map((b) => ({ box: b.slice(0, 4), faint: !!b.faint, under: !!b.under })), text: O.pageText(pic.res).map((l) => l.text).join("\n"),
      result: r.result, why: r.why, warnings: r.warnings, checks: r.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail || "" })),
      occurrences: r.occurrences.map((o) => ({ find: o.row.find, replaced: o.replaced, boxes: o.boxes })) };
    const dest = Object.entries(written).find(([rel]) => rel.endsWith(path.basename(f.path)));
    if (dest) {
      out.written = dest[1];
      // read again, and looked over for a face, apart from the page's own checks
      const back = pngDecode(fs.readFileSync(dest[1]));
      const again = await rd.read(O.toGray(back.data, back.w * back.h), back.w, back.h, pic.dpi);
      out.reread = O.pageText(again).map((l) => l.text).join("\n");
      out.facesAfter = Faces.find(back, []).portrait ? 1 : 0;
    }
    cards.push(out);
  }
  process.stdout.write(JSON.stringify({
    cards,
    items: [...items.values()].map((i) => ({ kind: i.kind, display: i.display, replacement: i.replacement })),
    rows: rows.map((r) => ({ find: r.find, replace: r.replace })),
  }));
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
