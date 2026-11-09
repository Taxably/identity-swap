## What this changes

<!-- One change per pull request. Say what a preparer sees differently. -->

## How it is tested

<!-- The test that fails without this change, and its name. -->

- [ ] `python -m pytest -q tests` passes
- [ ] `node bench/run.js` shows no score below the baseline
- [ ] `ruff check web tests companion` passes
- [ ] If anything under `web/` changed, `identity-swap.html` is rebuilt with `web/build.py`

## Privacy

- [ ] No real client's document, name, number or other personal information is anywhere in this
      change, its tests or its history (invented people only)
- [ ] The page still makes no network request, and every file it writes is still read back

## Agreement

- [ ] I agree to the [Contributor License Agreement](../CLA.md), and each commit is signed off
      (`git commit -s`)
