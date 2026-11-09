"""The companion (companion/swap_attachments.py) swaps a message and its attachments on this
computer, with LibreOffice, docling, python-docx, python-pptx and openpyxl, by the page's own rules.

What is held, over invented files made here:

  * the message and every file share the page's tags: [PERSON-1] in the message is [PERSON-1] in
    the Word file, the workbook and the deck
  * Word: a name Word split across three runs of different formatting is swapped whole, and the
    first run keeps its formatting; tables, headers and the file's author are swapped too
  * a legacy .doc is opened by LibreOffice and comes back as a swapped .docx
  * Excel: numbers stay numbers, a formula stays a formula, a sheet named for the client is
    renamed and the formula that names it follows, a comment is swapped
  * PowerPoint: slide text and the speaker's notes are swapped
  * every output is read here, part by part, independently of the companion: no hidden value is
    left in any XML part of any file, and every file name is swapped
  * the key the companion saves opens with the page's own code (web/hush.js) and restores an
    answer; without --key-passphrase-env no key is written
  * a PDF is read by docling and comes back as a laid-out PDF: a W-2's box table is still a table,
    each box beside its description and amount (skipped where docling is not installed)

Skipped where node, LibreOffice or the Python libraries are absent.
"""

import html
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPANION = os.path.join(ROOT, "companion", "swap_attachments.py")
UNLOCK = os.path.join(ROOT, "tests", "identity_swap_unlock_probe.js")
SECRETS = ["Marisol", "Quillfeather", "Daniel", "Elena", "481-27-3306", "529-61-0447", "Saguaro", "Tucson", "85711",
           "555-0142", "marisol.q@gmail.com", "Brightspan", "82-1234567"]
MESSAGE = "Please review the attached for Marisol J Quillfeather and her spouse Daniel Quillfeather."


def _need():
    for tool in ("node", "soffice"):
        if not shutil.which(tool):
            pytest.skip(tool + " not installed")
    for mod in ("docx", "pptx", "openpyxl", "pdfplumber", "cryptography"):
        pytest.importorskip(mod)


def _make(folder):
    import docx
    import openpyxl
    import pptx
    from docx.shared import Pt
    from openpyxl.comments import Comment

    d = docx.Document()
    d.core_properties.author = "Marisol Quillfeather"
    d.sections[0].header.paragraphs[0].text = "Quillfeather household 2025"
    p = d.add_paragraph("Client: ")
    r1 = p.add_run("Mari")
    r1.bold = True
    r1.font.size = Pt(13)
    p.add_run("sol J Quill").italic = True
    p.add_run("feather, SSN 481-27-3306")
    d.add_paragraph("Spouse: Daniel Quillfeather. Address 4417 E Saguaro Blossom Rd, Tucson, AZ 85711.")
    d.add_paragraph("Employer: Brightspan Digital LLC, EIN 82-1234567. Phone (520) 555-0142, marisol.q@gmail.com.")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text, t.cell(0, 1).text = "Dependent", "Elena Quillfeather"
    t.cell(1, 0).text, t.cell(1, 1).text = "Wages", "84,210.00"
    d.save(os.path.join(folder, "Quillfeather_Marisol notes.docx"))
    # the same document as a legacy .doc, written by LibreOffice
    subprocess.run(["soffice", "--headless", "--convert-to", "doc", "--outdir", folder, os.path.join(folder, "Quillfeather_Marisol notes.docx")],
                   capture_output=True, timeout=180, check=True)
    os.rename(os.path.join(folder, "Quillfeather_Marisol notes.doc"), os.path.join(folder, "Quillfeather legacy.doc"))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Quillfeather"
    ws.append(["Name", "SSN", "Wages"])
    ws.append(["Marisol J Quillfeather", "481-27-3306", 84210])
    ws.append(["Daniel Quillfeather", "529-61-0447", 61000])
    ws["A2"].comment = Comment("Confirm with Marisol Quillfeather", "Preparer")
    summary = wb.create_sheet("Summary")
    summary["A1"] = "=SUM(Quillfeather!C2:C3)"
    summary["A2"] = '=IF(Quillfeather!A2="Marisol J Quillfeather","taxpayer","other")'
    wb.save(os.path.join(folder, "wages.xlsx"))

    deck = pptx.Presentation()
    s = deck.slides.add_slide(deck.slide_layouts[1])
    s.shapes.title.text = "Review for Marisol J Quillfeather"
    s.placeholders[1].text = "SSN 481-27-3306\nEmployer Brightspan Digital LLC"
    s.notes_slide.notes_text_frame.text = "Call Daniel Quillfeather at (520) 555-0142"
    deck.save(os.path.join(folder, "deck.pptx"))


def _package(path):
    with zipfile.ZipFile(path) as z:
        return "\n".join(html.unescape(re.sub(r"<[^>]+>", sep, z.read(n).decode("utf-8", "replace")))
                         for n in z.namelist() if n.endswith((".xml", ".rels")) for sep in ("", " "))


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    _need()
    base = tmp_path_factory.mktemp("companion")
    src, out = base / "in", base / "out"
    src.mkdir()
    _make(str(src))
    env = dict(os.environ, SWAP_PASS="correct horse battery")
    r = subprocess.run([sys.executable, COMPANION, "--out", str(out), "--message-text", MESSAGE, "--key-passphrase-env", "SWAP_PASS",
                        *[str(src / n) for n in sorted(os.listdir(src))]], capture_output=True, text=True, timeout=900, env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    return {"out": str(out), "files": sorted(os.listdir(out)), "stdout": r.stdout}


def _file(run, start, end):
    got = [f for f in run["files"] if f.startswith(start) and f.endswith(end)]
    assert len(got) == 1, run["files"]
    return os.path.join(run["out"], got[0])


def _clean(text, where):
    left = [s for s in SECRETS if s.lower() in text.lower()]
    assert not left, (where, left)


def test_every_file_name_and_the_message_are_swapped(run):
    for f in run["files"]:
        _clean(f, "file name")
    with open(os.path.join(run["out"], "message (swapped).txt"), encoding="utf-8") as fh:
        assert fh.read() == "Please review the attached for [PERSON-1] and her spouse [PERSON-2]."


def test_no_hidden_value_is_left_in_any_part_of_any_office_file(run):
    for f in run["files"]:
        if f.endswith((".docx", ".xlsx", ".pptx")):
            _clean(_package(os.path.join(run["out"], f)), f)


def test_word_swaps_a_name_split_across_runs_and_keeps_its_formatting(run):
    import docx
    d = docx.Document(_file(run, "[PERSON-1-LAST]_[PERSON-1-FIRST] notes", ".docx"))
    p = d.paragraphs[0]
    assert p.text == "Client: [PERSON-1], SSN [SSN-1]"
    assert p.runs[1].text == "[PERSON-1]" and p.runs[1].bold and p.runs[1].font.size.pt == 13
    assert d.tables[0].cell(0, 1).text == "[PERSON-3]" and d.tables[0].cell(1, 1).text == "84,210.00"
    assert d.sections[0].header.paragraphs[0].text == "[PERSON-1-LAST] household 2025"
    assert d.core_properties.author == "[PERSON-1]"  # "Marisol Quillfeather" is the same person


def test_a_legacy_doc_comes_back_as_a_swapped_docx(run):
    import docx
    d = docx.Document(_file(run, "[PERSON-1-LAST] legacy", ".docx"))
    assert "[PERSON-1]" in "\n".join(p.text for p in d.paragraphs)


def test_excel_keeps_numbers_and_formulas_and_renames_a_client_sheet(run):
    import openpyxl
    wb = openpyxl.load_workbook(_file(run, "wages", ".xlsx"))
    assert wb.sheetnames == ["PERSON-1-LAST", "Summary"]
    ws = wb["PERSON-1-LAST"]
    assert ws["A2"].value == "[PERSON-1]" and ws["B2"].value == "[SSN-1]" and ws["C2"].value == 84210
    assert ws["A2"].comment.text == "Confirm with [PERSON-1]"
    assert wb["Summary"]["A1"].value == "=SUM('PERSON-1-LAST'!C2:C3)"
    assert wb["Summary"]["A2"].value == "=IF('PERSON-1-LAST'!A2=\"[PERSON-1]\",\"taxpayer\",\"other\")"


def test_powerpoint_swaps_slides_and_notes(run):
    import pptx
    deck = pptx.Presentation(_file(run, "deck", ".pptx"))
    s = deck.slides[0]
    assert s.shapes.title.text == "Review for [PERSON-1]"
    assert s.notes_slide.notes_text_frame.text == "Call [PERSON-2] at [PHONE-1]"


def test_the_key_opens_in_the_page_and_restores_an_answer(run):
    keys = [f for f in run["files"] if f.endswith(".swapkey")]
    assert len(keys) == 1
    with open(os.path.join(run["out"], keys[0]), encoding="utf-8") as fh:
        locked = fh.read()
    _key_holds_no_value(locked, SECRETS)
    r = subprocess.run(["node", UNLOCK, os.path.join(run["out"], keys[0]), "correct horse battery"], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    assert got["restored"] == "Dear Marisol, your SSN is 481-27-3306."
    bad = subprocess.run(["node", UNLOCK, os.path.join(run["out"], keys[0]), "wrong passphrase"], capture_output=True, text=True, timeout=120)
    assert bad.returncode != 0


def test_a_pdf_is_read_by_docling_and_laid_out_again(tmp_path):
    _need()
    pytest.importorskip("docling")
    import pdfplumber
    from reportlab.lib.pagesizes import letter
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    src = tmp_path / "Quillfeather W2.pdf"
    doc = SimpleDocTemplate(str(src), pagesize=letter)
    st = getSampleStyleSheet()
    doc.build([Paragraph("Form W-2 Wage and Tax Statement 2025", st["Title"]),
               Paragraph("Employee: Marisol J Quillfeather, SSN 481-27-3306. Spouse: Daniel Quillfeather.", st["Normal"]),
               Spacer(1, 12),
               Table([["Box", "Description", "Amount"], ["1", "Wages, tips, other compensation", "84,210.00"],
                      ["2", "Federal income tax withheld", "9,880.00"], ["3", "Social security wages", "84,210.00"],
                      ["4", "Social security tax withheld", "5,221.02"], ["5", "Medicare wages and tips", "84,210.00"],
                      ["6", "Medicare tax withheld", "1,221.05"], ["17", "State income tax", "3,410.00"]],
                     colWidths=[50, 280, 120],
                     style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey)]))])
    out = tmp_path / "out"
    r = subprocess.run([sys.executable, COMPANION, "--out", str(out), str(src)], capture_output=True, text=True, timeout=1800)
    assert r.returncode == 0, r.stdout + r.stderr
    pdfs = [f for f in os.listdir(out) if f.endswith(".pdf")]
    assert pdfs == ["[PERSON-1-LAST] W2 (swapped).pdf"], pdfs
    with pdfplumber.open(out / pdfs[0]) as pdf:
        text = "\n".join(p.extract_text() or "" for p in pdf.pages)
        tables = [t for p in pdf.pages for t in p.extract_tables()]
    _clean(text, "pdf")
    assert "[PERSON-1]" in text and "[SSN-1]" in text
    # the table is still a table: each box beside its amount, in a row of its own
    rows = [[" ".join(c.split()) for c in row if c] for t in tables for row in t]
    assert ["1", "Wages, tips, other compensation", "84,210.00"] in rows, rows
    assert ["17", "State income tax", "3,410.00"] in rows, rows


def test_a_scan_is_read_through_ocr_and_nothing_it_shows_survives(tmp_path):
    # a picture of a page, no text in the file: docling's OCR reads it, and the spaces OCR loses
    # ("JQuillfeather", "AZ85711") are put back before the rules read it, so every value is found
    _need()
    pytest.importorskip("docling")
    import pdfplumber
    from PIL import Image, ImageDraw, ImageFont
    font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    if not os.path.exists(font):
        pytest.skip("no DejaVu font to draw the scan with")
    img = Image.new("RGB", (1700, 1100), "white")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(font, 34)
    for i, line in enumerate(["Notice to Taxpayer", "Name: Marisol J Quillfeather", "SSN: 481-27-3306",
                              "Address: 4417 E Saguaro Blossom Rd, Tucson, AZ 85711", "Spouse: Daniel Quillfeather", "Amount due: 1,284.00"]):
        d.text((100, 80 + 70 * i), line, fill="black", font=f)
    src = tmp_path / "Quillfeather scan.pdf"
    img.save(src, resolution=200)
    out = tmp_path / "out"
    r = subprocess.run([sys.executable, COMPANION, "--out", str(out), str(src)], capture_output=True, text=True, timeout=1800)
    assert r.returncode == 0, r.stdout + r.stderr
    pdfs = [f for f in os.listdir(out) if f.endswith(".pdf")]
    assert pdfs == ["[PERSON-1-LAST] scan (swapped).pdf"], pdfs
    with pdfplumber.open(out / pdfs[0]) as pdf:
        text = " ".join((p.extract_text() or "") for p in pdf.pages)
    _clean(text, "scan")
    for tag in ("[PERSON-1]", "[PERSON-2]", "[SSN-1]", "[ADDRESS-1]", "[CITY-1]", "[ZIP-1]"):
        assert tag in text, (tag, text)
    assert "1,284.00" in text


def _key_holds_no_value(locked, secrets):
    """A saved key, judged as an attacker without the passphrase would read it: its readable fields
    hold no value, and its ciphertext, decoded, holds none either. (Searching the base64 text
    itself would find a short word like "Kip" in random ciphertext now and then.)"""
    import base64
    f = json.loads(locked)
    assert set(f) == {"format", "version", "cipher", "kdf", "iterations", "salt", "iv", "data"}, set(f)
    readable = json.dumps({k: v for k, v in f.items() if k not in ("salt", "iv", "data")}).lower()
    raw = b"".join(base64.b64decode(f[k]) for k in ("salt", "iv", "data"))
    for s in secrets:
        assert s.lower() not in readable, s
        assert s.encode("utf-8") not in raw and s.encode("utf-16-le") not in raw, s
