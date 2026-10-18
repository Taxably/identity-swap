/* PDF identity swap: scanned pages and photos. Tesseract 5 reads each picture of a page inside
 * this page (no install, no network), every value found is painted over in the picture with the
 * document's own letters, and the picture is read again to prove the new value reads and the old
 * one does not. The pieces that touch the browser (workers, canvases, pdf.js) are at the end and
 * are handed in, so the same steps run in node for the tests. */
const PDFSwapOCR = (() => {
  "use strict";
  const E = () => globalThis.PDFSwapEngine;

  // ---------------------------------------------------------------- pictures as numbers
  // These functions also run inside the reader's worker, so each uses nothing but the others.
  function toGray(rgba, n) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }
  /** A grey picture at another size: averaged when it shrinks, bilinear when it grows. */
  function resize(src, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh);
    if (nw <= w && nh <= h) {
      const fx = w / nw, fy = h / nh;
      for (let y = 0; y < nh; y++) {
        const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * fy)));
        for (let x = 0; x < nw; x++) {
          const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * fx)));
          let s = 0;
          for (let yy = y0; yy < y1; yy++) for (let xx = x0, r = yy * w; xx < x1; xx++) s += src[r + xx];
          out[y * nw + x] = s / ((y1 - y0) * (x1 - x0));
        }
      }
      return out;
    }
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1.001, Math.max(0, (y + 0.5) * h / nh - 0.5)), y0 = Math.floor(sy), dy = sy - y0;
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(w - 1.001, Math.max(0, (x + 0.5) * w / nw - 0.5)), x0 = Math.floor(sx), dx = sx - x0;
        const a = src[y0 * w + x0], b = src[y0 * w + x0 + 1], c = src[(y0 + 1) * w + x0], d = src[(y0 + 1) * w + x0 + 1];
        out[y * nw + x] = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
      }
    }
    return out;
  }
  /** How bright the paper is under every pixel: the page shrunk, its brightest nearby value
   * taken (the paper between the letters), smoothed and grown back. */
  function paper(gray, w, h) {
    const f = 8, sw = Math.max(1, Math.ceil(w / f)), sh = Math.max(1, Math.ceil(h / f));
    let small = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let yy = y * f; yy < Math.min(h, y * f + f); yy += 2) for (let xx = x * f, r = yy * w; xx < Math.min(w, x * f + f); xx += 2) if (gray[r + xx] > m) m = gray[r + xx];
      small[y * sw + x] = m;
    }
    const pass = (a, rad, op) => {
      const t = new Uint8Array(a.length), o = new Uint8Array(a.length);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { let v = op === "max" ? 0 : 0, n = 0; for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx < 0 || xx >= sw) continue; const s = a[y * sw + xx]; if (op === "max") { if (s > v) v = s; } else { v += s; n++; } } t[y * sw + x] = op === "max" ? v : v / n; }
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { let v = 0, n = 0; for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy < 0 || yy >= sh) continue; const s = t[yy * sw + x]; if (op === "max") { if (s > v) v = s; } else { v += s; n++; } } o[y * sw + x] = op === "max" ? v : v / n; }
      return o;
    };
    small = pass(pass(pass(small, 3, "max"), 2, "mean"), 2, "mean");
    return resize(small, sw, sh, w, h);
  }
  /** The page with its paper divided out (even light, white paper) and its contrast stretched. */
  function flatten(gray, bg) {
    const n = gray.length, out = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = Math.min(255, (gray[i] * 255) / (bg[i] + 1)); out[i] = v; hist[out[i]]++; }
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.002) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
    if (hi - lo < 40) return out;
    for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, ((out[i] - lo) * 255) / (hi - lo)));
    return out;
  }
  /** The ruling lines of a form: runs of dark pixels longer than any letter's stroke, across and
   * down. OCR reads the page without them; a line sitting on a box of text otherwise takes the
   * text out of the page's text altogether. */
  function lineMask(flat, w, h, minLen) {
    // a scan a degree off square moves a line a pixel sideways every fifty or so: a run is
    // followed through the pixel either side of it
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < dark.length; i++) dark[i] = flat[i] < 160 ? 1 : 0;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && (dark[y * w + x] || (y > 0 && dark[(y - 1) * w + x]) || (y < h - 1 && dark[(y + 1) * w + x]));
        if (on && s < 0) s = x;
        else if (!on && s >= 0) {
          if (x - s >= minLen) for (let k = s; k < x; k++) for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy >= 0 && yy < h && dark[yy * w + k]) m[yy * w + k] = 1; }
          s = -1;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      let s = -1;
      for (let y = 0; y <= h; y++) {
        const on = y < h && (dark[y * w + x] || (x > 0 && dark[y * w + x - 1]) || (x < w - 1 && dark[y * w + x + 1]));
        if (on && s < 0) s = y;
        else if (!on && s >= 0) {
          if (y - s >= minLen) for (let k = s; k < y; k++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && dark[k * w + xx]) m[k * w + xx] = 1; }
          s = -1;
        }
      }
    }
    const g = new Uint8Array(m);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (x > 0) g[y * w + x - 1] = 1; if (x < w - 1) g[y * w + x + 1] = 1;
      if (y > 0) g[(y - 1) * w + x] = 1; if (y < h - 1) g[(y + 1) * w + x] = 1;
    }
    return g;
  }
  /** What OCR reads: flattened, ruling lines taken out. */
  function prepare(gray, w, h, dpi) {
    const bg = paper(gray, w, h), flat = flatten(gray, bg);
    const mask = lineMask(flat, w, h, Math.max(24, Math.round(dpi * 0.4)));
    const clean = new Uint8Array(flat);
    let ink = 0;
    for (let i = 0; i < clean.length; i++) { if (mask[i]) clean[i] = 255; else if (clean[i] < 128) ink++; }
    return { clean, mask, bg, gray, ink: ink / clean.length };
  }

  /** Read one page picture with a Tesseract instance. Coordinates are those of the picture given.
   * coverage: ink no word covers is read again line by line; what still reads as nothing is
   * returned as marks. rects: read just these boxes, one line each (the read-back). */
  function readPage(M, api, { gray, w, h, dpi, coverage = true, rects = null }) {
    const { clean, ink, mask } = prepare(gray, w, h, dpi);
    const out = { w, h, ink, lines: [], marks: [], mean: 0, rectTexts: null };
    // a picture of no page of text (a photo of a person, noise) is not read: it would take minutes
    if (ink > 0.33) { out.notText = true; return out; }
    const give = (pix, pw, ph) => {
      const head = "P5\n" + pw + " " + ph + "\n255\n", file = new Uint8Array(head.length + pix.length);
      for (let i = 0; i < head.length; i++) file[i] = head.charCodeAt(i);
      file.set(pix, head.length);
      M.FS.writeFile("/input", file);
      if (api.SetImageFile(1, 0) === 1) throw Error("the picture could not be handed to the reader");
    };
    give(clean, w, h);
    api.SetVariable("user_defined_dpi", String(Math.round(dpi)));
    api.SetVariable("preserve_interword_spaces", "1");
    if (rects) {
      // each box read as a line, and again as raw text: a reader can misread a clean word once
      out.rectTexts = rects.map(([x0, y0, x1, y1]) => ["7", "13", "8"].map((psm) => {
        api.SetVariable("tessedit_pageseg_mode", psm);
        api.SetRectangle(Math.max(0, x0), Math.max(0, y0), Math.min(w, x1) - Math.max(0, x0), Math.min(h, y1) - Math.max(0, y0));
        api.Recognize(null);
        return api.GetUTF8Text().replace(/\s+/g, " ").trim();
      }));
      return out;
    }
    const collect = (pass) => {
      const it = api.GetIterator(), lines = [];
      if (!it || it.Empty(4)) return lines;
      let line = null, word = null;
      do {
        if (!line || it.IsAtBeginningOf(2)) { line = { words: [], pass }; lines.push(line); word = null; }
        if (!word || it.IsAtBeginningOf(3)) {
          const bb = it.getBoundingBox(3), bl = it.getBaseline(3);
          word = { conf: Math.round(it.Confidence(3)), box: [bb.x0, bb.y0, bb.x1, bb.y1], base: bl.has_baseline ? [bl.x0, bl.y0, bl.x1, bl.y1] : null, syms: [] };
          line.words.push(word);
        }
        const sb = it.getBoundingBox(4);
        word.syms.push({ c: it.GetUTF8Text(4) || "", conf: Math.round(it.Confidence(4)), box: [sb.x0, sb.y0, sb.x1, sb.y1] });
      } while (it.Next(4));
      return lines.filter((l) => l.words.some((wd) => wd.syms.some((s) => s.c.trim())));
    };
    api.SetVariable("tessedit_pageseg_mode", "3");
    api.Recognize(null);
    out.mean = api.MeanTextConf();
    out.lines = collect(1);
    // a word read with almost no confidence gets a second look (below, at twice the size, once
    // the page itself is done): small print beside a form's lines reads then, and what still does
    // not is writing nobody can search
    const doubtful = [], smallPrint = [];
    // a part of the page, read at twice its size, with what it read put back at the page's own
    const crop2x = (r, psm) => {
      const [cx0, cy0] = r, cw = r[2] - r[0], ch = r[3] - r[1];
      if (cw <= 0 || ch <= 0) return [];
      const crop = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) crop.set(clean.subarray((cy0 + y) * w + cx0, (cy0 + y) * w + cx0 + cw), y * cw);
      give(resize(crop, cw, ch, cw * 2, ch * 2), cw * 2, ch * 2);
      api.SetVariable("tessedit_pageseg_mode", psm);
      api.Recognize(null);
      const lines = collect(3);
      const back = (b) => [cx0 + Math.floor(b[0] / 2), cy0 + Math.floor(b[1] / 2), cx0 + Math.ceil(b[2] / 2), cy0 + Math.ceil(b[3] / 2)];
      for (const l of lines) for (const wd of l.words) { wd.box = back(wd.box); if (wd.base) wd.base = [cx0 + wd.base[0] / 2, cy0 + wd.base[1] / 2, cx0 + wd.base[2] / 2, cy0 + wd.base[3] / 2]; for (const sy of wd.syms) sy.box = back(sy.box); }
      return lines;
    };
    // handwriting the reader turned into "words" stands far taller than the page's print and is
    // read without much confidence: that is writing nobody can search, whatever it was read as
    const tall = out.lines.flatMap((l) => l.words.map((wd) => wd.box[3] - wd.box[1])).sort((a, b) => a - b);
    const typical = tall.length ? tall[tall.length >> 1] : dpi * 0.1;
    // how tall the ink in a word is (its box can take in a speck above or below it)
    const inkHeight = ([x0, y0, x1, y1]) => {
      let top = -1, bottom = -1;
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        let n = 0;
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) if (clean[y * w + x] < 128) n++;
        if (n >= 2) { if (top < 0) top = y; bottom = y; }
      }
      return top < 0 ? 0 : bottom - top + 1;
    };
    // a shape mostly ink (an icon, a filled box, a logo) is not writing: a pen's strokes, a
    // signature and a stamp's letters leave most of their box blank
    const solid = ([x0, y0, x1, y1]) => {
      let n = 0, a = 0;
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) { a++; if (clean[y * w + x] < 128) n++; }
      return a > 0 && n / a > 0.55;
    };
    const writing = (box) => { if (!solid(box)) out.marks.push({ box, kind: "writing" }); };
    for (const l of out.lines) for (const wd of l.words) {
      const hgt = wd.conf < 75 ? inkHeight(wd.box) : wd.box[3] - wd.box[1], alnums = wd.syms.filter((sy) => /[A-Za-z0-9]/.test(sy.c)).length;
      if (wd.conf < 75 && hgt > 1.8 * typical && alnums >= 1) writing(wd.box);
      else if (wd.conf < 45 && alnums >= 3 && hgt >= Math.max(8, dpi * 0.03)) doubtful.push({ box: wd.box, text: wd.syms.map((sy) => sy.c).join("") });
    }
    if (coverage) {
      const words = out.lines.flatMap((l) => l.words);
      const hs = words.map((wd) => wd.box[3] - wd.box[1]).sort((a, b) => a - b);
      const lineH = hs.length ? hs[hs.length >> 1] : dpi * 0.14;
      const c = Math.max(2, Math.round(dpi / 75)), cw = Math.ceil(w / c), ch = Math.ceil(h / c);
      const cell = new Uint8Array(cw * ch);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (clean[y * w + x] < 128) cell[((y / c) | 0) * cw + ((x / c) | 0)] = 1;
      for (const wd of words) {
        const [x0, y0, x1, y1] = wd.box;
        for (let y = Math.max(0, ((y0 / c) | 0) - 1); y <= Math.min(ch - 1, ((y1 / c) | 0) + 1); y++) for (let x = Math.max(0, ((x0 / c) | 0) - 1); x <= Math.min(cw - 1, ((x1 / c) | 0) + 1); x++) cell[y * cw + x] = 0;
      }
      // what is left, in pieces, merged into strips a line of text could be
      const seen = new Uint8Array(cw * ch), comps = [];
      for (let i = 0; i < cell.length; i++) {
        if (!cell[i] || seen[i]) continue;
        const stack = [i]; seen[i] = 1;
        let n = 0, bx0 = cw, by0 = ch, bx1 = 0, by1 = 0;
        while (stack.length) {
          const k = stack.pop(), x = k % cw, y = (k - x) / cw;
          n++; if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
            const kk = yy * cw + xx;
            if (cell[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); }
          }
        }
        if (n >= 3) comps.push([bx0 * c, by0 * c, (bx1 + 1) * c, (by1 + 1) * c]);
      }
      comps.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const strips = [];
      for (const b of comps) {
        const s = strips.find((t) => Math.min(t[3], b[3]) - Math.max(t[1], b[1]) > 0.5 * Math.min(t[3] - t[1], b[3] - b[1]) && b[0] - t[2] < 2 * lineH && t[0] - b[2] < 2 * lineH);
        if (s) { s[0] = Math.min(s[0], b[0]); s[1] = Math.min(s[1], b[1]); s[2] = Math.max(s[2], b[2]); s[3] = Math.max(s[3], b[3]); }
        else strips.push(b.slice());
      }
      // ink that sits against a ruling line taken out (the corner of a box) is what is left of it
      const againstLine = (s) => {
        let dark = 0, near = 0;
        for (let y = s[1]; y < s[3]; y++) for (let x = s[0]; x < s[2]; x++) {
          if (clean[y * w + x] >= 128) continue;
          dark++;
          let hit = false;
          for (let dy = -2; dy <= 2 && !hit; dy++) for (let dx = -2; dx <= 2 && !hit; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) hit = true; }
          if (hit) near++;
        }
        return dark && near / dark > 0.5;
      };
      for (const s of strips) {
        const sh = s[3] - s[1], sw = s[2] - s[0];
        if (againstLine(s)) continue;
        // a speck, a tick, or what is left of a ruling line beside the text
        if ((sh < 0.6 * lineH && sw < 2 * lineH) || (sw < 0.6 * lineH && sh < 1.5 * lineH) || sw < 0.25 * lineH || sh < 0.25 * lineH || sh > 4 * sw) continue;
        if (sh > 5 * lineH || sw > 0.95 * w) { out.marks.push({ box: s, kind: "picture" }); continue; } // a picture, a logo
        const pad = Math.round(lineH * 0.3), r = [Math.max(0, s[0] - pad), Math.max(0, s[1] - pad), Math.min(w, s[2] + pad), Math.min(h, s[3] + pad)];
        api.SetVariable("tessedit_pageseg_mode", sh < 1.8 * lineH ? "7" : "6");
        api.SetRectangle(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        api.Recognize(null);
        const got = collect(2).filter((l) => l.words.some((wd) => wd.conf >= 45 && wd.syms.some((sy) => /[A-Za-z0-9]/.test(sy.c))));
        if (got.length) out.lines.push(...got); else smallPrint.push(r);
      }
    }
    // small print the page's own read missed is read again at twice its size; what reads is added
    // to the page's text (it can hold a name), and what does not is writing nobody can search
    for (const r of smallPrint) {
      let got = [];
      for (const psm of ["7", "6"]) {
        got = crop2x(r, psm).filter((l) => l.words.some((wd) => wd.conf >= 30 && wd.syms.filter((sy) => /[A-Za-z0-9]/.test(sy.c)).length >= 2));
        if (got.length) break;
      }
      if (got.length) out.lines.push(...got); else writing(r);
    }
    // print reads the same twice, however unsure the reader is of it; writing nobody can read
    // comes out different each time
    const alnum = (t) => t.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const alike = (a, b) => {
      if (!a.length || !b.length) return 0;
      const d = Array.from({ length: b.length + 1 }, (_, j) => j);
      for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
      return 1 - d[b.length] / Math.max(a.length, b.length);
    };
    for (const { box: [x0, y0, x1, y1], text } of doubtful) {
      const pad = Math.max(3, Math.round((y1 - y0) * 0.4)), cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad), cw = Math.min(w, x1 + pad) - cx0, ch = Math.min(h, y1 + pad) - cy0;
      if (cw <= 0 || ch <= 0) continue;
      let readable = false;
      for (const psm of ["7", "8", "6"]) {
        const lines = crop2x([cx0, cy0, cx0 + cw, cy0 + ch], psm);
        const t = lines.map((l) => l.words.map((wd) => wd.syms.map((sy) => sy.c).join("")).join(" ")).join(" ");
        if (api.MeanTextConf() >= 30 || alike(alnum(text), alnum(t)) >= 0.7) { readable = true; break; }
      }
      if (!readable) writing([x0, y0, x1, y1]);
    }
    return out;
  }

  /** The worker the reader runs in: the Tesseract module's own script, these functions, and this. */
  function workerMain(scope) {
    let M = null, api = null;
    scope.onmessage = async (ev) => {
      const { id, type } = ev.data;
      try {
        if (type === "init") {
          M = await TesseractCore({ wasmBinary: ev.data.wasm, print() {}, printErr() {} });
          M.FS.mkdir("/td");
          M.FS.writeFile("/td/eng.traineddata", ev.data.model);
          api = new M.TessBaseAPI();
          if (api.Init("/td", "eng", 1) !== 0) throw Error("the reader's English model would not load");
          scope.postMessage({ id, ok: true });
        } else if (type === "read") {
          scope.postMessage({ id, ok: true, res: readPage(M, api, ev.data) });
        }
      } catch (e) { scope.postMessage({ id, ok: false, error: String((e && e.message) || e) }); }
    };
  }
  const SHARED = [toGray, resize, paper, flatten, lineMask, prepare, readPage];

  // ---------------------------------------------------------------- the reader
  /** A pool of readers. `spawn()` makes one: a worker in the page, the module itself in node.
   * Every read is a page picture in grey at its own resolution; it is scaled to about 300 dpi for
   * reading and the result is scaled back. */
  function pool(spawn, size, { timeout = 240000 } = {}) {
    const idle = [], queue = [];
    let made = 0;
    const take = () => new Promise((res) => { if (idle.length) res(idle.pop()); else if (made < size) { made++; res(spawn()); } else queue.push(res); });
    const give = (r) => { if (queue.length) queue.shift()(r); else idle.push(r); };
    // a reader that failed or ran out of time is closed and a fresh one takes its place
    const drop = () => { made--; if (queue.length) { made++; queue.shift()(spawn()); } };
    return {
      size,
      async read(gray, w, h, dpi, opts = {}) {
        const s0 = Math.max(0.5, Math.min(2, 300 / (dpi || 300)));
        const s = s0 * Math.min(1, Math.sqrt(30e6 / (w * h * s0 * s0)));
        const same = Math.abs(s - 1) < 0.02;
        const sw = same ? w : Math.max(1, Math.round(w * s)), sh = same ? h : Math.max(1, Math.round(h * s));
        const g = same ? gray : resize(gray, w, h, sw, sh);
        const rects = opts.rects ? opts.rects.map((r) => r.map((v) => Math.round(v * (same ? 1 : s)))) : null;
        const slot = await take();
        let reader;
        try { reader = await slot; } catch (e) { drop(); throw e; }
        let timer, res;
        try {
          res = await Promise.race([
            reader.read({ gray: g, w: sw, h: sh, dpi: dpi * (same ? 1 : s), coverage: opts.coverage !== false, rects }),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("reading this page took more than " + Math.round(timeout / 60000) + " minutes")), timeout); }),
          ]);
        } catch (e) { clearTimeout(timer); try { reader.close(); } catch (e2) { /* already gone */ } drop(); throw e; }
        clearTimeout(timer);
        give(slot);
        return scaleBack(res, same ? 1 : s);
      },
      async close() { for (const r of idle.splice(0)) { try { (await r).close(); } catch (e) { /* already gone */ } } },
    };
  }
  function scaleBack(res, s) {
    if (s === 1) return res;
    const b = (box) => box && [Math.floor(box[0] / s), Math.floor(box[1] / s), Math.ceil(box[2] / s), Math.ceil(box[3] / s)];
    for (const l of res.lines) for (const wd of l.words) { wd.box = b(wd.box); if (wd.base) wd.base = wd.base.map((v) => v / s); for (const sy of wd.syms) sy.box = b(sy.box); }
    res.marks = res.marks.map((m) => ({ box: b(m.box), kind: m.kind }));
    res.w = Math.round(res.w / s); res.h = Math.round(res.h / s);
    return res;
  }

  // ---------------------------------------------------------------- the page as text
  /** Each line as a string, with what symbol every character is (or -1 for a gap). A gap much
   * wider than a letter is three spaces, as the PDF text of a form's columns reads. */
  function pageText(res) {
    if (res._text) return res._text;
    const lines = [];
    res.lines.forEach((l, li) => {
      const syms = [], widths = [];
      for (const wd of l.words) for (const sy of wd.syms) widths.push(sy.box[2] - sy.box[0]);
      widths.sort((a, b) => a - b);
      const cw = widths.length ? Math.max(1, widths[widths.length >> 1]) : 10;
      let text = "", prev = null;
      const map = [];
      l.words.forEach((wd, wi) => {
        if (prev) { const gap = wd.box[0] - prev.box[2]; const sp = gap > 2.5 * cw ? "   " : " "; text += sp; for (let k = 0; k < sp.length; k++) map.push(-1); }
        wd.syms.forEach((sy, si) => { for (const ch of [...sy.c]) { text += ch; map.push(syms.length); } syms.push({ wi, si }); });
        prev = wd;
      });
      lines.push({ text, map, syms, li });
    });
    res._text = lines;
    return lines;
  }
  /** Whether a line is set in a typewriter face: its letters step along evenly. (The reader's
   * letter boxes drift a little, which this allows for.) */
  function evenlySpaced(line) {
    const steps = [];
    for (const wd of line.words) for (let k = 1; k < wd.syms.length; k++) steps.push((wd.syms[k].box[0] + wd.syms[k].box[2]) / 2 - (wd.syms[k - 1].box[0] + wd.syms[k - 1].box[2]) / 2);
    if (steps.length < 4) return false;
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    return Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length) / (mean || 1) < 0.15;
  }
  /** What the finding step reads of a picture: its lines, as a text file's are read, each line
   * marked as typewriter or proportional (fonts[0] and fonts[1] of the pair given), so a stand-in
   * about as wide as the original is preferred where the letters are proportional. */
  function profileParts(res, page, where, fonts = null) {
    const lines = pageText(res);
    const runs = [];
    let at = 0;
    lines.forEach((l, k) => {
      if (fonts) runs.push(at, fonts[evenlySpaced(res.lines[l.li]) ? 1 : 0]);
      at += l.text.length + 1;
      if (!fonts && k === 0) runs.push(0, -1);
    });
    if (!runs.length) runs.push(0, -1);
    const text = lines.map((l) => l.text);
    return { part: { text: text.join("\n"), runs, where, page }, block: { lines: text, where, page } };
  }

  // ---------------------------------------------------------------- finding the values in it
  // characters OCR mistakes for each other, both ways
  const CONFUSE = (() => {
    const groups = ["0OoDQ", "1lI|i!", "5Ss", "8B3", "6Gb", "9gq", "2Zz", "yv", "uv", "ce", "hb", "ao", "nh", "ft", "EF", ".,", "-–—~", "7T", "4A", "rn", "cC", "kK", "pP", "sS", "wW", "xX", "zZ", "oO", "uU", "vV"];
    const m = new Map();
    for (const g of groups) for (const a of g) for (const b of g) if (a !== b) { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); }
    return m;
  })();
  const ALNUM = /[\p{L}\p{N}]/u;
  /** Every place a row's text reads on the page: exactly, and where OCR misread a letter or two
   * as one it is often taken for (so "Priva" is still the "Priya" the folder holds). */
  function findOnPage(res, prepared, rows) {
    const out = [];
    const byLen = new Map();
    for (const r of rows) if (r.find.length >= 5 && ALNUM.test(r.find)) { if (!byLen.has(r.find.length)) byLen.set(r.find.length, []); byLen.get(r.find.length).push(r); }
    for (const line of pageText(res)) {
      const taken = new Uint8Array(line.text.length);
      for (const [s, e, row] of E().findMatches(line.text, prepared)) {
        if (e - s !== row.find.length) continue;
        out.push({ line, s, e, row, fuzzy: false });
        taken.fill(1, s, e);
      }
      const t = line.text;
      for (const [len, group] of byLen) {
        for (let s = 0; s + len <= t.length; s++) {
          if (taken[s] || (s > 0 && ALNUM.test(t[s - 1])) || (s + len < t.length && ALNUM.test(t[s + len]))) continue;
          for (const row of group) {
            const f = row.find;
            let miss = 0;
            for (let k = 0; k < len && miss <= 2; k++) {
              if (t[s + k] === f[k]) continue;
              if (!CONFUSE.get(f[k])?.has(t[s + k])) { miss = 9; break; }
              miss++;
            }
            if (miss === 0 || miss > (len >= 9 ? 2 : 1)) continue;
            let clash = false;
            for (let k = s; k < s + len; k++) if (taken[k]) clash = true;
            if (clash) continue;
            out.push({ line, s, e: s + len, row, fuzzy: true });
            taken.fill(1, s, s + len);
            break;
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- painting
  const CAPS = /[A-Z0-9]/, LOWX = /[acemnorsuvwxz]/, DESC = /[gjpqy,;]/;
  function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
  /** How tall the capitals of each line are, whether its face is a typewriter's (every letter
   * the same width apart) and how heavy its strokes are: a letter is borrowed from another line
   * only when that line looks like the same face. */
  function lineMetrics(res, clean, w) {
    if (res._metrics) return res._metrics;
    res._metrics = res.lines.map((l) => {
      const caps = [], xs = [], hs = [], steps = [], strokes = [];
      for (const wd of l.words) {
        hs.push(wd.box[3] - wd.box[1]);
        wd.syms.forEach((sy, k) => {
          const h = sy.box[3] - sy.box[1];
          if (CAPS.test(sy.c) && !/[QJ]/.test(sy.c)) caps.push(h); else if (LOWX.test(sy.c)) xs.push(h);
          const nx = wd.syms[k + 1];
          if (nx && sy.exact && nx.exact) steps.push((nx.box[0] + nx.box[2]) / 2 - (sy.box[0] + sy.box[2]) / 2);
          if (clean && sy.exact && /[A-Z]/.test(sy.c)) {
            const y = (sy.box[1] + sy.box[3]) >> 1;
            let run = 0;
            for (let x = sy.box[0]; x <= sy.box[2]; x++) { if (x < sy.box[2] && clean[y * w + x] < 150) run++; else if (run) { strokes.push(run); run = 0; } }
          }
        });
      }
      const cap = caps.length ? median(caps) : xs.length ? median(xs) * 1.43 : median(hs) * 0.72 || 10;
      const mean = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
      const sd = steps.length ? Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length) : 0;
      return { cap, mono: steps.length >= 4 ? sd / (mean || 1) < 0.1 : null, stroke: strokes.length ? median(strokes) / cap : null };
    });
    return res._metrics;
  }
  /** Two lines in the same face, as far as can be told: both evenly spaced or both not, and
   * strokes of about the same weight. Unknown is not the same. */
  const SAME_FACE = 0.7;
  function sameFace(a, b) {
    if (a.mono === null || b.mono === null || a.mono !== b.mono) return false;
    if (!a.stroke || !b.stroke || Math.abs(Math.log(a.stroke / b.stroke)) > 0.25) return false;
    return true;
  }
  function baselineAt(wd, x) {
    if (wd.base) { const [x0, y0, x1, y1] = wd.base; return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
    const bottoms = wd.syms.filter((s) => !DESC.test(s.c)).map((s) => s.box[3]);
    return bottoms.length ? median(bottoms) : wd.box[3];
  }

  /** The reader's box for each letter is where its model looked, not where the ink is: in a
   * proportional face it drifts by a few pixels. Each word's ink is split into its pieces (a dot
   * joins its stem, a colon its other half), and where there is one piece per letter the piece is
   * the letter's box. A word whose letters touch keeps the reader's boxes and is marked. */
  function refine(res, clean, w, h) {
    if (res._refined) return;
    res._refined = true;
    for (const l of res.lines) for (const wd of l.words) {
      const [bx0, by0, bx1, by1] = [Math.max(0, wd.box[0]), Math.max(0, wd.box[1]), Math.min(w, wd.box[2]), Math.min(h, wd.box[3])];
      const bw = bx1 - bx0, bh = by1 - by0;
      if (bw <= 0 || bh <= 0) { wd.touching = true; continue; }
      const lab = new Int32Array(bw * bh), comps = [];
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        if (lab[y * bw + x] || clean[(by0 + y) * w + bx0 + x] >= 150) continue;
        const id = comps.length + 1, st = [y * bw + x];
        lab[y * bw + x] = id;
        const c = { x0: x, y0: y, x1: x + 1, y1: y + 1, n: 0 };
        while (st.length) {
          const k = st.pop(), cx = k % bw, cy = (k - cx) / bw;
          c.n++; if (cx < c.x0) c.x0 = cx; if (cy < c.y0) c.y0 = cy; if (cx + 1 > c.x1) c.x1 = cx + 1; if (cy + 1 > c.y1) c.y1 = cy + 1;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx, yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
            const kk = yy * bw + xx;
            if (!lab[kk] && clean[(by0 + yy) * w + bx0 + xx] < 150) { lab[kk] = id; st.push(kk); }
          }
        }
        comps.push(c);
      }
      // what is left of a ruling line beside a word (a slanted photo leaves a few) is no letter,
      // unless the reader saw a letter of that shape there: an I, an l or a 1 in a sans face is a
      // bar the height of the word, and a hyphen a dash three pixels high
      const sawThere = (c, re) => wd.syms.some((sy) => re.test(sy.c) && Math.abs((sy.box[0] + sy.box[2]) / 2 - (bx0 + (c.x0 + c.x1) / 2)) <= Math.max(3, (c.x1 - c.x0) / 2 + 2));
      let parts = comps.filter((c) => c.n >= 3 && !((c.x1 - c.x0 >= 4 * (c.y1 - c.y0) && c.y1 - c.y0 <= 3 && !sawThere(c, /^[-‐‑‒–—_=~]$/)) || (c.y1 - c.y0 >= 4 * (c.x1 - c.x0) && c.x1 - c.x0 <= 3 && c.y1 - c.y0 > 0.8 * bh && !sawThere(c, /^[Il1|!i\]\[jtf]$/)))).sort((a, b) => a.x0 - b.x0);
      const merged = [];
      for (const c of parts) {
        const m = merged[merged.length - 1];
        if (m && Math.min(m.x1, c.x1) - Math.max(m.x0, c.x0) > 0.5 * Math.min(m.x1 - m.x0, c.x1 - c.x0)) { m.x0 = Math.min(m.x0, c.x0); m.y0 = Math.min(m.y0, c.y0); m.x1 = Math.max(m.x1, c.x1); m.y1 = Math.max(m.y1, c.y1); }
        else merged.push({ ...c });
      }
      parts = merged;
      const syms = wd.syms.filter((sy) => sy.c.trim());
      if (syms.length !== wd.syms.length || !syms.length) { wd.touching = true; continue; }
      let split = false;
      if (parts.length < syms.length) {
        // fewer pieces than letters (letters that touch, common at 200 dpi): a piece that holds
        // the centres of several of the reader's letters is cut at its faintest column near each
        // boundary the reader saw
        const out2 = [];
        for (const c of parts) {
          const inside = syms.filter((sy) => { const cx = (sy.box[0] + sy.box[2]) / 2 - bx0; return cx >= c.x0 && cx < c.x1; });
          if (inside.length < 2) { out2.push(c); continue; }
          const ink = (x) => { let n = 0; for (let y = c.y0; y < c.y1; y++) if (clean[(by0 + y) * w + bx0 + x] < 150) n++; return n; };
          let from = c.x0;
          for (let k = 1; k < inside.length; k++) {
            const guess = ((inside[k - 1].box[2] + inside[k].box[0]) / 2) - bx0, reach = Math.max(2, Math.round((inside[k].box[2] - inside[k].box[0]) * 0.35));
            let best = Math.round(guess), low = Infinity;
            for (let x = Math.max(from + 1, Math.round(guess) - reach); x <= Math.min(c.x1 - 2, Math.round(guess) + reach); x++) { const v = ink(x) + Math.abs(x - guess) * 0.15; if (v < low) { low = v; best = x; } }
            out2.push({ x0: from, y0: c.y0, x1: best, y1: c.y1 }); from = best;
          }
          out2.push({ x0: from, y0: c.y0, x1: c.x1, y1: c.y1 });
        }
        if (out2.length !== syms.length) { wd.touching = true; continue; }
        // each cut piece keeps only the rows its own columns ink
        for (const c of out2) {
          let y0 = c.y1, y1 = c.y0;
          for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (clean[(by0 + y) * w + bx0 + x] < 150) { if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1; break; }
          if (y1 > y0) { c.y0 = y0; c.y1 = y1; }
        }
        parts = out2; split = true;
      }
      if (parts.length !== syms.length) {
        // more pieces than letters (a letter broken in two by a thin scan): each piece goes to the
        // letter the reader saw nearest it, and the letters must come out in order, apart, whole
        const groups = syms.map(() => []);
        for (const c of parts) {
          const cx = bx0 + (c.x0 + c.x1) / 2;
          let best = 0, d = Infinity;
          syms.forEach((sy, k) => { const e = Math.abs((sy.box[0] + sy.box[2]) / 2 - cx); if (e < d) { d = e; best = k; } });
          groups[best].push(c);
        }
        // a letter's pieces sit close together; two letters given to one are apart
        if (groups.some((g) => !g.length || g.some((c, k) => k && c.x0 - g[k - 1].x1 > Math.max(1, 0.08 * bh)))) { wd.touching = true; continue; }
        parts = groups.map((g) => ({ x0: Math.min(...g.map((c) => c.x0)), y0: Math.min(...g.map((c) => c.y0)), x1: Math.max(...g.map((c) => c.x1)), y1: Math.max(...g.map((c) => c.y1)) }));
        if (parts.some((c, k) => k && c.x0 < parts[k - 1].x1)) { wd.touching = true; continue; }
      }
      // no single letter is wider than its line is tall (an M or a W is about as wide)
      if (parts.some((c, k) => c.x1 - c.x0 > 1.05 * bh && !/[MWmw@%]/.test(syms[k].c))) { wd.touching = true; continue; }
      // a letter cut from its neighbour is its own place on the line, but too rough a shape to
      // lend to another word
      syms.forEach((sy, k) => { const c = parts[k]; sy.box = [bx0 + c.x0, by0 + c.y0, bx0 + c.x1, by0 + c.y1]; sy.exact = true; sy.cut = split; });
    }
  }

  /** The letter shapes a page offers: every symbol read with confidence that stands clear of its
   * neighbours and of the form's lines. */
  /** How tall a word's capitals and figures stand: the middle of their boxes, or null for a word
   * of small letters only. */
  function wordCap(wd) {
    const hs = wd.syms.filter((sy) => /[A-Z0-9]/.test(sy.c) && sy.conf >= 60).map((sy) => sy.box[3] - sy.box[1]).sort((a, b) => a - b);
    return hs.length ? hs[hs.length >> 1] : null;
  }
  /** The size a letter is drawn at: its word's, where the word stands clearly taller or shorter
   * than its line (a card prints a value beside its small label on one line), else its line's. */
  const sizeOf = (wcap, lineCap) => (wcap && Math.abs(Math.log(wcap / lineCap)) > 0.15 ? wcap : lineCap);
  function onDark(wd, gray, w) {
    if (wd._onDark !== undefined) return wd._onDark;
    const [x0, y0, x1, y1] = wd.box, h = gray.length / w, ring = [];
    const at = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) ring.push(gray[y * w + x]); };
    for (let x = x0 - 3; x < x1 + 3; x++) { at(x, y0 - 3); at(x, y1 + 2); }
    for (let y = y0; y < y1; y++) { at(x0 - 3, y); at(x1 + 2, y); }
    return (wd._onDark = ring.length > 0 && ring.sort((a, b) => a - b)[ring.length >> 1] < 128);
  }
  function bank(res, prep, w) {
    if (res._bank) return res._bank;
    const out = new Map();
    const metrics = lineMetrics(res, prep.clean, w);
    res.lines.forEach((l, li) => l.words.forEach((wd, wi) => wd.syms.forEach((sy, si) => {
      if (!sy.exact || sy.cut || sy.conf < 80 || [...sy.c].length !== 1 || !/[\p{L}\p{N}&@#$%()\-.,/'’]/u.test(sy.c)) return;
      const [x0, y0, x1, y1] = sy.box;
      if (x1 - x0 < 2 || y1 - y0 < 3) return;
      const prev = wd.syms[si - 1], next = wd.syms[si + 1];
      if ((prev && prev.box[2] > x0) || (next && next.box[0] < x1)) return;
      let onLine = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) onLine += prep.mask[y * w + x];
      if (onLine > 0.03 * (x1 - x0) * (y1 - y0)) return;
      // a word printed light on a dark band ("ARIZONA" in white on a card's red header) has no
      // shapes of ink to borrow: the ground three pixels around the word, as scanned, has to be
      // light (around one letter is not enough: the reader can take a piece of a white letter for
      // a letter of its own)
      if (prep.gray && onDark(wd, prep.gray, w)) return;
      if (!out.has(sy.c)) out.set(sy.c, []);
      out.get(sy.c).push({ li, wi, si, cap: metrics[li].cap, size: sizeOf(wordCap(wd), metrics[li].cap), conf: sy.conf });
    })));
    res._bank = out;
    return out;
  }

  /** A glyph cut from the page: its coverage (0..1) per pixel against the paper under it. */
  function cutGlyph(img, prep, res, ref) {
    const wd = res.lines[ref.li].words[ref.wi], sy = wd.syms[ref.si];
    const W = img.w, [x0, y0, x1, y1] = sy.box;
    const bx0 = Math.max(0, x0 - 1), by0 = Math.max(0, y0 - 1), bx1 = Math.min(W, x1 + 1), by1 = Math.min(img.h, y1 + 1);
    const gw = bx1 - bx0, gh = by1 - by0, alpha = new Float32Array(gw * gh);
    // the ink is the cores of the strokes (the darkest sixth of what is drawn), not the single
    // darkest pixel, or the letter comes out lighter than the ones around it
    const vals = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4, v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) >> 8; if (v < prep.bg[y * W + x] - 40) vals.push(v); }
    vals.sort((a, b) => a - b);
    const core = vals.slice(0, Math.max(1, Math.ceil(vals.length / 6)));
    const ink = core.length ? core.reduce((a, b) => a + b, 0) / core.length : 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const i = (y * W + x) * 4, v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) >> 8, p = prep.bg[y * W + x];
      let a = p - ink > 20 ? (p - v) / (p - ink) : 0;
      if (prep.mask[y * W + x]) a = 0;
      alpha[(y - by0) * gw + (x - bx0)] = Math.max(0, Math.min(1, a));
    }
    // the pixel round the box is the letter's soft edge only where the letter is right beside it,
    // never a neighbour's ink
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      if (!(x < x0 || x >= x1 || y < y0 || y >= y1)) continue;
      const ix = Math.min(x1 - 1, Math.max(x0, x)), iy = Math.min(y1 - 1, Math.max(y0, y));
      const k = (y - by0) * gw + (x - bx0), inner = alpha[(iy - by0) * gw + (ix - bx0)];
      alpha[k] = inner > 0.5 ? Math.min(alpha[k], inner) * 0.6 : 0;
    }
    return { w: gw, h: gh, alpha, base: baselineAt(wd, (x0 + x1) / 2) - by0, cap: lineMetrics(res)[ref.li].cap };
  }
  function scaleGlyph(g, s) {
    if (Math.abs(s - 1) < 0.03) return g;
    const nw = Math.max(1, Math.round(g.w * s)), nh = Math.max(1, Math.round(g.h * s)), a = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const sx = Math.min(g.w - 1.001, Math.max(0, (x + 0.5) / s - 0.5)), sy = Math.min(g.h - 1.001, Math.max(0, (y + 0.5) / s - 0.5));
      const ix = Math.floor(sx), iy = Math.floor(sy), dx = sx - ix, dy = sy - iy, q = (xx, yy) => g.alpha[Math.min(g.h - 1, yy) * g.w + Math.min(g.w - 1, xx)];
      a[y * nw + x] = (q(ix, iy) * (1 - dx) + q(ix + 1, iy) * dx) * (1 - dy) + (q(ix, iy + 1) * (1 - dx) + q(ix + 1, iy + 1) * dx) * dy;
    }
    return { w: nw, h: nh, alpha: a, base: g.base * s, cap: g.cap * s };
  }

  /** The colour of the ink in a stretch of the original, and of the paper around it. */
  function inkOf(img, prep, boxes) {
    let r = 0, g = 0, b = 0, n = 0;
    for (const [x0, y0, x1, y1] of boxes) {
      let lo = 255;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.w + x) * 4, v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) >> 8; if (v < lo) lo = v; }
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.w + x) * 4, v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) >> 8;
        if (prep.mask[y * img.w + x] || v > lo + 18) continue;
        r += img.orig[i]; g += img.orig[i + 1]; b += img.orig[i + 2]; n++;
      }
    }
    return n ? [r / n, g / n, b / n] : [20, 20, 20];
  }

  /** Paper painted over a box: each column blended from the paper just above to just below,
   * with the grain of the paper around it, and the form's own lines left as they are. */
  function erase(img, prep, box, rand) {
    const W = img.w, H = img.h, [x0, y0, x1, y1] = box, d = img.data;
    const sample = (x, y, dir) => {
      for (let k = 1; k <= 6; k++) {
        const yy = y + dir * k;
        if (yy < 0 || yy >= H) break;
        const i = (yy * W + x) * 4, v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) >> 8;
        if (!prep.mask[yy * W + x] && v >= prep.bg[yy * W + x] - 30) return [img.orig[i], img.orig[i + 1], img.orig[i + 2]];
      }
      const p = prep.bg[Math.max(0, Math.min(H - 1, y)) * W + x];
      return [p, p, p];
    };
    let s = 0, ss = 0, n = 0;
    for (let x = x0; x < x1; x += 2) for (const y of [y0 - 2, y1 + 1]) {
      if (y < 0 || y >= H) continue;
      const i = (y * W + x) * 4, v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) >> 8;
      if (prep.mask[y * W + x] || v < prep.bg[y * W + x] - 30) continue;
      s += v; ss += v * v; n++;
    }
    const grain = n > 4 ? Math.min(12, Math.sqrt(Math.max(0, ss / n - (s / n) ** 2))) : 0;
    // the paper above and below, averaged over a few columns, so one dark pixel beside a line
    // does not run down the patch as a streak
    const tops = [], bots = [];
    for (let x = x0; x < x1; x++) { tops.push(sample(x, y0, -1)); bots.push(sample(x, y1 - 1, 1)); }
    const smooth = (arr, k) => { const out = []; for (let i = 0; i < arr.length; i++) { const c = [0, 0, 0]; let m = 0; for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { c[0] += arr[j][0]; c[1] += arr[j][1]; c[2] += arr[j][2]; m++; } out.push([c[0] / m, c[1] / m, c[2] / m]); } return out; };
    const T = smooth(tops, 3), B = smooth(bots, 3);
    for (let x = x0; x < x1; x++) {
      const top = T[x - x0], bot = B[x - x0];
      for (let y = y0; y < y1; y++) {
        if (prep.mask[y * W + x]) continue;
        const t = y1 - y0 > 1 ? (y - y0) / (y1 - y0 - 1) : 0.5, i = (y * W + x) * 4;
        const z = grain ? grain * gauss(rand) : 0;
        for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, top[c] * (1 - t) + bot[c] * t + z));
      }
    }
  }
  /** Writing nobody can read taken off the page. Marks on one line within a mark's height of each
   * other are one place (a signature the reader cut into several "words"), every stroke that
   * touches the place is followed to its end, and only those strokes and their soft edge are
   * painted over, each pixel with the paper around it (its shading, and its grain), so no blank
   * box and no streak is left. Print the page's own read is sure of, the stand-ins just painted
   * and the form's lines are left as they are. Returns the box each place covers. */
  function eraseWriting(img, prep, res, marks, keep, dpi, rand) {
    const W = img.w, H = img.h;
    let groups = marks.map((b) => b.slice());
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < groups.length && !merged; i++) for (let j = i + 1; j < groups.length && !merged; j++) {
        const a = groups[i], b = groups[j], hgt = Math.max(a[3] - a[1], b[3] - b[1]);
        if (Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0 && b[0] - a[2] < 1.5 * hgt && a[0] - b[2] < 1.5 * hgt) {
          groups[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
          groups.splice(j, 1); merged = true;
        }
      }
    }
    const heights = res.lines.flatMap((l) => l.words.map((wd) => wd.box[3] - wd.box[1])).sort((a, b) => a - b);
    const typical = heights.length ? heights[heights.length >> 1] : dpi * 0.1;
    const print = res.lines.flatMap((l) => l.words).filter((wd) => wd.conf >= 85 && wd.box[3] - wd.box[1] <= 1.3 * typical && wd.syms.filter((sy) => /[A-Za-z0-9]/.test(sy.c)).length >= 3).map((wd) => wd.box);
    const kept = new Uint8Array(W * H);
    for (const [x0, y0, x1, y1] of print.concat(keep)) for (let y = Math.max(0, y0 - 1); y < Math.min(H, y1 + 1); y++) kept.fill(1, y * W + Math.max(0, x0 - 1), y * W + Math.min(W, x1 + 1));
    const dark = (k) => prep.clean[k] < 140 && !kept[k];
    const gone = new Uint8Array(W * H), out = [];
    const grow = Math.max(2, Math.round(dpi / 100));
    for (const g of groups) {
      // the strokes: all ink inside the place, and what it runs into, within half its height
      const reach = Math.max(Math.round((g[3] - g[1]) * 0.5), Math.round(dpi * 0.1));
      const lim = [Math.max(0, g[0] - reach), Math.max(0, g[1] - reach), Math.min(W, g[2] + reach), Math.min(H, g[3] + reach)];
      const stack = [];
      const S = new Uint8Array(W * H);
      let bx0 = g[0], by0 = g[1], bx1 = g[2], by1 = g[3];
      for (let y = Math.max(0, g[1]); y < Math.min(H, g[3]); y++) for (let x = Math.max(0, g[0]); x < Math.min(W, g[2]); x++) { const k = y * W + x; if (dark(k)) { S[k] = 1; stack.push(k); } }
      while (stack.length) {
        const k = stack.pop(), x = k % W, y = (k - x) / W;
        if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x + 1 > bx1) bx1 = x + 1; if (y + 1 > by1) by1 = y + 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < lim[0] || yy < lim[1] || xx >= lim[2] || yy >= lim[3]) continue;
          const kk = yy * W + xx;
          if (!S[kk] && dark(kk)) { S[kk] = 1; stack.push(kk); }
        }
      }
      // and the stroke's soft edge
      for (let y = Math.max(0, by0 - grow); y < Math.min(H, by1 + grow); y++) for (let x = Math.max(0, bx0 - grow); x < Math.min(W, bx1 + grow); x++) {
        const k = y * W + x;
        if (!S[k]) continue;
        for (let dy = -grow; dy <= grow; dy++) for (let dx = -grow; dx <= grow; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const kk = yy * W + xx;
          if (!kept[kk] && !prep.mask[kk]) gone[kk] = 1;
        }
      }
      out.push([Math.max(0, Math.min(g[0], bx0) - grow - 1), Math.max(0, Math.min(g[1], by0) - grow - 1), Math.min(W, Math.max(g[2], bx1) + grow + 1), Math.min(H, Math.max(g[3], by1) + grow + 1)]);
    }
    // each pixel taken off is the average of the paper within a small window around it (a wider
    // one where the stroke is thick), with the paper's own grain added back
    const r0 = Math.max(6, Math.round(dpi / 25)), far = r0 * 4;
    for (const b of out) {
      const X0 = Math.max(0, b[0] - far), Y0 = Math.max(0, b[1] - far), X1 = Math.min(W, b[2] + far), Y1 = Math.min(H, b[3] + far), RW = X1 - X0 + 1;
      const sums = [0, 1, 2, 3, 4].map(() => new Float64Array(RW * (Y1 - Y0 + 1)));
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
        const k = y * W + x, i = k * 4, at = (y - Y0 + 1) * RW + (x - X0 + 1);
        const paperHere = !gone[k] && !prep.mask[k] && prep.clean[k] >= 200;
        const v = (img.orig[i] * 77 + img.orig[i + 1] * 150 + img.orig[i + 2] * 29) / 256;
        const add = paperHere ? [1, img.orig[i], img.orig[i + 1], img.orig[i + 2], v * v] : [0, 0, 0, 0, 0];
        for (let c = 0; c < 5; c++) sums[c][at] = add[c] + sums[c][at - 1] + sums[c][at - RW] - sums[c][at - RW - 1];
      }
      const box = (c, x0, y0, x1, y1) => { const s = sums[c]; return s[(y1 - Y0) * RW + (x1 - X0)] - s[(y0 - Y0) * RW + (x1 - X0)] - s[(y1 - Y0) * RW + (x0 - X0)] + s[(y0 - Y0) * RW + (x0 - X0)]; };
      for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) {
        const k = y * W + x;
        if (!gone[k]) continue;
        gone[k] = 2;
        for (let r = r0; r <= far; r *= 2) {
          const x0 = Math.max(X0, x - r), y0 = Math.max(Y0, y - r), x1 = Math.min(X1, x + r + 1), y1 = Math.min(Y1, y + r + 1);
          const n = box(0, x0, y0, x1, y1);
          if (n < 6 && r * 2 <= far) continue;
          if (!n) break;
          const R = box(1, x0, y0, x1, y1) / n, G = box(2, x0, y0, x1, y1) / n, B = box(3, x0, y0, x1, y1) / n;
          const lum = (R * 77 + G * 150 + B * 29) / 256, sd = Math.min(12, Math.sqrt(Math.max(0, box(4, x0, y0, x1, y1) / n - lum * lum)));
          const z = sd * gauss(rand), i = k * 4;
          img.data[i] = Math.max(0, Math.min(255, R + z)); img.data[i + 1] = Math.max(0, Math.min(255, G + z)); img.data[i + 2] = Math.max(0, Math.min(255, B + z));
          break;
        }
      }
    }
    return out;
  }
  function gauss(rand) { const u = rand() || 1e-9, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function stamp(img, prep, g, gx, gy, ink) {
    const W = img.w, H = img.h, d = img.data;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const a = g.alpha[y * g.w + x];
      if (a <= 0.02) continue;
      const px = gx + x, py = gy + y;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = (py * W + px) * 4;
      for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (ink[c] - d[i + c]) * a;
    }
  }

  /** Paint every found value over with its stand-in. img is { w, h, data (RGBA, edited in
   * place), orig (RGBA, as it came) }. renderGlyph(ch, cap, sample) draws a letter the page
   * does not offer, in a font chosen to look like the sample of the line's own letters. */
  function paint(img, res, found, { dpi = 300, bilevel = false, renderGlyph = null, fontFirst = null, cover = null } = {}) {
    const prep = img.prep || (img.prep = prepare(toGray(img.orig, img.w * img.h), img.w, img.h, dpi));
    refine(res, prep.clean, img.w, img.h);
    const metrics = lineMetrics(res, prep.clean, img.w), lib = bank(res, prep, img.w);
    const rand = seeded(img.w * 31 + img.h);
    const edits = [], problems = [];
    const shapes = new Map();
    // the face is judged on the line's own whole letters (one cut from its neighbour is not its
    // true shape), letters before figures, which look alike in most faces
    const sampleOf = (li) => {
      const pool2 = [];
      for (const wd of res.lines[li].words) for (const sy of wd.syms) if (sy.exact && sy.conf >= 80 && /[A-Za-z0-9]/.test(sy.c)) pool2.push({ c: sy.c, box: sy.box, whole: !sy.cut, letter: /[A-Za-z]/.test(sy.c) });
      pool2.sort((p, q) => (q.whole - p.whole) || (q.letter - p.letter));
      return pool2.slice(0, 8);
    };
    // another line lends a letter only when it is in the same face: by the font matcher where
    // there is one (it tells serif from sans), by spacing and weight where there is not
    // two lines are in one face when the letters they share look alike, pixel for pixel, once
    // scaled to one size: the plainest evidence there is (at a small size a serif can hide)
    const whole = (li) => { const m = new Map(); for (const wd of res.lines[li].words) for (const sy of wd.syms) if (sy.exact && !sy.cut && sy.conf >= 85 && /[A-Za-z0-9]/.test(sy.c) && !m.has(sy.c)) m.set(sy.c, sy.box); return m; };
    const shapeOf = (box, n) => {
      const [x0, y0, x1, y1] = box, out = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = prep.clean[Math.min(y1 - 1, y0 + Math.floor(((y + 0.5) * (y1 - y0)) / n)) * img.w + Math.min(x1 - 1, x0 + Math.floor(((x + 0.5) * (x1 - x0)) / n))] < 150 ? 1 : 0;
      return out;
    };
    const agree = new Map();
    const shared = (a, b) => {
      const key = a < b ? a + ":" + b : b + ":" + a;
      if (agree.has(key)) return agree.get(key);
      const A = whole(a), B = whole(b), scores = [];
      for (const [c, box] of A) if (B.has(c) && scores.length < 6) {
        const p = shapeOf(box, 16), q = shapeOf(B.get(c), 16);
        let both = 0, either = 0; for (let i = 0; i < p.length; i++) { both += p[i] & q[i]; either += p[i] | q[i]; }
        const ra = (box[2] - box[0]) / (box[3] - box[1]), rb = (B.get(c)[2] - B.get(c)[0]) / (B.get(c)[3] - B.get(c)[1]);
        scores.push((either ? both / either : 0) - Math.abs(Math.log(ra / rb)));
      }
      const v = scores.length >= 2 ? median(scores) : 0;
      agree.set(key, v);
      return v;
    };
    const faceAgrees = (a, b) => a === b || (sameFace(metrics[a], metrics[b]) && shared(a, b) >= SAME_FACE);
    let preferFont = false;
    const glyphFor = (ch, li, wcap = null) => {
      const cap = sizeOf(wcap, metrics[li].cap), key = ch + "@" + li + "@" + Math.round(cap) + (preferFont ? "@font" : "");
      if (shapes.has(key)) return shapes.get(key);
      let g = null;
      if (preferFont && renderGlyph) { g = renderGlyph(ch, cap, sampleOf(li), li); if (g) { g.from = "font"; shapes.set(key, g); return g; } }
      // the same line first, then a line in the same face and about the same size; a letter from
      // another face is used only when nothing can draw it in this one
      const all = (lib.get(ch) || []).filter((c) => Math.abs(Math.log(c.size / cap)) < 0.3);
      const order = (a, b) => (a.li === li ? 0 : 1) - (b.li === li ? 0 : 1) || Math.abs(Math.log(a.size / cap)) - Math.abs(Math.log(b.size / cap)) || b.conf - a.conf;
      const alike = all.filter((c) => faceAgrees(c.li, li)).sort(order);
      const pick = alike[0] || (!renderGlyph ? all.sort(order)[0] : null);
      if (pick) { const src = cutGlyph(img, prep, res, pick); g = scaleGlyph(src, cap / pick.size); g.from = "page"; g.line = pick.li; }
      else if (renderGlyph) {
        g = renderGlyph(ch, cap, sampleOf(li), li);
        if (g) g.from = "font";
      }
      shapes.set(key, g);
      return g;
    };
    // what is blanked out goes first, so lifting it off the paper never clips a stand-in drawn
    // beside it
    const order = cover ? [...found].sort((a, b) => cover.has(b.row.id) - cover.has(a.row.id)) : found;
    for (const occ of order) {
      const { line, s, e, row } = occ;
      // a value that did not read back the first time is drawn in the matching font throughout
      preferFont = !!(fontFirst && fontFirst.has(row.id));
      const L = res.lines[line.li], find = line.text.slice(s, e), rep = row.replace;
      const symAt = (k) => line.map[s + k];
      // a value that could not be drawn in its stand-in either way is lifted off the paper and
      // left blank: the file still comes back, with nothing of the value in it. Where its letters
      // touch the letters around them, the words it sits in go with it
      if (cover && cover.has(row.id)) {
        const qs = [];
        for (let k = 0; k < find.length; k++) if (symAt(k) >= 0) qs.push(line.syms[symAt(k)]);
        if (!qs.length) { problems.push({ occ, why: "it could not be found on the picture to blank out" }); continue; }
        const loose = qs.some((q) => { const sy = L.words[q.wi].syms[q.si]; return !sy.exact || sy.cut; });
        const bs = loose ? [...new Set(qs.map((q) => q.wi))].map((wi) => L.words[wi].box) : qs.map((q) => L.words[q.wi].syms[q.si].box);
        const er = [Math.max(0, Math.min(...bs.map((b) => b[0])) - 2), Math.max(0, Math.min(...bs.map((b) => b[1])) - 1), Math.min(img.w, Math.max(...bs.map((b) => b[2])) + 2), Math.min(img.h, Math.max(...bs.map((b) => b[3])) + 1)];
        erase(img, prep, er, rand);
        edits.push({ occ, boxes: [er], words: [], span: er, text: "", covered: true });
        continue;
      }
      // the stand-in is read in words; where it has as many words as the original, each word is
      // painted over its own word, otherwise the whole value is laid out again across its width
      const segs = [];
      const fw = find.split(" "), rw = rep.split(" ");
      const sameGaps = fw.length === rw.length;
      if (sameGaps) {
        let k = 0;
        fw.forEach((w, n) => { if (w) segs.push([k, k + w.length, rw[n]]); k += w.length + 1; });
      } else segs.push([0, find.length, rep]);
      // everything is worked out first and painted only when every letter of the value can be:
      // a value half painted would leave a change no check expects
      const boxes = [], ops = [], words = [];
      let failed = "";
      for (const [a, b, neuWord] of segs) {
        // one cell per character: what it was, what it becomes, the symbol it is drawn as; a
        // shorter stand-in leaves old letters with nothing in their place (taken out), a longer one
        // new letters with no old symbol
        let cells = [];
        const neuChars = [...neuWord];
        for (let k = 0; k < Math.max(b - a, neuChars.length); k++) {
          const q = k < b - a && symAt(a + k) >= 0 ? line.syms[symAt(a + k)] : null;
          cells.push({ orig: k < b - a ? find[a + k] : null, neu: k < neuChars.length ? neuChars[k] : null, q, gone: k >= neuChars.length, added: k >= b - a });
        }
        if (!cells.some((c) => c.orig !== c.neu)) continue;
        const symOf = (c) => c.q && L.words[c.q.wi].syms[c.q.si];
        const wis = [...new Set(cells.filter((c) => c.q).map((c) => c.q.wi))];
        if (!wis.length) continue;
        // letters that touch carry only rough boxes, so their word is taken out whole: the rest of
        // the word (the comma after a name) is drawn again as it was
        const loose = cells.some((c) => c.q && (!symOf(c).exact || symOf(c).cut));
        if (loose && wis.length === 1) {
          const W2 = L.words[wis[0]], inSeg = new Set(cells.filter((c) => c.q).map((c) => c.q.si)), first = Math.min(...inSeg);
          const pre = [], post = [];
          W2.syms.forEach((sy, si) => { if (!inSeg.has(si)) (si < first ? pre : post).push({ orig: sy.c, neu: sy.c, q: { wi: wis[0], si } }); });
          cells = pre.concat(cells, post);
        } else if (loose && wis.some((wi) => L.words[wi].syms.length !== cells.filter((c) => c.q && c.q.wi === wi).length)) { failed = "the letters of this value touch the letters around it, so it cannot be painted over cleanly"; break; }
        else if (!loose) {
          // what follows the value in its word (a full stop, a comma) moves with it, so a wider
          // stand-in never runs over it and a narrower one leaves no gap before it
          const W2 = L.words[wis[wis.length - 1]], last = Math.max(...cells.filter((c) => c.q && c.q.wi === wis[wis.length - 1]).map((c) => c.q.si));
          for (let si = last + 1; si < W2.syms.length; si++) cells.push({ orig: W2.syms[si].c, neu: W2.syms[si].c, q: { wi: wis[wis.length - 1], si }, tail: true });
        }
        const syms = cells.filter((c) => c.q).map((c) => c.q);
        const symBox = (q) => L.words[q.wi].syms[q.si].box;
        const wd = L.words[syms[0].wi];
        const sx0 = Math.min(...syms.map((q) => symBox(q)[0])), sx1 = Math.max(...syms.map((q) => symBox(q)[2]));
        const sy0 = Math.min(...syms.map((q) => symBox(q)[1])), sy1 = Math.max(...syms.map((q) => symBox(q)[3]));
        words.push({ text: cells.filter((c) => !c.tail).map((c) => c.neu).join("").trim(), box: [sx0, sy0, sx1, sy1] });
        const ink = inkOf(img, prep, syms.map(symBox));
        // a letter that stays is its own picture, unless it had to be cut from its neighbour (no
        // clean picture of itself); a new one comes from the page or a font
        const own = (c) => { const sy = symOf(c); return sy && sy.exact && !sy.cut && sy.c === c.orig ? sy : null; };
        const sameLength = !cells.some((c) => c.gone || c.added);
        // only the letters drawn: one taken out is erased with the rest and drawn as nothing
        cells = cells.filter((c) => !c.gone);
        const glyphs = [];
        // the size of the word being replaced, where it is not its line's
        const tcap = wordCap({ syms: cells.filter((c) => c.q).map(symOf) });
        for (const c of cells) {
          if (c.neu === " ") { glyphs.push(null); continue; }
          const g = c.neu === c.orig && own(c) ? cutGlyph(img, prep, res, { li: line.li, wi: c.q.wi, si: c.q.si }) : glyphFor(c.neu, line.li, tcap);
          if (!g) { failed = "no letter shape for '" + c.neu + "' on this page and no font to draw it"; break; }
          glyphs.push(g);
        }
        if (failed) break;
        const changed = cells.map((c, k) => k).filter((k) => cells[k].orig !== cells[k].neu);
        // slot by slot when every letter stands clear and each new one is about as wide as the one
        // it replaces (a typewriter face, figures): the letters around it are not touched
        let slot = sameGaps && sameLength && !loose && cells.every((c) => own(c) || (c.q && symOf(c).exact && !symOf(c).cut && symOf(c).c === c.orig));
        if (slot) for (const k of changed) {
          const bx = symBox(cells[k].q), g = glyphs[k];
          if (Math.abs(g.w - 2 - (bx[2] - bx[0])) <= Math.max(2, 0.18 * (bx[2] - bx[0]))) continue;
          // figures are set in slots of one width (a 1 is narrow, its slot is not): a figure for a
          // figure sits on the old one's centre, as long as it stays clear of its neighbours
          if (/\d/.test(cells[k].orig) && /\d/.test(cells[k].neu)) {
            const W4 = L.words[cells[k].q.wi], si = cells[k].q.si, cx = (bx[0] + bx[2]) / 2;
            const prev = W4.syms[si - 1], next = W4.syms[si + 1];
            const changedAt = (sy) => cells.some((c, j) => changed.includes(j) && c.q && L.words[c.q.wi].syms[c.q.si] === sy);
            const lo = prev ? (changedAt(prev) ? ((prev.box[0] + prev.box[2]) / 2 + cx) / 2 : prev.box[2] + 1) : bx[0] - metrics[line.li].cap * 0.3;
            const hi = next ? (changedAt(next) ? ((next.box[0] + next.box[2]) / 2 + cx) / 2 : next.box[0] - 1) : bx[2] + metrics[line.li].cap * 0.3;
            if (cx - (g.w - 2) / 2 >= lo && cx + (g.w - 2) / 2 <= hi) continue;
          }
          slot = false; break;
        }
        if (slot) {
          for (const k of changed) {
            const bx = symBox(cells[k].q), g = glyphs[k];
            const er = [Math.max(0, bx[0] - 1), Math.max(0, bx[1] - 1), Math.min(img.w, bx[2] + 1), Math.min(img.h, bx[3] + 1)];
            const cx = (bx[0] + bx[2]) / 2, base = baselineAt(wd, cx);
            const gx = Math.round(cx - g.w / 2), gy = Math.round(base - g.base);
            ops.push(() => { erase(img, prep, er, rand); stamp(img, prep, g, gx, gy, ink); });
            boxes.push([Math.min(er[0], gx), Math.min(er[1], gy), Math.max(er[2], gx + g.w), Math.max(er[3], gy + g.h)]);
          }
          continue;
        }
        const er = loose
          ? [Math.max(0, Math.min(sx0, wd.box[0]) - 2), Math.max(0, Math.min(sy0, wd.box[1]) - 1), Math.min(img.w, Math.max(sx1, wd.box[2]) + 2), Math.min(img.h, Math.max(sy1, wd.box[3]) + 1)]
          : [Math.max(0, sx0 - 1), Math.max(0, sy0 - 1), Math.min(img.w, sx1 + 1), Math.min(img.h, sy1 + 1)];
        // a typewriter face: every letter in its own slot, the word's width shared evenly among its
        // letters (the reader's own letter boxes drift where letters touch; a typewriter's do not)
        const pitch = (metrics[line.li].mono === true || evenlySpaced(L)) && cells.every((c) => c.q && c.neu !== " ") && wis.length === 1;
        if (pitch) {
          const placed = [], W3 = L.words[wis[0]], step = (W3.box[2] - W3.box[0]) / W3.syms.length;
          let bb = er.slice();
          cells.forEach((c, k) => {
            const g = glyphs[k], cx = W3.box[0] + (c.q.si + 0.5) * step, base = baselineAt(wd, cx);
            const gx = Math.round(cx - g.w / 2), gy = Math.round(base - g.base);
            placed.push([g, gx, gy]);
            bb = [Math.min(bb[0], gx), Math.min(bb[1], gy), Math.max(bb[2], gx + g.w), Math.max(bb[3], gy + g.h)];
          });
          ops.push(() => { erase(img, prep, er, rand); for (const [g, gx, gy] of placed) stamp(img, prep, g, gx, gy, ink); });
          boxes.push(bb);
          continue;
        }
        // laid out again: the letters at their own widths, each pair as far apart as the line's own
        // letters are, judged the way the eye judges it (row by row across the capitals, so an A
        // after an F sits in under its arm), stretched a little or squeezed a little to fill the
        // old width, the rest left after the end
        // (only the paper near a letter's edge counts, a sixth of its height deep, as a type
        // designer spaces a face: the open side of an L is not a gap)
        const cap = metrics[line.li].cap, band = Math.max(4, Math.round(cap)), clip = Math.max(1, cap * 0.16);
        const gaps = [], seen = [], pairs = new Map();
        // the line's own spacing, from letters that stand apart (letters cut from each other
        // touch, and would set every gap to nothing); a pair of letters the page itself sets side
        // by side, in this face, is set as the page sets it
        res.lines.forEach((l2, li2) => {
          if (li2 !== line.li && !faceAgrees(li2, line.li)) return;
          const scale = cap / metrics[li2].cap;
          for (const w2 of l2.words) for (let q = 1; q < w2.syms.length; q++) {
            const A = w2.syms[q - 1], B = w2.syms[q];
            if (!(A.exact && B.exact && !A.cut && !B.cut)) continue;
            if (Math.abs(Math.log(scale)) < 0.3) { const k2 = A.c + B.c; if (!pairs.has(k2)) pairs.set(k2, []); pairs.get(k2).push((B.box[0] - A.box[2]) * scale); }
            if (li2 !== line.li) continue;
            gaps.push(B.box[0] - A.box[2]);
            const base = baselineAt(w2, (A.box[2] + B.box[0]) / 2);
            seen.push(B.box[0] - A.box[2] + between(sidesOfBox(prep.clean, img.w, A.box, base, band), sidesOfBox(prep.clean, img.w, B.box, base, band), clip).side);
          }
        });
        const gap = gaps.length >= 3 ? Math.max(1, median(gaps)) : Math.max(1, Math.round(cap * 0.1));
        const optical = seen.length >= 3 ? median(seen) : null;
        const wordGaps = [];
        for (let q = 1; q < L.words.length; q++) wordGaps.push(L.words[q].box[0] - L.words[q - 1].box[2]);
        const space = Math.max(gap * 2, median(wordGaps.filter((g2) => g2 < cap * 2)) || cap * 0.6);
        const n = glyphs.length, inner = glyphs.reduce((t, g) => t + (g ? g.w - 2 : space), 0);
        // the distance before each letter, and the least it can be (a pixel of paper in every row)
        const sides = glyphs.map((g) => (g ? sidesOfGlyph(g, band) : null));
        const { rsb, lsb } = bearings(pairs);
        const want = [0], least = [0];
        for (let k = 1; k < n; k++) {
          if (!glyphs[k] || !glyphs[k - 1]) { want.push(gap); least.push(Math.min(gap, 1)); continue; }
          const b2 = between(sides[k - 1], sides[k], clip), a2 = cells[k - 1].neu, b3 = cells[k].neu, own = pairs.get(a2 + b3);
          // a pair the page never sets: the paper the first letter leaves after it and the second
          // before it, each worked out from every pair the page does set
          want.push(own ? Math.round(median(own)) : rsb.has(a2) && lsb.has(b3) ? Math.round(rsb.get(a2) + lsb.get(b3)) : optical === null ? gap : Math.round(optical - b2.side));
          least.push(Number.isFinite(b2.min) ? 1 - b2.min : -Infinity);
        }
        for (let k = 1; k < n; k++) want[k] = Math.max(want[k], least[k]);
        // a wider stand-in may take the empty paper after the word, up to a word's gap before the
        // next ink or ruling line; past that it is squeezed a little, and never into the next word
        const natural = inner + want.reduce((t, v) => t + v, 0);
        let target = sx1 - sx0;
        if (natural > target) {
          let x = sx1 + 1;
          const far = Math.min(img.w - 1, sx1 + Math.ceil(natural - target) + Math.ceil(space * 2));
          scan: for (; x < far; x++) for (let y = Math.max(0, sy0 - 1); y < Math.min(img.h, sy1 + 1); y++) if (prep.mask[y * img.w + x] || prep.clean[y * img.w + x] < 150) break scan;
          target = Math.max(target, Math.min(natural, x - Math.max(gap * 2, space * 0.9) - sx0));
        }
        // a narrower one keeps its own spacing: opened up to fill the old width it would read as
        // letters with gaps between them, and the space after it as no space
        let adj = n > 1 ? (target - natural) / (n - 1) : 0, squeeze = 1;
        if (adj > 0) adj = 0;
        // squeezed at most a fifth, the gaps closed by half the line's gap at most: past that it
        // would not read, and the read-back would refuse it anyway
        if (adj < -gap * 0.5) { adj = -gap * 0.5; squeeze = Math.max(0.8, (target - want.reduce((t, v) => t + v, 0) - adj * (n - 1)) / inner); }
        const step = want.map((v, k) => (k ? Math.max(least[k], v + adj) : 0));
        if (inner * squeeze + step.reduce((t, v) => t + v, 0) > target + Math.max(2, gap)) { failed = "the stand-in is wider than the space it is printed in; press New in step 2 for another"; break; }
        let x = sx0, bb = er.slice();
        const placed = [];
        glyphs.forEach((g, k) => {
          x += step[k];
          if (!g) { x += space * squeeze; return; }
          const gg = squeeze < 0.99 ? squeezeX(g, squeeze) : g;
          const base = baselineAt(wd, x + gg.w / 2);
          const gx = Math.round(x - 1), gy = Math.round(base - gg.base);
          placed.push([gg, gx, gy]);
          bb = [Math.min(bb[0], gx), Math.min(bb[1], gy), Math.max(bb[2], gx + gg.w), Math.max(bb[3], gy + gg.h)];
          x += gg.w - 2;
        });
        ops.push(() => { erase(img, prep, er, rand); for (const [gg, gx, gy] of placed) stamp(img, prep, gg, gx, gy, ink); });
        boxes.push(bb);
      }
      if (!failed) for (const op of ops) op();
      // the whole value, painted or kept, is what is read back
      const all = [];
      for (let k = 0; k < find.length; k++) if (symAt(k) >= 0) { const q = line.syms[symAt(k)]; all.push(L.words[q.wi].syms[q.si].box); }
      const span = all.length ? [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))] : null;
      if (failed) problems.push({ occ, why: failed });
      else if (boxes.length) edits.push({ occ, boxes, words, span: boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], span), text: rep });
    }
    if (bilevel) for (let i = 0; i < img.data.length; i += 4) { const v = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8 < 128 ? 0 : 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
    return { edits, problems };
  }
  /** The paper each letter leaves before and after itself, from the gaps between the pairs the
   * page sets (a gap is the first letter's after plus the second's before), by least squares. */
  function bearings(pairs) {
    const obs = [...pairs].map(([p2, v]) => [p2[0], p2[1], median(v)]);
    const rsb = new Map(), lsb = new Map();
    if (!obs.length) return { rsb, lsb };
    const mid = median(obs.map((o) => o[2])) / 2;
    for (const [a, b] of obs) { rsb.set(a, mid); lsb.set(b, mid); }
    for (let it = 0; it < 30; it++) {
      for (const c of rsb.keys()) { const v = obs.filter((o) => o[0] === c).map((o) => o[2] - lsb.get(o[1])); rsb.set(c, v.reduce((x, y) => x + y, 0) / v.length); }
      for (const c of lsb.keys()) { const v = obs.filter((o) => o[1] === c).map((o) => o[2] - rsb.get(o[0])); lsb.set(c, v.reduce((x, y) => x + y, 0) / v.length); }
    }
    return { rsb, lsb };
  }
  /** How much paper lies between a letter's box and its ink, row by row across the capital band
   * (baseline up), on each side: null where the row holds no ink. */
  function sidesOfGlyph(g, band) {
    const l = [], r = [], bw = g.w - 2;
    for (let rel = -band; rel < 0; rel++) {
      const row = Math.round(g.base + rel);
      let first = -1, last = -1;
      if (row >= 0 && row < g.h) for (let c = 1; c < g.w - 1; c++) if (g.alpha[row * g.w + c] > 0.4) { if (first < 0) first = c - 1; last = c - 1; }
      l.push(first < 0 ? null : first); r.push(last < 0 ? null : bw - 1 - last);
    }
    return { l, r };
  }
  function sidesOfBox(clean, w, [x0, y0, x1, y1], base, band) {
    const l = [], r = [];
    for (let rel = -band; rel < 0; rel++) {
      const y = Math.round(base + rel);
      let first = -1, last = -1;
      if (y >= y0 && y < y1) for (let x = x0; x < x1; x++) if (clean[y * w + x] < 150) { if (first < 0) first = x - x0; last = x - x0; }
      l.push(first < 0 ? null : first); r.push(last < 0 ? null : x1 - x0 - 1 - last);
    }
    return { l, r };
  }
  /** The paper two letters' shapes add to the gap between their boxes, on average across the band
   * (an open side counts as half the band at most), and at its least where both have ink. */
  function between(A, B, clip) {
    let s = 0, min = Infinity;
    for (let i = 0; i < A.r.length; i++) {
      const a = A.r[i], b = B.l[i];
      s += Math.min(clip, a === null ? clip : a) + Math.min(clip, b === null ? clip : b);
      if (a !== null && b !== null) min = Math.min(min, a + b);
    }
    return { side: A.r.length ? s / A.r.length : 0, min };
  }
  function squeezeX(g, s) {
    const nw = Math.max(1, Math.round(g.w * s)), a = new Float32Array(nw * g.h);
    for (let y = 0; y < g.h; y++) for (let x = 0; x < nw; x++) {
      const sx = Math.min(g.w - 1.001, Math.max(0, (x + 0.5) / s - 0.5)), ix = Math.floor(sx), dx = sx - ix;
      a[y * nw + x] = g.alpha[y * g.w + ix] * (1 - dx) + g.alpha[y * g.w + Math.min(g.w - 1, ix + 1)] * dx;
    }
    return { w: nw, h: g.h, alpha: a, base: g.base, cap: g.cap, from: g.from };
  }

  // ---------------------------------------------------------------- the checks a picture gets
  /** After painting: the picture read again. Every stand-in must read where it was painted, no
   * original value may read anywhere, and outside the painted boxes the picture must be the one
   * that came in (to within what saving it again as JPEG moves). */
  async function verify(reader, before, after, w, h, dpi, edits, rows, { lossy = false, erased = [] } = {}) {
    const checks = [];
    const pad = (b) => [b[0] - 4, b[1] - 4, b[2] + 4, b[3] + 4];
    // every painted word is read on its own (the words it stands among were not painted, and are
    // not this check's); a c, o, s, v, w, x or z looks the same in both cases, so its case is not
    const asks = [];
    for (const ed of edits) for (const wd of ed.words || [{ text: ed.text, box: ed.span }]) {
      const b = ed.boxes.reduce((u, x) => (Math.min(u[3], x[3]) > Math.max(u[1], x[1]) && Math.min(u[2], x[2]) > Math.max(u[0], x[0]) ? [Math.min(u[0], x[0]), Math.min(u[1], x[1]), Math.max(u[2], x[2]), Math.max(u[3], x[3])] : u), wd.box);
      asks.push({ ed, text: wd.text, rect: pad(b) });
    }
    const gray = toGray(after, w * h);
    let bad = [];
    const badRows = [];
    if (asks.length) {
      const back = await reader.read(gray, w, h, dpi, { rects: asks.map((a) => a.rect) });
      const squash = (t) => t.replace(/\s+/g, "").replace(/[COSVWXZ]/g, (c) => c.toLowerCase());
      asks.forEach((a, k) => {
        const want = squash(a.text);
        if (!(back.rectTexts[k] || []).some((t) => squash(t).includes(want))) { bad.push((a.ed.occ.row.label || "a stand-in") + " (map row " + a.ed.occ.row.id + ")"); badRows.push(a.ed.occ.row.id); }
      });
    }
    checks.push({ name: "stand-ins read back", passed: !bad.length, detail: bad.length ? "these do not read as painted: " + [...new Set(bad)].join("; ") : "", rows: [...new Set(badRows)] });
    const again = await reader.read(gray, w, h, dpi, { coverage: true });
    const residual = rows.filter((r) => !rows.some((o) => o.replace.includes(r.find)));
    const prepared = E().prepareRows(residual.map((r) => ({ ...r })));
    // a stand-in can differ from its original by one letter OCR confuses (0136 for 0186): a near
    // miss that reads exactly as a stand-in is the stand-in
    const standIns = new Set(rows.map((r) => r.replace));
    const leftovers = findOnPage(again, prepared, residual).filter((o) => !o.fuzzy || !standIns.has(o.line.text.slice(o.s, o.e)));
    const left = leftovers.length;
    checks.push({ name: "nothing left in the picture", passed: left === 0, detail: left ? left + " original values still read in the picture: " + [...new Set(leftovers.map((o) => (o.row.label || "a value") + " (map row " + o.row.id + ")"))].join("; ") : "", at: leftovers.map((o) => { const L = again.lines[o.line.li], q = o.line.syms[o.line.map[o.s]]; return q ? L.words[q.wi].box : null; }) });
    // outside the painted boxes: unchanged (a lossless copy) or within saving noise (JPEG)
    const mask = new Uint8Array(w * h);
    // the painted words, and the writing erased by choice, are the places allowed to change
    for (const b of edits.flatMap((ed) => ed.boxes).concat(erased)) { const [x0, y0, x1, y1] = pad(b); for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) mask.fill(1, y * w + Math.max(0, x0), y * w + Math.min(w, x1)); }
    const tol = lossy ? 48 : 0;
    let outside = 0;
    const where = [w, h, 0, 0];
    for (let k = 0, i = 0; k < w * h; k++, i += 4) {
      if (mask[k]) continue;
      if (Math.abs(before[i] - after[i]) > tol || Math.abs(before[i + 1] - after[i + 1]) > tol || Math.abs(before[i + 2] - after[i + 2]) > tol) {
        if (!lossy) { outside++; continue; }
        // a JPEG copy may move an edge a pixel: a pixel counts only when nothing next to it matches
        let near = false;
        const x = k % w, y = (k - x) / w;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = (yy * w + xx) * 4;
          if (Math.abs(before[i] - after[j]) <= tol && Math.abs(before[i + 1] - after[j + 1]) <= tol && Math.abs(before[i + 2] - after[j + 2]) <= tol) near = true;
        }
        if (!near) { outside++; const x = k % w, y = (k - x) / w; where[0] = Math.min(where[0], x); where[1] = Math.min(where[1], y); where[2] = Math.max(where[2], x); where[3] = Math.max(where[3], y); }
      }
    }
    checks.push({ name: "picture outside the swapped words", passed: outside === 0, detail: outside ? outside + " pixels changed outside the swapped words" : "", at: outside ? where : null });
    return checks;
  }

  // ---------------------------------------------------------------- JPEG quality
  /** About the quality a JPEG was saved at (IJG scale), from its luminance table. */
  function jpegQuality(bytes) {
    const T = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
    for (let i = 2; i + 4 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const m = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (m === 0xdb && (bytes[i + 4] >> 4) === 0) {
        let sum = 0; for (let k = 0; k < 64; k++) sum += bytes[i + 5 + k];
        let best = 75, err = Infinity;
        for (let q = 1; q <= 100; q++) {
          const sc = q < 50 ? 5000 / q : 200 - 2 * q;
          let s = 0; for (const t of T) s += Math.max(1, Math.min(255, Math.floor((t * sc + 50) / 100)));
          if (Math.abs(s - sum) < err) { err = Math.abs(s - sum); best = q; }
        }
        return best;
      }
      if (m === 0xda) break;
      i += 2 + len;
    }
    return 85;
  }

  // ---------------------------------------------------------------- a picture turned upright
  /** A picture's pixels in the page's own orientation. m = [ax, ay, bx, by]: where the picture's
   * next column and next row go on the screen, each one of (±1, 0) or (0, ±1). */
  function orient(img, m) {
    const [ax, ay, bx, by] = m, w = img.w, h = img.h;
    if (ax === 1 && ay === 0 && bx === 0 && by === 1) return img;
    const nw = Math.abs(ax) * w + Math.abs(bx) * h, nh = Math.abs(ay) * w + Math.abs(by) * h;
    const ox = (ax < 0 ? w - 1 : 0) * -ax + (bx < 0 ? h - 1 : 0) * -bx, oy = (ay < 0 ? w - 1 : 0) * -ay + (by < 0 ? h - 1 : 0) * -by;
    const out = new Uint8ClampedArray(nw * nh * 4), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = ax * x + bx * y + ox, Y = ay * x + by * y + oy, i = (y * w + x) * 4, j = (Y * nw + X) * 4;
      out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2]; out[j + 3] = d[i + 3];
    }
    return { w: nw, h: nh, data: out };
  }
  /** Back again: the inverse of an axis-aligned turn is its transpose. */
  function unorient(img, m) { const [ax, ay, bx, by] = m; return orient(img, [ax, bx, ay, by]); }
  function boxBack(box, m, w, h) {
    // a box in the turned picture, as pixels of the picture as stored
    const [ax, ay, bx, by] = m, inv = [ax, bx, ay, by];
    const nw = Math.abs(ax) * w + Math.abs(bx) * h, nh = Math.abs(ay) * w + Math.abs(by) * h;
    const pts = [[box[0], box[1]], [box[2] - 1, box[3] - 1]].map(([X, Y]) => {
      const [iax, iay, ibx, iby] = inv;
      const ox = (iax < 0 ? nw - 1 : 0) * -iax + (ibx < 0 ? nh - 1 : 0) * -ibx, oy = (iay < 0 ? nw - 1 : 0) * -iay + (iby < 0 ? nh - 1 : 0) * -iby;
      return [iax * X + ibx * Y + ox, iay * X + iby * Y + oy];
    });
    return [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]) + 1, Math.max(pts[0][1], pts[1][1]) + 1];
  }
  /** How a picture drawn with this matrix on a page turned `rotate` degrees sits on the screen. */
  function placement(ctm, rotate, w) {
    const r = ((rotate % 360) + 360) % 360, c = Math.round(Math.cos((r * Math.PI) / 180)), s = Math.round(Math.sin((r * Math.PI) / 180));
    const turn = ([x, y]) => [x * c + y * s, -x * s + y * c]; // clockwise, as /Rotate turns the page
    const right = turn([ctm[0], ctm[1]]), down = turn([-ctm[2], -ctm[3]]);
    const unit = ([x, y]) => (Math.abs(x) >= Math.abs(y) ? [Math.sign(x) || 1, 0] : [0, Math.sign(y) || 1]);
    const [ax, ay] = unit([right[0], -right[1]]), [bx, by] = unit([down[0], -down[1]]);
    const m = ax * by - ay * bx === 0 ? [1, 0, 0, 1] : [ax, ay, bx, by];
    return { m, dpi: (w * 72) / (Math.hypot(ctm[0], ctm[1]) || 1) };
  }

  // ---------------------------------------------------------------- in the browser
  /** The reader as workers in this page, from the Tesseract module's own script and its two files. */
  function browserReader({ glue, wasm, model, size }) {
    const src = glue + "\n" + SHARED.map((f) => f.toString()).join("\n") + "\n(" + workerMain.toString() + ")(self);";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const spawn = () => new Promise((resolve, reject) => {
      const w = new Worker(url);
      let seq = 0;
      const waiting = new Map();
      w.onmessage = (ev) => { const p = waiting.get(ev.data.id); if (!p) return; waiting.delete(ev.data.id); if (ev.data.ok) p.res(ev.data.res); else p.rej(new Error(ev.data.error)); };
      w.onerror = (e) => { e.preventDefault?.(); for (const p of waiting.values()) p.rej(new Error("the reader stopped")); waiting.clear(); };
      const call = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); w.postMessage({ ...msg, id }, transfer || []); });
      call({ type: "init", wasm: wasm.slice(0), model: model.slice(0) }).then(() => resolve({
        read: (job) => { const gray = job.gray.slice(); return call({ ...job, type: "read", gray }, [gray.buffer]); },
        close: () => w.terminate(),
      }), (e) => { w.terminate(); reject(e); });
    });
    return pool(spawn, size);
  }
  async function decodeFile(bytes, type) {
    const bmp = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: "from-image" });
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(bmp, 0, 0); bmp.close?.();
    return { w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data };
  }
  async function encodeFile(img, type, quality) {
    const c = new OffscreenCanvas(img.w, img.h);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
    return new Uint8Array(await (await c.convertToBlob({ type, quality })).arrayBuffer());
  }
  async function deflate(bytes) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
    return new Uint8Array(await out);
  }

  /** Letters the page does not offer, drawn in the installed face that looks most like the line's
   * own letters (sans, serif or typewriter, regular or bold), at the line's capital height. */
  const FACES = [
    "Arial, 'Liberation Sans', Helvetica, sans-serif", "'Times New Roman', 'Liberation Serif', Times, serif", "'Courier New', 'Liberation Mono', Courier, monospace",
  ].flatMap((css) => [{ css, weight: "normal" }, { css, weight: "bold" }]);
  function glyphRenderer(img, prep) {
    const faceOf = new Map(), canvas = new OffscreenCanvas(8, 8), cx = canvas.getContext("2d", { willReadFrequently: true });
    // a small letter is drawn four times as large and shrunk, pixel by pixel average, so its edges
    // are as soft as a printed letter's of that size and its strokes as heavy
    const draw = (ch, face, px) => {
      if (px < 40) {
        const k = 4, big = drawAt(ch, face, px * k), w = Math.ceil(big.w / k) + 1, h = Math.ceil(big.h / k) + 1;
        const ox = (k - (big.w % k || k)) >> 1, base = (big.base + ox) / k;
        const a = new Float32Array(w * h);
        for (let y = 0; y < big.h; y++) for (let x = 0; x < big.w; x++) a[(((y + ox) / k) | 0) * w + (((x + ox) / k) | 0)] += big.alpha[y * big.w + x] / (k * k);
        return { w, h, alpha: a, base };
      }
      return drawAt(ch, face, px);
    };
    const drawAt = (ch, face, px) => {
      cx.font = face.weight + " " + px + "px " + face.css;
      const m = cx.measureText(ch), asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
      const left = Math.floor(-m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
      const gw = Math.max(1, right - left) + 2, gh = Math.max(1, asc + desc) + 2;
      if (canvas.width < gw || canvas.height < gh) { canvas.width = Math.max(canvas.width, gw); canvas.height = Math.max(canvas.height, gh); }
      cx.clearRect(0, 0, canvas.width, canvas.height);
      cx.font = face.weight + " " + px + "px " + face.css; cx.fillStyle = "#000"; cx.textBaseline = "alphabetic";
      cx.fillText(ch, 1 - left, 1 + asc);
      const d = cx.getImageData(0, 0, gw, gh).data, alpha = new Float32Array(gw * gh);
      for (let i = 0; i < gw * gh; i++) alpha[i] = d[i * 4 + 3] / 255;
      return { w: gw, h: gh, alpha, base: 1 + asc };
    };
    const capRatio = new Map();
    const sizeFor = (face, cap) => {
      if (!capRatio.has(face)) { cx.font = face.weight + " 100px " + face.css; capRatio.set(face, (cx.measureText("H").actualBoundingBoxAscent || 72) / 100); }
      return Math.max(4, cap / capRatio.get(face));
    };
    const mask = (box) => {
      // the reader can give a letter on a small picture a box that runs off the picture or turns
      // inside out: what is left of it on the picture, or nothing
      const x0 = Math.max(0, Math.round(box[0])), y0 = Math.max(0, Math.round(box[1]));
      const w = Math.max(0, Math.min(img.w, Math.round(box[2])) - x0), h = Math.max(0, Math.min(img.h, Math.round(box[3])) - y0), a = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = prep.clean[(y0 + y) * img.w + x0 + x] < 150 ? 1 : 0;
      return { w, h, a };
    };
    const likeness = (g, m) => {
      // the drawn letter's ink box set over the page's, compared cell by cell
      let x0 = g.w, y0 = g.h, x1 = 0, y1 = 0;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.alpha[y * g.w + x] > 0.5) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      if (x1 < x0) return 0;
      let both = 0, either = 0;
      for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
        const gx = x0 + Math.floor(((x + 0.5) * (x1 - x0 + 1)) / m.w), gy = y0 + Math.floor(((y + 0.5) * (y1 - y0 + 1)) / m.h);
        const p = m.a[y * m.w + x], q = g.alpha[gy * g.w + gx] > 0.5 ? 1 : 0;
        both += p & q; either += p | q;
      }
      return either ? both / either : 0;
    };
    // how thick a letter's strokes are, as a share of its height: the middle run of ink across it
    const stroke = (a, gw, gh, on) => {
      const runs = [];
      for (const y of [Math.floor(gh * 0.4), Math.floor(gh * 0.55), Math.floor(gh * 0.7)]) {
        let run = 0;
        for (let x = 0; x <= gw; x++) { if (x < gw && on(a, y * gw + x)) run++; else if (run) { runs.push(run); run = 0; } }
      }
      runs.sort((p, q) => p - q);
      return runs.length ? runs[runs.length >> 1] / gh : null;
    };
    const choose = (cap, sample, li) => {
      if (!faceOf.has(li)) {
        let best = FACES[0], score = -Infinity;
        const sw = sample.map((sm) => { const m = mask(sm.box); return stroke(m.a, m.w, m.h, (a, i) => a[i] === 1); }).filter(Boolean);
        const want = sw.length ? median(sw) : null;
        // a scan's letters are softened, so each drawn letter is softened as much before it is
        // compared (otherwise every bold face looks like the scan)
        const r = Math.max(1, Math.round(cap / 18));
        const softened = (g) => {
          const a = new Float32Array(g.alpha.length);
          for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
            let t = 0, n = 0;
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= g.w || yy >= g.h) { n++; continue; } t += g.alpha[yy * g.w + xx]; n++; }
            a[y * g.w + x] = t / n > 0.3 ? 1 : 0;
          }
          return { ...g, alpha: a };
        };
        const inkBox = (g) => { let x0 = g.w, y0 = g.h, x1 = 0, y1 = 0; for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.alpha[y * g.w + x] > 0.5) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return x1 < x0 ? null : [x0, y0, x1 + 1, y1 + 1]; };
        for (const face of FACES) {
          let sum = 0, aspect = 0, na = 0;
          const fw = [];
          for (const sm of sample) {
            const g = softened(draw(sm.c, face, sizeFor(face, cap)));
            sum += likeness(g, mask(sm.box));
            const t = stroke(g.alpha, g.w, g.h, (a, i) => a[i] > 0.5), b = inkBox(g);
            if (t && b) fw.push(t * g.h / Math.max(1, sm.box[3] - sm.box[1]));
            // how wide each letter is for its height: a typewriter's i is as wide as its m
            if (b && sm.whole) { aspect += Math.abs(Math.log(((b[2] - b[0]) / (b[3] - b[1])) / ((sm.box[2] - sm.box[0]) / Math.max(1, sm.box[3] - sm.box[1])))); na++; }
          }
          // bold has to win clearly: at a small size a softened regular letter looks heavy too
          const sc = sum / Math.max(1, sample.length) - (want && fw.length ? 1.2 * Math.abs(Math.log(median(fw) / want)) : 0) - (na ? 0.8 * aspect / na : 0) - (face.weight === "bold" ? 0.05 : 0);
          if (sc > score) { score = sc; best = face; }
        }
        faceOf.set(li, best);
      }
      return faceOf.get(li);
    };
    // the softness of a scan: one pass of a 3x3 blur, lighter the smaller the letter (a stroke one
    // pixel wide blurred as much as a large letter's is grey, and no longer reads)
    const soften = (g, cap) => {
      const side = cap >= 24 ? 0.6 : cap >= 14 ? 0.3 : 0, soft = new Float32Array(g.alpha.length);
      if (!side) return g;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        let s2 = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= g.w || yy >= g.h) continue; s2 += g.alpha[yy * g.w + xx] * (dx || dy ? side : 1); n += dx || dy ? side : 1; }
        soft[y * g.w + x] = s2 / n;
      }
      return { ...g, alpha: soft };
    };
    // how much ink a letter puts in its box, from 0 (none) to 1 (solid): the page's own letters
    // against the paper under them and their darkest ink, a drawn letter by its coverage
    const pageInk = (box) => {
      const [x0, y0, x1, y1] = box;
      let lo = 255, sum = 0, n = 0;
      const gray = (k) => (img.orig[k * 4] * 77 + img.orig[k * 4 + 1] * 150 + img.orig[k * 4 + 2] * 29) >> 8;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) lo = Math.min(lo, gray(y * img.w + x));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * img.w + x, p = prep.bg[k]; sum += p - lo > 20 ? Math.max(0, Math.min(1, (p - gray(k)) / (p - lo))) : 0; n++; }
      return n ? sum / n : null;
    };
    const drawnInk = (g, gam) => {
      let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.alpha[y * g.w + x] > 0.4) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      if (x1 < 0) return null;
      let sum = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += Math.pow(g.alpha[y * g.w + x], gam);
      return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    };
    // the drawn letters are toned, line by line, to carry as much ink as the line's own: a
    // regular letter drawn small is lighter than a printed one, and a bold one heavier
    const toneOf = new Map();
    const toneFor = (li, face, cap, sample) => {
      if (toneOf.has(li)) return toneOf.get(li);
      const pairs = [];
      for (const sm of sample.slice(0, 6)) {
        const want = pageInk(sm.box), g = soften(draw(sm.c, face, sizeFor(face, cap)), cap);
        if (want !== null && drawnInk(g, 1) !== null) pairs.push([want, g]);
      }
      let gam = 1;
      if (pairs.length) {
        const target = pairs.reduce((t, [w]) => t + w, 0) / pairs.length;
        const mean = (gm) => pairs.reduce((t, [, g]) => t + drawnInk(g, gm), 0) / pairs.length;
        let lo = 0.25, hi = 4;
        for (let i = 0; i < 24; i++) { const mid = Math.sqrt(lo * hi); if (mean(mid) > target) lo = mid; else hi = mid; }
        gam = Math.sqrt(lo * hi);
      }
      toneOf.set(li, gam);
      return gam;
    };
    const render = (ch, cap, sample, li) => {
      const face = choose(cap, sample, li), g = soften(draw(ch, face, sizeFor(face, cap)), cap);
      const gam = toneFor(li, face, cap, sample);
      const alpha = new Float32Array(g.alpha.length);
      for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(1, Math.pow(g.alpha[i], gam));
      return { w: g.w, h: g.h, alpha, base: g.base, cap };
    };
    render.face = choose;
    return render;
  }

  /** The pictures pdf.js draws on one page, in the order it draws them, with their pixels. */
  async function pagePictures(pdfjsDoc, pageIndex) {
    const page = await pdfjsDoc.getPage(pageIndex + 1);
    const ops = await page.getOperatorList();
    const OPS = globalThis.pdfjsLib.OPS, out = [];
    const want = new Set([OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter((v) => v !== undefined));
    for (let i = 0; i < ops.fnArray.length; i++) if (want.has(ops.fnArray[i])) { const [id, w, h] = ops.argsArray[i]; out.push({ id, w, h }); }
    const get = (id) => new Promise((res) => (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, res));
    for (const o of out) o.obj = await get(o.id);
    return out;
  }
  function pixelsOf(obj) {
    const w = obj.width, h = obj.height;
    if (obj.bitmap) {
      const c = new OffscreenCanvas(w, h), x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(obj.bitmap, 0, 0);
      return { w, h, data: x.getImageData(0, 0, w, h).data };
    }
    const src = obj.data, out = new Uint8ClampedArray(w * h * 4);
    if (obj.kind === 1) {
      const row = (w + 7) >> 3;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0, j = (y * w + x) * 4; out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255; }
    } else if (obj.kind === 2) {
      for (let i = 0, j = 0; i < w * h; i++, j += 4) { out[j] = src[i * 3]; out[j + 1] = src[i * 3 + 1]; out[j + 2] = src[i * 3 + 2]; out[j + 3] = 255; }
    } else out.set(src.subarray(0, w * h * 4));
    return { w, h, data: out };
  }

  // ---------------------------------------------------------------- whole files
  const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  function mimeOf(path) { const m = /\.([a-z0-9]+)$/i.exec(path); return m ? MIME[m[1].toLowerCase()] || null : null; }
  /** Writing on a picture the reader could not make out (handwriting, a signature, a stamp), and
   * words it read with almost no confidence: neither can be searched for names and numbers. */
  function unread(res) {
    return res.marks.filter((m) => m.kind === "writing").map((m) => m.box);
  }
  /** `inset`: a picture set into a page of text (a statement's logo, a banner, a cheque), where
   * what is not words is as often the artwork as anybody's hand. */
  function pictureNote(res, label, inset = false) {
    const n = unread(res).length;
    if (!n) return "";
    if (inset) return label + ": " + n + (n === 1 ? " place on it holds" : " places on it hold") + " shapes the reader could not make out as words (artwork, a logo, handwriting or a signature)";
    return label + ": " + n + (n === 1 ? " place holds" : " places hold") + " writing that could not be read (handwriting, a signature or a stamp)";
  }

  /** A picture read the way up its text runs: as it sits first, and when that reads poorly
   * (a page fed in upside down, a photo taken sideways), turned each other way, keeping the turn
   * that reads best. m is how the picture sits on the screen to begin with. */
  const TURNS = [null, ([x, y]) => [-x, -y], ([x, y]) => [-y, x], ([x, y]) => [y, -x]];
  async function readUpright(svc, px, m0, dpi) {
    let best = null;
    for (const turn of TURNS) {
      const m = turn ? [...turn([m0[0], m0[1]]), ...turn([m0[2], m0[3]])] : m0;
      const up = orient(px, m);
      const res = await svc.reader.read(toGray(up.data, up.w * up.h), up.w, up.h, dpi);
      if (res.notText) return { res, m };
      const good = res.lines.reduce((n, l) => n + l.words.filter((wd) => wd.conf >= 70).length, 0);
      if (!best || good > best.good) best = { res, m, good };
      if (good >= 12 && res.mean >= 70) break;
    }
    return best;
  }
  /** Whether a picture is an ID card (a driver's licence, a state ID, a passport): three of the
   * words such cards print, or one of them and a photo of a face. A card's labels are small and
   * often red, and the reader loses most of them ("15sex", "RIVEREL ICENSE"); a tax document
   * carries no portrait, so a face beside one card word settles it. Its photo is then replaced,
   * and every date and long number on it is taken for the card's own. */
  const ID_SIGNS = [/DRIVER'?S?\s*LICEN[SC]E|ICEN[SC]E/i, /IDENTIFICATION\s+CARD|\bID\s+CARD\b/i, /(?<![A-Za-z])DLN\b|\bDL\s*(?:NO|#)/i, /(?<![A-Za-z])DOB\b/i, /(?<![A-Za-z])EXP\b/i,
    /(?<![A-Za-z])ISS\b/i, /\bCLASS\b/i, /(?<![A-Za-z])SEX\b/i, /(?<![A-Za-z])HGT\b|\bHEIGHT\b/i, /(?<![A-Za-z])EYES\b/i, /\bRESTR/i, /\bENDORSE|(?<![A-Za-z])END\b/i, /\b4[abd]\b/i, /(?<![A-Za-z])DD\b/, /PASSPORT/i,
    /REAL\s*ID|\bDONOR\b/i, /(?<![A-Za-z])WGT\b|\bWEIGHT\b/i];
  // the words only a card prints: one of these is worth looking for a face (a tax form prints
  // "4a", "CLASS" and "END" too, so those count only towards three)
  const CARD_ONLY = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 14, 15, 16]);
  const idSigns = (res, only = false) => { const text = pageText(res).map((l) => l.text).join("\n"); return ID_SIGNS.filter((r, k) => (!only || CARD_ONLY.has(k)) && r.test(text)).length; };
  const isIdCard = (res) => idSigns(res) >= 3;
  /** Reads whether a picture just read is an ID card, and if so finds its photos: sets res.idCard
   * and res.photos. */
  function cardCheck(svc, img, res) {
    const signs = idSigns(res);
    if (signs >= 3) { res.idCard = true; res.photos = findPhotos(svc, img, res); return; }
    res.idCard = false;
    if (!idSigns(res, true)) return;
    const F = svc.faces || globalThis.PDFSwapFaces;
    const photo = F ? F.find(img, printedWords(res)) : { portrait: null };
    if (photo.portrait) { res.idCard = true; res.photos = findPhotos(svc, img, res, photo); }
  }
  /** An ID card's photos, found when it is read: what the reader made of them is a face's
   * shading, not words, and is taken out before anything is searched. Returns the boxes. */
  function findPhotos(svc, img, res, found = null) {
    const F = svc.faces || globalThis.PDFSwapFaces;
    if (!F) return [];
    const photo = found || F.find(img, printedWords(res));
    const boxes = [photo.portrait, ...photo.ghosts].filter(Boolean);
    // the words printed over a faint copy are the card's, and stay
    const inside = (b) => boxes.some((p) => Math.min(p[2], b[2]) - Math.max(p[0], b[0]) > 0.5 * (b[2] - b[0]) && Math.min(p[3], b[3]) - Math.max(p[1], b[1]) > 0.5 * (b[3] - b[1]) && !(p.under && F.printed(img, p, b)));
    if (boxes.length) {
      // blanked where they stand: the words keep their places, so nothing that counts them moves
      for (const l of res.lines) for (const wd of l.words) if (inside(wd.box)) { wd.conf = 0; for (const sy of wd.syms) sy.c = " "; }
      res.marks = res.marks.filter((m) => !inside(m.box));
      // the page's text was put together to tell it is a card, with the photo's shading in it
      delete res._text;
    }
    return boxes;
  }
  /** The boxes of the words read with confidence: no photo covers them. */
  const printedWords = (res) => res.lines.flatMap((l) => l.words.filter((wd) => wd.conf >= 70 && wd.syms.some((sy) => /[A-Za-z0-9]/.test(sy.c))).map((wd) => wd.box));
  /** First pass, a photo or picture file: read it. */
  /** A picture file's pages, as RGBA: through the page's codec (every kind, every page of a
   * TIFF), or a single picture through `decode` (the tests' own). */
  async function decodePages(svc, bytes, path) {
    if (svc.codec) return svc.codec.decodeAll(bytes, path);
    const type = mimeOf(path);
    return { kind: type, pages: [await svc.decode(bytes, type)], info: [], lossy: type !== "image/png" };
  }
  async function encodePages(svc, pages, dec, quality) {
    if (svc.codec) return svc.codec.encodeAll(pages, dec, quality);
    return { bytes: await svc.encode(pages[0], dec.kind, quality) };
  }
  async function readPictureFile(svc, bytes, path) {
    const dec = await decodePages(svc, bytes, path), pictures = [];
    let symbols = 0;
    for (let p = 0; p < dec.pages.length; p++) {
      const img = dec.pages[p], meta = dec.info[p] || {};
      // a TIFF says its resolution; a photo is taken to be a letter-size page across
      const dpi = Math.max(100, Math.min(600, meta.xres > 50 && meta.unit !== 3 ? meta.xres : meta.xres > 20 && meta.unit === 3 ? meta.xres * 2.54 : img.w / 8.5));
      const { res, m } = await readUpright(svc, img, [1, 0, 0, 1], dpi);
      if (res.notText) continue;
      cardCheck(svc, orient(img, m), res);
      symbols += res.lines.reduce((n, l) => n + l.words.reduce((k, wd) => k + wd.syms.length, 0), 0);
      pictures.push({ key: path + "#" + p, res, dpi, m, page: p });
    }
    if (!pictures.length) return { notText: true };
    return { pictures, symbols, pages: dec.pages.length };
  }
  /** First pass, a PDF: read every picture big enough to be a page, or a photo of a document,
   * set on one of its pages. */
  async function readPdfPictures(svc, bytes, model) {
    const E_ = E(), byRef = new Map();
    for (const d of model.images) {
      const page = model.pages[d.page], { width, height } = page.getSize();
      const area = Math.abs(d.ctm[0] * d.ctm[3] - d.ctm[1] * d.ctm[2]) / (width * height || 1);
      let info; try { info = E_.imageInfo(model, d.ref); } catch (e) { continue; }
      if (area < 0.05 || Math.min(info.w, info.h) < 150) continue;
      if (!byRef.has(d.ref.tag)) byRef.set(d.ref.tag, { ref: d.ref, info, draws: [], area: 0 });
      byRef.get(d.ref.tag).draws.push(d);
      byRef.get(d.ref.tag).area = Math.max(byRef.get(d.ref.tag).area, area);
    }
    if (!byRef.size) return { pictures: [], symbols: 0 };
    const pdf = await svc.pdfjs(bytes);
    const pictures = [];
    let symbols = 0;
    try {
      for (const pic of byRef.values()) {
        const first = pic.draws[0];
        const px = await pictureOf(pdf, model, first, pic.info);
        if (!px) { pictures.push({ key: pic.ref.tag, failed: "a picture on page " + (first.page + 1) + " could not be read" }); continue; }
        const placed = placement(first.ctm, model.pages[first.page].getRotation().angle, pic.info.w);
        const { res, m } = await readUpright(svc, px, placed.m, placed.dpi);
        const dpi = placed.dpi;
        if (res.notText) continue;
        cardCheck(svc, orient(px, m), res);
        symbols += res.lines.reduce((n, l) => n + l.words.reduce((k, wd) => k + wd.syms.length, 0), 0);
        pictures.push({ key: pic.ref.tag, res, dpi, m, page: first.page, pages: [...new Set(pic.draws.map((d) => d.page))], inset: pic.area < 0.4 });
      }
    } finally { pdf.destroy(); }
    return { pictures, symbols };
  }
  /** One picture's pixels, as stored, from pdf.js: the draw is found among the page's pictures by
   * its order on the page and its size. */
  async function pictureOf(pdf, model, draw, info) {
    const mine = model.images.filter((d) => d.page === draw.page);
    const k = mine.indexOf(draw);
    const theirs = await pagePictures(pdf, draw.page);
    let j = -1, seen = -1;
    for (let q = 0; q < theirs.length; q++) {
      if (theirs[q].w !== info.w || theirs[q].h !== info.h) continue;
      seen++;
      const sameBefore = mine.slice(0, k).filter((d) => { try { const i2 = E().imageInfo(model, d.ref); return i2.w === info.w && i2.h === info.h; } catch (e) { return false; } }).length;
      if (seen === sameBefore) { j = q; break; }
    }
    if (j < 0 || !theirs[j].obj) return null;
    return pixelsOf(theirs[j].obj);
  }

  /** Paint one picture, write it as its own kind, and check what was written. */
  async function paintOne(svc, up, pic, rows, prepared, { bilevel, fontFirst = null, cover = null, wipe = [] }) {
    const res = pic.res;
    const found = findOnPage(res, prepared, rows);
    const img = { w: up.w, h: up.h, orig: up.data, data: new Uint8ClampedArray(up.data) };
    img.prep = prepare(toGray(img.orig, img.w * img.h), img.w, img.h, pic.dpi);
    // an ID card's photo, and the faint copy beside it, are a face: replaced with a silhouette
    const F = svc.faces || globalThis.PDFSwapFaces;
    const portraits = res.idCard && F ? res.photos || [] : [];
    const photoMissing = !!res.idCard && !portraits.length;
    // a faint copy with words printed over it keeps the words; only the photo goes
    const inPhoto = (b) => portraits.some((p) => !p.under && Math.min(p[2], b[2]) > Math.max(p[0], b[0]) && Math.min(p[3], b[3]) > Math.max(p[1], b[1]));
    const marks = unread(res).filter((b) => !inPhoto(b));
    if (!found.length && !portraits.length && !wipe.length && !(svc.marks === "erase" && marks.length)) return { found, edits: [], problems: [], unchanged: true, marks, portraits, photoMissing, wiped: [] };
    for (const b of portraits) F.paint(img, b, { bilevel, under: !!b.under, faint: !!b.faint });
    const { edits, problems } = paint(img, res, found, { dpi: pic.dpi, bilevel, fontFirst, cover, renderGlyph: svc.renderer ? svc.renderer(img, img.prep) : null });
    // a word the read-back still found an original value in, which the first read did not:
    // blanked like a value that could not be drawn
    const wiped = [];
    for (const b of wipe) {
      const er = [Math.max(0, b[0] - 2), Math.max(0, b[1] - 1), Math.min(img.w, b[2] + 2), Math.min(img.h, b[3] + 1)];
      erase(img, img.prep, er, seeded(11)); wiped.push(er);
    }
    if (bilevel && wiped.length) for (let i = 0; i < img.data.length; i += 4) { const v = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8 < 128 ? 0 : 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
    const erased = svc.marks === "erase" && marks.length ? eraseWriting(img, img.prep, res, marks, edits.flatMap((ed) => ed.boxes).concat(portraits, wiped), pic.dpi, seeded(7)) : [];
    return { found, edits, problems, img, marks, erased, portraits, photoMissing, wiped };
  }
  /** What to try next on a picture whose painting did not pass: the values that did not read
   * back drawn in the matching font (where there is one to draw with), then every value that
   * still fails lifted off the paper and left blank, with any word the read-back still found an
   * original value in. Null when it passed, or nothing is left to try. */
  function retry(svc, done, checks, { fontFirst, cover }) {
    const rb = checks.find((c) => c.name === "stand-ins read back"), left = checks.find((c) => c.name === "nothing left in the picture");
    const failing = new Set([...rb.rows, ...done.problems.map((p) => p.occ.row.id)]);
    if (!failing.size && left.passed) return null;
    if (!fontFirst && svc.renderer && rb.rows.length && !done.problems.length && left.passed) return { fontFirst: new Set(rb.rows), cover: null, wipe: [] };
    // once blanking has begun, only a value not yet blanked is worth another round
    if (cover && [...failing].every((id) => cover.has(id)) && left.passed) return null;
    return { fontFirst: new Set([...(fontFirst || []), ...rb.rows]), cover: new Set([...(cover || []), ...failing]), wipe: left.passed ? [] : (left.at || []).filter(Boolean) };
  }
  /** What the report says about values blanked out rather than drawn in their stand-ins. */
  function blankSaid(done, label) {
    const covered = (done.edits || []).filter((ed) => ed.covered), wiped = (done.wiped || []).length;
    const parts = [];
    if (covered.length) {
      const kinds = [...new Set(covered.map((ed) => ed.occ.row.label || "a value"))];
      parts.push(covered.length + (covered.length === 1 ? " value" : " values") + " (" + kinds.join(", ") + ") could not be drawn in " + (covered.length === 1 ? "its stand-in" : "their stand-ins") + " and " + (covered.length === 1 ? "was" : "were") + " blanked out");
    }
    if (wiped) parts.push(wiped + (wiped === 1 ? " word" : " words") + " the reader first missed, holding an original value, blanked out");
    return parts.length ? label + ": " + parts.join("; ") : "";
  }
  /** What the report says about an ID card's photo. */
  function photoSaid(done, label) {
    if (done.photoMissing) return label + ": an ID card, and no photo was found on it to replace; look at it before the copy is shared";
    const n = done.portraits ? done.portraits.length : 0;
    return n ? label + ": the photo on the ID card" + (n > 1 ? " and its faint copy were" : " was") + " replaced with a plain silhouette" : "";
  }
  function occurrence(occ, page, label, ok, why, boxes) {
    return { page, where: "scanned page", label, row: occ.row, replaced: ok, reason: ok ? "" : why, widthChange: 0, font: "", boxes: boxes || [], fuzzy: occ.fuzzy };
  }

  /** Second pass, a photo or picture file: the painted copy, its checks, what was found. */
  async function paintPictureFile(svc, bytes, path, pictures, rows) {
    const prepared = E().prepareRows(rows.map((r) => ({ ...r })));
    const dec = await decodePages(svc, bytes, path), pages = dec.pages.slice();
    const many = pages.length > 1, lossy = dec.lossy;
    const quality = /jpe?g/i.test(dec.kind) || dec.kind === "heic" ? Math.max(85, Math.min(95, (/jpe?g/i.test(dec.kind) ? jpegQuality(bytes) : 90) + 5)) / 100 : 0.92;
    const occurrences = [], checks = [], warnings = [];
    let erasedAll = 0, changed = false, ok = true, problems = 0;
    for (const pic of pictures) {
      const label = many ? "page " + (pic.page + 1) : "the picture";
      const raw = pages[pic.page], m = pic.m || [1, 0, 0, 1], up = orient(raw, m);
      const note = pictureNote(pic.res, label);
      let done, output, pageChecks, fontFirst = null, cover = null, wipe = [];
      // a value that does not read back is painted again in the matching font; what still will
      // not paint is then lifted off and left blank, so the picture still comes back
      for (let attempt = 0; attempt < 4; attempt++) {
        done = await paintOne(svc, up, pic, rows, prepared, { bilevel: (dec.info[pic.page] || {}).bits === 1, fontFirst, cover, wipe });
        if (done.unchanged) break;
        // written the way it came (a photo stays the way the camera took it); a picture written
        // with loss is read back from what was written
        output = unorient(done.img, m);
        const back = lossy ? orient((await decodePages(svc, (await encodePages(svc, [output], dec, quality)).bytes, dec.kind === "heic" ? "x.jpg" : path)).pages[0], m) : done.img;
        pageChecks = await verify(svc.reader, up.data, back.data, up.w, up.h, pic.dpi, done.edits, rows, { lossy, erased: done.erased.concat(done.portraits, done.wiped) });
        const next = retry(svc, done, pageChecks, { fontFirst, cover });
        if (!next) break;
        ({ fontFirst, cover, wipe } = next);
      }
      const photoNote = photoSaid(done, label);
      if (photoNote) warnings.push(photoNote);
      const blankNote = blankSaid(done, label);
      if (blankNote) warnings.push(blankNote);
      if (done.unchanged) { if (note) warnings.push(note); continue; }
      const pageOk = pageChecks.every((c) => c.passed) && !done.problems.length;
      // for looking at a painted picture by hand (a test sets the list; the page never does)
      if (Array.isArray(globalThis.PDFSWAP_DEBUG)) globalThis.PDFSWAP_DEBUG.push({ path, page: pic.page, w: done.img.w, h: done.img.h, data: done.img.data, checks: pageChecks });
      checks.push(...pageChecks.map((c) => (many ? { ...c, name: c.name + " (" + label + ")" } : c)));
      const why = pageChecks.every((c) => c.passed) ? "another value in this picture could not be painted" : "the painted picture failed its check (" + pageChecks.filter((c) => !c.passed).map((c) => c.name + ": " + c.detail).join("; ") + ")";
      for (const ed of done.edits) occurrences.push(occurrence(ed.occ, pic.page, label, pageOk, why, ed.boxes.map((b) => [pic.page, boxBack(b, m, raw.w, raw.h)])));
      for (const pr of done.problems) occurrences.push(occurrence(pr.occ, pic.page, label, false, pr.why));
      problems += done.problems.length;
      if (done.erased.length) warnings.push(label + ": " + done.erased.length + (done.erased.length === 1 ? " place" : " places") + " of writing that could not be read erased");
      else if (note) warnings.push(note);
      erasedAll += done.erased.length;
      if (!pageOk) ok = false;
      pages[pic.page] = output; changed = true;
    }
    if (dec.dropped) warnings.push(dec.dropped + (dec.dropped === 1 ? " small preview picture" : " small preview pictures") + " of the pages left out of the copy (they would still show the old values)");
    if (!changed) return { output: null, occurrences, checks, warnings };
    const written = await encodePages(svc, pages, dec, quality);
    if (written.ext) warnings.push("written as a " + (written.ext === ".jpg" ? "JPEG" : written.ext.slice(1).toUpperCase()) + ": no free tool writes this kind of picture in a browser");
    return { output: ok && !problems ? written.bytes : null, ext: written.ext || null, occurrences, checks, warnings, marksErased: erasedAll };
  }

  /** Second pass, a PDF: the engine's paint step. Every picture that holds a value is painted,
   * checked and written back under its own reference; the engine then swaps the page text (and
   * the hidden search text over a scan, where its picture was painted). */
  async function paintPdfPictures(svc, { model, prepared, rows }, bytes, pictures) {
    const E_ = E(), out = { occurrences: [], rowsByPage: new Map(), changed: false, checks: [], warnings: [], extraAllowed: [] };
    if (!pictures || !pictures.length) return out;
    const pdf = await svc.pdfjs(bytes);
    try {
      for (const pic of pictures) {
        if (pic.failed) { out.warnings.push(pic.failed); continue; }
        const ref = [...model.images].find((d) => d.ref.tag === pic.key)?.ref;
        if (!ref) continue;
        const info = E_.imageInfo(model, ref);
        const draws = model.images.filter((d) => d.ref.tag === pic.key);
        // a picture set into a page of text is not the page scanned
        const label = pic.inset ? "a picture on page " + (pic.page + 1) : "page " + (pic.page + 1) + " (scanned)";
        const note = pictureNote(pic.res, label, !!pic.inset);
        if (note && svc.marks !== "erase") out.warnings.push(note);
        const px = await pictureOf(pdf, model, draws[0], info);
        if (!px) { out.warnings.push("the picture on " + label + " could not be read again"); continue; }
        const up = orient(px, pic.m);
        const bilevel = info.bpc === 1 || info.filters.some((f) => f === "CCITTFaxDecode" || f === "JBIG2Decode");
        const lossy = !!info.jpeg || info.filters.includes("JPXDecode");
        let done, bytesOut, filter, gray = false, bpc = 8, checks, fontFirst = null, cover = null, wipe = [];
        // a value that does not read back is painted again in the matching font; what still will
        // not paint is then lifted off and left blank, so the page still comes back
        for (let attempt = 0; attempt < 4; attempt++) {
          done = await paintOne(svc, up, pic, rows, E_.prepareRows(rows.map((r) => ({ ...r }))), { bilevel, fontFirst, cover, wipe });
          if (done.unchanged) break;
          // as stored, packed the way it came (or as near as a page allows), then read back
          const stored = unorient(done.img, pic.m);
          let back;
          gray = false; bpc = 8;
          if (lossy) {
            const q = info.jpeg ? Math.max(85, Math.min(95, jpegQuality(info.jpeg) + 5)) : 90;
            bytesOut = await svc.encode(stored, "image/jpeg", q / 100); filter = "DCTDecode";
            back = orient(await svc.decode(bytesOut, "image/jpeg"), pic.m);
          } else if (bilevel) {
            const row = (stored.w + 7) >> 3, packed = new Uint8Array(row * stored.h);
            for (let y = 0; y < stored.h; y++) for (let x = 0; x < stored.w; x++) if (stored.data[(y * stored.w + x) * 4] >= 128) packed[y * row + (x >> 3)] |= 0x80 >> (x & 7);
            bytesOut = await svc.deflate(packed); filter = "FlateDecode"; gray = true; bpc = 1; back = done.img;
          } else {
            gray = true;
            for (let i = 0; i < stored.data.length && gray; i += 4) if (stored.data[i] !== stored.data[i + 1] || stored.data[i] !== stored.data[i + 2]) gray = false;
            const n = stored.w * stored.h, raw = new Uint8Array(gray ? n : n * 3);
            for (let i = 0; i < n; i++) { if (gray) raw[i] = stored.data[i * 4]; else { raw[i * 3] = stored.data[i * 4]; raw[i * 3 + 1] = stored.data[i * 4 + 1]; raw[i * 3 + 2] = stored.data[i * 4 + 2]; } }
            bytesOut = await svc.deflate(raw); filter = "FlateDecode"; back = done.img;
          }
          checks = await verify(svc.reader, up.data, back.data, up.w, up.h, pic.dpi, done.edits, rows, { lossy, erased: done.erased.concat(done.portraits, done.wiped) });
          const next = retry(svc, done, checks, { fontFirst, cover });
          if (!next) break;
          ({ fontFirst, cover, wipe } = next);
        }
        const photoNote = photoSaid(done, label);
        if (photoNote) out.warnings.push(photoNote);
        const blankNote = blankSaid(done, label);
        if (blankNote) out.warnings.push(blankNote);
        if (done.unchanged) continue;
        out.checks.push(...checks.map((c) => ({ ...c, name: c.name + " (" + label + ")" })));
        const ok = checks.every((c) => c.passed) && !done.problems.length;
        if (ok) { E_.replaceImage(model, ref, { bytes: bytesOut, filter, gray, bpc }); out.changed = true; }
        // where each painted value sits on every page that draws the picture, for the picture check
        const pdfBoxes = (b) => draws.map((d) => {
          const sb = boxBack(b, pic.m, info.w, info.h), u0 = sb[0] / info.w, u1 = sb[2] / info.w, v0 = 1 - sb[3] / info.h, v1 = 1 - sb[1] / info.h;
          const pts = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]].map(([u, v]) => [d.ctm[0] * u + d.ctm[2] * v + d.ctm[4], d.ctm[1] * u + d.ctm[3] * v + d.ctm[5]]);
          return [d.page, [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]];
        });
        const why = checks.every((c) => c.passed) ? "another value in this picture could not be painted" : "the painted picture failed its check (" + checks.filter((c) => !c.passed).map((c) => c.name + ": " + c.detail).join("; ") + ")";
        for (const ed of done.edits) {
          out.occurrences.push(occurrence(ed.occ, pic.page, label, ok, why, ed.boxes.flatMap(pdfBoxes)));
          if (ok) for (const pg of pic.pages) { if (!out.rowsByPage.has(pg)) out.rowsByPage.set(pg, new Set()); out.rowsByPage.get(pg).add(ed.occ.row.id); }
        }
        for (const pr of done.problems) out.occurrences.push(occurrence(pr.occ, pic.page, label, false, pr.why));
        if (ok && done.portraits.length) out.extraAllowed.push(...done.portraits.flatMap(pdfBoxes));
        if (ok && done.erased.length) {
          out.warnings.push(label + ": " + done.erased.length + (done.erased.length === 1 ? " place" : " places") + " of writing that could not be read erased");
          out.extraAllowed.push(...done.erased.flatMap(pdfBoxes));
        }
      }
    } finally { pdf.destroy(); }
    return out;
  }

  /** What the folder step is handed: read and paint, with the reader, the codecs and the choice
   * about writing that could not be read already in it. */
  function service(svc) {
    return {
      parallel: svc.reader.size, marks: svc.marks || "keep",
      readPdf: (bytes, model) => readPdfPictures(svc, bytes, model),
      readPicture: (bytes, path) => readPictureFile(svc, bytes, path),
      canRead: (path) => (svc.codec ? svc.codec.canRead(path) : !!mimeOf(path)),
      paintPdf: (ctx, bytes, pictures) => paintPdfPictures(svc, ctx, bytes, pictures),
      paintPicture: (bytes, path, pictures, rows) => paintPictureFile(svc, bytes, path, pictures, rows),
    };
  }

  return { isIdCard, printedWords, photoSaid, toGray, resize, paper, flatten, lineMask, prepare, readPage, workerMain, SHARED, pool, pageText, profileParts, findOnPage, paint, verify, jpegQuality, bank, lineMetrics, refine, service,
    mimeOf, unread, pictureNote, readPictureFile, readPdfPictures, paintPictureFile, paintPdfPictures,
    orient, unorient, boxBack, placement, browserReader, decodeFile, encodeFile, deflate, glyphRenderer, pagePictures, pixelsOf };
})();
globalThis.PDFSwapOCR = PDFSwapOCR;
if (typeof module !== "undefined") module.exports = PDFSwapOCR;
