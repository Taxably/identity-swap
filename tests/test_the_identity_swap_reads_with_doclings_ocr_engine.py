"""The identity swap page reads with docling's OCR engine beside Tesseract, so what Tesseract
misses on a hard scan is still found and swapped, and a PDF whose text is not held as letters is
read as it is drawn, swapped, and never copied with a value still showing.

Docling reads a page with RapidOCR's PP-OCR models on ONNX Runtime; the page carries the same
models and runtime. tests/identity_swap_drawn_probe.js runs the page's own three steps in node
with both readers taken out of the built page, over a client folder made here of invented people:

  * a phone photo of a page: slightly turned, soft and grainy. Tesseract alone loses the spouse's
    SSN on it; with both readers every value is found
  * a tax summary set in Helvetica with the spouse's line drawn as shapes (no font at all)
  * a statement drawn wholly as shapes
  * a letter whose account number is a small picture set into the page

What is held: docling's reader starts; every file is swapped and passes every check (the PDFs'
pages that showed text the file does not hold as letters drawn again as pictures and painted, and
the report says so); and every copy, drawn and read again by both readers apart from the page's
checks, shows none of the original values.

Skipped where node is absent. Takes a few minutes: both readers run in one thread.
"""

import json
import os
import shutil
import subprocess
import sys
import zlib

import numpy as np
import pypdfium2
import pytest
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_drawn_probe.js")
PAGE = os.path.join(ROOT, "identity-swap.html")
ORIGINALS = ["Marisol", "Quillfeather", "481-27-3306", "Dmitri", "Okonkwo", "529-61-0447", "Juniper", "6021-4419", "555-0143"]


def _font(size):
    import reportlab
    return ImageFont.truetype(os.path.join(os.path.dirname(reportlab.__file__), "fonts", "Vera.ttf"), size)


def _esc(t):
    return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _text(t, x, y, s=11):
    return "BT /F1 %d Tf %d %d Td (%s) Tj ET\n" % (s, x, y, _esc(t))


def _shapes(text, x, y, size):
    """Path operators that draw `text` as filled rectangles traced from a 600 dpi rendering: text
    with no font, as a PDF printed with its text turned to outlines holds it."""
    sc = 600 / 72
    f = _font(int(size * sc))
    w, h = f.getbbox(text)[2] + 4, int(size * sc * 1.3)
    im = Image.new("1", (w, h), 1)
    ImageDraw.Draw(im).text((2, 0), text, font=f, fill=0)
    a = np.array(im)
    ops = []
    for r in range(h):
        row = ~a[r]
        c = 0
        while c < w:
            if row[c]:
                s = c
                while c < w and row[c]:
                    c += 1
                ops.append("%.2f %.2f %.2f %.2f re" % (x + s / sc, y + (h - r - 1) / sc - size * 0.25, (c - s) / sc, 1 / sc))
            else:
                c += 1
    return "0 g\n" + "\n".join(ops) + "\nf\n"


def _pdf(content, extra=(), xobject=""):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> "
            + xobject.encode() + b" >> >>",
            b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content.encode("latin-1")),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"] + list(extra)
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def _photo(path):
    """A page photographed with a phone: rendered at 170 dpi, turned 2.5 degrees, soft, grainy."""
    lines = ["Taxpayer: Marisol Quillfeather   SSN 481-27-3306", "Spouse: Dmitri Okonkwo-Vance   SSN 529-61-0447",
             "Address: 4418 Juniper Hollow Rd, Tucson, AZ 85745", "Phone (520) 555-0143   Account 6021-4419"]
    ops = "".join(_text(t, 54, 300 - 28 * i, 10) + "0.5 w 50 %d m 570 %d l S\n" % (297 - 28 * i, 297 - 28 * i) for i, t in enumerate(lines))
    pdf = _pdf(ops).replace(b"/MediaBox [0 0 612 792]", b"/MediaBox [0 0 612 324]")
    img = pypdfium2.PdfDocument(pdf)[0].render(scale=170 / 72).to_pil().convert("L")
    img = img.rotate(2.5, expand=True, fillcolor=235).filter(ImageFilter.GaussianBlur(0.9))
    a = np.array(img).astype(float) + np.random.default_rng(3).normal(0, 12, (img.size[1], img.size[0]))
    Image.fromarray(np.clip(a, 0, 255).astype("uint8")).save(path)


def _folder(d):
    os.makedirs(d)
    c = (_text("Form 1040 summary for tax year 2025", 72, 720, 14) + _text("Taxpayer: Marisol Quillfeather   SSN 481-27-3306", 72, 690)
         + _text("Address: 4418 Juniper Hollow Rd, Tucson, AZ 85745", 72, 670) + _shapes("Spouse: Dmitri Okonkwo   SSN 529-61-0447", 72, 640, 11))
    with open(os.path.join(d, "1040 summary.pdf"), "wb") as fh:
        fh.write(_pdf(c))
    c = (_shapes("Brokerage statement", 72, 720, 14) + _shapes("Account holder: Marisol Quillfeather", 72, 690, 11)
         + _shapes("Account 6021-4419   Phone (520) 555-0143", 72, 670, 11))
    with open(os.path.join(d, "statement outlined.pdf"), "wb") as fh:
        fh.write(_pdf(c))
    im = Image.new("L", (900, 110), 255)
    ImageDraw.Draw(im).text((10, 20), "Account 6021-4419", font=_font(44), fill=0)
    data = zlib.compress(im.tobytes())
    img = (b"<< /Type /XObject /Subtype /Image /Width 900 /Height 110 /ColorSpace /DeviceGray /BitsPerComponent 8"
           b" /Filter /FlateDecode /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
    c = _text("Payroll letter", 72, 720, 14) + _text("Employee: Marisol Quillfeather", 72, 690) + "q 300 0 0 36.7 72 600 cm /Im1 Do Q\n"
    with open(os.path.join(d, "payroll letter.pdf"), "wb") as fh:
        fh.write(_pdf(c, [img], "/XObject << /Im1 6 0 R >>"))
    _photo(os.path.join(d, "phone photo.png"))


def _probe(node, src, out, docling=True):
    env = dict(os.environ, IDENTITY_SWAP_DOCLING="1" if docling else "0")
    r = subprocess.run([node, PROBE, PAGE, src, out, sys.executable], capture_output=True, text=True, encoding="utf-8", timeout=1800, env=env)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's readers cannot be run here")
    d = tmp_path_factory.mktemp("docling")
    src = str(d / "in" / "Quillfeather, Marisol")
    _folder(src)
    both = _probe(node, src, str(d / "out"))
    # the photo alone, read by Tesseract alone
    alone = str(d / "alone" / "Quillfeather, Marisol")
    os.makedirs(alone)
    shutil.copy(os.path.join(src, "phone photo.png"), alone)
    tess = _probe(node, alone, str(d / "alone-out"), docling=False)
    return both, tess


def test_doclings_reader_starts(run):
    both, tess = run
    assert both["docling"] is True
    assert tess["docling"] is False


def test_tesseract_alone_misses_a_value_on_the_photo_that_both_readers_find(run):
    both, tess = run
    found = lambda r: {x["find"] for x in r["rows"]}  # noqa: E731
    assert "529-61-0447" not in found(tess)
    for value in ORIGINALS:
        assert any(value in f for f in found(both)), value


def test_every_file_is_swapped_and_passes_every_check(run):
    both, _ = run
    for r in both["results"]:
        assert r["result"] == "swapped", (r["path"], r["why"])
        assert all(c["passed"] for c in r["checks"]), (r["path"], r["checks"])


def test_pages_not_held_as_letters_are_drawn_again_and_the_report_says_so(run):
    both, _ = run
    status = {s["path"].split("/")[-1]: s for s in both["status"]}
    assert status["statement outlined.pdf"]["flatten"] == [0]
    assert status["1040 summary.pdf"]["drawn"] == [0]
    for r in both["results"]:
        if r["path"].endswith(".pdf"):
            assert any("drawn again as a picture" in w for w in r["warnings"]), r["path"]


def test_no_copy_shows_an_original_value_read_again_by_both_readers(run):
    both, _ = run
    assert len(both["reread"]) == 4
    for name, text in both["reread"].items():
        left = [v for v in ORIGINALS if v.lower() in text.lower()]
        assert not left, (name, left, text)
    # what was not a value is still there to read
    assert any("Brokerage statement" in t for t in both["reread"].values())
