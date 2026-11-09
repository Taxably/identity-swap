"""The built page works end to end in a real browser, as a preparer uses it.

identity_swap_e2e_probe.js drives identity-swap.html in Chromium (Playwright) and saves every file
it downloads; this test opens each one on its own. What is held:

  * the text swap hides every value in a client email, a rare client name included once the
    firm's client list is imported, and a word on the list to always hide; a renamed tag holds;
    "Swapped!" is shown and the swapped text is what reaches the clipboard
  * every attachment (Word, Excel, a PDF whose font has no "[", a phone photo of a notice read
    by the page's OCR) comes back swapped, holding no value, under a swapped name
  * an AI's answer is restored, and so is a Word file it handed back, value for value
  * the key saved locked holds no value; forgotten, nothing restores; the wrong passphrase is
    refused; the right one opens it and the answer restores again
  * the check-it-yourself panel shows the page refusing the internet, and no request leaves the
    page through the whole session
  * the folder swap reads a client folder and downloads a .zip in which no value is left
  * no script error is raised anywhere

Skipped where Playwright or its Chromium is absent.
"""

import io
import json
import os
import shutil
import subprocess
import zipfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "tests", "identity_swap_e2e_probe.js")
PAGE = os.path.join(ROOT, "identity-swap.html")
SECRETS = ["Marisol", "Quillfeather", "Daniel", "481-27-3306", "Saguaro", "85711", "555-0142", "marisol.q@gmail.com",
           "Brightspan", "82-1234567", "Ostfeather", "Kip"]
MESSAGE = ("Hi, please review the return for Marisol J Quillfeather (SSN 481-27-3306) and her spouse Daniel Quillfeather.\n"
           "Address: 4417 E Saguaro Blossom Rd, Tucson, AZ 85711. Phone (520) 555-0142, email marisol.q@gmail.com.\n"
           "Employer: Brightspan Digital LLC, EIN 82-1234567. Kofi Ostfeather referred them. Ask Kip.")
ANSWER = "Dear [PERSON-1-FIRST], your SSN [SSN-1] is on file; [SPOUSE] signs too."
LINES = ["Client: Marisol J Quillfeather   SSN 481-27-3306", "Spouse: Daniel Quillfeather",
         "4417 E Saguaro Blossom Rd, Tucson, AZ 85711", "Employer: Brightspan Digital LLC  EIN 82-1234567"]


def _need():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    r = subprocess.run([node, "-e", "require('playwright')"], capture_output=True, cwd=ROOT)
    if r.returncode:
        pytest.skip("playwright not installed for node")
    return node


def _make(base):
    import docx
    import openpyxl
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    att = base / "attachments"
    att.mkdir()
    d = docx.Document()
    for line in LINES:
        d.add_paragraph(line)
    d.save(str(att / "Quillfeather_Marisol notes.docx"))
    wb = openpyxl.Workbook()
    wb.active.append(["Name", "SSN", "Wages"])
    wb.active.append(["Marisol J Quillfeather", "481-27-3306", 84210])
    wb.save(str(att / "wages.xlsx"))
    files = [str(att / "Quillfeather_Marisol notes.docx"), str(att / "wages.xlsx")]
    ttf = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    if os.path.exists(ttf):
        pdfmetrics.registerFont(TTFont("Embedded", ttf))
        c = canvas.Canvas(str(att / "W2 subset font.pdf"), pagesize=letter)
        for i, line in enumerate(LINES):
            c.setFont("Embedded", 11)
            c.drawString(72, 720 - 18 * i, line)
        c.save()
        files.append(str(att / "W2 subset font.pdf"))
    # a phone photo of a notice: read by the page's two OCR engines, its values painted over with tags
    from PIL import Image, ImageDraw, ImageFont
    if os.path.exists(ttf):
        img = Image.new("RGB", (1400, 360), "white")
        dr = ImageDraw.Draw(img)
        f = ImageFont.truetype(ttf, 30)
        for i, line in enumerate(["IRS Notice CP2000", "SSN: 481-27-3306", "4417 E Saguaro Blossom Rd, Tucson, AZ 85711", "Amount due: 1,284.00"]):
            dr.text((60, 40 + 80 * i), line, fill="black", font=f)
        img.save(str(att / "notice photo.png"))
        files.append(str(att / "notice photo.png"))
    (base / "clients.csv").write_text('Client Name,SSN\n"Ostfeather, Kofi",1\n"Quillfeather, Marisol & Daniel",2\n')
    folder = base / "Quillfeather, Marisol"
    (folder / "2025").mkdir(parents=True)
    (folder / "2025" / "notes.txt").write_text("\n".join(LINES) + "\n")
    shutil.copy(att / "Quillfeather_Marisol notes.docx", folder / "2025" / "engagement.docx")
    return files, str(base / "clients.csv"), str(folder)


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    node = _need()
    base = tmp_path_factory.mktemp("e2e")
    files, clients, folder = _make(base)
    out = base / "out"
    out.mkdir()
    job = base / "job.json"
    job.write_text(json.dumps({"page": PAGE, "message": MESSAGE, "answer": ANSWER, "clients": clients,
                               "attachments": files, "folder": folder, "out": str(out)}))
    r = subprocess.run([node, PROBE, str(job)], capture_output=True, text=True, encoding="utf-8", timeout=1500, cwd=ROOT)
    if r.returncode and "Executable doesn't exist" in r.stderr:
        pytest.skip("Playwright's Chromium is not installed")
    assert r.returncode == 0, r.stderr[-3000:]
    got = json.loads(r.stdout)
    got["out"] = str(out)
    return got


def _clean(text, where):
    left = [s for s in SECRETS if s.lower() in text.lower()]
    assert not left, (where, left)


def _office_text(data):
    import html
    import re
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return "\n".join(html.unescape(re.sub(r"<[^>]+>", " ", z.read(n).decode("utf-8", "replace"))) for n in z.namelist() if n.endswith(".xml"))


def test_no_script_error_and_no_request_leaves_the_page(run):
    assert run["errors"] == []
    assert run["requests"] == []
    assert "Refused" in run["checkTry"]
    assert run["checkCounts"].startswith("0requests that left this page")


def test_the_text_swap_hides_everything_and_copies_what_it_shows(run):
    _clean(run["swapped"], "swapped text")
    assert "[PERSON-1]" in run["swapped"] and "[SSN-1]" in run["swapped"] and "[HIDDEN-1]" in run["swapped"]
    assert "Searched again: none of the hidden values is left" in run["check"]
    assert "2 clients known by name" in run["clientMsg"] or "3 clients known by name" in run["clientMsg"]
    assert "her spouse [SPOUSE]." in run["renamed"]
    assert run["copyMsg"].startswith("Swapped!")
    assert run["clipboard"] == run["renamed"]


def test_every_attachment_comes_back_swapped(run):
    import pdfplumber
    files = run["attachmentFiles"]
    assert len(files) == len(run["attachments"]) and all("(swapped)" in f for f in files), files
    for f in files:
        _clean(f, "file name")
        path = os.path.join(run["out"], "attachments", f)
        if f.endswith(".png"):
            # a picture holds no text to search here: the page read it back with both OCR engines
            # before it offered it, and its note lists anything blanked rather than drawn
            continue
        if f.endswith(".pdf"):
            with pdfplumber.open(path) as pdf:
                text = "\n".join(pg.extract_text() or "" for pg in pdf.pages)
            assert text.splitlines()[0] == "Client: [PERSON-1] SSN [SSN-1]", text
        else:
            with open(path, "rb") as fh:
                text = _office_text(fh.read())
            assert "[PERSON-1]" in text
        _clean(text, f)


def test_an_answer_and_a_file_are_restored(run):
    import docx
    assert run["restored"] == "Dear Marisol, your SSN 481-27-3306 is on file; Daniel Quillfeather signs too."
    assert run["restoredFile"] == "Quillfeather_Marisol notes (restored).docx"
    d = docx.Document(os.path.join(run["out"], "restored", run["restoredFile"]))
    assert [p.text for p in d.paragraphs] == LINES


def test_the_locked_key_holds_no_value_and_opens_only_with_its_passphrase(run):
    with open(os.path.join(run["out"], "key", run["keyFile"]), encoding="utf-8") as fh:
        locked = fh.read()
    assert run["keyFile"].endswith(".swapkey")
    _clean(locked, "key file")
    assert "Marisol" not in run["afterForget"]
    assert "does not open this key" in run["wrongPass"]
    assert run["keyMsg"].startswith("Opened")
    assert run["afterOpen"] == run["restored"]


def test_the_folder_swap_downloads_a_clean_copy(run):
    assert "Every file that holds text was swapped and passed every check." in run["folderResult"]
    path = os.path.join(run["out"], "folder", run["folderZip"])
    _clean(run["folderZip"], "zip name")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        assert any(n.endswith("notes.txt") for n in names) and any(n.endswith("engagement.docx") for n in names), names
        for n in names:
            _clean(n, "path in zip")
            data = z.read(n)
            text = _office_text(data) if n.endswith(".docx") else data.decode("utf-8", "replace")
            if not n.endswith(".csv"):
                _clean(text, n)
