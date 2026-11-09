# Changelog

## 1.1.0 (2026-11-09)

**Excel attachments, as firms keep them.**
- A sheet or table named for the client no longer leaves a workbook Excel calls damaged: its name
  takes a form Excel allows and every formula that names it follows.
- An SSN, phone or account number typed as a number, and a birth date kept as a date, are found
  and swapped; a number cell that takes a tag is written as text.
- A link's address and hover text are swapped (they held the client's email).
- Older spreadsheets (.xls, .xlsb, .ods, .numbers) are accepted, opened by SheetJS 0.20.3 inside
  the page and returned as .xlsx.
- Restoring a workbook puts the client's name back in its sheet names too.

## 1.0.0 (2026-11-09)

The first open-source release, under AGPL-3.0-only.

**Folder swap.** A client folder comes back with every person replaced by a realistic stand-in:
PDFs, Office files, text, zip archives, scans, photos and ID cards, every file checked before it
is written.

**Text swap for an AI chat.**
- Paste a client email or note: names, SSNs, EINs, addresses, phones, emails, accounts, card
  numbers and birth dates become tags such as `[PERSON-1]`; one value keeps one tag in every paste.
- Attach PDF, Word, Excel, PowerPoint and text files, scans and photos: each comes back swapped
  with the message's tags, its layout kept, read back before it is offered.
- Restore the AI's answer, typed or as a file, inside the page.
- Import the firm's client list, so every client is known by name.
- Save the key locked with a passphrase (AES-256-GCM); forget it, and everything with it, in one
  click.
- Check it yourself: a live count of every request the page makes (none) and a button that shows
  the browser refusing one.

**Companion.** `companion/swap_attachments.py` swaps attachments on the firm's computer with
docling, LibreOffice, python-docx, python-pptx and openpyxl, by the page's own rules.

**Proof.** A benchmark of 600 invented tax documents (names 99.5%, 100% with a client list; every
other kind 100%; no word wrongly hidden), an end-to-end test of the page in Chromium, and CI that
fails on any drop and rebuilds the page byte for byte.
