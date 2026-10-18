/* PDF identity swap: the checks only a renderer can make. pdf.js draws each changed page of the
 * original and the copy, form fields included, and the copy is kept only if every pixel outside
 * the swapped words and changed fields is the same, the page text reads exactly as planned, and
 * every swapped word drew something wherever the original did. */
const PDFSwapCheck = (() => {
  "use strict";
  const SCALE = 1.5; // 108 dpi: a changed letter is many pixels
  const DIFF = 48; // a channel must move this much (of 255) to count
  const PAD = 1.5; // points around a swapped word where its picture may change
  const INK = 40;

  const open = (bytes) => pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  async function render(page) {
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    return { viewport, canvas, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  }
  // A line ends where pdf.js says it does; without the break, the last word of one line runs into
  // the first of the next and a whole-word match is refused in the expected text only.
  // Pieces drawn apart on one line (a form's columns, drawn in any order) are kept apart too, or
  // "J" runs into the surname drawn after it.
  async function text(page) {
    const tc = await page.getTextContent();
    let out = "", prev = null;
    for (const i of tc.items) {
      if (typeof i.str !== "string") continue;
      if (prev && out && !/\s$/.test(out)) {
        const h = Math.abs(i.transform[3]) || Math.abs(prev.transform[3]) || 10;
        const ex = prev.transform[4] + prev.width, ey = prev.transform[5];
        if (Math.abs(i.transform[4] - ex) > 0.15 * h || Math.abs(i.transform[5] - ey) > 0.5 * h) out += " ";
      }
      out += i.str + (i.hasEOL ? "\n" : "");
      prev = i;
    }
    return out;
  }
  function expected(textBefore, prepared) {
    return PDFSwapEngine.swapPlain(textBefore, prepared)[0];
  }

  /** Checks for one file. `res.allowed` (page -> boxes in PDF space) comes from the engine. */
  async function check(original, output, res, rows) {
    const pages = [...(res.allowed ? res.allowed.keys() : [])].sort((a, b) => a - b);
    const prepared = PDFSwapEngine.prepareRows(rows.map((r) => ({ ...r })));
    const textBad = [], pixBad = [], inkBad = [];
    const [a, b] = [await open(original), await open(output)];
    try {
      for (const p of pages) {
        const [pa, pb] = [await a.getPage(p + 1), await b.getPage(p + 1)];
        const want = expected(await text(pa), prepared), got = await text(pb);
        if (want !== got) {
          // which kind of difference, never the text itself
          const flat = (t) => t.replace(/\s+/g, "");
          textBad.push("page " + (p + 1) + (flat(want) === flat(got) ? " (only where a space falls)" : " (characters differ)"));
        }
        const [ra, rb] = [await render(pa), await render(pb)];
        const w = ra.canvas.width, h = ra.canvas.height;
        if (w !== rb.canvas.width || h !== rb.canvas.height) { pixBad.push("page " + (p + 1) + " changed size"); continue; }
        const mask = new Uint8Array(w * h), boxes = [];
        for (const box of res.allowed.get(p)) {
          const r = ra.viewport.convertToViewportRectangle([box[0] - PAD, box[1] - PAD, box[2] + PAD, box[3] + PAD]);
          const x0 = Math.max(0, Math.floor(Math.min(r[0], r[2]))), x1 = Math.min(w, Math.ceil(Math.max(r[0], r[2])));
          const y0 = Math.max(0, Math.floor(Math.min(r[1], r[3]))), y1 = Math.min(h, Math.ceil(Math.max(r[1], r[3])));
          boxes.push([x0, y0, x1, y1]);
          for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
        }
        // A renderer can land text that has not moved one pixel over at some sizes; a pixel counts
        // as changed only when nothing within a pixel of it in the other picture matches it. A
        // letter that changed or a mark drawn or lost still counts; a real move is the positions
        // check's.
        let outside = 0;
        const A = ra.pixels, B = rb.pixels;
        const same = (P, i, Q, j) => Math.abs(P[i] - Q[j]) <= DIFF && Math.abs(P[i + 1] - Q[j + 1]) <= DIFF && Math.abs(P[i + 2] - Q[j + 2]) <= DIFF;
        const near = (P, Q, x, y) => {
          const i = (y * w + x) * 4;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && same(P, i, Q, (yy * w + xx) * 4)) return true;
          }
          return false;
        };
        for (let i = 0, k = 0; k < w * h; k++, i += 4) {
          if (mask[k] || same(A, i, B, i)) continue;
          const x = k % w, y = (k - x) / w;
          if (!near(A, B, x, y) || !near(B, A, x, y)) outside++;
        }
        if (outside) pixBad.push("page " + (p + 1) + ": " + outside + " pixels changed outside the swapped text");
        // A box fails when the original showed ink there and the copy shows none. A form that
        // asks the viewer to redraw its fields from their values (NeedAppearances) is drawn by
        // pdf.js from a font it may not have, so such a box can be blank in both; the engine's
        // own checks cover what is in it.
        const spread = (P, x0, y0, x1, y1) => {
          let lo = 255, hi = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4, g = (P[i] + P[i + 1] + P[i + 2]) / 3; if (g < lo) lo = g; if (g > hi) hi = g; }
          return hi - lo;
        };
        for (const [x0, y0, x1, y1] of boxes) {
          if (x1 <= x0 || y1 <= y0) continue;
          if (spread(A, x0, y0, x1, y1) >= INK && spread(B, x0, y0, x1, y1) < INK) { inkBad.push("page " + (p + 1)); break; }
        }
      }
    } finally { a.destroy(); b.destroy(); }
    return [
      { name: "page text", passed: !textBad.length, detail: textBad.length ? "reads differently than planned on " + textBad.join(", ") : "" },
      { name: "picture", passed: !pixBad.length, detail: pixBad.join("; ") },
      { name: "new text drawn", passed: !inkBad.length, detail: inkBad.length ? "a swapped word drew nothing on " + inkBad.join(", ") : "" },
    ];
  }
  return { check };
})();

globalThis.PDFSwapCheck = PDFSwapCheck;
