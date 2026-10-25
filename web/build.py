"""Build identity-swap.html: one file, every library inside it, no network at run time.

    python build.py --libs <node_modules folder> --models <folder> [--out FILE]

The folder is a node_modules folder holding pdf-lib 1.17.1 (with pako), pdfjs-dist 3.11.174,
tesseract.js-core 7.0.0, @tesseract.js-data/eng 1.0.0, fflate 0.8.3, utif 3.1.0, gifenc 1.0.3,
libheif-js 1.23.5, tracking 1.1.3 and onnxruntime-web 1.22.0. --models is the folder
fetch_docling_models.py fills with the PP-OCR models docling's RapidOCR engine runs. Each file is
checked against the SHA-256 pinned below before it goes in, and its licence goes in with it. The
OCR engines' WebAssembly and their models go in as base64; Tesseract's model, ONNX Runtime's
WebAssembly and the PP-OCR models go in gzipped (the page unpacks them with the browser's own
DecompressionStream).
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import importlib.metadata
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

LIBS = {
    "pdf-lib/dist/pdf-lib.min.js": "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f",
    "pdfjs-dist/build/pdf.min.js": "5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946",
    # zip archives and Office files (MIT)
    "fflate/umd/index.js": "462ef8041fc970e3615a20a9dd2b2e3047a073b2da729ef4f02b634bba8b7b83",
    # TIFF pages, read (MIT); it inflates through fflate, given to it as the pako it asks for
    "utif/UTIF.js": "e3e76115f49571e39624c3316a76b3c4c5b2c5ca518dfec4b66a9f7af8c6d059",
    # GIF written again (MIT); a CommonJS module, given an exports object of its own
    "gifenc/dist/gifenc.js": "ab1ff6a05a05ddb85f642ae4c3f96d9e69e56fcfc472982172b088344e0fdb59",
    # HEIC photos, read (LGPL-3.0, unmodified, its own script)
    "libheif-js/libheif-wasm/libheif-bundle.js": "074b2b55ef3de477ba9f794ca381f3f0324c1cba8c91b4af07395f39c22d54cc",
    # the photo on an ID card, found (BSD): the Viola-Jones detector and its frontal-face cascade
    "tracking/build/tracking-min.js": "b53ce081c1b8e64be541dfe5329d62235491e11d2f0b80b1f7f27519e819df60",
    "tracking/build/data/face-min.js": "3f0f3431466b3d494786e2880fce060da5d3b347f6483c93a9a73e1aa74a8a1a",
}
# what goes around a library so it can run as a script of its own in the page
WRAP = {
    "utif/UTIF.js": ("self.pako = { inflate: function (d) { try { return fflate.unzlibSync(d); } catch (e) { return fflate.inflateSync(d); } } };\n", ""),
    "gifenc/dist/gifenc.js": ("(function () { var exports = {}, module = { exports: exports };\n", "\nself.gifenc = exports; })();"),
}
WORKER = ("pdfjs-dist/build/pdf.worker.min.js",
          "feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b")
LICENCES = [("pdf-lib 1.17.1", "pdf-lib/LICENSE.md"), ("pako 1.0.11 (inside pdf-lib)", "pako/LICENSE"),
            ("PDF.js 3.11.174", "pdfjs-dist/LICENSE"), ("fflate 0.8.3", "fflate/LICENSE"), ("UTIF.js 3.1.0", "utif/LICENSE"),
            ("gifenc 1.0.3", "gifenc/LICENSE.md"),
            ("tracking.js 1.1.3 (its Viola-Jones detector, and the frontal-face cascade it carries, converted from OpenCV's)", "tracking/LICENSE.md"),
            ("libheif-js 1.23.5 (libheif and libde265 compiled to WebAssembly; carried unmodified as its own script, so it can"
             " be replaced; source at github.com/catdad-experiments/libheif-js, github.com/strukturag/libheif and"
             " github.com/strukturag/libde265)", "libheif-js/LICENSE")]
OCR_CORE = ("tesseract.js-core/tesseract-core-simd-lstm.js", "e48e2f02ddae3716c8dd24bf41cd290d4efa96892d689cdc4013c2545d63f469")
OCR_WASM = ("tesseract.js-core/tesseract-core-simd-lstm.wasm", "34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea")
OCR_MODEL = ("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91")
# docling's OCR engine: RapidOCR's PP-OCR models, run by ONNX Runtime's WebAssembly build (MIT)
DL_ORT = ("onnxruntime-web/dist/ort.wasm.bundle.min.mjs", "e53392ea5f0e654acf1866c16564b340661ed5d238f692c3c2bd40b940f924a2")
DL_GLUE = ("onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8")
DL_WASM = ("onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4")
DL_DET = ("ch_PP-OCRv5_mobile_det.onnx", "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae")
DL_REC = ("en_PP-OCRv5_rec_mobile_infer.onnx", "c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8")
DL_KEYS = ("ppocrv5_en_dict.txt", "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6")
APP = ["data.js", "places.js", "names.js", "engine.js", "pii.js", "faces.js", "docling.js", "ocr.js", "pictures.js", "office.js", "folder.js", "check.js", "ui.js"]


def read_pinned(libs: str, rel: str, digest: str, binary: bool = False):
    path = os.path.join(libs, *rel.split("/"))
    with open(path, "rb") as fh:
        data = fh.read()
    got = hashlib.sha256(data).hexdigest()
    if got != digest:
        raise SystemExit("%s is not the pinned file (sha256 %s, expected %s)" % (rel, got, digest))
    return data if binary else data.decode("utf-8")


def inline(js: str) -> str:
    """Script text that cannot end the <script> element it sits in."""
    return js.replace("</script", "<\\/script").replace("<!--", "<\\!--")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--libs", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "identity-swap.html"))
    args = ap.parse_args()
    with open(os.path.join(HERE, "template.html"), encoding="utf-8") as fh:
        page = fh.read()
    libs = "\n".join("<script>\n%s\n</script>" % inline(WRAP.get(rel, ("", ""))[0] + read_pinned(args.libs, rel, d) + WRAP.get(rel, ("", ""))[1])
                      for rel, d in LIBS.items())
    worker = inline(read_pinned(args.libs, *WORKER))
    app = []
    for name in APP:
        with open(os.path.join(HERE, name), encoding="utf-8") as fh:
            app.append("/* ---- %s ---- */\n%s" % (name, fh.read()))
    notices = []
    for title, rel in LICENCES:
        with open(os.path.join(args.libs, *rel.split("/")), encoding="utf-8") as fh:
            notices.append("==== %s ====\n%s" % (title, fh.read()))
    with open(os.path.join(HERE, "places-LICENSE.txt"), encoding="utf-8") as fh:
        notices.append("==== zipcodes 1.2.0 (the US city, state and ZIP table in places.js) ====\n" + fh.read())
    notices.append("==== names.js (first names and surnames) ====\nThe U.S. Census Bureau's 1990 first-name tables and 2010 "
                   "surname table, and the Social Security Administration's baby-name tables, all public domain; which "
                   "names are also English words is marked from github.com/dwyl/english-words (the Unlicense).")
    with open(os.path.join(args.libs, "tesseract.js-core", "LICENSE"), encoding="utf-8") as fh:
        notices.append("==== tesseract.js-core 7.0.0 (the OCR engine's WebAssembly build and its loader) ====\n" + fh.read())
    with open(os.path.join(HERE, "ocr-LICENSES.txt"), encoding="utf-8") as fh:
        notices.append(fh.read())
    ocr_core = inline(read_pinned(args.libs, *OCR_CORE))
    ocr_wasm = base64.b64encode(read_pinned(args.libs, *OCR_WASM, binary=True)).decode("ascii")
    ocr_model = base64.b64encode(read_pinned(args.libs, *OCR_MODEL, binary=True)).decode("ascii")
    with open(os.path.join(HERE, "docling-LICENSES.txt"), encoding="utf-8") as fh:
        notices.append(fh.read())
    # gzip with no name or time in it, so the same inputs always give the same page
    gz = lambda b: base64.b64encode(gzip.compress(b, 9, mtime=0)).decode("ascii")  # noqa: E731
    dl_ort = inline(read_pinned(args.libs, *DL_ORT))
    dl_glue = inline(read_pinned(args.libs, *DL_GLUE))
    dl_wasm = gz(read_pinned(args.libs, *DL_WASM, binary=True))
    dl_det = gz(read_pinned(args.models, *DL_DET, binary=True))
    dl_rec = gz(read_pinned(args.models, *DL_REC, binary=True))
    dl_keys = inline(read_pinned(args.models, *DL_KEYS))
    dist = importlib.metadata.distribution("pdfminer.six")
    lic = next(f for f in dist.files if "LICENSE" in str(f).upper())
    notices.append("==== pdfminer.six (encoding tables and font widths in data.js) ====\n" + lic.read_text())
    page = (page.replace("/*@@LIBS@@*/", libs).replace("/*@@WORKER@@*/", worker)
            .replace("/*@@OCRCORE@@*/", ocr_core).replace("/*@@OCRWASM@@*/", ocr_wasm).replace("/*@@OCRMODEL@@*/", ocr_model)
            .replace("/*@@DLORT@@*/", dl_ort).replace("/*@@DLGLUE@@*/", dl_glue).replace("/*@@DLWASM@@*/", dl_wasm).replace("/*@@DLDET@@*/", dl_det)
            .replace("/*@@DLREC@@*/", dl_rec).replace("/*@@DLKEYS@@*/", dl_keys)
            .replace("/*@@APP@@*/", inline("\n".join(app)))
            .replace("/*@@NOTICES@@*/", "\n\n".join(notices).replace("-->", "-- >")))
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(page)
    print("%s, %.1f MB" % (args.out, os.path.getsize(args.out) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
