/* PDF identity swap: the photo on an ID card, found and replaced with a plain silhouette.
 *
 * Faces are found with the Viola-Jones method (Haar-like features in a boosted cascade, the
 * detector OpenCV made standard), as tracking.js implements it, with its frontal-face cascade
 * (BSD). It is a fixed set of pixel comparisons: no model is trained or asked here, and nothing
 * leaves the page. A face counts only where no printed word sits; the largest is the card's photo,
 * whose frame is found by its straight edges. The faint copy many cards print beside it (the
 * "ghost" image) is found by matching the photo itself at smaller sizes, contrast aside. Each is
 * painted over with a flat panel and a head-and-shoulders silhouette in the card's own greys.
 */
const PDFSwapFaces = (() => {
  "use strict";
  const gray = (img) => {
    const g = new Float32Array(img.w * img.h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
    return g;
  };
  /** A picture at another size, by averaging (RGBA in, RGBA out). */
  function shrink(img, w, h) {
    const out = new Uint8ClampedArray(w * h * 4), sx = img.w / w, sy = img.h / h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      const acc = [0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.w + xx) * 4; acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2]; n++; }
      const o = (y * w + x) * 4;
      out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = 255;
    }
    return { w, h, data: out };
  }
  /** Faces in a picture, [{x, y, w, h, n}] in its own pixels, n the detections merged into each. Searched at no more than 1200 pixels
   * across, from 24 pixels up there: a card on a scanned page is a small part of it. */
  function detect(img) {
    const T = globalThis.tracking;
    if (!T || !T.ViolaJones || !T.ViolaJones.classifiers.face) return [];
    const s = Math.min(1, 1200 / Math.max(img.w, img.h));
    const small = s < 1 ? shrink(img, Math.round(img.w * s), Math.round(img.h * s)) : img;
    const rects = T.ViolaJones.detect(small.data, small.w, small.h, 24 / 20, 1.1, 1, 0.2, T.ViolaJones.classifiers.face);
    return rects.map((r) => ({ x: r.x / s, y: r.y / s, w: r.width / s, h: r.height / s, n: r.total || 1 }));
  }
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

  /** The photo's frame around a face: on each side, the nearest straight edge that runs the
   * whole length of that side with the card's plain ground beyond it (a photo's border does; the
   * folds of a shirt and a card's printed band do not), else a generous head-and-shoulders box;
   * never over a printed word. */
  function frame(img, g, face, words) {
    const { w: W, h: H } = img, cx = face.x + face.w / 2;
    const clampX = (v) => Math.max(1, Math.min(W - 2, Math.round(v))), clampY = (v) => Math.max(1, Math.min(H - 2, Math.round(v)));
    const STEP = 12; // a change of this much grey, across a pixel, is an edge
    // the share of a line, along its length, that is an edge (a pixel either side allowed)
    const colScore = (x, y0, y1) => {
      let n = 0, t = 0;
      for (let y = y0; y < y1; y++, t++) {
        let m = 0;
        for (const dx of [-1, 0, 1]) { const xx = x + dx; if (xx >= 1 && xx < W) m = Math.max(m, Math.abs(g[y * W + xx] - g[y * W + xx - 1])); }
        if (m > STEP) n++;
      }
      return t ? n / t : 0;
    };
    const rowScore = (y, x0, x1) => {
      let n = 0, t = 0;
      for (let x = x0; x < x1; x++, t++) {
        let m = 0;
        for (const dy of [-1, 0, 1]) { const yy = y + dy; if (yy >= 1 && yy < H) m = Math.max(m, Math.abs(g[yy * W + x] - g[(yy - 1) * W + x])); }
        if (m > STEP) n++;
      }
      return t ? n / t : 0;
    };
    // how busy a line is along its own length: a photo is, the card's ground is not (a printed
    // rule along the line is not busy along it either)
    const busyRow = (y, a, b) => { if (y < 0 || y >= H) return 99; let n = 0; for (let x = a + 1; x < b; x++) n += Math.abs(g[y * W + x] - g[y * W + x - 1]); return n / Math.max(1, b - a - 1); };
    const busyCol = (x, a, b) => { if (x < 0 || x >= W) return 99; let n = 0; for (let y = a + 1; y < b; y++) n += Math.abs(g[y * W + x] - g[(y - 1) * W + x]); return n / Math.max(1, b - a - 1); };
    const median = (vs) => vs.sort((p, q) => p - q)[vs.length >> 1];
    // going out from the face, the first line that is an edge along most of its length and has
    // the card's plain ground just beyond it (a collar, or a helmet over a shirt, is an edge with
    // more photo past it); with none, the first edge; with no edge, a generous box
    // returns the line and whether it is sure (plain ground beyond it)
    const nearest = (from, to, score, busy, fallback) => {
      const dir = to >= from ? 1 : -1;
      let first = null;
      for (let v = from; dir > 0 ? v <= to : v >= to; v += dir) {
        if (score(v) < 0.75) continue;
        if (first === null) first = v;
        const beyond = [];
        for (let k = 4; k <= 10; k++) beyond.push(busy(v + dir * k));
        if (median(beyond) < 6) return [v, true];
      }
      return [first === null ? fallback : first, false];
    };
    const ys = [clampY(face.y - 0.25 * face.h), clampY(face.y + 1.6 * face.h)];
    let [x0, s0] = nearest(clampX(cx - 0.62 * face.w), clampX(cx - 1.6 * face.w), (x) => colScore(x, ys[0], ys[1]), (x) => busyCol(x, ys[0], ys[1]), clampX(cx - 1.15 * face.w));
    let [x1, s1] = nearest(clampX(cx + 0.62 * face.w), clampX(cx + 1.6 * face.w), (x) => colScore(x, ys[0], ys[1]), (x) => busyCol(x, ys[0], ys[1]), clampX(cx + 1.15 * face.w));
    const xIn = [clampX(Math.max(x0, cx - 0.85 * face.w)), clampX(Math.min(x1, cx + 0.85 * face.w))];
    let [y0, t0] = nearest(clampY(face.y - 0.12 * face.h), clampY(face.y - 1.2 * face.h), (y) => rowScore(y, xIn[0], xIn[1]), (y) => busyRow(y, xIn[0], xIn[1]), clampY(face.y - 0.7 * face.h));
    let [y1, t1] = nearest(clampY(face.y + 1.25 * face.h), clampY(face.y + 3.2 * face.h), (y) => rowScore(y, xIn[0], xIn[1]), (y) => busyRow(y, xIn[0], xIn[1]), clampY(face.y + 2.4 * face.h));
    // a printed word beside the photo bounds a side the edges were not sure of (a word inside a
    // sure frame is the reader making letters of the photo's shading)
    const sure = [x0, y0, x1, y1];
    for (const b of words) {
      if (!overlap([x0, y0, x1, y1], b)) continue;
      if (s0 && s1 && t0 && t1 && b[0] >= sure[0] && b[2] <= sure[2] && b[1] >= sure[1] && b[3] <= sure[3]) continue;
      if (b[2] <= face.x && !s0) x0 = Math.max(x0, b[2] + 2);
      else if (b[0] >= face.x + face.w && !s1) x1 = Math.min(x1, b[0] - 2);
      else if (b[1] >= face.y + face.h && !t1) y1 = Math.min(y1, b[1] - 2);
      else if (b[3] <= face.y && !t0) y0 = Math.max(y0, b[3] + 2);
    }
    // the border itself goes with the photo
    return [Math.max(0, x0 - 2), Math.max(0, y0 - 2), Math.min(W, x1 + 3), Math.min(H, y1 + 3)];
  }

  /** Where the photo's smaller copy is: the photo matched at a third to two thirds of its size,
   * by normalised correlation (so a copy printed faint still matches), on a picture shrunk to
   * 360 pixels across. */
  function ghosts(img, box, words) {
    const s = Math.min(1, 360 / Math.max(img.w, img.h));
    const small = shrink(img, Math.max(1, Math.round(img.w * s)), Math.max(1, Math.round(img.h * s)));
    const g = gray(small), W = small.w, H = small.h;
    const bx = box.map((v) => Math.round(v * s));
    const tw0 = bx[2] - bx[0], th0 = bx[3] - bx[1];
    if (tw0 < 12 || th0 < 12) return [];
    // every place the photo, taken from `src`, matches at a third to two thirds of its size
    const scan = (src, lo = 0.6) => {
      const found = [];
      for (const k of [0.3, 0.38, 0.46, 0.55, 0.65]) {
        const tw = Math.round(tw0 * k), th = Math.round(th0 * k);
        if (tw < 8 || th < 8) continue;
        // the photo, at this size, zero-mean and unit length
        const t = new Float32Array(tw * th);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) t[y * tw + x] = src[(bx[1] + Math.floor(y / k)) * W + bx[0] + Math.floor(x / k)] || 0;
        let mt = 0; for (const v of t) mt += v; mt /= t.length;
        let nt = 0; for (let i = 0; i < t.length; i++) { t[i] -= mt; nt += t[i] * t[i]; }
        nt = Math.sqrt(nt) || 1;
        for (let y = 0; y + th <= H; y += 2) for (let x = 0; x + tw <= W; x += 2) {
          if (overlap([x, y, x + tw, y + th], bx) > 0) continue;
          let m = 0;
          for (let yy = 0; yy < th; yy++) for (let xx = 0; xx < tw; xx++) m += g[(y + yy) * W + x + xx];
          m /= tw * th;
          let num = 0, den = 0;
          for (let yy = 0; yy < th; yy++) for (let xx = 0; xx < tw; xx++) { const v = g[(y + yy) * W + x + xx] - m; num += v * t[yy * tw + xx]; den += v * v; }
          const c = den > 0 ? num / (Math.sqrt(den) * nt) : 0;
          if (c > lo) found.push({ c, b: [x / s, y / s, (x + tw) / s, (y + th) / s] });
        }
      }
      return found.sort((p, q) => q.c - p.c);
    };
    // the best match of each place; one with printed words over it counts only when it matches
    // the photo closely, and is marked so its words are kept
    const out = [];
    for (const f of scan(g)) {
      if (out.some((o) => overlap(o, f.b) > 0)) continue;
      const area = (f.b[2] - f.b[0]) * (f.b[3] - f.b[1]);
      const under = words.reduce((n, w) => n + (printed(img, f.b, w) ? overlap(w, f.b) : 0), 0) > 0.05 * area;
      if (under && f.c < 0.72) continue;
      // a second copy has to match as closely as a copy does (0.9 on the cards tried), not as
      // loosely as a patch of pattern can (0.6)
      if (out.length && f.c < 0.75) continue;
      const b = f.b.map(Math.round);
      b.faint = true;
      if (under) b.under = true;
      out.push(b);
    }
    if (out.length || !bilevel(img)) return out.slice(0, 2);
    // a black-and-white fax keeps only the darkest parts of a faint copy (a helmet, the hair, the
    // shadow under a chin), so the photo is matched again with each of its dark areas shrunk to
    // its core. A match counts when it is the one place that stands out: on the cards tried the
    // copy matches at 0.6 and the best of anywhere else at 0.48. No printed word may sit over it
    const all = scan(cores(img, box, s, W, g), 0.3).filter((f) => !words.some((w) => printed(img, f.b, w) && overlap(w, f.b) > 0));
    const best = all[0];
    if (!best || best.c < 0.55) return [];
    const rival = all.find((f) => overlap(f.b, best.b) === 0);
    if (rival && best.c - rival.c < 0.08) return [];
    // the copy's specks reach a little past where the photo's shape puts it
    const px = 0.06 * (best.b[2] - best.b[0]), py = 0.06 * (best.b[3] - best.b[1]);
    let b = [Math.max(0, best.b[0] - px), Math.max(0, best.b[1] - py), Math.min(img.w, best.b[2] + px), Math.min(img.h, best.b[3] + py)].map(Math.round);
    // a place with no ink in it holds no copy, however its blank paper happens to match
    if (inkShare(img, b) < 0.03) return [];
    b = withSpecks(img, b, words);
    b.faint = true;
    return [b];
  }
  /** The picture shrunk as `ghosts` shrinks it, with the photo's dark areas first shrunk to their
   * cores at full size (each pixel of the photo the lightest within a fortieth of its width,
   * row-wise then column-wise), then averaged down: what a faint copy keeps once faxed. */
  function cores(img, box, s, W, g) {
    const [x0, y0, x1, y1] = box.map(Math.round), bw = x1 - x0, bh = y1 - y0, R = Math.max(1, Math.round(0.025 * bw));
    const lum = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = ((y0 + y) * img.w + x0 + x) * 4; lum[y * bw + x] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; }
    const rowMax = new Float32Array(bw * bh), m = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let v = 0; for (let k = Math.max(0, x - R); k <= Math.min(bw - 1, x + R); k++) v = Math.max(v, lum[y * bw + k]); rowMax[y * bw + x] = v; }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let v = 0; for (let k = Math.max(0, y - R); k <= Math.min(bh - 1, y + R); k++) v = Math.max(v, rowMax[k * bw + x]); m[y * bw + x] = v; }
    const out = new Float32Array(g);
    const sx0 = Math.round(x0 * s), sy0 = Math.round(y0 * s), sx1 = Math.round(x1 * s), sy1 = Math.round(y1 * s);
    for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
      const fx0 = Math.max(0, Math.floor(x / s) - x0), fx1 = Math.min(bw, Math.floor((x + 1) / s) - x0), fy0 = Math.max(0, Math.floor(y / s) - y0), fy1 = Math.min(bh, Math.floor((y + 1) / s) - y0);
      let t = 0, n = 0;
      for (let yy = fy0; yy < fy1; yy++) for (let xx = fx0; xx < fx1; xx++) { t += m[yy * bw + xx]; n++; }
      if (n) out[y * W + x] = t / n;
    }
    return out;
  }
  const darkAt = (img, x, y) => { const i = (y * img.w + x) * 4; return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] < 128; };
  function inkShare(img, [x0, y0, x1, y1]) {
    let n = 0, d = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) if (darkAt(img, x, y)) d++;
    return n ? d / n : 0;
  }
  /** A faxed copy's box taken out to the specks of ink that touch it and reach past it (a fax
   * keeps what it keeps of the face, not its outline), up to a quarter of its size further on each
   * side, and never over a printed word. */
  function withSpecks(img, b, words) {
    const qx = Math.round(0.25 * (b[2] - b[0])), qy = Math.round(0.25 * (b[3] - b[1]));
    const X0 = Math.max(0, b[0] - qx), Y0 = Math.max(0, b[1] - qy), X1 = Math.min(img.w, b[2] + qx), Y1 = Math.min(img.h, b[3] + qy), W = X1 - X0, H = Y1 - Y0;
    const seen = new Uint8Array(W * H), out = b.slice(), stack = [];
    const word = (x, y) => words.some((w) => x >= w[0] && x < w[2] && y >= w[1] && y < w[3]);
    for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) {
      const k = (y - Y0) * W + (x - X0);
      if (seen[k] || !darkAt(img, x, y)) continue;
      seen[k] = 1; stack.push(k);
      while (stack.length) {
        const q = stack.pop(), qx2 = q % W + X0, qy2 = ((q / W) | 0) + Y0;
        if (word(qx2, qy2)) continue;
        out[0] = Math.min(out[0], qx2); out[1] = Math.min(out[1], qy2); out[2] = Math.max(out[2], qx2 + 1); out[3] = Math.max(out[3], qy2 + 1);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx2 + dx, ny = qy2 + dy;
          if (nx < X0 || ny < Y0 || nx >= X1 || ny >= Y1) continue;
          const nk = (ny - Y0) * W + (nx - X0);
          if (!seen[nk] && darkAt(img, nx, ny)) { seen[nk] = 1; stack.push(nk); }
        }
      }
    }
    return out;
  }
  /** Whether a picture is black and white (a fax, a bilevel scan): next to no greys between,
   * at its own size (a picture shrunk by averaging has greys of its own). */
  function bilevel(img) {
    let mid = 0, n = 0;
    for (let i = 0; i < img.w * img.h; i += 7, n++) { const v = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]; if (v > 40 && v < 215) mid++; }
    return n > 0 && mid < 0.08 * n;
  }

  /** Whether what the detector took for a face is a photo: a block of bold print can pass the
   * detector, and is mostly the plain ground it is printed on (three quarters or more of it
   * within a few greys of its lightest tenth); a face is not (about a third to a half, on the
   * cards tried, in colour, grey or black and white). */
  function photoLike(img, g, f) {
    const x0 = Math.max(0, Math.round(f.x)), y0 = Math.max(0, Math.round(f.y)), x1 = Math.min(img.w, Math.round(f.x + f.w)), y1 = Math.min(img.h, Math.round(f.y + f.h));
    const vals = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(g[y * img.w + x]);
    if (!vals.length) return false;
    const ground = [...vals].sort((a, b) => a - b)[Math.floor(0.9 * vals.length)];
    return vals.filter((v) => v >= ground - 25).length / vals.length < 0.72;
  }
  /** The card's photo (and its faint copy), as boxes: [] when no face is found. `words` are the
   * boxes of words read with confidence, which no photo covers. */
  function find(img, words) {
    const g = gray(img), minSide = Math.min(img.w, img.h);
    const faces = detect(img).filter((f) => f.w >= Math.max(24, 0.02 * minSide) && photoLike(img, g, f) && !words.some((b) => overlap(b, [f.x, f.y, f.x + f.w, f.y + f.h]) > 0.15 * f.w * f.h));
    if (!faces.length) return { portrait: null, ghosts: [] };
    // the one the detector found most often over nearby places and sizes (a face is found many
    // times over, a block of print that happens to pass is found once), then the largest
    const face = faces.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.w > a.w) ? b : a));
    const box = frame(img, g, face, words);
    return { portrait: box, ghosts: ghosts(img, box, words) };
  }

  /** A flat panel and a head-and-shoulders silhouette over a box, in greys taken from the card
   * around it (a black-and-white scan gets a white panel and a black outline). */
  function paint(img, box, { bilevel = false, under = false, faint = false } = {}) {
    const [x0, y0, x1, y1] = box.map(Math.round), W = x1 - x0, H = y1 - y0;
    if (W < 4 || H < 4) return;
    if (under) return flatten(img, [x0, y0, x1, y1]);
    // the card just outside the box, for the panel's tone
    const ring = [];
    for (let x = x0; x < x1; x += 2) for (const y of [y0 - 3, y1 + 2]) if (y >= 0 && y < img.h) { const i = (y * img.w + x) * 4; ring.push(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]); }
    ring.sort((a, b) => a - b);
    const card = ring.length ? ring[ring.length >> 1] : 230;
    // the faint copy gets a faint silhouette, close to the card's own tone
    const panel = bilevel ? 255 : faint ? Math.max(150, card * 0.96) : Math.max(150, Math.min(225, card * 0.88));
    const figure = bilevel ? 0 : panel * (faint ? 0.86 : 0.72), edge = bilevel ? 0 : panel * (faint ? 0.92 : 0.8);
    const cx = W / 2, hy = 0.38 * H, hr = Math.min(0.2 * W, 0.17 * H), sy = 1.02 * H, srx = 0.46 * W, sry = 0.36 * H;
    // inside the silhouette, at a point of the box (head circle, or the shoulders' ellipse)
    const inside = (x, y) => (x - cx) ** 2 / (hr * 0.9) ** 2 + (y - hy) ** 2 / hr ** 2 <= 1 || (y <= H && (x - cx) ** 2 / srx ** 2 + (y - sy) ** 2 / sry ** 2 <= 1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v;
      if (bilevel) {
        // an outline two pixels wide, and the frame
        const on = inside(x + 0.5, y + 0.5), near = [[-2, 0], [2, 0], [0, -2], [0, 2]].some(([dx, dy]) => inside(x + 0.5 + dx, y + 0.5 + dy) !== on);
        // the faint copy had no frame of its own: white, and the silhouette's outline
        v = near || (!faint && (x < 2 || y < 2 || x >= W - 2 || y >= H - 2)) ? 0 : 255;
      } else {
        // four samples a pixel, so the outline is smooth
        let n = 0;
        for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) if (inside(x + dx, y + dy)) n++;
        v = panel + (figure - panel) * (n / 4);
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) v = edge;
      }
      const i = ((y0 + y) * img.w + x0 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }

  /** A faint copy of the photo with words printed over it: every pixel that is not the print
   * (darker than half the card, and the pixel beside it) takes the card's own colour, so the face
   * is gone and the words are where they were. */
  const lumAt = (img, i) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  /** The card's colour just outside a box: the middle of each channel, and its grey. */
  function cardTone(img, [x0, y0, x1, y1]) {
    const ring = [[], [], []];
    const take = (x, y) => { if (x < 0 || y < 0 || x >= img.w || y >= img.h) return; const i = (y * img.w + x) * 4; for (let c = 0; c < 3; c++) ring[c].push(img.data[i + c]); };
    for (let x = x0; x < x1; x += 2) { take(x, y0 - 3); take(x, y1 + 2); }
    for (let y = y0; y < y1; y += 2) { take(x0 - 3, y); take(x1 + 2, y); }
    const mid = ring.map((r) => (r.sort((a, b) => a - b), r.length ? r[r.length >> 1] : 235));
    return { mid, card: 0.299 * mid[0] + 0.587 * mid[1] + 0.114 * mid[2] };
  }
  /** Whether a word inside a faint copy is print (some of it darker than half the card around the
   * copy) or the reader making letters of the face's shading. */
  function printed(img, copy, word) {
    const { card } = cardTone(img, copy);
    let n = 0, dark = 0;
    for (let y = Math.max(0, Math.round(word[1])); y < Math.min(img.h, Math.round(word[3])); y++) for (let x = Math.max(0, Math.round(word[0])); x < Math.min(img.w, Math.round(word[2])); x++, n++) if (lumAt(img, (y * img.w + x) * 4) < card * 0.5) dark++;
    return n > 0 && dark / n >= 0.04;
  }
  function flatten(img, [x0, y0, x1, y1]) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(img.w, x1); y1 = Math.min(img.h, y1);
    const W = x1 - x0, H = y1 - y0, lum = (i) => lumAt(img, i);
    const { mid, card } = cardTone(img, [x0, y0, x1, y1]);
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lum(((y0 + y) * img.w + x0 + x) * 4) < card * 0.5) ink[y * W + x] = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let keep = false;
      for (let dy = -1; dy <= 1 && !keep; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < H && xx < W && ink[yy * W + xx]) { keep = true; break; } }
      if (keep) continue;
      const i = ((y0 + y) * img.w + x0 + x) * 4;
      img.data[i] = mid[0]; img.data[i + 1] = mid[1]; img.data[i + 2] = mid[2];
    }
  }

  return { detect, find, paint, frame, ghosts, printed };
})();
globalThis.PDFSwapFaces = PDFSwapFaces;
if (typeof module !== "undefined") module.exports = PDFSwapFaces;
