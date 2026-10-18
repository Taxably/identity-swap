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
  - A phone photo keeps its orientation, and nothing else the camera wrote (where it was taken,
    what took it) comes back.
  - A picture keeps its format, resolution and colours: a black-and-white fax stays black and
    white, a PNG keeps its palette.
- Every folder comes back, empty ones included. The report is saved beside the copy, not inside it.

## How it proves the copy

Every file is checked before it is written. Text is searched again for every original value. Each
PDF page is drawn before and after and must differ only inside the swapped words. Scanned pages and
photos are read again, and the page confirms every stand-in reads as painted, no original value
remains, and nothing outside the swapped words changed. If a value can't be redrawn cleanly, it is
blanked out and the report says so. A file that fails its checks is never written.

## Privacy

Everything runs inside the browser on your own computer. The page is one file with everything it
needs built in, and it is locked so it cannot connect to the internet: its Content-Security-Policy
forbids every request. No AI service is used, and no file is uploaded anywhere.

Scanned pages are read with Tesseract, the open-source text recognition engine, which runs inside
the page. The photo on an ID card is found with the Viola-Jones face detector (tracking.js), a
fixed set of pixel comparisons that also runs inside the page.

## What it leaves out, and says so

- Password-protected PDFs, and PDFs restricted against copying or printing
- Digitally signed PDFs
- A PDF whose text is drawn in a font that gives no letters back, so it cannot be searched for names
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
| `web/ocr.js` | Reads scanned pages and photos, and repaints them |
| `web/faces.js` | Finds the photo and its faint copy on an ID card |
| `web/pictures.js` | Reads and writes JPEG, PNG, WebP, TIFF, HEIC, GIF and BMP |
| `web/office.js` | Swaps Excel, Word and PowerPoint files inside their own parts |
| `web/folder.js` | Runs a whole folder and writes the report |
| `web/check.js` | Draws each PDF page before and after and compares them |
| `web/ui.js` | The page's three steps |
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
python web/build.py --libs node_modules
```

`build.py` checks every library file against a pinned SHA-256 before it goes in, and puts each
library's licence into the page with it. The OCR engine's WebAssembly and its English model go in
as base64. A test fails if `identity-swap.html` does not carry every source as it now is, so
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
| zipcodes 1.2.0 (the ZIP table in `places.js`) | MIT, in `web/places-LICENSE.txt` |
| Census Bureau and SSA name tables (`names.js`) | Public domain |
| dwyl english-words | The Unlicense |
| pdfminer.six (encoding tables and font widths in `data.js`) | MIT |

PDF.js 3.11.174 is subject to advisory GHSA-wgrm-67xf-hhpq (CVE-2024-4367), which lets a crafted
PDF run script through PDF.js's font code. The advisory's workaround is to open documents with
`isEvalSupported: false`, which is how this page opens every PDF, and the page's
Content-Security-Policy forbids evaluating text as script in any case.

## Licence

Copyright © 2026 Taxably, Inc. All rights reserved. See `LICENSE`. The third-party components
above are under their own licences.
