/* PDF identity swap: the second reader, docling's OCR engine. Docling reads a page picture with
 * RapidOCR, which runs PaddleOCR's PP-OCR models on ONNX Runtime: a detector finds every line of
 * text as a box, and a recogniser reads each box. The same models, and the same steps RapidOCR
 * takes (the same sizes, thresholds and decoding), run here on ONNX Runtime's WebAssembly build,
 * inside this page. Tesseract stays the reader whose letter boxes the painting uses; what this
 * reader reads that Tesseract did not is added to the page's text, so it is searched and painted,
 * and the read-back after painting is searched with both. */
const PDFSwapDocling = (() => {
  "use strict";

  // ---------------------------------------------------------------- the steps, as RapidOCR takes them
  // These functions also run inside the reader's worker, so each uses nothing but the others.
  // RapidOCR 3.4.0's settings (config.yaml): a page longer than 2000 pixels is shrunk to fit, one
  // shorter than 736 across its short side grown towards it, both sides a multiple of 32; text where the
  // detector's map is over 0.3, a box kept when its mean is 0.5 or more and grown by 1.6; a line
  // kept when it reads with a mean confidence of 0.5 or more.
  const DL = { maxSide: 2000, minSide: 736, thresh: 0.3, boxThresh: 0.5, unclip: 1.6, minSize: 3, textScore: 0.5, recH: 48, recW: 320 };

  /** The detector's input: the picture grey in all three channels, scaled, as (x / 255 - 0.5) / 0.5. */
  function dlDetInput(gray, w, h) {
    let r = Math.min(1, DL.maxSide / Math.max(w, h));
    // grown to 736 across its short side, as RapidOCR grows it, but never past 2000 along its
    // long side: a strip of one line of text would otherwise be read at four times its size
    if (Math.min(w, h) * r < DL.minSide) r = Math.max(r, Math.min(DL.minSide / Math.min(w, h), DL.maxSide / Math.max(w, h)));
    const dw = Math.max(32, Math.round((w * r) / 32) * 32), dh = Math.max(32, Math.round((h * r) / 32) * 32);
    const n = dw * dh, data = new Float32Array(3 * n), fx = w / dw, fy = h / dh;
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(h - 1.001, Math.max(0, (y + 0.5) * fy - 0.5)), y0 = Math.floor(sy), ty = sy - y0;
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(w - 1.001, Math.max(0, (x + 0.5) * fx - 0.5)), x0 = Math.floor(sx), tx = sx - x0;
        const a = gray[y0 * w + x0], b = gray[y0 * w + x0 + 1], c = gray[(y0 + 1) * w + x0], d = gray[(y0 + 1) * w + x0 + 1];
        const v = ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / 127.5 - 1;
        data[y * dw + x] = v; data[n + y * dw + x] = v; data[2 * n + y * dw + x] = v;
      }
    }
    return { data, dw, dh };
  }

  /** The detector's map made into boxes of text: the map over its threshold, grown a pixel right
   * and down (RapidOCR's dilation), each joined piece taken as the smallest turned rectangle
   * around it (along its own long axis), kept when the map's mean inside is high enough, grown as
   * DB grows its boxes, and given in the picture's own pixels. A box is { cx, cy, ux, uy, hw, hh }:
   * its centre, the direction its text runs, and half its length and height. */
  function dlBoxes(prob, dw, dh, w, h) {
    const n = dw * dh, on = new Uint8Array(n);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const k = y * dw + x;
      if (prob[k] > DL.thresh || (x > 0 && prob[k - 1] > DL.thresh) || (y > 0 && prob[k - dw] > DL.thresh) || (x > 0 && y > 0 && prob[k - dw - 1] > DL.thresh)) on[k] = 1;
    }
    const seen = new Uint8Array(n), out = [], stack = [];
    for (let i = 0; i < n && out.length < 1000; i++) {
      if (!on[i] || seen[i]) continue;
      const px = [];
      seen[i] = 1; stack.push(i);
      while (stack.length) {
        const k = stack.pop(), x = k % dw, y = (k - x) / dw;
        px.push(k);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= dw || yy >= dh) continue;
          const kk = yy * dw + xx;
          if (on[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); }
        }
      }
      if (px.length < 4) continue;
      // the piece's long axis, from its second moments
      let mx = 0, my = 0;
      for (const k of px) { mx += k % dw; my += (k - (k % dw)) / dw; }
      mx /= px.length; my /= px.length;
      let cxx = 0, cyy = 0, cxy = 0;
      for (const k of px) { const x = (k % dw) - mx, y = (k - (k % dw)) / dw - my; cxx += x * x; cyy += y * y; cxy += x * y; }
      let th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      // a line of text runs across: an axis within a few degrees of level is taken as level
      if (Math.abs(th) < 0.035) th = 0;
      let ux = Math.cos(th), uy = Math.sin(th);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const k of px) {
        const x = (k % dw) + 0.5, y = (k - (k % dw)) / dw + 0.5, u = x * ux + y * uy, v = -x * uy + y * ux;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      u0 -= 0.5; u1 += 0.5; v0 -= 0.5; v1 += 0.5;
      let len = u1 - u0, hgt = v1 - v0;
      if (Math.min(len, hgt) < DL.minSize) continue;
      // the map's mean inside the rectangle
      let s = 0, cnt = 0;
      const corners = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]].map(([u, v]) => [u * ux - v * uy, u * uy + v * ux]);
      const bx0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])))), bx1 = Math.min(dw, Math.ceil(Math.max(...corners.map((c) => c[0]))));
      const by0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])))), by1 = Math.min(dh, Math.ceil(Math.max(...corners.map((c) => c[1]))));
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
        const u = (x + 0.5) * ux + (y + 0.5) * uy, v = -(x + 0.5) * uy + (y + 0.5) * ux;
        if (u >= u0 && u <= u1 && v >= v0 && v <= v1) { s += prob[y * dw + x]; cnt++; }
      }
      if (!cnt || s / cnt < DL.boxThresh) continue;
      // grown by area * ratio / perimeter on every side, as DB's unclip does
      const d = (len * hgt * DL.unclip) / (2 * (len + hgt));
      len += 2 * d; hgt += 2 * d;
      if (Math.min(len, hgt) < DL.minSize + 2) continue;
      // a box taller than it is long is a line of text set on end: its text runs along its height
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      let cx = uc * ux - vc * uy, cy = uc * uy + vc * ux;
      if (hgt > len) { [len, hgt] = [hgt, len]; [ux, uy] = [-uy, ux]; }
      if (ux < 0) { ux = -ux; uy = -uy; }
      // in the picture's own pixels
      const sx = w / dw, sy = h / dh;
      cx *= sx; cy *= sy;
      const ex = ux * sx, ey = uy * sy, el = Math.hypot(ex, ey), fx = -uy * sx, fy = ux * sy, fl = Math.hypot(fx, fy);
      out.push({ cx, cy, ux: ex / el, uy: ey / el, hw: (len * el) / 2, hh: (hgt * fl) / 2 });
    }
    // top to bottom, and left to right along a line (RapidOCR's sorted_boxes)
    out.sort((a, b) => a.cy - a.hh - (b.cy - b.hh) || a.cx - b.cx);
    for (let i = 0; i + 1 < out.length; i++) for (let j = i; j >= 0 && Math.abs(out[j + 1].cy - out[j + 1].hh - (out[j].cy - out[j].hh)) < 10 && out[j + 1].cx - out[j + 1].hw < out[j].cx - out[j].hw; j--) [out[j], out[j + 1]] = [out[j + 1], out[j]];
    return out;
  }

  /** The recogniser's input for one box: the box cut out straight (a grey picture 48 high, as long
   * as the box is for that height), padded to at least 320 across with the middle grey a zero is,
   * as (x / 255 - 0.5) / 0.5 in three channels. */
  function dlRecInput(gray, w, h, b) {
    const len = 2 * b.hw, hgt = 2 * b.hh;
    const rw = Math.max(1, Math.min(4000, Math.ceil((DL.recH * len) / hgt))), W = Math.max(DL.recW, rw), H = DL.recH, n = W * H;
    const data = new Float32Array(3 * n);
    const vx = -b.uy, vy = b.ux, ax = b.cx - b.ux * b.hw - vx * b.hh, ay = b.cy - b.uy * b.hw - vy * b.hh;
    for (let j = 0; j < H; j++) {
      const v = ((j + 0.5) * hgt) / H;
      for (let i = 0; i < rw; i++) {
        const u = ((i + 0.5) * len) / rw;
        const sx = Math.min(w - 1.001, Math.max(0, ax + u * b.ux + v * vx - 0.5)), sy = Math.min(h - 1.001, Math.max(0, ay + u * b.uy + v * vy - 0.5));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
        const g = (gray[y0 * w + x0] * (1 - tx) + gray[y0 * w + x0 + 1] * tx) * (1 - ty) + (gray[(y0 + 1) * w + x0] * (1 - tx) + gray[(y0 + 1) * w + x0 + 1] * tx) * ty;
        const val = g / 127.5 - 1;
        data[j * W + i] = val; data[n + j * W + i] = val; data[2 * n + j * W + i] = val;
      }
    }
    return { data, W, H, rw };
  }

  /** The recogniser's output read the CTC way: the likeliest character at each step, a repeat or
   * the blank dropped. Each character keeps the step it was read at, which says where along the
   * box it sits. keys: the model's characters, with the blank first and the space last. */
  function dlDecode(probs, T, C, keys) {
    const chars = [];
    let last = -1;
    for (let t = 0; t < T; t++) {
      let best = 0, p = -Infinity;
      for (let c = 0; c < C; c++) { const q = probs[t * C + c]; if (q > p) { p = q; best = c; } }
      if (best !== 0 && best !== last && best < keys.length) chars.push({ c: keys[best], p, t });
      last = best;
    }
    return chars;
  }

  /** One box's characters as a line of words, each character with a box in the picture's own
   * pixels: along the box from where it was read (half-way to its neighbours), across the box's
   * whole height. Spaces part the words and are not kept. */
  function dlLine(b, chars, T, W, rw) {
    const len = 2 * b.hw, step = W / T, along = (t) => ((t + 0.5) * step * len) / rw;
    const vx = -b.uy, vy = b.ux, ax = b.cx - b.ux * b.hw - vx * b.hh, ay = b.cy - b.uy * b.hw - vy * b.hh;
    const at = chars.map((ch) => along(ch.t));
    const gaps = [];
    for (let k = 1; k < at.length; k++) gaps.push(at[k] - at[k - 1]);
    const half = gaps.length ? [...gaps].sort((a, c) => a - c)[gaps.length >> 1] / 2 : (step * len) / rw;
    const aabb = (u0, u1) => {
      const pts = [[u0, 0], [u1, 0], [u0, 2 * b.hh], [u1, 2 * b.hh]].map(([u, v]) => [ax + u * b.ux + v * vx, ay + u * b.uy + v * vy]);
      return [Math.floor(Math.min(...pts.map((q) => q[0]))), Math.floor(Math.min(...pts.map((q) => q[1]))), Math.ceil(Math.max(...pts.map((q) => q[0]))), Math.ceil(Math.max(...pts.map((q) => q[1])))];
    };
    const words = [];
    let word = null;
    chars.forEach((ch, k) => {
      if (!ch.c.trim()) { word = null; return; }
      const u0 = Math.max(0, k > 0 ? (at[k - 1] + at[k]) / 2 : at[k] - half), u1 = Math.min(len, k + 1 < at.length ? (at[k] + at[k + 1]) / 2 : at[k] + half);
      if (!word) { word = { syms: [] }; words.push(word); }
      word.syms.push({ c: ch.c, conf: Math.round(ch.p * 100), box: aabb(u0, u1), dl: true });
    });
    for (const wd of words) {
      wd.box = [Math.min(...wd.syms.map((s) => s.box[0])), Math.min(...wd.syms.map((s) => s.box[1])), Math.max(...wd.syms.map((s) => s.box[2])), Math.max(...wd.syms.map((s) => s.box[3]))];
      wd.conf = Math.round(wd.syms.reduce((a, s) => a + s.conf, 0) / wd.syms.length);
      wd.base = null;
    }
    return words;
  }

  /** Read a grey picture: every line the detector finds, read by the recogniser. Returns lines as
   * Tesseract's are given ({ words: [{ conf, box, syms: [{ c, conf, box }] }] }), with the line's
   * text and mean confidence. */
  async function dlRead(dl, gray, w, h) {
    const { ort, det, rec, keys } = dl;
    const inp = dlDetInput(gray, w, h);
    const got = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", inp.data, [1, 3, inp.dh, inp.dw]) });
    const prob = got[det.outputNames[0]].data;
    const boxes = dlBoxes(prob, inp.dw, inp.dh, w, h);
    const lines = [];
    for (const b of boxes) {
      if (b.hh < 2.5 || b.hw < 2.5) continue;
      const r = dlRecInput(gray, w, h, b);
      const o = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", r.data, [1, 3, r.H, r.W]) });
      const t = o[rec.outputNames[0]], [, T, C] = t.dims;
      const chars = dlDecode(t.data, T, C, keys);
      const real = chars.filter((ch) => ch.c.trim());
      if (!real.length) continue;
      const conf = real.reduce((a, ch) => a + ch.p, 0) / real.length;
      if (conf < DL.textScore) continue;
      const words = dlLine(b, chars, T, r.W, r.rw);
      if (words.length) lines.push({ words, conf: Math.round(conf * 100), text: words.map((wd) => wd.syms.map((s) => s.c).join("")).join(" "), dl: true });
    }
    return lines;
  }

  /** What this reader read, added to what Tesseract read of the same picture: a line holding a
   * word Tesseract did not read the same where it stands (missed, read otherwise, or read as two
   * words: "529-61 -0447" is no SSN to the finding step) is added whole, so whatever the word is
   * part of is searched as it is printed. A line Tesseract read the same, word for word, adds
   * nothing. Writing Tesseract could not make out that this reader
   * reads with high confidence is text after all, and is no longer counted as unreadable. */
  function dlMerge(res, lines) {
    // a word as both readers would give it: its characters, and its case only where a reader
    // could not tell (Tesseract's "c" for a "C" is the same word)
    const norm = (wd) => wd.syms.map((s) => s.c).join("").replace(/\s+/g, "").toLowerCase();
    const tw = [];
    for (const l of res.lines) for (const wd of l.words) {
      const t = norm(wd);
      if (/[\p{L}\p{N}]/u.test(t)) tw.push({ box: wd.box, t });
    }
    const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const area = (a) => Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
    let added = 0;
    for (const l of lines) {
      let fresh = false;
      for (const wd of l.words) {
        const t = norm(wd);
        if (!/[\p{L}\p{N}]/u.test(t)) continue;
        const under = tw.filter((x) => overlap(x.box, wd.box) > 0.3 * Math.min(area(x.box), area(wd.box)));
        // the same word, or a word of Tesseract's this one is the letters of without the
        // punctuation Tesseract also read beside it ("Name:" for "Name")
        const bare = (x) => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (!(under.length === 1 && (under[0].t === t || bare(under[0].t) === bare(t)))) { fresh = true; break; }
      }
      if (!fresh) continue;
      res.lines.push({ words: l.words, pass: 4, dl: true });
      added++;
      if (l.conf >= 90) {
        const box = [Math.min(...l.words.map((wd) => wd.box[0])), Math.min(...l.words.map((wd) => wd.box[1])), Math.max(...l.words.map((wd) => wd.box[2])), Math.max(...l.words.map((wd) => wd.box[3]))];
        res.marks = res.marks.filter((m) => !(m.kind === "writing" && overlap(m.box, box) > 0.6 * area(m.box)));
      }
    }
    res.docling = { lines: lines.length, added };
    return res;
  }

  /** The reader's models opened in ONNX Runtime's WebAssembly build, in one thread. `glue` is
   * where ONNX Runtime's loader for its WebAssembly is to be imported from (a blob in the page). */
  async function dlOpen(ort, { glue, wasm, det, rec, keys }) {
    // the loader is handed over inside a module of two lines that gives it its WebAssembly
    // compiled: left to itself it works out where the file would sit beside it, which a module
    // with no address of its own (a blob) cannot answer
    const wrap = "import load from " + JSON.stringify(glue) + ";\nexport default (m) => load({ ...m, instantiateWasm(imports, done) { WebAssembly.instantiate(m.wasmBinary, imports).then((r) => done(r.instance, r.module)); return {}; } });\n";
    ort.env.wasm.wasmPaths = { mjs: glue.startsWith("blob:") ? URL.createObjectURL(new Blob([wrap], { type: "text/javascript" })) : "data:text/javascript;base64," + btoa(wrap) };
    ort.env.wasm.wasmBinary = wasm;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const list = ["blank", ...String(keys).split(/\r?\n/).filter((k, i, a) => k.length || i < a.length - 1), " "];
    return { ort, det: await ort.InferenceSession.create(det, opts), rec: await ort.InferenceSession.create(rec, opts), keys: list };
  }
  const SHARED = [dlDetInput, dlBoxes, dlRecInput, dlDecode, dlLine, dlRead, dlMerge, dlOpen];

  return { DL, dlDetInput, dlBoxes, dlRecInput, dlDecode, dlLine, read: dlRead, merge: dlMerge, open: dlOpen, SHARED };
})();
globalThis.PDFSwapDocling = PDFSwapDocling;
if (typeof module !== "undefined") module.exports = PDFSwapDocling;
