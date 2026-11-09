"""The identity swap page swaps attachments for an AI chat with the same tags as the message.

web/attach.js runs in node (identity_swap_attach_probe.js) over invented attachments made here: a
PDF in a standard font, a PDF whose embedded font is a subset with no "[" in it, a Word file with
a table, an Excel workbook with a formula, and a picture. What is held:

  * the message and every attachment share one plan: [PERSON-1] in the message is [PERSON-1] in
    the W-2, the notes and the wage sheet
  * the Word file and the workbook keep their layout: the table is a table, the formula is a
    formula, the numbers are numbers; no personal value is left in any part of either
  * a PDF keeps its layout whatever its fonts hold: one whose embedded subset has no "[" has each
    value taken out and its tag drawn in its place, read here with pdfplumber line by line as the
    original reads, every word of the original there but the hidden values
  * a file's name is swapped too ("Quillfeather W2.pdf" never reaches the AI)
  * a picture is refused with a pointer to the folder swap, never passed through
  * a workbook as firms keep one comes back whole and clean: a client-named sheet or table gets a
    name Excel allows and every formula that names it follows; an SSN, phone or account typed as a
    number and a birth date kept as a date become tags in text cells (a number cell holding text is
    a damaged file); a mailto link, its hover text, a comment, a header and the file's details are
    swapped; no value is left in any part of the file. A legacy .xls is opened in the page, swapped
    the same way and written as .xlsx
  * every swapped file, handed back as an AI would, is restored with the key: the Word file and
    the workbook come back with every value where it was, the PDF reads line for line as the
    original, and the restored names carry the real names again

Skipped where node is absent.
"""

import json
import os
import shutil
import subprocess
import zipfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_attach_probe.js")
LINES = ["Client: Marisol J Quillfeather   SSN 481-27-3306", "Spouse: Daniel Quillfeather",
         "4417 E Saguaro Blossom Rd, Tucson, AZ 85711", "Phone (520) 555-0142  marisol.q@gmail.com",
         "Employer: Brightspan Digital LLC  EIN 82-1234567", "Wages 84,210.00   Federal withholding 9,880.00"]
SECRETS = ["Marisol", "Quillfeather", "Daniel", "481-27-3306", "529-61-0447", "Saguaro", "Tucson", "85711",
           "555-0142", "marisol.q@gmail.com", "Brightspan", "82-1234567"]
MESSAGE = "Can you check the attached W-2 and wage sheet for Marisol J Quillfeather? Her spouse Daniel Quillfeather is in the notes."


def _make(folder):
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    import docx
    import openpyxl

    def pdf(path, font):
        c = canvas.Canvas(path, pagesize=letter)
        y = 720
        for line in LINES:
            c.setFont(font, 11)
            c.drawString(72, y, line)
            y -= 18
        c.save()

    pdf(os.path.join(folder, "Quillfeather W2.pdf"), "Helvetica")
    ttf = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    if os.path.exists(ttf):
        pdfmetrics.registerFont(TTFont("Embedded", ttf))
        pdf(os.path.join(folder, "1099 subset font.pdf"), "Embedded")
    d = docx.Document()
    d.add_heading("Engagement notes", 1)
    for line in LINES:
        d.add_paragraph(line)
    t = d.add_table(rows=1, cols=2)
    t.rows[0].cells[0].text = "Dependent"
    t.rows[0].cells[1].text = "Elena Quillfeather"
    d.save(os.path.join(folder, "Quillfeather_Marisol notes.docx"))
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Name", "SSN", "Wages"])
    ws.append(["Marisol J Quillfeather", "481-27-3306", 84210])
    ws.append(["Daniel Quillfeather", "529-61-0447", 61000])
    ws["E1"] = "=SUM(C2:C3)"
    wb.save(os.path.join(folder, "wages.xlsx"))
    from PIL import Image
    Image.new("RGB", (40, 20), "white").save(os.path.join(folder, "photo.png"))
    _organizer(folder)


def _organizer(folder):
    """A workbook as a firm keeps one: a sheet named for the client and referred to by formulas
    (quoted and unquoted), an Excel table named for the client, an SSN, a phone number and an
    account number typed as numbers, birth dates as dates, a mailto link, a comment, a header, and
    the client as the file's last editor. Then the same workbook as a legacy .xls."""
    import datetime
    import openpyxl
    from openpyxl.comments import Comment
    from openpyxl.worksheet.table import Table
    wb = openpyxl.Workbook()
    wb.properties.lastModifiedBy = "Marisol Quillfeather"
    ws = wb.active
    ws.title = "Quillfeather 2025"
    ws.append(["Client", "SSN", "DOB", "Phone", "Email", "Wages", "Account"])
    ws.append(["Marisol J Quillfeather", 481273306, datetime.date(1984, 3, 14), 5205550142, "marisol.q@gmail.com", 84210.5, "0012345678"])
    ws.append(["Daniel Quillfeather", "529-61-0447", datetime.date(1982, 7, 2), "(520) 555-0199", "dan.q@outlook.com", 61000, 12345678])
    ws["A2"].comment = Comment("Confirm address with Marisol", "Preparer")
    ws["E2"].hyperlink = "mailto:marisol.q@gmail.com"
    ws.oddHeader.center.text = "Quillfeather household"
    q = wb.create_sheet("Quillfeather")
    q.append(["Item", "Amount"])
    q.append(["Wages", 100])
    q.append(["Interest", 50])
    q.add_table(Table(displayName="Quillfeather_Items", ref="A1:B3"))
    summary = wb.create_sheet("Summary")
    summary["A1"] = "=SUM('Quillfeather 2025'!F2:F3)"
    summary["A2"] = "=Quillfeather!B2+Quillfeather!B3"
    summary["A3"] = "=SUM(Quillfeather_Items[Amount])"
    path = os.path.join(folder, "Quillfeather 2025 organizer.xlsx")
    wb.save(path)
    if shutil.which("soffice"):
        subprocess.run(["soffice", "--headless", "--convert-to", "xls", "--outdir", folder, path], capture_output=True, timeout=180)
        if os.path.exists(path[:-1]):
            os.rename(path[:-1], os.path.join(folder, "Quillfeather legacy.xls"))


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed - the page's rules cannot be run here")
    base = tmp_path_factory.mktemp("attach")
    src, out = base / "in", base / "out"
    src.mkdir()
    out.mkdir()
    _make(str(src))
    job = base / "job.json"
    job.write_text(json.dumps({"in": str(src), "out": str(out), "message": MESSAGE}))
    r = subprocess.run([node, PROBE, str(job)], capture_output=True, text=True, encoding="utf-8", timeout=300)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    got["out"] = str(out)
    got["by"] = {f["in"]: f for f in got["files"]}
    return got


def _clean(text):
    left = [s for s in SECRETS if s.lower() in text.lower()]
    assert not left, left


def test_the_message_and_the_files_share_one_plan(run):
    assert run["message"].startswith("Can you check the attached W-2 and wage sheet for [PERSON-1]?")
    assert "[PERSON-2]" in run["message"]


def test_the_word_file_keeps_its_table_and_loses_every_value(run):
    import docx
    f = run["by"]["Quillfeather_Marisol notes.docx"]
    assert f["how"] == "layout kept" and "Quillfeather" not in f["name"] and "Marisol" not in f["name"]
    d = docx.Document(os.path.join(run["out"], f["name"]))
    text = "\n".join(p.text for p in d.paragraphs)
    _clean(text)
    assert "Client: [PERSON-1]   SSN [SSN-1]" in text
    assert len(d.tables) == 1 and d.tables[0].rows[0].cells[1].text.startswith("[PERSON-")
    _clean(d.tables[0].rows[0].cells[1].text)


def test_the_workbook_keeps_its_formula_and_numbers(run):
    import openpyxl
    f = run["by"]["wages.xlsx"]
    assert f["how"] == "layout kept"
    ws = openpyxl.load_workbook(os.path.join(run["out"], f["name"])).active
    assert ws["A2"].value == "[PERSON-1]" and ws["B2"].value == "[SSN-1]"
    assert ws["A3"].value == "[PERSON-2]" and ws["B3"].value == "[SSN-2]"
    assert ws["C2"].value == 84210 and ws["E1"].value == "=SUM(C2:C3)"


def test_a_pdf_keeps_its_layout_even_when_its_font_lacks_the_brackets(run):
    import pdfplumber
    if "1099 subset font.pdf" not in run["by"]:
        pytest.skip("no DejaVu font to embed")
    f = run["by"]["1099 subset font.pdf"]
    assert f["how"] == "layout kept", f
    assert any("tag drawn in its place" in n for n in f["notes"]), f
    with pdfplumber.open(os.path.join(run["out"], f["name"])) as pdf:
        lines = (pdf.pages[0].extract_text() or "").splitlines()
    assert lines[0] == "Client: [PERSON-1] SSN [SSN-1]", lines
    assert lines[1] == "Spouse: [PERSON-2]", lines
    assert lines[-1] == "Wages 84,210.00 Federal withholding 9,880.00", lines


def test_a_pdf_the_tags_cannot_be_drawn_in_comes_back_as_a_text_pdf(run):
    import pdfplumber
    for name in ["Quillfeather W2.pdf", "1099 subset font.pdf"]:
        if name not in run["by"]:
            continue
        f = run["by"][name]
        assert f["how"] in ("text only", "layout kept"), f
        assert "Quillfeather" not in f["name"]
        with pdfplumber.open(os.path.join(run["out"], f["name"])) as pdf:
            text = "\n".join(p.extract_text() or "" for p in pdf.pages)
        _clean(text)
        assert "[PERSON-1]" in text and "[SSN-1]" in text and "Federal withholding 9,880.00" in text
        if f["how"] == "text only":
            assert "Text only: personal details are replaced by tags." in text
            assert f["notes"] and "text PDF" in f["notes"][0]


def test_a_picture_is_refused_not_passed_through(run):
    f = run["by"]["photo.png"]
    assert f["problem"] and "folder swap" in f["problem"]
    assert not os.path.exists(os.path.join(run["out"], "photo.png"))


def test_every_swapped_file_restores_to_the_original(run):
    import docx
    import openpyxl
    import pdfplumber
    rdir = os.path.join(run["out"], "restored")
    for f in run["files"]:
        if f["name"]:
            assert f["restored"] and not f["restored"]["problem"], f
    d = docx.Document(os.path.join(rdir, run["by"]["Quillfeather_Marisol notes.docx"]["restored"]["name"]))
    assert run["by"]["Quillfeather_Marisol notes.docx"]["restored"]["name"] == "Quillfeather_Marisol notes (restored).docx"
    assert [p.text for p in d.paragraphs][1:1 + len(LINES)] == LINES
    assert d.tables[0].rows[0].cells[1].text == "Elena Quillfeather"
    ws = openpyxl.load_workbook(os.path.join(rdir, run["by"]["wages.xlsx"]["restored"]["name"])).active
    assert [ws["A2"].value, ws["B2"].value, ws["C2"].value, ws["E1"].value] == ["Marisol J Quillfeather", "481-27-3306", 84210, "=SUM(C2:C3)"]
    for name in ["Quillfeather W2.pdf", "1099 subset font.pdf"]:
        if name not in run["by"]:
            continue
        with pdfplumber.open(os.path.join(rdir, run["by"][name]["restored"]["name"])) as pdf:
            got = [" ".join(line.replace(" ,", ",").split()) for line in (pdf.pages[0].extract_text() or "").splitlines()]
        want = [" ".join(line.split()) for line in LINES]
        assert got == want, (name, got)


ORGANIZER = ["Marisol", "Quillfeather", "Daniel", "481273306", "529-61-0447", "5205550142", "555-0199", "marisol.q", "dan.q",
             "0012345678", "12345678", "30755", "30134"]


def _every_part(path):
    import html
    import re
    with zipfile.ZipFile(path) as z:
        return "\n".join(html.unescape(z.read(n).decode("utf-8", "replace")) + " " + re.sub(r"<[^>]+>", " ", z.read(n).decode("utf-8", "replace"))
                         for n in z.namelist() if n.endswith((".xml", ".rels", ".vml")))


@pytest.mark.parametrize("name", ["Quillfeather 2025 organizer.xlsx", "Quillfeather legacy.xls"])
def test_a_workbook_as_firms_keep_one_comes_back_whole_and_clean(run, name):
    import openpyxl
    if name not in run["by"]:
        pytest.skip("LibreOffice is not here to make the legacy .xls")
    f = run["by"][name]
    assert f["name"] and f["name"].endswith(".xlsx") and not f["problem"], f
    path = os.path.join(run["out"], f["name"])
    wb = openpyxl.load_workbook(path)  # a damaged file (text in a number cell, "[" in a sheet name) fails here
    assert wb.sheetnames == ["PERSON-1-LAST 2025", "PERSON-1-LAST", "Summary"], wb.sheetnames
    ws = wb["PERSON-1-LAST 2025"]
    row2 = [c.value for c in ws[2]]
    assert row2[0] == "[PERSON-1]" and row2[1].startswith("[SSN-") and row2[2].startswith("[DOB-") and row2[3].startswith("[PHONE-")
    assert row2[4].startswith("[EMAIL-") and row2[5] == 84210.5 and row2[6].startswith("[ACCOUNT-")
    assert [c.value for c in ws[3]][6].startswith("[ACCOUNT-")
    summary = wb["Summary"]
    assert summary["A1"].value == "=SUM('PERSON-1-LAST 2025'!F2:F3)"
    assert summary["A2"].value == "='PERSON-1-LAST'!B2+'PERSON-1-LAST'!B3"
    if name.endswith(".xlsx"):
        assert summary["A3"].value == "=SUM(PERSON_1_LAST__Items[Amount])"
        assert list(wb["PERSON-1-LAST"].tables) == ["PERSON_1_LAST__Items"]
        assert ws["E2"].hyperlink.target == "mailto:[EMAIL-1]"
    else:
        assert any("Opened from .xls" in n for n in f["notes"]), f["notes"]
    text = _every_part(path)
    left = [s for s in ORGANIZER if s in text]
    assert not left, left
    assert f["restored"] and not f["restored"]["problem"], f["restored"]
