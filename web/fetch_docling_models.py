"""Fetch the OCR models docling's RapidOCR engine runs, for build.py to put inside the page.

    python fetch_docling_models.py <folder>

Each file comes from RapidOCR 3.4.0's own model store, at the address its default_models.yaml
names, and is checked against the SHA-256 that file pins (the dictionary, which it does not pin,
against the one pinned here). A file already in the folder with the right digest is kept.
"""

from __future__ import annotations

import hashlib
import os
import sys
import urllib.request

STORE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/"
MODELS = {
    # PP-OCRv5's mobile detector: finds every line of text on a page
    "ch_PP-OCRv5_mobile_det.onnx": ("onnx/PP-OCRv5/det/ch_PP-OCRv5_mobile_det.onnx",
                                    "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae"),
    # PP-OCRv5's mobile English recogniser, and the characters it reads
    "en_PP-OCRv5_rec_mobile_infer.onnx": ("onnx/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile_infer.onnx",
                                          "c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8"),
    "ppocrv5_en_dict.txt": ("paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile_infer/ppocrv5_en_dict.txt",
                            "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6"),
}


def digest(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, (rel, want) in MODELS.items():
        path = os.path.join(out, name)
        if os.path.exists(path) and digest(path) == want:
            continue
        with urllib.request.urlopen(STORE + rel) as r, open(path + ".part", "wb") as fh:
            fh.write(r.read())
        got = digest(path + ".part")
        if got != want:
            os.remove(path + ".part")
            raise SystemExit("%s is not the pinned file (sha256 %s, expected %s)" % (name, got, want))
        os.replace(path + ".part", path)
    print("%s: %s" % (out, ", ".join(MODELS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
