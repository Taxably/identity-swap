"""Identity Swap companion: swap a message and its attachments for an AI chat, on this computer.

    python companion/swap_attachments.py --out OUT [--message FILE | --message-text TEXT]
        [--always-hide WORD ...] [--key-passphrase-env VAR] FILE [FILE ...]

The page (identity-swap.html) runs in a browser, so it can open only what a browser can. This
companion runs the same finding and tagging rules (web/pii.js and web/hush.js, through node and
companion/rules.js) and adds what needs a real computer:

  * LibreOffice, headless, opens the kinds no browser can: .doc, .xls, .ppt, .rtf, .odt, .ods and
    .odp are converted to .docx, .xlsx and .pptx first, and a rebuilt PDF is laid out by it too
  * docling reads a PDF as a document: headings, paragraphs and tables, and scans through OCR. The
    tagged text is laid out again as a Word file and printed to PDF by LibreOffice, so a W-2's
    boxes and a statement's table stay a table
  * python-docx and python-pptx swap Word and PowerPoint text run by run, keeping each run's
    formatting, a value Word split across runs included, in the body, tables, headers, footers,
    notes and the file's own properties
  * openpyxl swaps Excel cell by cell: text cells, the text inside formulas, comments, headers and
    footers, sheet names (with every formula that names them) and the file's properties; numbers
    and formulas stay numbers and formulas

The message, every file's text and every file's name are read as one, so a person has one tag in
all of them, and the tags are the page's: a key saved here opens in the page, which restores the
AI's answer. Every output is read back on its own (pdfplumber for a PDF, every XML part of an
Office file) and searched for every hidden value; a file that still holds one is deleted, not
delivered. The report beside the output shows values only by their last four characters.

Nothing here sends a document anywhere. docling fetches its models once from Hugging Face the
first time it runs (models only, never a document); after that it runs offline, or point it at a
folder of models with DOCLING_ARTIFACTS_PATH.
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = os.path.join(HERE, "rules.js")
LEGACY = {".doc": "docx", ".rtf": "docx", ".odt": "docx", ".xls": "xlsx", ".ods": "xlsx", ".ppt": "pptx", ".odp": "pptx"}
WORD = {".docx", ".docm"}
EXCEL = {".xlsx", ".xlsm"}
SLIDES = {".pptx", ".pptm"}
TEXT = {".txt", ".csv", ".md", ".eml", ".tsv"}


# ---------------------------------------------------------------- the page's rules, through node
class Rules:
    def __init__(self, node: str | None = None):
        self.node = node or shutil.which("node")
        if not self.node:
            raise SystemExit("node is needed: the companion runs the page's own rules (web/pii.js, web/hush.js)")

    def ask(self, **q):
        r = subprocess.run([self.node, RULES], input=json.dumps(q), capture_output=True, text=True, encoding="utf-8", timeout=600)
        if r.returncode:
            raise RuntimeError("the rules failed: " + r.stderr.strip()[-400:])
        return json.loads(r.stdout)

    def plan(self, texts, always_hide, clients=()):
        return self.ask(op="plan", texts=texts, alwaysHide=always_hide, clients=list(clients))["plan"]

    def clients(self, text):
        return self.ask(op="clients", text=text)["people"]

    def swap(self, texts, plan):
        return self.ask(op="swap", texts=list(texts), plan=plan)["texts"] if texts else []

    def rows(self, text, plan):
        return self.ask(op="rows", text=text, plan=plan)["rows"]

    def leaks(self, text, plan):
        return self.ask(op="leaks", text=text, plan=plan)["leaks"]

    def key(self, plan):
        return self.ask(op="key", plan=plan)["key"]


class Replacer:
    """The exact swaps a file needs (from the rules, over its whole text), applied to any string:
    whole words only, longest first, so a full name goes before its first name."""

    def __init__(self, rows):
        self.rows = sorted(rows, key=lambda r: -len(r["find"]))
        self.map = {r["find"]: r["replace"] for r in self.rows}
        alts = []
        for r in self.rows:
            f = re.escape(r["find"])
            if re.match(r"\w", r["find"]):
                f = r"(?<!\w)" + f
            if re.search(r"\w$", r["find"]):
                f = f + r"(?!\w)"
            alts.append(f)
        self.rx = re.compile("|".join(alts)) if alts else None

    def __call__(self, s):
        if not self.rx or not s:
            return s
        return self.rx.sub(lambda m: self.map[m.group(0)], s)

    def spans(self, s):
        return [(m.start(), m.end(), self.map[m.group(0)]) for m in self.rx.finditer(s)] if self.rx and s else []


def replace_runs(runs, rep: Replacer) -> int:
    """Swap across a paragraph's runs: each replacement goes into the run where its value starts,
    keeping that run's formatting; the rest of the value is taken out of the runs it spilled into."""
    texts = [r.text or "" for r in runs]
    spans = rep.spans("".join(texts))
    if not spans:
        return 0
    pos = 0
    for run, t in zip(runs, texts):
        out = []
        for i, ch in enumerate(t, start=pos):
            hit = next((sp for sp in spans if sp[0] <= i < sp[1]), None)
            if hit is None:
                out.append(ch)
            elif i == hit[0]:
                out.append(hit[2])
        pos += len(t)
        new = "".join(out)
        if new != t:
            run.text = new
    return len(spans)


# ---------------------------------------------------------------- LibreOffice
def soffice(src, fmt, outdir):
    """LibreOffice, headless, with a profile of its own (so a LibreOffice the user has open is not
    disturbed), converting `src` to `fmt` in `outdir`."""
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise RuntimeError("LibreOffice is not installed (soffice not found)")
    with tempfile.TemporaryDirectory() as profile:
        r = subprocess.run([exe, "-env:UserInstallation=file://" + profile.replace("\\", "/"), "--headless", "--norestore",
                            "--convert-to", fmt, "--outdir", outdir, src], capture_output=True, text=True, timeout=300)
    out = os.path.join(outdir, os.path.splitext(os.path.basename(src))[0] + "." + fmt.split(":")[0])
    if r.returncode or not os.path.exists(out):
        raise RuntimeError("LibreOffice could not convert it: " + (r.stderr or r.stdout).strip()[-300:])
    return out


# ---------------------------------------------------------------- Word
def word_paragraphs(doc):
    """Every paragraph of a Word file: body, tables (nested too), and every header and footer."""
    def walk(container):
        for p in container.paragraphs:
            yield p
        for t in getattr(container, "tables", []):
            for row in t.rows:
                for cell in row.cells:
                    yield from walk(cell)
    yield from walk(doc)
    for s in doc.sections:
        for part in (s.header, s.footer, s.first_page_header, s.first_page_footer, s.even_page_header, s.even_page_footer):
            if part is not None and not part.is_linked_to_previous:
                yield from walk(part)


def runs_of(paragraph):
    """A paragraph's runs, a hyperlink's runs included, in reading order."""
    out = []
    for item in paragraph.iter_inner_content():
        out.extend(item.runs if hasattr(item, "runs") and not hasattr(item, "bold") else [item])
    return out


def word_text(path):
    import docx
    doc = docx.Document(path)
    cp = doc.core_properties
    return "\n".join([p.text for p in word_paragraphs(doc)] + [cp.author or "", cp.last_modified_by or "", cp.title or "", cp.subject or ""])


def word_swap(src, dst, rep):
    import docx
    doc = docx.Document(src)
    # a merged cell is met more than once; a second pass over it finds only tags, and changes nothing
    n = sum(replace_runs(runs_of(p), rep) for p in word_paragraphs(doc))
    cp = doc.core_properties
    for attr in ("author", "last_modified_by", "title", "subject", "keywords", "comments"):
        v = getattr(cp, attr)
        if v:
            setattr(cp, attr, rep(v))
    doc.save(dst)
    return n


# ---------------------------------------------------------------- PowerPoint
def slide_paragraphs(prs):
    def shapes(coll):
        for sh in coll:
            if sh.shape_type == 6:  # a group
                yield from shapes(sh.shapes)
                continue
            if sh.has_text_frame:
                yield from sh.text_frame.paragraphs
            if getattr(sh, "has_table", False) and sh.has_table:
                for row in sh.table.rows:
                    for cell in row.cells:
                        yield from cell.text_frame.paragraphs
    for slide in prs.slides:
        yield from shapes(slide.shapes)
        if slide.has_notes_slide:
            yield from slide.notes_slide.notes_text_frame.paragraphs


def slides_text(path):
    import pptx
    prs = pptx.Presentation(path)
    return "\n".join("".join(r.text for r in p.runs) for p in slide_paragraphs(prs)) + "\n" + (prs.core_properties.author or "")


def slides_swap(src, dst, rep):
    import pptx
    prs = pptx.Presentation(src)
    n = sum(replace_runs(list(p.runs), rep) for p in slide_paragraphs(prs))
    cp = prs.core_properties
    for attr in ("author", "last_modified_by", "title", "subject", "keywords", "comments"):
        v = getattr(cp, attr)
        if v:
            setattr(cp, attr, rep(v))
    prs.save(dst)
    return n


# ---------------------------------------------------------------- Excel
def _header_parts(ws):
    for hf in (ws.oddHeader, ws.oddFooter, ws.evenHeader, ws.evenFooter, ws.firstHeader, ws.firstFooter):
        for part in (hf.left, hf.center, hf.right):
            yield part


def excel_text(path):
    import openpyxl
    wb = openpyxl.load_workbook(path)
    out = [wb.properties.creator or "", wb.properties.lastModifiedBy or "", wb.properties.title or ""]
    for ws in wb.worksheets:
        out.append(ws.title)
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str):
                    out.append(c.value)
                if c.comment:
                    out.append(c.comment.text)
        out.extend(p.text or "" for p in _header_parts(ws))
    return "\n".join(out)


SHEET_BAD = re.compile(r"[\[\]:*?/\\]")


def excel_swap(src, dst, rep):
    """Cell by cell. A formula keeps its form; only the text in its quotes and the sheet names it
    refers to change. Numbers stay numbers."""
    import openpyxl
    wb = openpyxl.load_workbook(src)
    n = 0
    # a sheet named for a client is renamed (a tag without its brackets, which a sheet name
    # cannot hold), and every formula that names it follows
    renamed = {}
    for ws in wb.worksheets:
        new = SHEET_BAD.sub("", rep(ws.title))[:31]
        if new != ws.title:
            renamed[ws.title] = new
    def formula(f):
        f = re.sub(r'"([^"]*)"', lambda m: '"' + rep(m.group(1)) + '"', f)
        for old, new in renamed.items():
            f = f.replace("'" + old + "'!", "'" + new + "'!").replace(old + "!", "'" + new + "'!")
        return f
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                v = c.value
                if isinstance(v, str):
                    neu = formula(v) if v.startswith("=") else rep(v)
                    if neu != v:
                        c.value = neu
                        n += 1
                if c.comment:
                    c.comment.text = rep(c.comment.text)
                    c.comment.author = rep(c.comment.author or "")
        for part in _header_parts(ws):
            if part.text:
                part.text = rep(part.text)
    for old, new in renamed.items():
        wb[old].title = new
        n += 1
    for attr in ("creator", "lastModifiedBy", "title", "subject", "keywords", "description"):
        v = getattr(wb.properties, attr)
        if v:
            setattr(wb.properties, attr, rep(v))
    wb.save(dst)
    return n


def excel_extras(path):
    """What openpyxl does not carry into the copy: charts and pictures."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
    lost = [k for k, pre in (("charts", "xl/charts/"), ("pictures", "xl/media/")) if any(n.startswith(pre) for n in names)]
    return lost


# ---------------------------------------------------------------- PDF, through docling
_CONVERTER = None
_READ = {}


def docling_document(path):
    """The PDF as docling reads it: titles, headings, paragraphs, lists and tables with their
    merged cells, a scan read through OCR."""
    global _CONVERTER
    if _CONVERTER is None:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        opts = PdfPipelineOptions()
        opts.do_ocr = True
        opts.do_table_structure = True
        if os.environ.get("DOCLING_ARTIFACTS_PATH"):
            opts.artifacts_path = os.environ["DOCLING_ARTIFACTS_PATH"]
        _CONVERTER = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
    # read once: the same reading plans the tags and lays out the copy
    if path not in _READ:
        _READ[path] = _CONVERTER.convert(path).document
    return _READ[path]


def ocr_blocks(blocks, rules):
    """docling's blocks with the spaces OCR loses put back (the page's own rule, hush.js ocrText),
    so the rules read "AZ85711" as "AZ 85711". The copy is laid out from these same texts."""
    texts = [b[1] for b in blocks if b[0] not in ("table", "picture")] + [c[5] for b in blocks if b[0] == "table" for c in b[3]]
    fixed = iter(rules.ask(op="ocr", texts=texts)["texts"])
    out = [(b[0], next(fixed)) if b[0] not in ("table", "picture") else b for b in blocks]
    return [("table", b[1], b[2], [c[:5] + (next(fixed),) for c in b[3]]) if b[0] == "table" else b for b in out]


def docling_blocks(doc):
    """docling's reading as plain blocks, in reading order: ("title" | "heading" | "list" |
    "text" | "small", text) and ("table", rows, cols, cells), each cell (row, end row, column,
    end column, header, text); ("picture",) for a picture, which is not carried."""
    out = []
    for item, _level in doc.iterate_items():
        kind = type(item).__name__
        label = str(getattr(item, "label", "")).split(".")[-1].lower()
        if kind == "TableItem":
            d = item.data
            cells = [(c.start_row_offset_idx, c.end_row_offset_idx, c.start_col_offset_idx, c.end_col_offset_idx, bool(c.column_header), c.text)
                     for c in d.table_cells]
            if cells:
                out.append(("table", d.num_rows, d.num_cols, cells))
        elif kind == "PictureItem":
            out.append(("picture",))
        elif getattr(item, "text", "").strip():
            k = ("title" if label == "title" else "heading" if label == "section_header" else "list" if kind == "ListItem"
                 else "small" if label in ("page_header", "page_footer", "footnote", "caption") else "text")
            out.append((k, item.text))
    return out


def blocks_text(blocks):
    return "\n".join(b[1] if b[0] not in ("table", "picture") else "\n".join(c[5] for c in b[3]) if b[0] == "table" else "" for b in blocks)


def blocks_to_word(blocks, swap, dst, note):
    """docling's blocks as a Word file, each text through `swap` (all of them in one call): real
    tables with docling's merged cells, its header rows in bold."""
    import docx
    from docx.shared import Pt, RGBColor
    texts = []
    for b in blocks:
        if b[0] == "table":
            texts.extend(c[5] for c in b[3])
        elif b[0] != "picture":
            texts.append(b[1])
    swapped = iter(swap(texts))
    doc = docx.Document()
    doc.styles["Normal"].font.name = "Calibri"
    doc.styles["Normal"].font.size = Pt(10)
    def small(text):
        r = doc.add_paragraph().add_run(text)
        r.italic = True
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(0x4F, 0x5E, 0x78)
    small(note)
    for b in blocks:
        if b[0] == "table":
            _, rows, cols, cells = b
            t = doc.add_table(rows=rows, cols=cols)
            t.style = "Table Grid"
            for r0, r1, c0, c1, head, _text in cells:
                cell = t.cell(r0, c0)
                if r1 - r0 > 1 or c1 - c0 > 1:
                    cell = cell.merge(t.cell(max(r0, r1 - 1), max(c0, c1 - 1)))
                cell.text = next(swapped)
                if head:
                    for run in cell.paragraphs[0].runs:
                        run.bold = True
            doc.add_paragraph()
        elif b[0] == "picture":
            small("[A picture here is not carried into this copy.]")
        else:
            text = next(swapped)
            if b[0] == "title":
                doc.add_heading(text, 0)
            elif b[0] == "heading":
                doc.add_heading(text, 2)
            elif b[0] == "list":
                doc.add_paragraph(text, style="List Bullet")
            elif b[0] == "small":
                small(text)
            else:
                doc.add_paragraph(text)
    doc.save(dst)


def pdf_text(path):
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)


# ---------------------------------------------------------------- reading back
def package_text(path):
    """Every text in every XML part of an Office file, tags taken out: what any reader of the file
    could find, the parts this script never edits (comments, footnotes) included."""
    out = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.endswith((".xml", ".rels")) or name.endswith(".vml"):
                xml = z.read(name).decode("utf-8", "replace")
                # a value Word split across runs reads whole once the tags between are gone; a
                # value in a cell of its own reads as a word once each tag is a space
                out.append(html.unescape(re.sub(r"<[^>]+>", "", xml)))
                out.append(html.unescape(re.sub(r"<[^>]+>", " ", xml)))
    return "\n".join(out)


# ---------------------------------------------------------------- one run
def swap_name(name, rules, plan):
    stem, ext = os.path.splitext(name)
    under = "_" in stem and " " not in stem
    neu = rules.swap([stem.replace("_", " ") if under else stem], plan)[0]
    return (neu.replace(" ", "_") if under else neu) + " (swapped)" + ext


def read_text(kind, path, rules=None):
    if kind == "word":
        return word_text(path)
    if kind == "excel":
        return excel_text(path)
    if kind == "slides":
        return slides_text(path)
    if kind == "pdf":
        return blocks_text(ocr_blocks(docling_blocks(docling_document(path)), rules))
    with open(path, "rb") as fh:
        raw = fh.read()
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def kind_of(ext):
    return "word" if ext in WORD else "excel" if ext in EXCEL else "slides" if ext in SLIDES else "pdf" if ext == ".pdf" else "text" if ext in TEXT else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Swap a message and its attachments for an AI chat, on this computer.")
    ap.add_argument("files", nargs="*")
    ap.add_argument("--out", required=True, help="folder for the swapped files and the report")
    ap.add_argument("--message", help="a text file holding the message")
    ap.add_argument("--message-text", help="the message itself")
    ap.add_argument("--always-hide", action="append", default=[], help="a word to hide wherever it appears (repeatable)")
    ap.add_argument("--clients", help="the firm's client list (a CSV or text export): every client is known by name, however rare")
    ap.add_argument("--accept", action="append", default=[], help="a value the check after swapping reads as personal but you have "
                    "looked at and know is not (a firm's own name, a public payer): the file is delivered with it (repeatable)")
    ap.add_argument("--key-passphrase-env", help="name of an environment variable holding a passphrase: the key is saved locked "
                    "with it (a .swapkey the page opens). Without it no key is written, because a key holds the real values.")
    ap.add_argument("--node", help="path to node, if it is not on PATH")
    args = ap.parse_args(argv)
    rules = Rules(args.node)
    os.makedirs(args.out, exist_ok=True)
    message = args.message_text or ""
    if args.message:
        with open(args.message, encoding="utf-8") as fh:
            message = fh.read()

    work = tempfile.mkdtemp(prefix="identity-swap-")
    try:
        # 1. every file in a kind this script can swap, and its text
        items = []
        for src in args.files:
            name = os.path.basename(src)
            ext = os.path.splitext(name)[1].lower()
            it = {"in": name, "src": src, "path": src, "ext": ext, "notes": [], "problem": None, "out": None, "how": None, "count": 0}
            items.append(it)
            try:
                if ext in LEGACY:
                    it["path"] = soffice(src, LEGACY[ext], work)
                    it["ext"] = "." + LEGACY[ext]
                    it["notes"].append("opened with LibreOffice and written back as " + it["ext"])
                it["kind"] = kind_of(it["ext"])
                if not it["kind"]:
                    it["problem"] = "not a kind of file this can swap"
                    continue
                it["text"] = read_text(it["kind"], it["path"], rules)
                if not it["text"].strip():
                    it["problem"] = "no text could be read from it"
            except Exception as e:  # noqa: BLE001 - one file's failure is reported, the rest go on
                it["problem"] = "it could not be read: " + str(e)[:300]

        # 2. one plan over the message, every file's text and every file's name
        texts = [message] + [t for it in items if not it["problem"] for t in (os.path.splitext(it["in"])[0].replace("_", " "), it["text"])]
        clients = []
        if args.clients:
            with open(args.clients, encoding="utf-8-sig", errors="replace") as fh:
                clients = rules.clients(fh.read())
        plan = rules.plan(texts, args.always_hide, clients) if any(t.strip() for t in texts) else []
        if message.strip():
            with open(os.path.join(args.out, "message (swapped).txt"), "w", encoding="utf-8") as fh:
                fh.write(rules.swap([message], plan)[0])

        # 3. each file swapped, then read back on its own
        for it in items:
            if it["problem"]:
                continue
            try:
                swap_one(it, rules, plan, args.out, work, args.accept)
            except Exception as e:  # noqa: BLE001
                it["problem"] = "it could not be swapped: " + str(e)[:300]
                if it["out"] and os.path.exists(it["out"]):
                    os.remove(it["out"])
                it["out"] = None

        if args.key_passphrase_env:
            phrase = os.environ.get(args.key_passphrase_env, "")
            stamp = dt.datetime.now().strftime("%Y-%m-%d %H%M")
            with open(os.path.join(args.out, "Swap key " + stamp + ".swapkey"), "w", encoding="utf-8") as fh:
                fh.write(lock_key(rules.key(plan), args.always_hide, phrase, clients))
        write_report(items, plan, args.out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    for it in items:
        print(("OK   " if it["out"] else "NO   ") + it["in"] + " -> " + (os.path.basename(it["out"]) + " (" + it["how"] + ")" if it["out"] else it["problem"]))
    return 0 if all(it["out"] for it in items) else 1


def swap_one(it, rules, plan, outdir, work, accept=()):
    on = [p for p in plan if p["checked"]]
    rep = Replacer(rules.rows(it["text"], on))
    name = swap_name(os.path.splitext(it["in"])[0] + it["ext"], rules, on)
    dst = os.path.join(outdir, name)
    kind = it["kind"]
    if kind == "word":
        it["count"] = word_swap(it["path"], dst, rep)
        it["how"] = "layout kept (python-docx)"
        back = package_text(dst)
    elif kind == "slides":
        it["count"] = slides_swap(it["path"], dst, rep)
        it["how"] = "layout kept (python-pptx)"
        back = package_text(dst)
    elif kind == "excel":
        it["count"] = excel_swap(it["path"], dst, rep)
        it["how"] = "cells, formulas and numbers kept (openpyxl)"
        lost = excel_extras(it["path"])
        if lost:
            it["notes"].append("openpyxl does not carry " + " or ".join(lost) + " into the copy; the page's own Excel swap keeps them")
        back = package_text(dst)
    elif kind == "pdf":
        it["count"] = len(rules.rows(it["text"], on))
        docx_path = os.path.join(work, os.path.splitext(os.path.basename(dst))[0] + ".docx")
        blocks_to_word(ocr_blocks(docling_blocks(docling_document(it["path"])), rules), lambda texts: rules.swap(texts, on), docx_path,
                       "Read by docling and laid out again: personal details are replaced by tags. Tables are kept; the original page design is not.")
        made = soffice(docx_path, "pdf:writer_pdf_Export", work)
        shutil.move(made, dst)
        it["how"] = "rebuilt from docling's reading (tables kept), printed by LibreOffice"
        back = pdf_text(dst)
    else:
        with open(it["path"], "rb") as fh:
            raw = fh.read()
        enc = "utf-8-sig" if raw.startswith(b"\xef\xbb\xbf") else "utf-8"
        try:
            raw.decode(enc)
        except UnicodeDecodeError:
            enc = "cp1252"
        with open(dst, "w", encoding=enc, newline="") as fh:
            fh.write(rules.swap([it["text"]], on)[0])
        it["count"] = len(rep.rows)
        it["how"] = "text, its encoding kept"
        back = it["text"] and open(dst, encoding=enc).read()
    it["out"] = dst
    # read back: no hidden value may be left anywhere a reader of the file could find it
    left = rules.leaks(back, plan)
    stuck = [l for l in left if l.get("tag")]
    # no one reviews a list here, as the page's user does, so whatever still reads as personal holds
    # the file back until it is hidden (--always-hide) or accepted as not personal (--accept)
    taken = {a.strip().upper() for a in accept}
    still = sorted({l["value"] for l in left if not l.get("tag") and l["value"].strip().upper() not in taken})
    if stuck or still:
        os.remove(dst)
        it["out"] = None
        it["problem"] = ("the copy still held " + ", ".join("[" + l["tag"] + "]" for l in stuck) + ", so it was deleted, not delivered" if stuck else
                         "the copy still reads as personal at " + ", ".join(v[:2] + "*" * max(0, len(v) - 2) for v in still[:8]) +
                         ", so it was deleted, not delivered; hide each with --always-hide, or pass --accept for one you know is not personal")


def write_report(items, plan, outdir):
    mask = lambda v: ("*" * max(0, len(v) - 4) + v[-4:]) if len(v) > 4 else "*" * len(v)  # noqa: E731
    with open(os.path.join(outdir, "Identity Swap attachments report.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["file (new name)", "result", "how", "values swapped", "notes"])
        for it in items:
            w.writerow([os.path.basename(it["out"]) if it["out"] else "", "swapped" if it["out"] else "not delivered: " + (it["problem"] or ""),
                        it["how"] or "", it["count"], "; ".join(it["notes"])])
        w.writerow([])
        w.writerow(["tag", "kind", "value (last four)"])
        for p in plan:
            if p["checked"]:
                w.writerow(["[" + p["tag"] + "]", p["kind"], mask(p["value"])])


# ---------------------------------------------------------------- the locked key, as the page writes it
def lock_key(key, always_hide, passphrase, clients=()):
    """The key in the page's own .swapkey format (AES-256-GCM, PBKDF2-SHA-256, 600,000 rounds), so
    the page opens it and restores an answer."""
    if len(passphrase) < 8:
        raise SystemExit("the key's passphrase must be at least 8 characters")
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    salt, iv = os.urandom(16), os.urandom(12)
    k = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=600000).derive(passphrase.encode("utf-8"))
    plain = json.dumps({"entries": key["entries"], "counters": key["counters"], "alwaysHide": always_hide, "clients": list(clients)}).encode("utf-8")
    data = AESGCM(k).encrypt(iv, plain, None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return json.dumps({"format": "identity-swap-hush-key", "version": 1, "cipher": "AES-256-GCM", "kdf": "PBKDF2-SHA-256",
                       "iterations": 600000, "salt": b64(salt), "iv": b64(iv), "data": b64(data)})


if __name__ == "__main__":
    sys.exit(main())
