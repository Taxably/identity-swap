"""The identity swap page takes the person off a driver licence: the photo and its faint copy are
replaced with a plain silhouette, and the name, licence number, birth date, issue and expiry dates,
address and DD number are swapped, on the card as read and proved on the copy.

A card is drawn here, the size of a real one at 300 dpi: its print set by pdfium in the standard
faces (labels small and red, as cards print them), a head and shoulders drawn in shapes for its
photo (no photograph of anybody), and the same head printed small and faint for the copy most
cards carry. tests/identity_swap_id_card_probe.js runs web/ in node over a folder
holding it, through the page's own read, find and choose, and swap and check, with the OCR engine,
its model and the face detector taken out of the built page. What is held:

  * the card is told for an ID card, and its photo and the faint copy are found where they were
    drawn, the photo's frame included
  * the card's details are found from the card as read: the licence number, the birth date, the
    expiry and issue dates, the DD number, the names on its numbered lines, the address
  * the copy is written with every check passed; read again apart from those checks it holds none
    of the old values, and the face detector finds no face on it; the photo's place holds no pixel
    of the drawn skin
  * every pixel outside the painted words and the two photos is the card's own
  * the same card faxed (black and white, where the faint copy breaks up into a few blots of its
    darkest parts, the hair and the brows) is told for a card too, its faint copy found from those
    blots, every blot inside what is taken off, and none of it left

Skipped where node is absent. Takes a minute or so: Tesseract runs in one thread.
"""

import json
import os
import shutil
import subprocess

import numpy as np
import pypdfium2
import pytest
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_id_card_probe.js")
PAGE = os.path.join(ROOT, "identity-swap.html")

CLIENT = "Harrowgate, Quenby O"
W, H = 1012, 638
PHOTO = (40, 128, 200, 332)        # the photo, its frame two pixels outside it
GHOST = (880, 452, 952, 544)       # the faint copy, nearly half the photo's size
SKIN = (206, 160, 134)
VALUES = {
    "idnum": ["K41702953", "7741203CX88301456"],
    "dob": ["07/19/1979"],
    "iddate": ["07/19/2031", "06/11/2022"],
}
OLD = ["K41702953", "7741203CX88301456", "07/19/1979", "07/19/2031", "06/11/2022", "HARROWGATE", "QUENBY", "ODETTE", "JUNCO", "86004"]
# labels small and red, values large and bold; the fine print carries every letter and figure, so
# a stand-in is painted with the card's own letters (in node there is no canvas to draw one)
PRINT = [
    # (x, baseline y from the top, font, size, colour, text)
    (30, 66, "F1", 44, "W", "ARIZONA"), (330, 62, "F1", 34, "W", "DRIVER LICENSE"),
    (240, 150, "F2", 20, "R", "4d DLN"), (330, 150, "F1", 28, "K", "K41702953"),
    (240, 210, "F2", 20, "R", "3 DOB"), (318, 210, "F1", 28, "K", "07/19/1979"),
    (620, 210, "F2", 20, "R", "4b EXP"), (705, 210, "F1", 28, "K", "07/19/2031"),
    (240, 266, "F2", 20, "R", "1"), (262, 266, "F1", 28, "K", "HARROWGATE"),
    (240, 312, "F2", 20, "R", "2"), (262, 312, "F1", 28, "K", "QUENBY ODETTE"),
    (240, 364, "F2", 20, "R", "8"), (262, 364, "F1", 28, "K", "2290 N JUNCO HOLLOW DR"),
    (270, 404, "F1", 28, "K", "FLAGSTAFF, AZ 86004"),
    (240, 456, "F2", 20, "R", "4a ISS"), (326, 456, "F1", 28, "K", "06/11/2022"),
    (620, 456, "F2", 20, "R", "15 SEX"), (705, 456, "F1", 28, "K", "F"),
    (240, 520, "F2", 20, "R", "5 DD"), (312, 520, "F1", 28, "K", "7741203CX88301456"),
    (40, 566, "F1", 24, "K", "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 01234 56789"),
    (40, 604, "F2", 18, "K", "PACK MY BOX WITH FIVE DOZEN LIQUOR JUGS  pack my box with five dozen liquor jugs"),
]
COLOURS = {"R": "0.6 0.15 0.15", "K": "0.08 0.08 0.12", "W": "1 1 1"}


def _print_layer():
    def esc(t):
        return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    ops = "".join("BT %s rg /%s %d Tf %d %d Td (%s) Tj ET\n" % (COLOURS[c], f, s, x, H - y, esc(t)) for x, y, f, s, c, t in PRINT)
    fonts = {"F1": "Helvetica-Bold", "F2": "Helvetica"}
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents 4 0 R /Resources << /Font << " % (W, H)
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
    page = pypdfium2.PdfDocument(bytes(out))[0]
    return page.render(scale=1, fill_color=(0, 0, 0, 0)).to_pil().convert("RGBA")


def _head(w, h):
    """A head and shoulders in shapes, shaded the way a face detector looks for: an eye band darker
    than the cheeks, a nose bridge lighter between the eyes."""
    im = Image.new("RGB", (w, h), (176, 196, 214))
    d = ImageDraw.Draw(im)
    cx = w // 2
    d.ellipse((cx - 0.62 * w, 0.80 * h, cx + 0.62 * w, 1.5 * h), fill=(52, 58, 76))
    d.rectangle((cx - 0.11 * w, 0.62 * h, cx + 0.11 * w, 0.84 * h), fill=(176, 128, 104))
    d.ellipse((cx - 0.34 * w, 0.08 * h, cx + 0.34 * w, 0.40 * h), fill=(58, 40, 28))
    d.ellipse((cx - 0.29 * w, 0.17 * h, cx + 0.29 * w, 0.74 * h), fill=(172, 128, 104))
    d.ellipse((cx - 0.25 * w, 0.17 * h, cx + 0.25 * w, 0.70 * h), fill=SKIN)
    d.rectangle((cx - 0.29 * w, 0.17 * h, cx + 0.29 * w, 0.26 * h), fill=(58, 40, 28))
    for s in (-1, 1):
        ex = cx + s * 0.12 * w
        d.ellipse((ex - 0.085 * w, 0.33 * h, ex + 0.085 * w, 0.44 * h), fill=(120, 84, 70))
        d.rectangle((ex - 0.08 * w, 0.31 * h, ex + 0.08 * w, 0.335 * h), fill=(50, 34, 26))
        d.ellipse((ex - 0.05 * w, 0.37 * h, ex + 0.05 * w, 0.41 * h), fill=(236, 232, 228))
        d.ellipse((ex - 0.022 * w, 0.372 * h, ex + 0.022 * w, 0.408 * h), fill=(30, 22, 18))
    d.rectangle((cx - 0.03 * w, 0.34 * h, cx + 0.03 * w, 0.52 * h), fill=(226, 182, 156))
    d.ellipse((cx - 0.06 * w, 0.50 * h, cx + 0.06 * w, 0.55 * h), fill=(150, 104, 86))
    d.ellipse((cx - 0.10 * w, 0.59 * h, cx + 0.10 * w, 0.635 * h), fill=(140, 70, 70))
    return im.filter(ImageFilter.GaussianBlur(max(1, w / 120)))


def _card():
    ground = (226, 233, 238)
    card = Image.new("RGB", (W, H), ground)
    d = ImageDraw.Draw(card)
    for k in range(0, W + H, 14):
        d.line([(k, 0), (k - H, H)], fill=(216, 225, 232), width=1)
    d.rectangle((0, 0, W, 92), fill=(122, 40, 40))
    x0, y0, x1, y1 = PHOTO
    card.paste(_head(x1 - x0, y1 - y0), (x0, y0))
    d.rectangle((x0 - 2, y0 - 2, x1 + 1, y1 + 1), outline=(90, 90, 90), width=2)
    gx0, gy0, gx1, gy1 = GHOST
    faint = _head(x1 - x0, y1 - y0).resize((gx1 - gx0, gy1 - gy0)).convert("L").convert("RGB")
    card.paste(Image.blend(Image.new("RGB", faint.size, ground), faint, 0.45), (gx0, gy0))
    card = card.convert("RGBA")
    card.alpha_composite(_print_layer())
    return card.convert("RGB")


@pytest.fixture(scope="module")
def probe(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's reader cannot be run here")
    d = tmp_path_factory.mktemp("idcard")
    folder = d / "in" / CLIENT / "2025"
    folder.mkdir(parents=True)
    card = _card()
    card.save(folder / "DL front.png", dpi=(300, 300))
    # the same card faxed dark enough that its faint copy keeps only the hair and the brows: a
    # few blots that no longer look like the photo
    card.convert("L").point(lambda v: 255 if v > 150 else 0).save(folder / "DL fax.png", dpi=(300, 300))
    r = subprocess.run([node, PROBE, PAGE, str(d / "in"), str(d / "out")], capture_output=True, text=True, encoding="utf-8", timeout=900)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    out["original"] = str(folder / "DL front.png")
    return out


def _near(box, want, slack=8):
    return all(abs(a - b) <= slack for a, b in zip(box, want))


def _front(probe):
    return next(c for c in probe["cards"] if c["path"].endswith("DL front.png"))


def _fax(probe):
    return next(c for c in probe["cards"] if c["path"].endswith("DL fax.png"))


def test_the_card_is_told_for_an_id_card_and_both_photos_are_found(probe):
    card = _front(probe)
    assert card["idCard"], card["text"]
    frame = (PHOTO[0] - 2, PHOTO[1] - 2, PHOTO[2] + 2, PHOTO[3] + 2)
    portraits = [p for p in card["photos"] if not p["faint"]]
    copies = [p for p in card["photos"] if p["faint"]]
    assert len(portraits) == 1 and _near(portraits[0]["box"], frame), card["photos"]
    assert len(copies) == 1 and _near(copies[0]["box"], GHOST), card["photos"]


def test_the_cards_details_are_found_from_the_card_as_read(probe):
    found = {(i["kind"], i["display"]) for i in probe["items"]}
    for kind, values in VALUES.items():
        for v in values:
            assert (kind, v) in found, (kind, v, sorted(found))
    names = {i["display"].upper() for i in probe["items"] if i["kind"] == "name"}
    assert {"HARROWGATE", "QUENBY", "ODETTE"} <= names, names
    assert any(i["kind"] == "street" and "JUNCO" in i["display"] for i in probe["items"])
    assert ("zip", "86004") in found


def test_the_copy_is_written_checked_and_holds_none_of_the_person(probe):
    card = _front(probe)
    assert card["result"] == "swapped", (card["result"], card["why"])
    assert all(c["passed"] for c in card["checks"]), card["checks"]
    assert any("silhouette" in w for w in card["warnings"]), card["warnings"]
    again = card["reread"].upper().replace(" ", "")
    assert not [v for v in OLD if v in again], card["reread"]
    assert card["facesAfter"] == 0, "a face is still found on the copy"
    after = np.asarray(Image.open(card["written"]).convert("RGB")).astype(int)
    x0, y0, x1, y1 = PHOTO
    skin = (np.abs(after[y0:y1, x0:x1] - np.array(SKIN)).max(axis=2) <= 12).sum()
    assert skin == 0, "%d pixels of the drawn face's skin are left in the photo's place" % skin


def test_nothing_outside_the_painted_words_and_the_photos_moves(probe):
    card = _front(probe)
    before = np.asarray(Image.open(probe["original"]).convert("RGB")).astype(int)
    after = np.asarray(Image.open(card["written"]).convert("RGB")).astype(int)
    assert before.shape == after.shape
    allowed = np.zeros(before.shape[:2], bool)
    for o in card["occurrences"]:
        for _page, (x0, y0, x1, y1) in o["boxes"]:
            allowed[max(0, y0 - 2):y1 + 2, max(0, x0 - 2):x1 + 2] = True
    for p in card["photos"]:
        x0, y0, x1, y1 = p["box"]
        allowed[max(0, y0):y1, max(0, x0):x1] = True
    moved = (before != after).any(axis=2)
    assert moved[allowed].any(), "nothing was painted"
    assert not moved[~allowed].any(), "%d pixels outside the painted words and the photos changed" % moved[~allowed].sum()


def test_a_faxed_card_loses_its_faint_copy_too(probe):
    fax = _fax(probe)
    assert fax["idCard"], fax["text"]
    frame = (PHOTO[0] - 2, PHOTO[1] - 2, PHOTO[2] + 2, PHOTO[3] + 2)
    portraits = [p for p in fax["photos"] if not p["faint"]]
    copies = [p for p in fax["photos"] if p["faint"]]
    assert len(portraits) == 1 and _near(portraits[0]["box"], frame), fax["photos"]
    assert len(copies) == 1, fax["photos"]
    assert fax["result"] == "swapped" and all(c["passed"] for c in fax["checks"]), (fax["result"], fax["why"], fax["checks"])
    assert fax["facesAfter"] == 0, "a face is still found on the faxed copy"
    before = np.asarray(Image.open(os.path.join(os.path.dirname(probe["original"]), "DL fax.png")).convert("L")).astype(int)
    after = np.asarray(Image.open(fax["written"]).convert("L")).astype(int)
    gx0, gy0, gx1, gy1 = GHOST
    blots = np.argwhere(before[gy0:gy1, gx0:gx1] < 128)
    assert len(blots) > 200, "the fax kept no blot of the faint copy to take off"
    # every blot sits inside what was taken off, and none is left
    x0, y0, x1, y1 = copies[0]["box"]
    assert all(x0 <= gx0 + x < x1 and y0 <= gy0 + y < y1 for y, x in blots), (copies[0]["box"], blots.min(axis=0), blots.max(axis=0))
    assert (after[gy0:gy1, gx0:gx1] < 128).sum() == 0, "a blot of the faint copy is left on the faxed card"
