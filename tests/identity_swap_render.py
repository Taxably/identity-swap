"""Draws a PDF's pages for the node probes, as pdf.js draws them in the page: the page's own
renderer stands in for pdf.js, which needs a canvas node does not have.

    python identity_swap_render.py <pdf> <dpi> <most> <pages, comma-separated, or "all"> <out folder>

Writes each page's pixels (RGBA) to <out>/<page>.rgba and prints one JSON list: for each page its
index, size, resolution, where the file's own text sits on it (each character's box, in pixels),
and where the picture's corners fall in the page's own space (bottom left, bottom right, top left).
"""

import json
import os
import sys

import pypdfium2


def main() -> int:
    path, dpi, most, pages, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4], sys.argv[5]
    doc = pypdfium2.PdfDocument(path)
    want = range(len(doc)) if pages == "all" else [int(p) for p in pages.split(",") if p]
    listed = []
    for i in want:
        page = doc[i]
        if page.get_rotation():
            raise SystemExit("a turned page is not drawn here")
        x0, y0, x1, y1 = page.get_cropbox()
        scale = min(dpi / 72, most / max(x1 - x0, y1 - y0))
        img = page.render(scale=scale, may_draw_forms=True).to_pil().convert("RGBA")
        w, h = img.size
        with open(os.path.join(out, "%d.rgba" % i), "wb") as fh:
            fh.write(img.tobytes())
        tp = page.get_textpage()
        boxes = []
        for k in range(tp.count_chars()):
            if not tp.get_text_range(k, 1).strip():
                continue
            l, b, r, t = tp.get_charbox(k)
            boxes.append([int((l - x0) * scale), int((y1 - t) * scale), int((r - x0) * scale) + 1, int((y1 - b) * scale) + 1])
        listed.append({"page": i, "w": w, "h": h, "dpi": 72 * scale, "boxes": boxes,
                       "corners": [[x0, y0], [x0 + w / scale, y0], [x0, y0 + h / scale]]})
    print(json.dumps(listed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
