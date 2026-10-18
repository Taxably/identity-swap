"""Write places.js: every active US ZIP code with its city and state, for the identity swap page.

    python make_places.py <zipcodes-1.2.0-py2.py3-none-any.whl>

The source is the zipcodes package on PyPI (MIT), version 1.2.0, whose wheel is checked against
the SHA-256 below before anything is read from it. The page uses the table two ways: to tell a
real "City, ST 12345" from a form's words that only look like one, and to give an address a
stand-in that is a real place: a real city of the same length in a real state, and a real ZIP
code of that city.

Format, one string per state: "City|zips;City|zips;...", zips comma-separated, a ZIP that is not
a street delivery ZIP (a PO box, a single firm's ZIP, military) marked with a leading "*". Such a
ZIP is real and counts when finding an address, but is never chosen as a stand-in. Only the
territories and military post offices are left out, so the same wheel always gives the same
places.js.
"""

from __future__ import annotations

import bz2
import hashlib
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
WHEEL_SHA256 = "e06e4ad7a460cfa892452e1b8d6207a0e9059e2a00e96bf0b7b36afcaa176a29"
# the 50 states and DC; territories and military post offices are left out of stand-ins
STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY "
    "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())


def main() -> int:
    wheel = sys.argv[1]
    with open(wheel, "rb") as fh:
        got = hashlib.sha256(fh.read()).hexdigest()
    if got != WHEEL_SHA256:
        raise SystemExit("%s is not the pinned zipcodes 1.2.0 wheel (sha256 %s)" % (wheel, got))
    with zipfile.ZipFile(wheel) as z:
        rows = json.loads(bz2.decompress(z.read("zipcodes/zips.json.bz2")))
        licence = z.read("zipcodes-1.2.0.dist-info/LICENSE.txt").decode("utf-8")
    by_state: dict[str, dict[str, list[str]]] = {}
    for r in rows:
        if not r["active"] or r["state"] not in STATES:
            continue
        mark = "" if r["zip_code_type"] == "STANDARD" else "*"
        cities = by_state.setdefault(r["state"], {})
        cities.setdefault(r["city"], []).append(mark + r["zip_code"])
        # a name the post office also accepts for this ZIP is a real place for finding it
        for alt in r.get("acceptable_cities") or []:
            cities.setdefault(alt, []).append("*" + r["zip_code"])
    out = {}
    for st in sorted(by_state):
        parts = []
        for city in sorted(by_state[st]):
            zips = sorted(set(by_state[st][city]), key=lambda z: (z.lstrip("*"), z))
            # a ZIP listed both as standard and as a marked alternate is standard
            plain = {z for z in zips if not z.startswith("*")}
            zips = [z for z in zips if not (z.startswith("*") and z[1:] in plain)]
            parts.append(city + "|" + ",".join(zips))
        out[st] = ";".join(parts)
    body = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(HERE, "places.js"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("/* US cities, states and ZIP codes, from the zipcodes package 1.2.0 (MIT), data of "
                 "October 2021; written by make_places.py. */\n")
        fh.write("const PDFSWAP_PLACES = " + body + ";\n")
        fh.write("globalThis.PDFSWAP_PLACES = PDFSWAP_PLACES;\n")
    with open(os.path.join(HERE, "places-LICENSE.txt"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(licence)
    n = sum(len(v) for v in by_state.values())
    print("places.js: %d states, %d city names, %.0f KB" % (len(out), n, len(body) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
