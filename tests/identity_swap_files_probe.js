// Drives web/ in node, with pdf-lib, fflate, UTIF and gifenc taken out of the
// built page, for test_the_identity_swap_keeps_every_kind_of_file_as_it_came.py. Two kinds of job:
//
//   {"job": "folder", "in": <folder>, "out": <folder>}: the page's own three steps over a folder of
//     invented documents (read, find and choose, swap and check), with no reader for pictures;
//     every file written goes under "out", every folder of the original (empty ones too) is made
//     there under its swapped name, and the results and the map come back.
//   {"job": "picture", "kind": ..., "original": <file>, "rgba": <raw pixels>, "w", "h", "out"}: a
//     picture written back by the page's own writer, with what the original's header says. Kind
//     "jpeg-orient": the upright pixels laid back the way the original was stored (to "outRaw"),
//     and the rotation flag the original carries given to "plain", a JPEG with no flag of its own.
//
// Prints one JSON object.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const W = path.join(ROOT, "web");
const page = fs.readFileSync(path.join(ROOT, "identity-swap.html"), "utf8");
globalThis.self = globalThis;
// the page's own libraries, each the script block that defines it
const blocks = [...page.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1].replace(/<\\\/script/g, "</script").replace(/<\\!--/g, "<!--"));
for (const [sign, name] of [["PDFDocument", "PDFLib"], ["unzipSync", "fflate"], ["UTIF", "UTIF"], ["self.gifenc", "gifenc"]]) {
  const src = blocks.find((b) => b.includes(sign) && !b.includes("PDFSwapEngine"));
  if (!src) throw Error("the page carries no " + name);
  vm.runInThisContext(src, { filename: name + ".js" });
  if (!globalThis[name]) throw Error(name + " did not load");
}
for (const f of ["data.js", "places.js", "names.js"]) require(path.join(W, f));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
globalThis.PDFSwapOffice = require(path.join(W, "office.js"));
const PIC = require(path.join(W, "pictures.js"));
const F = require(path.join(W, "folder.js"));
const P = globalThis.PDFSwapPII;

async function folder(job) {
  const files = [], dirs = [];
  const rel = (p) => path.relative(path.dirname(job.in), p).split(path.sep).join("/");
  const walk = (d) => {
    dirs.push(rel(d));
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push({ path: path.relative(path.dirname(job.in), p).split(path.sep).join("/"), size: fs.statSync(p).size, read: async () => new Uint8Array(fs.readFileSync(p)) });
    }
  };
  walk(job.in);
  const { profiles, status } = await F.analyze(files, {});
  const { items, phrases } = F.plan(profiles, files.map((f) => f.path));
  const rows = P.allRows(items, phrases);
  const results = await F.run(files, rows, status, {
    include: () => false,
    write: async (rel, bytes) => { const dest = path.join(job.out, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); },
  });
  const madeFolders = F.folders(dirs, rows);
  for (const d of madeFolders) fs.mkdirSync(path.join(job.out, d), { recursive: true });
  return {
    folders: { in: dirs, out: madeFolders },
    rows: rows.map((r) => ({ find: r.find, replace: r.replace })),
    results: results.map((r) => ({ path: r.path, outPath: r.outPath, kind: r.kind, result: r.result, why: r.why, found: r.found, swapped: r.swapped, checks: r.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail || "" })) })),
    status: [...status].map(([p, s]) => ({ path: p, kind: s.kind, state: s.state, why: s.why || "", enc: s.enc || null })),
  };
}

async function picture(job) {
  const original = new Uint8Array(fs.readFileSync(job.original));
  let bytes;
  if (job.kind === "tiff") {
    const dec = PIC.tiffDecode(original);
    bytes = PIC.tiffEncode(dec.pages, dec.info);
  } else {
    const raw = new Uint8ClampedArray(fs.readFileSync(job.rgba));
    const img = { w: job.w, h: job.h, data: raw };
    if (job.kind === "png") bytes = PIC.pngEncode(img, PIC.pngHeader(original).png);
    else if (job.kind === "bmp") bytes = PIC.bmpEncode(img, PIC.bmpHeader(original).bmp);
    else if (job.kind === "gif") bytes = PIC.gifEncode(img, PIC.gifHeader(original).gif);
    else if (job.kind === "jpeg-density") bytes = PIC.withDensity(new Uint8Array(fs.readFileSync(job.rgba)), PIC.jpegHeader(original).jfif);
    else if (job.kind === "jpeg-orient") {
      const o = PIC.jpegHeader(original).orient || 1, stored = PIC.toStored(img, o);
      fs.writeFileSync(job.outRaw, Buffer.from(stored.data.buffer));
      bytes = PIC.withOrientation(new Uint8Array(fs.readFileSync(job.plain)), o);
      fs.writeFileSync(job.out, bytes);
      return { written: bytes.length, orient: o, w: stored.w, h: stored.h };
    }
    else throw Error("no writer for " + job.kind);
  }
  fs.writeFileSync(job.out, bytes);
  return { written: bytes.length };
}

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = [];
  for (const job of jobs) out.push(job.job === "folder" ? await folder(job) : await picture(job));
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
