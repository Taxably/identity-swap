// Drives web/ in node over a folder of PDFs and pictures with both readers the page carries
// (Tesseract, and docling's OCR engine), for test_the_identity_swap_reads_with_doclings_ocr_engine.py.
// The page's own three steps run (read, find and choose, swap and check); a PDF's pages are drawn
// by tests/identity_swap_render.py, as pdf.js draws them in the page. Each copy written is then
// drawn and read again by both readers, apart from the page's own checks, and what it reads comes
// back with the results and the map.
//
//   node identity_swap_drawn_probe.js <page> <folder in> <folder out> <python>
//
// Prints one JSON object.
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm"), zlib = require("zlib"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const W = path.join(ROOT, "web");
const [pagePath, inDir, outDir, python] = process.argv.slice(2);
const page = fs.readFileSync(pagePath, "utf8");
globalThis.self = globalThis;
const blocks = [...page.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1].replace(/<\\\/script/g, "</script").replace(/<\\!--/g, "<!--"));
for (const [sign, name] of [["PDFDocument", "PDFLib"], ["unzipSync", "fflate"]]) {
  const src = blocks.find((b) => b.includes(sign) && !b.includes("PDFSwapEngine"));
  vm.runInThisContext(src, { filename: name + ".js" });
}
for (const f of ["data.js", "places.js", "names.js"]) require(path.join(W, f));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
globalThis.PDFSwapOffice = require(path.join(W, "office.js"));
const { reader, pngDecode, pngEncode, O } = require(path.join(__dirname, "identity_swap_ocr_probe.js"));
globalThis.PDFSwapOCR = O;
const F = require(path.join(W, "folder.js"));
const P = globalThis.PDFSwapPII;

/** A PDF's pages drawn, as the page's `render` hands them over. */
async function render(bytes, dpi, want, each, most = 2400) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawn-"));
  try {
    const file = path.join(dir, "in.pdf");
    fs.writeFileSync(file, bytes);
    const all = JSON.parse(execFileSync(python, [path.join(__dirname, "identity_swap_render.py"), file, String(dpi), String(most), "all", dir], { maxBuffer: 1 << 28 }).toString());
    for (const pg of all) {
      if (!want(pg.page)) continue;
      pg.data = new Uint8ClampedArray(fs.readFileSync(path.join(dir, pg.page + ".rgba")));
      await each(pg);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  const rd = await reader(pagePath);
  const svc = { reader: rd, decode: async (b) => pngDecode(Buffer.from(b)), encode: async (img) => pngEncode(img), deflate: async (b) => new Uint8Array(zlib.deflateSync(b)), renderer: null, marks: "keep",
    render, pdfjs: null };
  // a picture set on a PDF's page, as pdf.js gives its pixels in the page: here only the kind a
  // page drawn again as a picture is (8-bit grey or RGB, deflated)
  svc.pixels = async (model, ref) => {
    const L = globalThis.PDFLib, o = model.ctx.lookup(ref), d = o.dict, num = (k) => d.lookup(L.PDFName.of(k)).asNumber();
    const w = num("Width"), h = num("Height"), cs = d.lookup(L.PDFName.of("ColorSpace")).decodeText(), raw = zlib.inflateSync(Buffer.from(o.contents));
    const n = cs === "DeviceGray" ? 1 : 3, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { for (let c = 0; c < 3; c++) data[i * 4 + c] = raw[i * n + (n === 1 ? 0 : c)]; data[i * 4 + 3] = 255; }
    return { w, h, data };
  };
  const ocr = O.service(svc);
  const files = [], dirs = [];
  const walk = (d) => {
    dirs.push(path.relative(path.dirname(inDir), d).split(path.sep).join("/"));
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push({ path: path.relative(path.dirname(inDir), p).split(path.sep).join("/"), size: fs.statSync(p).size, read: async () => new Uint8Array(fs.readFileSync(p)) });
    }
  };
  walk(inDir);
  const { profiles, status } = await F.analyze(files, { ocr });
  const { items, phrases } = F.plan(profiles, files.map((f) => f.path));
  const rows = P.allRows(items, phrases);
  const written = [];
  const results = await F.run(files, rows, status, {
    ocr, include: () => false,
    write: async (rel, bytes) => { const dest = path.join(outDir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); written.push(dest); },
  });
  // every copy read again by both readers, apart from the page's checks
  const reread = {};
  for (const dest of written) {
    const texts = [];
    if (/\.pdf$/i.test(dest)) {
      await render(new Uint8Array(fs.readFileSync(dest)), 200, () => true, async (pg) => {
        const res = await rd.read(O.toGray(pg.data, pg.w * pg.h), pg.w, pg.h, pg.dpi);
        texts.push(O.pageText(res).map((l) => l.text).join("\n"));
      });
    } else if (/\.png$/i.test(dest)) {
      const img = pngDecode(fs.readFileSync(dest));
      texts.push(O.pageText(await rd.read(O.toGray(img.data, img.w * img.h), img.w, img.h, 200)).map((l) => l.text).join("\n"));
    }
    reread[path.relative(outDir, dest).split(path.sep).join("/")] = texts.join("\n");
  }
  process.stdout.write(JSON.stringify({
    docling: (await rd.second()).docling,
    rows: rows.map((r) => ({ find: r.find, replace: r.replace, label: r.label || "" })),
    status: [...status].map(([p, s]) => ({ path: p, state: s.state, why: s.why || "", flatten: s.flatten || null, drawn: (s.drawn || []).map((d) => d.page) })),
    results: results.map((r) => ({ path: r.path, outPath: r.outPath, result: r.result, why: r.why, found: r.found, swapped: r.swapped, warnings: r.warnings || [], checks: r.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail || "" })) })),
    reread,
  }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
