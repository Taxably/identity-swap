"""The identity swap page writes every kind of file back as the kind it came, with nothing of the
original values left in it and nothing else moved.

web/ runs in node over a synthetic client folder of invented people
(identity_swap_files_probe.js, with the libraries the built page carries), through the page's own
three steps. What is held:

  * every file comes back the kind it was, and opens: a PDF, a workbook (its formulas, its
    numbers still numbers, its sheet named for the client renamed), a Word letter (a name Word
    split across two runs is found and swapped whole), a slide deck, a CSV in Windows-1252, a text
    file in UTF-16 and one in UTF-8 with its byte-order mark, and a zip holding a PDF and a CSV
  * no original value is left anywhere a reader could pull it out: page text, every part of an
    Office file (with its tags taken out, so a value split across runs counts), every text file
    in its own encoding, every file inside the archive, and every file and folder name
  * in the PDF a stand-in of another length takes the value's place and nothing else moves: the
    page text is the original with each value swapped, every character outside a value keeps its
    place to 0.01 pt, and no new character overlaps one that was already there
  * a locked PDF is left out with its reason, never written
  * each picture writer keeps the original's own kind: a PNG its colour type (grey, RGB, RGBA,
    palette, with the palette it had) and resolution, a BMP its depth (a palette BMP stays one)
    and resolution, a GIF the palette it had (a grey GIF stays grey), a TIFF every page at its own
    bit depth (a CCITT fax stays one bit a pixel) and resolution, every pixel as it was; a JPEG is
    given its resolution back

Skipped where node is absent.
"""

import io
import json
import os
import re
import shutil
import subprocess
import zipfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_files_probe.js")

CLIENT = "Pennywhistle, Corwin D"
TP, SP, KID = "Corwin D Pennywhistle", "Ottoline Pennywhistle", "Barnaby Pennywhistle"
SSN, EIN = "529-41-0386", "84-2290715"
# SSNs that start with zeros: a spreadsheet or a CSV that keeps one as a number drops them
KID_SSN, SP_SSN = "031-50-7264", "004-56-1203"
STREET, CITY, ZIP = "6120 W Bramblewood Ln", "Prescott", "86301"
EMPLOYER = "Larchmont Freight Partners LLC"
VALUES = ["Corwin", "Pennywhistle", "Ottoline", "Barnaby", SSN, SSN.replace("-", ""), EIN, "Bramblewood", ZIP, "Larchmont",
          KID_SSN, "31507264", SP_SSN, "4561203"]


def node():
    exe = shutil.which("node")
    if not exe:
        pytest.skip("node not installed - the page's code cannot be run here")
    return exe


def run_probe(jobs, tmp):
    path = os.path.join(tmp, "jobs.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(jobs, fh)
    r = subprocess.run([node(), PROBE, path], capture_output=True, text=True, encoding="utf-8", timeout=600)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


# ------------------------------------------------------------------ the folder
def make_folder(root):
    from docx import Document
    from openpyxl import Workbook
    from pptx import Presentation
    from pypdf import PdfReader, PdfWriter
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    d = os.path.join(root, CLIENT, "2025")
    os.makedirs(d)
    # folders with nothing in them yet, one named for the client, one inside another
    os.makedirs(os.path.join(root, CLIENT, "2024"))
    os.makedirs(os.path.join(root, CLIENT, "Private", "Pennywhistle letters"))

    def pdf(path_or_buf, lines):
        c = canvas.Canvas(path_or_buf, pagesize=letter)
        for k, t in enumerate(lines):
            c.setFont("Helvetica", 10)
            c.drawString(54, 720 - 18 * k, t)
        c.save()

    pdf(os.path.join(d, "W2 Larchmont.pdf"), [
        "Form W-2 Wage and Tax Statement 2025",
        "a Employee's social security number  " + SSN + "  b EIN " + EIN,
        "c Employer's name, address, and ZIP code",
        EMPLOYER + ", 41 E Gurley St, Prescott, AZ 86301",
        "e Employee's first name and initial  Last name",
        TP + "  Box 1  71,204.33",
        STREET + ", " + CITY + ", AZ " + ZIP,
    ])
    locked = PdfWriter(clone_from=PdfReader(os.path.join(d, "W2 Larchmont.pdf")))
    locked.encrypt(user_password="", owner_password="owner", permissions_flag=0)
    locked.write(os.path.join(d, "Statement locked.pdf"))

    wb = Workbook()
    ws = wb.active
    ws.title = "Pennywhistle 2025"
    for row in [("Taxpayer", TP), ("SSN", int(SSN.replace("-", ""))), ("Spouse", SP), ("Dependent 1", KID),
                ("Address", STREET), ("City", CITY), ("ZIP", int(ZIP)), ("Wages", 71204.33), ("Other", 1200.0)]:
        ws.append(row)
    ws["C8"] = "=B8+B9"
    # what prints at the top and foot of every page, in Excel's own codes ("&C" centres it)
    ws.oddHeader.center.text = "Pennywhistle 2025"
    ws.oddFooter.left.text = "Prepared for Corwin"
    # a table with an SSN column, and a cell in Excel's own SSN format, both kept as numbers
    deps = wb.create_sheet("Dependents")
    deps.append(("Name", "Relationship", "SSN"))
    deps.append((KID, "Son", int(KID_SSN.replace("-", ""))))
    deps["E2"] = "Spouse"
    deps["F2"] = int(SP_SSN.replace("-", ""))
    deps["F2"].number_format = "000-00-0000"
    wb.save(os.path.join(d, "Household 2025.xlsx"))

    doc = Document()
    p = doc.add_paragraph()
    p.add_run("Dear Cor")
    p.add_run("win Pennywhistle,")
    doc.add_paragraph("We have " + SP + " as your spouse and " + KID + " as your dependent.")
    doc.add_paragraph(STREET)
    doc.add_paragraph("Dependent SSN " + KID_SSN + ", spouse SSN " + SP_SSN)
    doc.save(os.path.join(d, "Engagement letter.docx"))

    deck = Presentation()
    s = deck.slides.add_slide(deck.slide_layouts[1])
    s.shapes.title.text = "Year in review for " + TP
    s.placeholders[1].text = "Spouse: " + SP
    deck.save(os.path.join(d, "Review.pptx"))

    with open(os.path.join(d, "Bank export.csv"), "wb") as fh:
        # a payee in capitals with its web address, the way a bank prints a payroll deposit
        fh.write(("Date,Payee,Amount\n01/09/2025,Café for " + KID + ",42.00\n02/01/2025,Payroll " + TP + ",2600.00\n"
                  "02/15/2025,LARCHMONT FREIGHT PAYROLL larchmont.com,2600.00\n").encode("cp1252"))
    with open(os.path.join(d, "contacts.txt"), "wb") as fh:
        fh.write(b"\xff\xfe" + ("Taxpayer: " + TP + "\r\nSSN: " + SSN + "\r\n").encode("utf-16-le"))
    with open(os.path.join(d, "notes.txt"), "wb") as fh:
        fh.write(("﻿Client " + TP + " lives at " + STREET + ", " + CITY + ", AZ " + ZIP + ".\n").encode("utf-8"))

    buf = io.BytesIO()
    pdf(buf, ["Summary for " + TP + "  SSN " + SSN, "Spouse " + SP])
    with zipfile.ZipFile(os.path.join(d, "Export 2024.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Pennywhistle 2024/Summary.pdf", buf.getvalue())
        z.writestr("Pennywhistle 2024/dependents.csv", "Name,Relationship,SSN\n" + KID + ",Son," + KID_SSN.replace("-", "").lstrip("0") + "\n")
    return os.path.join(root, CLIENT)


@pytest.fixture(scope="module")
def swapped(tmp_path_factory):
    node()
    tmp = str(tmp_path_factory.mktemp("swap"))
    src = make_folder(os.path.join(tmp, "in"))
    out = os.path.join(tmp, "out")
    got = run_probe([{"job": "folder", "in": src, "out": out}], tmp)[0]
    return {"in": os.path.dirname(src), "out": out, **got}


def by_name(run, name):
    return next(r for r in run["results"] if r["path"].endswith(name))


def read_out(run, name):
    r = by_name(run, name)
    with open(os.path.join(run["out"], r["outPath"]), "rb") as fh:
        return fh.read()


def read_in(run, name):
    r = by_name(run, name)
    with open(os.path.join(run["in"], r["path"]), "rb") as fh:
        return fh.read()


def left(text):
    return [v for v in VALUES if re.search(r"(?<![A-Za-z0-9])" + re.escape(v) + r"(?![A-Za-z0-9])", text, re.I)]


def ooxml_text(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    out = []
    for n in z.namelist():
        if n.endswith((".xml", ".rels")):
            x = z.read(n).decode("utf-8", "replace")
            t = re.sub(r"<[^>]+>", "", re.sub(r"</(w:p|a:p|si)>", "\n", x))
            # read as Excel shows it: entities decoded, a header's codes (&C, &P, &"Arial") a space
            t2 = t.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")
            out += [x, re.sub(r"<[^>]+>", "", x), t, re.sub(r'&(?:"[^"]*"|K[0-9A-Fa-f]{6}|\d+|[LCRPNDTFAZGBIUESXYH&])', " ", t2)]
    return "\n".join(out)


def decode(b):
    if b[:2] == b"\xff\xfe":
        return b[2:].decode("utf-16-le"), "utf-16-le"
    if b[:3] == b"\xef\xbb\xbf":
        return b[3:].decode("utf-8"), "utf-8-sig"
    try:
        return b.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return b.decode("cp1252"), "cp1252"


def test_every_file_is_swapped_checked_and_written_but_the_locked_one(swapped):
    for r in swapped["results"]:
        if r["path"].endswith("Statement locked.pdf"):
            assert r["result"] == "left out" and "password protected or restricted" in r["why"], r
            assert not os.path.exists(os.path.join(swapped["out"], r["outPath"])), "a locked file is never written"
            continue
        assert r["result"] == "swapped", r
        assert r["found"] == r["swapped"] and all(c["passed"] for c in r["checks"]), r


def test_no_original_value_is_left_in_any_name(swapped):
    for r in swapped["results"]:
        if r["result"] == "swapped":
            assert not left(r["outPath"]), r["outPath"]


def test_the_workbook_keeps_its_formulas_and_numbers_and_loses_every_value(swapped):
    from openpyxl import load_workbook
    data = read_out(swapped, "Household 2025.xlsx")
    assert not left(ooxml_text(data))
    before = load_workbook(io.BytesIO(read_in(swapped, "Household 2025.xlsx"))).active
    after = load_workbook(io.BytesIO(data)).active
    assert after.title != before.title and after.title.endswith(" 2025"), after.title
    assert after["C8"].value == "=B8+B9"
    assert isinstance(after["B2"].value, int) and after["B2"].value != before["B2"].value
    assert isinstance(after["B7"].value, int) and after["B7"].value != before["B7"].value
    assert after["B8"].value == 71204.33 and after["A1"].value == "Taxpayer"


def test_a_sheets_header_and_footer_lose_the_name_and_keep_their_codes(swapped):
    from openpyxl import load_workbook
    after = load_workbook(io.BytesIO(read_out(swapped, "Household 2025.xlsx"))).worksheets[0]
    head, foot = after.oddHeader.center.text, after.oddFooter.left.text
    assert head and head.endswith(" 2025") and "Pennywhistle" not in head, head
    assert foot and foot.startswith("Prepared for ") and "Corwin" not in foot, foot


def test_every_folder_comes_back_under_its_swapped_name_an_empty_one_too(swapped):
    made = swapped["folders"]["out"]
    assert len(made) == len(swapped["folders"]["in"]), made
    assert not any(left(d) for d in made), made
    on_disk = sorted(os.path.relpath(r, swapped["out"]).replace(os.sep, "/") for r, _, _ in os.walk(swapped["out"]) if r != swapped["out"])
    assert on_disk == made, (on_disk, made)
    # the same shape: as many folders at each depth, the empty ones empty
    assert sorted(d.count("/") for d in made) == sorted(d.count("/") for d in swapped["folders"]["in"])
    empty = [d for d in made if not os.listdir(os.path.join(swapped["out"], d))]
    assert len(empty) == 2 and any(d.endswith("/2024") for d in empty) and any(d.endswith(" letters") and "/Private/" in d for d in empty), empty
    # every file's swapped path sits in one of those folders (a file inside the archive sits in it)
    for r in swapped["results"]:
        if r["result"] == "swapped" and ".zip/" not in r["outPath"]:
            assert r["outPath"].rsplit("/", 1)[0] in made, r["outPath"]


def test_a_name_word_split_across_runs_is_swapped_whole(swapped):
    from docx import Document
    data = read_out(swapped, "Engagement letter.docx")
    assert not left(ooxml_text(data))
    paras = [p.text for p in Document(io.BytesIO(data)).paragraphs]
    assert paras[0].startswith("Dear ") and paras[0].endswith(",") and len(paras[0].split()) == 3, paras[0]
    assert len(paras) == len(Document(io.BytesIO(read_in(swapped, "Engagement letter.docx"))).paragraphs)


def test_the_deck_opens_and_loses_every_value(swapped):
    from pptx import Presentation
    data = read_out(swapped, "Review.pptx")
    assert not left(ooxml_text(data))
    assert len(Presentation(io.BytesIO(data)).slides) == 1


def test_each_text_file_keeps_its_encoding_and_its_lines(swapped):
    for name, enc in (("Bank export.csv", "cp1252"), ("contacts.txt", "utf-16-le"), ("notes.txt", "utf-8-sig")):
        before, after = read_in(swapped, name), read_out(swapped, name)
        (tb, eb), (ta, ea) = decode(before), decode(after)
        assert eb == ea == enc, (name, eb, ea)
        assert tb.count("\n") == ta.count("\n") and not left(ta), name
    assert "Café for " in decode(read_out(swapped, "Bank export.csv"))[0]


def test_every_file_inside_the_archive_is_swapped(swapped):
    z = zipfile.ZipFile(io.BytesIO(read_out(swapped, "Export 2024.zip")))
    names = z.namelist()
    assert len(names) == 2 and not any(left(n) for n in names), names
    for n in names:
        data = z.read(n)
        text = data.decode("latin-1") if n.endswith(".csv") else pdf_text(data)
        assert not left(text), n


def pdf_text(data):
    import pdfplumber
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)


def spaced(chars):
    out, prev = "", None
    for c in chars:
        if c["text"].isspace():
            out += "" if out.endswith(" ") else " "
            prev = None
            continue
        if prev is not None and (abs(c["top"] - prev["top"]) > 0.5 * c["size"] or c["x0"] - prev["x1"] > 0.15 * c["size"]) and not out.endswith(" "):
            out += " "
        out += c["text"]
        prev = c
    return out


def test_in_the_pdf_a_stand_in_of_another_length_moves_nothing_else(swapped):
    import pdfplumber
    rows = sorted(swapped["rows"], key=lambda r: -len(r["find"]))
    pat = re.compile("|".join(r"(?<![A-Za-z0-9])" + r"\s+".join(re.escape(w) for w in r["find"].split()) + r"(?![A-Za-z0-9])" for r in rows))
    exact = {re.sub(r"\s+", "", r["find"]): r["replace"] for r in rows}
    before = pdfplumber.open(io.BytesIO(read_in(swapped, "W2 Larchmont.pdf"))).pages[0]
    after = pdfplumber.open(io.BytesIO(read_out(swapped, "W2 Larchmont.pdf"))).pages[0]
    nospace = lambda t: re.sub(r"\s+", "", t)  # noqa: E731
    # one entry per letter: a ligature ("ff") is one glyph holding two
    ca = [c for c in before.chars if c["text"].strip() for _ in nospace(c["text"])]
    cb = [c for c in after.chars if c["text"].strip() for _ in nospace(c["text"])]
    pieces, at, text = [], 0, spaced(before.chars)
    for m in pat.finditer(text):
        pieces += [text[at:m.start()], (m.group(0), exact[nospace(m.group(0))])]
        at = m.end()
    pieces.append(text[at:])
    assert "".join(nospace(p) if isinstance(p, str) else nospace(p[1]) for p in pieces) == "".join(nospace(c["text"]) for c in after.chars)
    assert any(isinstance(p, tuple) and len(p[0]) != len(p[1]) for p in pieces), "the test needs a stand-in of another length"
    i = j = 0
    new = []
    for p in pieces:
        if isinstance(p, str):
            k = len(nospace(p))
            for x, y in zip(ca[i:i + k], cb[j:j + k]):
                assert abs(x["x0"] - y["x0"]) <= 0.01 and abs(x["top"] - y["top"]) <= 0.01, (x["text"], x["x0"], y["x0"])
            i, j = i + k, j + k
        else:
            k = len(nospace(p[1]))
            new += cb[j:j + k]
            i, j = i + len(nospace(p[0])), j + k
    ids = {id(c) for c in new}
    for c in new:
        for o in cb:
            if id(o) not in ids and abs(c["top"] - o["top"]) < 0.5 * c["size"]:
                assert min(c["x1"], o["x1"]) - max(c["x0"], o["x0"]) <= 0.3, (c["text"], o["text"])
    assert (before.width, before.height) == (after.width, after.height)


# ------------------------------------------------------------------ the picture writers
def picture(tmp, kind, original, rgba=None, size=None):
    out = os.path.join(tmp, "out-" + os.path.basename(original))
    job = {"job": "picture", "kind": kind, "original": original, "out": out}
    if rgba is not None:
        raw = os.path.join(tmp, os.path.basename(original) + ".rgba")
        with open(raw, "wb") as fh:
            fh.write(rgba)
        job.update(rgba=raw, w=size[0], h=size[1])
    run_probe([job], tmp)
    return out


def text_picture(mode, size=(320, 120)):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", size, (250, 248, 240))
    d = ImageDraw.Draw(im)
    d.rectangle((10, 10, 200, 60), fill=(20, 40, 120))
    d.text((20, 70), "Sample 2025", fill=(0, 0, 0))
    if mode == "L":
        return im.convert("L")
    if mode == "RGBA":
        im = im.convert("RGBA")
        im.putpixel((0, 0), (0, 0, 0, 0))
        return im
    if mode == "P":
        return im.convert("P", palette=Image.ADAPTIVE, colors=8)
    if mode == "1":
        return im.convert("1")
    return im


@pytest.mark.parametrize("mode", ["L", "RGB", "RGBA", "P"])
def test_a_png_keeps_its_colour_type_its_palette_and_its_resolution(tmp_path, mode):
    from PIL import Image
    node()
    im = text_picture(mode)
    src = str(tmp_path / ("in-%s.png" % mode))
    im.save(src, dpi=(150, 150))
    out = picture(str(tmp_path), "png", src, Image.open(src).convert("RGBA").tobytes(), im.size)
    back = Image.open(out)
    assert back.mode == mode and back.size == im.size
    assert [round(v) for v in back.info["dpi"]] == [150, 150]
    assert back.convert("RGBA").tobytes() == Image.open(src).convert("RGBA").tobytes()
    if mode == "P":
        assert back.getpalette()[:24] == Image.open(src).getpalette()[:24]


@pytest.mark.parametrize("mode", ["RGB", "P"])
def test_a_bmp_keeps_its_depth_and_its_resolution(tmp_path, mode):
    from PIL import Image
    node()
    im = text_picture(mode)
    src = str(tmp_path / ("in-%s.bmp" % mode))
    im.save(src, dpi=(200, 200))
    out = picture(str(tmp_path), "bmp", src, Image.open(src).convert("RGBA").tobytes(), im.size)
    back = Image.open(out)
    assert back.mode == Image.open(src).mode and back.size == im.size
    assert [round(v) for v in back.info["dpi"]] == [200, 200]
    assert back.convert("RGB").tobytes() == Image.open(src).convert("RGB").tobytes()


@pytest.mark.parametrize("mode", ["L", "P"])
def test_a_gif_keeps_the_palette_it_had(tmp_path, mode):
    from PIL import Image
    node()
    im = text_picture(mode)
    src = str(tmp_path / ("in-%s.gif" % mode))
    im.save(src)
    out = picture(str(tmp_path), "gif", src, Image.open(src).convert("RGBA").tobytes(), im.size)
    back = Image.open(out)
    assert back.mode == Image.open(src).mode and back.size == im.size
    assert back.convert("RGB").tobytes() == Image.open(src).convert("RGB").tobytes()


@pytest.mark.parametrize("mode,compression", [("1", "group4"), ("1", "tiff_lzw"), ("L", "tiff_lzw"), ("RGB", "tiff_lzw"), ("L", "raw")])
def test_a_tiff_keeps_every_page_at_its_own_depth_and_resolution(tmp_path, mode, compression):
    from PIL import Image, ImageSequence
    node()
    pages = [text_picture(mode), text_picture(mode, (300, 140))]
    src = str(tmp_path / ("in-%s-%s.tif" % (mode, compression)))
    pages[0].save(src, save_all=True, append_images=pages[1:], compression=compression, dpi=(200, 200))
    out = picture(str(tmp_path), "tiff", src)
    a = [f.copy() for f in ImageSequence.Iterator(Image.open(src))]
    b = [f.copy() for f in ImageSequence.Iterator(Image.open(out))]
    assert len(a) == len(b) == 2
    for x, y in zip(a, b):
        assert y.mode == x.mode and y.size == x.size and y.tobytes() == x.tobytes()
        assert [round(v) for v in y.info["dpi"]] == [200, 200]


def test_a_phone_photo_keeps_its_rotation_flag_and_the_way_it_was_stored(tmp_path):
    from PIL import Image, ImageOps
    import numpy as np
    # stored on its side, the way a phone's sensor saw it, with the flag that says turn it a
    # quarter clockwise to show it, and where it was taken (which never comes back)
    stored = text_picture("RGB", (240, 160)).rotate(90, expand=True)
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x8825] = {1: "N", 2: (34.0, 32.0, 0.0)}
    orig = str(tmp_path / "IMG_0001.jpg")
    stored.save(orig, quality=95, exif=exif)
    upright = ImageOps.exif_transpose(Image.open(orig)).convert("RGBA")
    raw = str(tmp_path / "upright.rgba")
    with open(raw, "wb") as fh:
        fh.write(upright.tobytes())
    plain = str(tmp_path / "plain.jpg")
    Image.open(orig).convert("RGB").save(plain, quality=95)
    out, back = str(tmp_path / "out.jpg"), str(tmp_path / "stored.rgba")
    got = run_probe([{"job": "picture", "kind": "jpeg-orient", "original": orig, "rgba": raw, "w": upright.width, "h": upright.height, "plain": plain, "out": out, "outRaw": back}], str(tmp_path))[0]
    # the upright picture laid back exactly as the original stored it
    assert got["orient"] == 6 and (got["w"], got["h"]) == stored.size, got
    with open(back, "rb") as fh:
        laid = np.frombuffer(fh.read(), np.uint8).reshape(got["h"], got["w"], 4)[..., :3].astype(int)
    assert np.abs(laid - np.asarray(Image.open(orig).convert("RGB")).astype(int)).max() == 0
    # the copy carries the flag and nothing else the camera wrote, and shows the same way up
    written = Image.open(out)
    assert dict(written.getexif()) == {0x0112: 6}, dict(written.getexif())
    assert written.size == stored.size and ImageOps.exif_transpose(written).size == upright.size


def test_a_jpeg_is_given_its_resolution_back(tmp_path):
    from PIL import Image
    node()
    src = str(tmp_path / "in.jpg")
    text_picture("RGB").save(src, dpi=(240, 240), quality=90)
    plain = str(tmp_path / "plain.jpg")
    text_picture("RGB").save(plain, quality=90)  # as a browser writes it: no resolution of its own
    with open(plain, "rb") as fh:
        browser = fh.read()
    out = os.path.join(str(tmp_path), "out-in.jpg")
    run_probe([{"job": "picture", "kind": "jpeg-density", "original": src, "rgba": plain, "out": out}], str(tmp_path))
    assert [round(v) for v in Image.open(out).info["dpi"]] == [240, 240]
    assert Image.open(out).tobytes() == Image.open(io.BytesIO(browser)).tobytes()


def test_an_ssn_that_lost_its_leading_zero_is_found_and_keeps_as_many_digits(swapped):
    """012-34-5678 kept as a number is 12345678. It is found under an SSN column, in Excel's SSN
    format and in a CSV's SSN column, and its stand-in has as many leading zeros, so the dashed
    form in the letter and the number in the workbook still agree."""
    from openpyxl import load_workbook
    rows = {r["find"]: r["replace"] for r in swapped["rows"]}
    for dashed, short in ((KID_SSN, "31507264"), (SP_SSN, "4561203")):
        assert dashed in rows and short in rows, (dashed, short)
        new = rows[dashed].replace("-", "")
        assert len(new) == 9 and new.lstrip("0") == rows[short] and len(rows[short]) == len(short), (rows[dashed], rows[short])
    deps = load_workbook(io.BytesIO(read_out(swapped, "Household 2025.xlsx")))["Dependents"]
    assert str(deps["C2"].value) == rows["31507264"] and isinstance(deps["C2"].value, int)
    assert str(deps["F2"].value) == rows["4561203"] and deps["F2"].number_format == "000-00-0000"
    z = zipfile.ZipFile(io.BytesIO(read_out(swapped, "Export 2024.zip")))
    csv = z.read(next(n for n in z.namelist() if n.endswith(".csv"))).decode("utf-8")
    assert csv.strip().split("\n")[1].endswith("," + rows["31507264"]), csv
