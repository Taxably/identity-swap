# Identity Swap

Identity Swap turns a client folder into a realistic copy with every person replaced, so it can be
used for testing, demos and training without exposing a single client.

It is a single web page that makes a de-identified copy of a client folder. It finds names, SSNs,
EINs, addresses, account numbers, dates of birth and ID details in every file, then replaces each
one with a realistic stand-in. The copy has the same folders and files in the same places and
layouts. Nothing is uploaded.

Point Identity Swap at a client folder and it gives back the same folder with the people taken out.
Every folder and file comes back where it was, the same kind of file with the same layout, but
every name, number and address belongs to nobody.

It also has a second mode, **Swap text for an AI chat**: paste a client email or note, and every
name, SSN, EIN, address, phone, email, account number and birth date becomes a tag such as
`[PERSON-1]` or `[SSN-1]`. Send the swapped text to whichever AI you use, paste the answer back, and
the page puts the real details back in. See [Swapping text for an AI chat](#swapping-text-for-an-ai-chat).

## What it replaces

- Taxpayer, spouse, dependent and children's names, including middle initials and names that only
  appear in a sentence or a table
- SSNs and ITINs, including SSNs a spreadsheet stored as a number and dropped the leading zero from
- EINs, account numbers, phone numbers and email addresses
- Dates of birth
- Street addresses, cities and ZIP codes, using real cities with real ZIP codes in the same state
- Businesses, employers and payers, keeping what kind of business they are ("Consulting LLC" stays
  "Consulting LLC"). Banks, brokerages, universities and other institutions are left as printed.
- Driver licences and ID cards: the photo and its faint copy become a plain silhouette, and the
  name, licence number, birth date, issue and expiry dates, address and DD number are swapped

A stand-in is never one of the folder's own values, so no client's real name or ZIP turns up as
another client's stand-in. Names come from the Census Bureau's and the Social Security
Administration's public tables, places from a table of every active US ZIP code.

## How the copy stays faithful

- One stand-in per value, everywhere it appears, so a household stays consistent across every
  document, folder name and file name.
- File types:
  - PDFs, scans, phone photos, TIFF faxes, Excel, Word, PowerPoint, CSV, text files and zip
    archives all come back as the kind they came. The one exception is a HEIC photo, which comes
    back as a JPEG named .jpg, because no browser can write HEIC; the report says so.
  - Workbooks keep their sheets, formulas, numbers, comments, headers and footers.
  - A text file keeps its encoding (UTF-8, UTF-16 or Windows-1252). A zip archive is opened, every
    file inside it is handled as if it sat in the folder, and the archive is written again.
- Layout:
  - On a PDF page, nothing moves except the swapped text.
  - On a scanned page or photo, each value is repainted in the document's own lettering, cut from
    elsewhere on the same page. A letter the page never prints is drawn in the closest of six
    common typefaces.
  - A PDF page whose text the file does not hold as letters (text printed as outlines, a font
    that gives no letters back, a small picture of a name or number) is drawn again as a picture
    and painted like a scan, and the report says so. That page's text can no longer be selected.
  - A phone photo keeps its orientation, and nothing else the camera wrote (where it was taken,
    what took it) comes back.
  - A picture keeps its format, resolution and colours: a black-and-white fax stays black and
    white, a PNG keeps its palette.
- Every folder comes back, empty ones included. The report is saved beside the copy, not inside it.

## How it proves the copy

Every file is checked before it is written. Text is searched again for every original value. Each
PDF page is drawn before and after and must differ only inside the swapped words. Scanned pages and
photos are read again by both readers, and the page confirms every stand-in reads as painted, no
original value remains, and nothing outside the swapped words changed. Every PDF page that showed
text the file does not hold as letters is drawn again from the copy and read: no original value
may read there. If a value can't be redrawn cleanly, it is
blanked out and the report says so. A file that fails its checks is never written.

## Privacy

Everything runs inside the browser on your own computer. The page is one file with everything it
needs built in, and it is locked so it cannot connect to the internet: its Content-Security-Policy
forbids every request. No AI service is used, and no file is uploaded anywhere.

Scanned pages and photos are read by two engines, both inside the page:

- Tesseract, the open-source text recognition engine, whose letter boxes the repainting uses.
- Docling's OCR engine: RapidOCR's PP-OCRv5 models (a text detector and an English recogniser,
  from PaddleOCR), run by ONNX Runtime's WebAssembly build with the same steps and settings
  RapidOCR uses. Docling itself is a Python library and cannot run in a browser; this is the OCR
  engine it reads pages with. Whatever it reads that Tesseract missed or misread is searched and
  swapped, and the read-back after painting is searched with both.

Every PDF page is also drawn, docling's way. Where the drawing shows ink the file's own text does
not account for, docling's engine reads it, so a name printed as outlines or set in a small
picture is found too. If docling's engine cannot start, Tesseract reads alone and the page says
so. The photo on an ID card is found with the Viola-Jones face detector (tracking.js), a
fixed set of pixel comparisons that also runs inside the page.

## What it leaves out, and says so

- Password-protected PDFs, and PDFs restricted against copying or printing
- Digitally signed PDFs
- Animated GIFs
- Mac system files (.DS_Store, ._ files, __MACOSX folders)
- File types it can't open (an older .doc or .xls among them), unless you choose to copy them
  unchanged

Handwriting and signatures it can't read are flagged in the report, and you choose whether to keep
or erase them.

## Using it

1. Download `identity-swap.html` and open it in Chrome or Edge. In another browser the copy
   downloads as a .zip, which holds at most 4 GB, and the page says so before it starts. Reading
   scanned pages needs WebAssembly SIMD, OffscreenCanvas and DecompressionStream; a browser
   without them is told the scans cannot be read, and they are listed with the files the page
   cannot change.
2. Choose the folder: a folder of client folders, or one client's own folder. The page reads every
   file and lists what it found.
3. Review. Each value shows its stand-in, which you can edit or untick, and whether it fits where
   it is printed. You can add a name the page did not recognise, or any other find and replace
   pair. If files hold handwriting or signatures, choose whether to keep them as they are, erase
   them, or leave those files out.
4. Start. Chrome and Edge ask where to save, and write `<folder> (swapped <date> <time>)` there one
   file at a time, so a large folder never sits in memory. The folder's own name is swapped too.

The report, `<copy> - Identity Swap report.csv`, is saved beside the copy. It names files only by
their new names and shows values only by their last four characters.

## Swapping text for an AI chat

The second tab at the top of the page. It is for asking an AI about a client without handing the
AI the client.

1. Paste the text, or open a .txt, .csv, .eml or .md file. Each value becomes a tag: `[PERSON-1]`,
   `[PERSON-1-FIRST]` for the first name alone ("Dear [PERSON-1-FIRST]"), `[SSN-1]`, `[EIN-1]`,
   `[ADDRESS-1]`, `[CITY-1]`, `[ZIP-1]`, `[PHONE-1]`, `[EMAIL-1]`, `[ACCOUNT-1]`, `[DOB-1]`,
   `[BUSINESS-1]`, and `[HIDDEN-1]` for your own list. A state code is left as written, since it
   identifies nobody and a tax answer often turns on it.
   Under **Words to always hide**, import the firm's client list (a CSV or text export from
   ProConnect, TaxDome, Canopy or a spreadsheet): every client is then a known person, however
   rare the name. On the benchmark this takes names from 99.5% to 100%. The list stays in the tab,
   and goes into a saved key only locked.
2. Check the list. Untick anything that should stay, or rename a tag so the AI reads it better
   (`[PERSON-2]` to `[SPOUSE]`, `[PERSON-3]` to `[CHILD-1]`). Copy the swapped text.
3. Paste the AI's answer back. Every tag the key knows becomes the real value again. A tag the AI
   invented is listed and left as written, never guessed.

### Attachments

Attach PDF, Word, Excel, PowerPoint or text files beside the message. The message and every
attachment, file names included, are read as one, so `[PERSON-1]` in the email is `[PERSON-1]` in
the W-2 and in the wage sheet. Each attachment comes back as a file to download and attach:

- Word, Excel and PowerPoint: swapped inside the file's own parts. Tables, formulas, numbers and
  layout stay as they were.
- PDF: swapped in place with its layout kept. Where the PDF's own fonts can draw the tags, they are
  written in them. Most PDFs embed only the letters they print, so a font often has no `[`: then
  each value is taken out (which needs no letter) and its tag drawn on the same baseline in
  Helvetica, sized to fit where the value was. Only a PDF the engine cannot change at all comes back
  as a text PDF of its pages, labelled as one. One limit: drawn tags sit at the end of the page's
  text stream, so a reader that ignores position (rather than reading the page as laid out) meets
  them after the rest of the page's text.
- Scans and photos, and PDFs whose pages are scans: read by the page's two OCR engines, each value
  painted over with its tag in the page's own lettering, then read again. A tag wider than the
  room its value had, or a value the readers disagree on, is blanked out instead of drawn, and the
  file's note says so: nothing of the value is left either way.
- The file name is swapped too: `Quillfeather W2.pdf` becomes `[PERSON-1-LAST] W2 (swapped).pdf`.
- Every file is read back after it is made and searched for every hidden value. One that still
  holds any is not offered.
- Restoring works on files too: give the page a Word, Excel, PowerPoint, PDF or text file the AI
  handed back, and each tag the key knows is put back inside the file, read back to check.

How it finds things: the same rules the folder swap uses, plus a reading of names in running
text (a first name followed by a surname, a name after a label such as "Spouse:" or a greeting
such as "Hi Sarah,", a hyphenated or Irish surname), birth dates after "born" or "DOB", and
businesses by their legal ending (LLC, Inc, Corp). An SSN, EIN, phone or account number is hidden
however it is spaced or punctuated, and a card number when its check digit is right (Luhn). A
bank's routing number names a bank, not a client, and is left as written. **Words to always hide**
catches anything else: a nickname, an employer, a street.

How it checks itself: before you copy, the swapped text is searched again for every hidden value,
and run through the finder again. A value still present blocks it with a red note; anything that
still reads as personal is offered with a one-click "Hide".

The key: which tag stands for which value lives in the tab's memory and is gone when the tab
closes. One value keeps one tag across every paste in the tab, so a household reads the same in a
whole conversation. To restore an answer days later, save the key locked with a passphrase
(a .swapkey file, AES-256-GCM, key drawn with PBKDF2-SHA-256 at 600,000 rounds, all by the browser's own Web
Crypto). The file holds the real values encrypted and nothing readable; without the passphrase it
cannot be opened. Nothing is ever written to browser storage.

What it does not do, plainly:

- Finding is a safety net, not a guarantee. Names are the hardest part. Read the swapped text
  before you send it.
- The AI company still receives everything that is not hidden. A rare condition, an unusual job
  or a small town can point to a person.
- Swapping text does not by itself make a firm compliant with any rule on client data (IRC 7216, the
  FTC Safeguards Rule, or a state law). It supports the safeguards they expect.
- The page cannot be inside the AI site itself yet: you copy the swapped text and attach the
  swapped files. A browser extension that does this in place is the next step.

## The companion: attachments with docling, LibreOffice and Python

The page runs in a browser, so it opens only what a browser can. `companion/swap_attachments.py`
runs on the firm's own computer and swaps a message and its attachments with the page's own rules
(through node and `companion/rules.js`, so a tag means the same in both), using the tools a browser
cannot:

| Tool | What it does here |
|---|---|
| LibreOffice (headless) | Opens .doc, .xls, .ppt, .rtf, .odt, .ods and .odp and writes them as .docx, .xlsx and .pptx before they are swapped; prints a rebuilt PDF |
| docling | Reads a PDF as a document, with headings, paragraphs and tables, and scans through OCR. The tagged text is laid out again as a Word file and printed to PDF by LibreOffice, so a W-2's boxes stay a table |
| python-docx, python-pptx | Swap Word and PowerPoint text run by run, keeping each run's formatting, a value Word split across runs included: body, tables, headers, footers, speaker notes and the file's author and title |
| openpyxl | Swaps Excel cell by cell: numbers stay numbers, formulas stay formulas (only the text in their quotes changes), a sheet named for a client is renamed and every formula that names it follows, comments, headers and footers |
| pdfplumber | Reads every rebuilt PDF back, on its own, to check it |

```bash
python companion/swap_attachments.py --out "Swapped for AI" --message message.txt "Quillfeather W2.pdf" wages.xls notes.docx
```

Add `--clients list.csv` to read the firm's client list, `--always-hide WORD` for anything the rules might miss, and `--key-passphrase-env VAR` to save
the key locked with the passphrase in that environment variable. The key is a `.swapkey` in the
page's own format: open it in the page's text swap mode to restore the AI's answer. Without the
flag no key is written, because a key holds the real values.

Every output is read back, independently of how it was written: every XML part of an Office
file, every page of a PDF. A file that still holds any hidden value, or anything else that still
reads as personal, is deleted, not delivered, and the run ends with an error. No one reviews a
list here the way the page's user does, so the companion is stricter: hide what it names with
`--always-hide`, or pass `--accept VALUE` for one you have looked at and know is not personal.

Text docling reads from a scan has the spaces OCR tends to lose put back before the rules read it
("Marisol JQuillfeather", "AZ85711"); the copy is laid out from that same text. The report beside the files shows values by their last four
characters only.

Set up once:

```bash
pip install -r companion/requirements.txt
```

LibreOffice and node install on their own. docling downloads its models from Hugging Face the
first time it reads a PDF (models only, never a document). After that it runs offline, or point
`DOCLING_ARTIFACTS_PATH` at a folder of downloaded models. Note that openpyxl does not carry charts
or pictures into a copy; the companion says so for a workbook that has them, and the page's own
Excel swap keeps them.

## How well it finds: the benchmark

`node bench/run.js` scores the finding rules on 600 invented tax documents (client emails, W-2s,
1099-NECs, preparers' notes, CSV exports, letters, scans' OCR text, and notes full of words that
look like names and are not). Every value in them is labelled, so a miss or a wrong hide is counted,
never guessed. Every push runs it, and CI fails if any score drops below `bench/baseline.json`.

| Kind | Found |
|---|---|
| SSNs, EINs, account numbers, phones, emails, birth dates | 100% |
| Streets, cities, ZIP codes, businesses | 100% |
| People's names | 99.5% (100% with the firm's client list imported) |
| Words wrongly hidden (forms, IRS terms, banks, "Will", "Grace", "Bill") | 0 of 1,720 |

The names it still misses are a first name no public list carries beside a surname no list carries,
with no label near them ("for Priya Ostfeather"). The documents are invented, so these numbers say
what the rules do on the cases written into the benchmark, not on every real file: read the swapped
text before you send it. `node bench/run.js --misses` lists every miss.

## Check it yourself

Both modes share a panel at the bottom of the page that counts every request the tab makes (it
should read 0), a button that tries to reach the internet and shows the browser refusing it, and
the page's own Content-Security-Policy, as the browser enforces it. You can also turn off Wi-Fi
and reload: the page works the same, because everything it needs is inside the one file.

### Before you share a copy

Read the report's notes. Three of them mean the copy may still hold something of a person:

- an ID card on which no photo was found (a face turned in profile, or a very small or glaring one)
- a file whose handwriting or signatures were kept as they are
- a file copied unchanged, which keeps everything it showed (only its file name is swapped)

## What is in this repository

| Path | What it is |
|---|---|
| `identity-swap.html` | The page, built. This is the file to download and open. |
| `web/template.html` | The page around the scripts: layout, wording and its Content-Security-Policy |
| `web/engine.js` | Swaps text inside a PDF, in the font the page already uses |
| `web/pii.js` | Finds personal information and chooses each stand-in |
| `web/ocr.js` | Reads scanned pages and photos, and repaints them; draws PDF pages and reads what they show |
| `web/docling.js` | Docling's OCR engine: RapidOCR's PP-OCR detection and recognition steps on ONNX Runtime |
| `web/fetch_docling_models.py` | Downloads the PP-OCRv5 models from RapidOCR's model store, checked against pinned SHA-256s |
| `web/docling-LICENSES.txt` | Licences of ONNX Runtime (and its third-party parts), the PP-OCR models and RapidOCR |
| `web/faces.js` | Finds the photo and its faint copy on an ID card |
| `web/pictures.js` | Reads and writes JPEG, PNG, WebP, TIFF, HEIC, GIF and BMP |
| `web/office.js` | Swaps Excel, Word and PowerPoint files inside their own parts |
| `web/folder.js` | Runs a whole folder and writes the report |
| `web/check.js` | Draws each PDF page before and after and compares them |
| `web/ui.js` | The page's three steps |
| `web/hush.js` | Swaps text into tags, checks the result, restores an answer, and locks or opens a saved key |
| `companion/swap_attachments.py`, `companion/rules.js` | The companion: attachments swapped on the firm's computer with LibreOffice, docling, python-docx, python-pptx and openpyxl, by the page's own rules |
| `bench/corpus.js`, `bench/run.js`, `bench/baseline.json` | The benchmark: invented tax documents with every value labelled, the scorer, and the scores CI holds the rules to |
| `CLA.md`, `.github/pull_request_template.md` | The contributor licence agreement, and the checklist every pull request carries |
| `.github/workflows/ci.yml` | CI: the benchmark, the tests, and a rebuild of the page that must match the committed one byte for byte |
| `web/attach.js` | Swaps a PDF, Word, Excel, PowerPoint or text attachment with the message's tags, and reads it back to check |
| `web/hushui.js` | The page's text swap mode and the "Check it yourself" panel |
| `web/data.js` | PDF encoding tables and standard font widths |
| `web/names.js`, `web/make_names.py` | First names and surnames, and the script that writes them from the Census Bureau and SSA tables |
| `web/places.js`, `web/make_places.py` | Every active US ZIP code with its city and state, and the script that writes it |
| `web/build.py` | Builds `identity-swap.html` from the sources and the pinned libraries |
| `web/ocr-LICENSES.txt`, `web/places-LICENSE.txt` | Licences of the OCR engine's parts and the ZIP table, carried into the page |
| `package.json`, `package-lock.json` | The libraries the build puts inside the page, at exact versions |
| `requirements.txt` | Python packages for the build and the tests |
| `tests/` | The tests, and the node scripts they run the page's code through |

## Rebuilding the page

```
npm ci --ignore-scripts --omit=optional
pip install -r requirements.txt
python web/fetch_docling_models.py ocr-models
python web/build.py --libs node_modules --models ocr-models
```

`build.py` checks every library file against a pinned SHA-256 before it goes in, and puts each
library's licence into the page with it. The OCR engines' WebAssembly and their models go in
as base64, most of them gzipped (the page is about 34 MB). A test fails if `identity-swap.html` does not carry every source as it now is, so
rebuild after any change under `web/`.

`names.js` and `places.js` are written from public data, and each input is checked against a
pinned SHA-256 before it is read:

```
python web/make_names.py dist.female.first dist.male.first names.zip baby-names.csv words_alpha.txt
python web/make_places.py zipcodes-1.2.0-py2.py3-none-any.whl
```

`make_names.py` says where each of its five inputs comes from: the Census Bureau's 1990 first-name
and 2010 surname tables, the Social Security Administration's baby-name tables (all public domain),
and the dwyl English word list (the Unlicense), which only marks names that are also English words.
`make_places.py` reads the zipcodes package on PyPI (MIT). The same inputs always give the same
files.

## Tests

```
python -m pytest tests -q
```

The tests need `requirements.txt` installed and Node.js; they were run on Python 3.13 and Node 22.
Every document they use is built inside the test from invented people, and the page's
own code runs in node with its libraries taken out of the built page, so no `node_modules` is
needed. They check:

- the built page carries every source and pinned library as it now is, with every licence, and
  forbids every network request (`test_the_identity_swap_page_is_its_sources_and_reaches_no_network.py`)
- people, businesses and places are found, and form words, state codes and acronyms are not
  (`test_the_identity_swap_finds_people_and_places_not_form_words.py`)
- every kind of file comes back as it came: a PDF, a locked PDF, a workbook, a Word letter, a slide
  deck, text files in three encodings, a zip, empty folders, a workbook's header and footer, an
  SSN that lost its leading zero, PNG, BMP, GIF, TIFF and JPEG pictures with their colour type,
  palette, depth and resolution, and a phone photo's rotation flag
  (`test_the_identity_swap_keeps_every_kind_of_file_as_it_came.py`)
- a scan is read, repainted and read again with every stand-in and none of the old values, a
  signature is kept or erased as chosen, and a value no letter on the page can draw is blanked
  (`test_the_identity_swap_reads_and_repaints_a_scan.py`)
- docling's OCR engine starts beside Tesseract; on a soft, grainy phone photo it finds the SSN
  Tesseract alone misses; a PDF with a line of text drawn as shapes, one drawn wholly as shapes and
  one with an account number in a small picture all come back swapped, their pages drawn again as
  pictures; and every copy, read again by both readers, shows no original value
  (`test_the_identity_swap_reads_with_doclings_ocr_engine.py`)
- a driver licence loses its photo, its faint copy and every detail, and the same card faxed so
  dark that its faint copy is a few blots loses every one of them
  (`test_the_identity_swap_replaces_an_id_cards_photo_and_details.py`)

## Third-party components

The page carries every library it uses, each under its own licence, and their full licence texts
are inside it (search the page source for `====`):

| Component | Licence |
|---|---|
| pdf-lib 1.17.1, with pako 1.0.11 | MIT; pako MIT and Zlib |
| PDF.js (pdfjs-dist) 3.11.174 | Apache-2.0 |
| fflate 0.8.3 | MIT |
| UTIF.js 3.1.0 | MIT |
| gifenc 1.0.3 | MIT |
| libheif-js 1.23.5 (libheif and libde265) | LGPL-3.0, carried unmodified as its own script so it can be replaced |
| tracking.js 1.1.3 and its frontal-face cascade | BSD |
| tesseract.js-core 7.0.0 (Tesseract, Leptonica, libpng, LibTIFF, libwebp, zlib, libjpeg) | Apache-2.0 and each part's own licence, in `web/ocr-LICENSES.txt` |
| Tesseract's English model (tessdata_best), packaged by @tesseract.js-data/eng 1.0.0 | Apache-2.0; the package MIT |
| ONNX Runtime Web 1.22.0 (onnxruntime-web) | MIT, with its third-party notices, in `web/docling-LICENSES.txt` |
| PP-OCRv5 mobile detector and English recogniser (PaddleOCR), in RapidOCR 3.4.0's ONNX form | Apache-2.0, in `web/docling-LICENSES.txt` |
| zipcodes 1.2.0 (the ZIP table in `places.js`) | MIT, in `web/places-LICENSE.txt` |
| Census Bureau and SSA name tables (`names.js`) | Public domain |
| dwyl english-words | The Unlicense |
| pdfminer.six (encoding tables and font widths in `data.js`) | MIT |

PDF.js 3.11.174 is subject to advisory GHSA-wgrm-67xf-hhpq (CVE-2024-4367), which lets a crafted
PDF run script through PDF.js's font code. The advisory's workaround is to open documents with
`isEvalSupported: false`, which is how this page opens every PDF, and the page's
Content-Security-Policy forbids evaluating text as script in any case.

## Licence

Identity Swap is open source under the GNU Affero General Public License, version 3 only
(AGPL-3.0-only). Copyright © 2026 Taxably, Inc. See `LICENSE` for the licence and `NOTICE` for the
copyright notice and the list of third-party components, which stay under their own licences.

In plain words: anyone may use, study, change and share Identity Swap. Whoever shares a changed
version, or runs one for other people over a network, must offer those people its source under the
same licence. A firm that wants to build it into a closed product can ask Taxably for a commercial
licence instead.

Contributions are welcome: see `CONTRIBUTING.md` and the contributor licence agreement in `CLA.md`. To report a security problem privately, see
`SECURITY.md`.
