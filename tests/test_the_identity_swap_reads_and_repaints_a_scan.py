"""The identity swap page reads a scanned page, paints every value over in the page's own letters,
and proves the copy: the new values read, the old ones do not, and nothing else moved.

A scan is made here: a page of invented people set in Times, Helvetica and Courier, rendered by
pdfium at 200 dpi onto slightly grey paper with grain, with a pen signature drawn under it.
tests/identity_swap_ocr_probe.js runs web/ocr.js in node with the OCR engine
and its model taken out of the built page, through the page's own read, paint and check, and then
reads the painted copy again by itself. What is held:

  * every value is found on the picture and painted, and the page's three checks pass
  * read again, apart from those checks, the copy holds every stand-in and none of the old values
  * every pixel outside the painted words is the scan's own, byte for byte (a PNG stays lossless)
  * a signature nobody can read is reported as such, and with "erase" chosen it is gone and the
    paper where it was is paper
  * a page fed in upside down is read the right way up and painted, and stays as it was fed
  * a value whose stand-in cannot be drawn either way is lifted off the paper and left blank, so
    the picture still comes back, with nothing of the value in it, and the report says so
  * a picture turned any of the eight ways and back is itself, and a box found on the turned
    picture names the same pixels of the picture as stored

Skipped where node is absent. Takes a minute or two: Tesseract runs in one thread.
"""

import io
import json
import os
import shutil
import subprocess

import numpy as np
import pypdfium2
import pytest
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_ocr_probe.js")
PAGE = os.path.join(ROOT, "identity-swap.html")

# Each face carries every letter its stand-ins need, so the painted words borrow only the page's
# own letters (in node there is no canvas to draw a missing one).
LINES = [
    ("F1", 12, "Dear Marisol, this statement is furnished to the Internal Revenue Service."),
    ("F1", 12, "From Form 1099: the quick brown fox jumps over the lazy dog, said Quillfeather."),
    ("F2", 11, "RECIPIENT MARISOL QUILLFEATHER    SSN 481-27-3306"),
    ("F2", 11, "PACK MY BOX WITH FIVE DOZEN LIQUOR JUGS 0123456789"),
    ("F3", 11, "Account 6021-4419   Phone (520) 555-0143"),
    ("F3", 11, "Reference 0123456789"),
]
ROWS = [
    ("Marisol", "Rosalie"), ("MARISOL", "ROSALIE"),
    ("Quillfeather", "Fairweathers"), ("QUILLFEATHER", "FAIRWEATHERS"),
    ("481-27-3306", "512-64-7790"), ("6021-4419", "6021-8835"), ("555-0143", "555-0187"),
]
DPI = 200


def _pdf():
    def esc(t):
        return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    ops = "".join("BT /%s %d Tf 54 %d Td (%s) Tj ET\n" % (f, s, 300 - 24 * i, esc(t)) for i, (f, s, t) in enumerate(LINES))
    fonts = {"F1": "Times-Roman", "F2": "Helvetica", "F3": "Courier"}
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 324] /Contents 4 0 R /Resources << /Font << "
        + b" ".join(b"/%s %d 0 R" % (k.encode(), 5 + i) for i, k in enumerate(fonts)) + b" >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(ops), ops.encode("latin-1")),
    ] + [b"<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>" % v.encode() for v in fonts.values()]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (n, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def _scan(signed):
    page = pypdfium2.PdfDocument(_pdf())[0].render(scale=DPI / 72).to_pil().convert("RGB")
    if signed:
        # a pen signature, far taller than the print and nothing a reader can make out
        draw = ImageDraw.Draw(page)
        pts = [(260 + 9 * k, 790 + (34 if k % 4 == 1 else -30 if k % 4 == 3 else 0) + (k % 3) * 6) for k in range(52)]
        draw.line(pts, fill=(28, 34, 92), width=4, joint="curve")
        draw.line([(280, 760), (310, 840), (338, 752)], fill=(28, 34, 92), width=4)
    px = np.asarray(page).astype(np.float64)
    rng = np.random.default_rng(11)
    px = px * np.array([0.965, 0.96, 0.95]) + rng.normal(0, 3.0, px.shape[:2])[..., None]
    return Image.fromarray(np.clip(px, 0, 255).astype(np.uint8))


def _png(img, path):
    img.save(path, format="PNG")
    return path


@pytest.fixture(scope="module")
def probe(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's reader cannot be run here")
    d = tmp_path_factory.mktemp("scan")
    signed = _scan(signed=True)
    jobs = [
        {"image": _png(signed, str(d / "signed.png")), "out": str(d / "signed-out.png"), "marks": "keep"},
        {"image": str(d / "signed.png"), "out": str(d / "erased-out.png"), "marks": "erase"},
        {"image": _png(_scan(signed=False).rotate(180), str(d / "upside.png")), "out": str(d / "upside-out.png"), "marks": "keep"},
    ]
    rows = [{"id": i + 1, "find": f, "replace": r} for i, (f, r) in enumerate(ROWS)]
    for j in jobs:
        j["rows"] = rows
    # a stand-in with a mark the page never prints, and no font here to draw it: the value is
    # blanked out rather than the picture held back
    jobs.append({"image": str(d / "signed.png"), "out": str(d / "blanked-out.png"), "marks": "keep",
                 "rows": rows[:-1] + [{"id": len(rows), "find": ROWS[-1][0], "replace": "555-0@@7", "label": "phone"}]})
    with open(d / "jobs.json", "w", encoding="utf-8") as fh:
        json.dump(jobs, fh)
    r = subprocess.run([node, PROBE, PAGE, str(d / "jobs.json")], capture_output=True, text=True, encoding="utf-8", timeout=900)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    for job, res in zip(jobs, out["results"]):
        res["job"] = job
    return out



def test_every_value_is_found_painted_and_checked(probe):
    res = probe["results"][0]
    assert res["written"], res
    assert all(c["passed"] for c in res["checks"]), res["checks"]
    assert {c["name"] for c in res["checks"]} == {"stand-ins read back", "nothing left in the picture", "picture outside the swapped words"}
    painted = {o["find"] for o in res["occurrences"] if o["replaced"]}
    assert painted == {f for f, _ in ROWS}, res["occurrences"]
    assert not [o for o in res["occurrences"] if not o["replaced"]]


def test_read_again_the_copy_holds_the_stand_ins_and_none_of_the_old_values(probe):
    for res in (probe["results"][0], probe["results"][2]):
        again = res["reread"].replace(" ", "")
        assert not [f for f, _ in ROWS if f.replace(" ", "") in again], again
        assert not [r for _, r in ROWS if r.replace(" ", "") not in again], again


def test_nothing_outside_the_painted_words_moves(probe):
    res = probe["results"][0]
    before = np.asarray(Image.open(res["job"]["image"]).convert("RGB")).astype(int)
    after = np.asarray(Image.open(res["job"]["out"]).convert("RGB")).astype(int)
    assert before.shape == after.shape
    allowed = np.zeros(before.shape[:2], bool)
    for o in res["occurrences"]:
        for _page, (x0, y0, x1, y1) in o["boxes"]:
            allowed[max(0, y0 - 2):y1 + 2, max(0, x0 - 2):x1 + 2] = True
    moved = (before != after).any(axis=2)
    assert moved[allowed].any(), "nothing was painted"
    assert not moved[~allowed].any(), "%d pixels outside the painted words changed" % moved[~allowed].sum()


def test_a_signature_is_reported_and_kept_unless_erase_is_chosen(probe):
    keep, erase = probe["results"][0], probe["results"][1]
    assert any("writing that could not be read" in w for w in keep["warnings"]), keep["warnings"]
    assert keep["erased"] == 0
    assert erase["written"] and all(c["passed"] for c in erase["checks"]), erase["checks"]
    assert erase["erased"] >= 1
    assert any("erased" in w for w in erase["warnings"]), erase["warnings"]
    before = np.asarray(Image.open(erase["job"]["image"]).convert("L")).astype(int)
    kept = np.asarray(Image.open(keep["job"]["out"]).convert("L")).astype(int)
    gone = np.asarray(Image.open(erase["job"]["out"]).convert("L")).astype(int)
    region = (slice(735, 860), slice(250, 740))
    assert (kept[region] < 120).sum() > 500, "the signature was kept with keep chosen"
    assert (gone[region] < 150).sum() == 0, "ink of the signature is left"
    paper = before[60:100, 1300:1600]
    assert abs(gone[region].mean() - paper.mean()) < 4, "the erased place is not the colour of the paper"
    assert gone[region].std() > 1.0, "the erased place has none of the paper's grain"


def test_a_page_fed_upside_down_is_read_the_right_way_up_and_kept_as_fed(probe):
    res = probe["results"][2]
    assert res["turned"] == [-1, 0, 0, -1]
    assert res["written"] and all(c["passed"] for c in res["checks"]), res["checks"]
    assert {o["find"] for o in res["occurrences"] if o["replaced"]} == {f for f, _ in ROWS}
    fed = Image.open(res["job"]["image"])
    out = Image.open(res["job"]["out"])
    assert out.size == fed.size
    a = np.asarray(fed.convert("L")).astype(int)
    b = np.asarray(out.convert("L")).astype(int)
    # the top strip of an upside-down page is the bottom margin of the page: untouched
    assert (a[:60] == b[:60]).all()


def test_a_picture_turned_any_way_and_back_is_itself(probe):
    assert len(probe["orientation"]) == 8
    for o in probe["orientation"]:
        assert o["roundTrip"] and o["boxes"], o


def test_no_scan_is_read_slower_than_a_minute_and_a_half(probe):
    assert max(r["seconds"] for r in probe["results"]) < 90, [r["seconds"] for r in probe["results"]]


def test_a_value_that_cannot_be_drawn_is_blanked_out_and_the_picture_still_comes_back(probe):
    res = probe["results"][3]
    assert res["written"] and all(c["passed"] for c in res["checks"]), res["checks"]
    assert all(o["replaced"] for o in res["occurrences"]), res["occurrences"]
    assert any("blanked out" in w and "phone" in w for w in res["warnings"]), res["warnings"]
    again = res["reread"].replace(" ", "")
    assert "555-0143" not in again and "555-0@@7" not in again, again
    # every other value is drawn in its stand-in as before
    assert not [r for f, r in ROWS[:-1] if r.replace(" ", "") not in again], again
