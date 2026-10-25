// Drives web/ocr.js in node, with the OCR engine and model taken out of the
// built page, over the scans test_the_identity_swap_reads_and_repaints_a_scan.py makes. Each job
// is one picture file through the page's own two steps (read, then paint and check); the painted
// copy is then read again by a fresh call to the reader, apart from the page's own checks. Prints
// one JSON object for the test to judge. Required by another probe, it only hands over its helpers.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const W = path.join(__dirname, "..", "web");
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
const D = require(path.join(W, "docling.js"));
const O = require(path.join(W, "ocr.js"));

// ------------------------------------------------------------ PNG, as far as these tests need it
function pngDecode(buf) {
  let p = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("latin1", p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9]; if (body[8] !== 8 || body[12]) throw Error("only 8-bit, non-interlaced PNG"); }
    else if (kind === "IDAT") idat.push(body);
    p += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 6: 4 }[type];
  if (!bpp) throw Error("PNG colour type " + type);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (bpp === 1) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[i]; data[i * 4 + 3] = 255; }
    else for (let c = 0; c < 4; c++) data[i * 4 + c] = c < bpp ? px[i * bpp + c] : 255;
  }
  return { w, h, data };
}
function pngEncode(img) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const kb = Buffer.concat([Buffer.from(kind, "latin1"), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(kb)); return Buffer.concat([len, kb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * img.w * 4, img.w * 4).copy(raw, y * (img.w * 4 + 1) + 1);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// ------------------------------------------------------------ the engine, out of the built page
function fromPage(page, id) {
  const m = page.match(new RegExp('<script type="text/plain" id="' + id + '">([\\s\\S]*?)</script>'));
  if (!m) throw Error("the page carries no " + id);
  return m[1].replace(/<\\\/script/g, "</script").replace(/<\\!--/g, "<!--");
}
/** Docling's OCR engine out of the built page: ONNX Runtime's module and WebAssembly, and the
 * PP-OCR models. Null with IDENTITY_SWAP_DOCLING=0, so a test can read with Tesseract alone. */
async function docling(page) {
  if (process.env.IDENTITY_SWAP_DOCLING === "0") return null;
  // imported as the page imports it, from no file (the page's is a blob), so it runs the loader
  // it carries rather than looking for one beside it
  const ort = await import("data:text/javascript;base64," + Buffer.from(fromPage(page, "dl-ort")).toString("base64"));
  const gz = (id) => zlib.gunzipSync(Buffer.from(fromPage(page, id).trim(), "base64"));
  // its loader for the WebAssembly is imported from a file in node (it asks node where it is);
  // the page hands it over as a blob
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-glue-")), file = path.join(dir, "ort-wasm-simd-threaded.mjs");
  fs.writeFileSync(file, fromPage(page, "dl-glue"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return D.open(ort, { glue: require("url").pathToFileURL(file).href, wasm: gz("dl-wasm"), det: gz("dl-det"), rec: gz("dl-rec"), keys: fromPage(page, "dl-keys") });
}
async function reader(pagePath) {
  const page = fs.readFileSync(pagePath, "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-core-"));
  const glue = path.join(dir, "core.js");
  fs.writeFileSync(glue, fromPage(page, "ocr-core"));
  const TesseractCore = require(glue);
  const wasm = Buffer.from(fromPage(page, "ocr-wasm").trim(), "base64");
  const model = zlib.gunzipSync(Buffer.from(fromPage(page, "ocr-model").trim(), "base64"));
  const M = await TesseractCore({ wasmBinary: wasm, print() {}, printErr() {} });
  M.FS.mkdir("/td"); M.FS.writeFile("/td/eng.traineddata", model);
  const api = new M.TessBaseAPI();
  if (api.Init("/td", "eng", 1) !== 0) throw Error("the model did not load");
  fs.rmSync(dir, { recursive: true, force: true });
  const dl = await docling(page);
  return O.pool(async () => ({ read: async (job) => O.readJob(M, api, dl, D, job), docling: !!dl, close() {} }), 1);
}

module.exports = { reader, docling, pngDecode, pngEncode, fromPage, O, D };
if (require.main === module) (async () => {
  const [pagePath, jobsPath] = process.argv.slice(2);
  const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  const rd = await reader(pagePath);
  const results = [];
  for (const job of jobs) {
    const svc = O.service({ reader: rd, decode: async (b) => pngDecode(Buffer.from(b)), encode: async (img) => pngEncode(img), deflate: async (b) => new Uint8Array(zlib.deflateSync(b)), renderer: null, marks: job.marks || "keep" });
    const bytes = new Uint8Array(fs.readFileSync(job.image));
    const t0 = Date.now();
    const got = await svc.readPicture(bytes, job.image);
    const text = O.pageText(got.pictures[0].res).map((l) => l.text).join("\n");
    const res = await svc.paintPicture(bytes, job.image, got.pictures, job.rows);
    const out = { turned: got.pictures[0].m, text, checks: res.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail || "" })), warnings: res.warnings, erased: res.marksErased || 0, written: !!res.output,
      occurrences: res.occurrences.map((o) => ({ find: o.row.find, replaced: o.replaced, reason: o.reason, boxes: o.boxes, fuzzy: !!o.fuzzy })) };
    if (res.output) {
      fs.writeFileSync(job.out, res.output);
      // read again, apart from the page's own checks: the way up it was found, at the page's own size
      const back = O.orient(pngDecode(Buffer.from(res.output)), got.pictures[0].m);
      const again = await rd.read(O.toGray(back.data, back.w * back.h), back.w, back.h, got.pictures[0].dpi);
      out.reread = O.pageText(again).map((l) => l.text).join("\n");
    }
    out.seconds = (Date.now() - t0) / 1000;
    results.push(out);
  }
  // every way a picture can sit, turned up and back, and a box taken back to where it is stored
  const img = { w: 5, h: 3, data: new Uint8ClampedArray(60).map((_, i) => i) };
  const turns = [[1, 0, 0, 1], [-1, 0, 0, -1], [0, 1, -1, 0], [0, -1, 1, 0], [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]];
  const orientation = turns.map((m) => {
    const up = O.orient(img, m), back = O.unorient(up, m);
    let boxes = true;
    for (let y = 0; y < up.h; y++) for (let x = 0; x < up.w; x++) {
      const [x0, y0, x1, y1] = O.boxBack([x, y, x + 1, y + 1], m, img.w, img.h);
      if (x1 - x0 !== 1 || y1 - y0 !== 1) boxes = false;
      else for (let c = 0; c < 4; c++) if (up.data[(y * up.w + x) * 4 + c] !== img.data[(y0 * img.w + x0) * 4 + c]) boxes = false;
    }
    return { m, roundTrip: back.w === img.w && back.h === img.h && back.data.every((v, i) => v === img.data[i]), boxes };
  });
  process.stdout.write(JSON.stringify({ results, orientation }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
