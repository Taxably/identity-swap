# Contributing to Identity Swap

Identity Swap reads clients' tax documents, so every change is held to three rules before anything
else:

1. **No network.** The page's Content-Security-Policy forbids every request, and a test fails if a
   build loosens it. No library may be loaded from a CDN, and no feature may need a server.
2. **Nothing unchecked is delivered.** Every file the page or the companion writes is read back and
   searched for every value it hid. A change that writes a file must keep that check, or add one.
3. **Pinned and reproducible.** Every library inside the page is pinned by version and SHA-256 in
   `web/build.py`, with its licence carried into the page. The same inputs build the same page,
   byte for byte.

## Set up

```bash
npm ci --ignore-scripts --omit=optional
pip install -r requirements.txt
python web/fetch_docling_models.py ocr-models
```

For the companion (optional): `pip install -r companion/requirements.txt`, plus LibreOffice and node
on the path.

## Build the page

`identity-swap.html` is a build output and is committed. After changing anything under `web/`:

```bash
python web/build.py --libs node_modules --models ocr-models
```

A test fails if the committed page does not carry every source as it now is.

## Test

```bash
python -m pytest -q tests
```

```bash
node bench/run.js
```

The first runs the tests. The second scores the finding rules on the benchmark of invented tax
documents and fails if any score drops below `bench/baseline.json`. A change that raises a score
updates the baseline in the same pull request.

Tests use invented people and real public places only. Never commit a real client's document,
name or number, not even redacted; a test file that came from a real return is rejected.

## Pull requests

- One change per pull request, with a test that fails without it.
- Run `ruff check web tests companion` and the tests before you push.
- Sign off each commit (`git commit -s`): the sign-off certifies the
  [Developer Certificate of Origin](https://developercertificate.org/), that you wrote the change
  or have the right to submit it under the project's licence.
- Agree to the [Contributor License Agreement](CLA.md) by ticking its box in the pull request.
  Identity Swap is AGPL-3.0-only and Taxably also offers it under commercial licences; the
  agreement lets your contribution be part of both. You keep your copyright.

## Writing style

Code comments and user-facing words say what happens in plain language, the way the rest of the
code does. User-facing text names what was left out or could not be checked; it never claims more
than the checks prove.
