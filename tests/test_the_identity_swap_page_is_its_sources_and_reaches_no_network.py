"""The identity swap page (identity-swap.html) is its own sources, and asks the
network for nothing.

The page is one file a person opens from disk, with every library inside it, so the copy in the
repository is a build output. A change to a source under web/ that nobody
rebuilt would ship a page that does something the source no longer says. The page reads clients'
documents, so it is also held to what its header promises: no request leaves it. The OCR engine
and its English model ride inside it too, and so do the libraries that open and write Office
files, TIFFs, GIFs and HEIC photos, and the face detector that finds the photo on an ID card: each
is held to the file build.py pins, with its licence.
"""

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = ROOT
WEB = os.path.join(TOOL, "web")
PAGE = os.path.join(TOOL, "identity-swap.html")
APP = ["data.js", "places.js", "names.js", "engine.js", "pii.js", "faces.js", "ocr.js", "pictures.js", "office.js", "folder.js", "check.js", "ui.js"]


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _inline(js):
    # the same escaping build.py applies, so a source compares with what the page carries
    return js.replace("</script", "<\\/script").replace("<!--", "<\\!--")


def test_build_lists_exactly_the_app_files_this_test_checks():
    build = _read(os.path.join(WEB, "build.py"))
    listed = re.search(r"^APP = \[(.*?)\]", build, re.M).group(1)
    assert re.findall(r'"([^"]+)"', listed) == APP


def test_the_page_carries_every_source_as_it_now_is():
    page = _read(PAGE)
    stale = [name for name in APP if _inline(_read(os.path.join(WEB, name))) not in page]
    assert not stale, ("identity-swap.html is older than %s; rebuild it with "
                       "web/build.py" % ", ".join(stale))


def test_the_page_keeps_the_template_around_its_scripts():
    template = _read(os.path.join(WEB, "template.html"))
    page = _read(PAGE)
    for piece in re.split(r"/\*@@[A-Z]+@@\*/", template):
        assert piece in page, "a part of template.html is not in the built page"


def test_the_page_forbids_every_request():
    page = _read(PAGE)
    csp = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', page)
    assert csp, "the page has no Content-Security-Policy"
    rules = dict((d.split()[0], d.split()[1:]) for d in csp.group(1).split(";") if d.strip())
    assert rules.get("default-src") == ["'none'"]
    assert rules.get("connect-src") == ["'none'"]
    assert rules.get("form-action") == ["'none'"]
    for directive in ("script-src", "worker-src", "img-src", "style-src"):
        assert not any(s.startswith(("http", "*")) or s == "'self'" for s in rules.get(directive, [])), directive


def test_no_script_or_stylesheet_is_loaded_from_anywhere():
    page = _read(PAGE)
    assert not re.search(r"<script[^>]*\bsrc=", page, re.I)
    assert not re.search(r"<link[^>]*\brel=[\"']?stylesheet", page, re.I)


def test_the_page_may_compile_its_reader_but_never_evaluate_text():
    # the OCR engine is WebAssembly, which a page compiles only under 'wasm-unsafe-eval'; that is
    # all it is allowed: no string is ever run as script
    page = _read(PAGE)
    csp = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', page).group(1)
    script = next(d.split()[1:] for d in csp.split(";") if d.split() and d.split()[0] == "script-src")
    assert "'wasm-unsafe-eval'" in script
    assert "'unsafe-eval'" not in script


def test_the_reader_and_its_model_are_the_pinned_files():
    import base64
    import hashlib
    build = _read(os.path.join(WEB, "build.py"))
    pins = dict(re.findall(r'^OCR_([A-Z]+) = \("[^"]+", "([0-9a-f]{64})"\)', build, re.M))
    assert set(pins) == {"CORE", "WASM", "MODEL"}
    page = _read(PAGE)

    def tag(name):
        return re.search(r'<script type="text/plain" id="%s">(.*?)</script>' % name, page, re.S).group(1)
    glue = tag("ocr-core").replace("<\\/script", "</script").replace("<\\!--", "<!--").encode("utf-8")
    assert hashlib.sha256(glue).hexdigest() == pins["CORE"]
    assert hashlib.sha256(base64.b64decode(tag("ocr-wasm"))).hexdigest() == pins["WASM"]
    assert hashlib.sha256(base64.b64decode(tag("ocr-model"))).hexdigest() == pins["MODEL"]


def test_the_page_carries_the_readers_licences():
    page = _read(PAGE)
    notices = _read(os.path.join(WEB, "ocr-LICENSES.txt")).replace("-->", "-- >")
    assert notices in page
    assert "tesseract.js-core 7.0.0" in page


def _build():
    import importlib.util
    spec = importlib.util.spec_from_file_location("identity_swap_build", os.path.join(WEB, "build.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_every_library_in_the_page_is_the_pinned_file():
    import hashlib
    build = _build()
    page = _read(PAGE)
    blocks = [b.replace("<\\/script", "</script").replace("<\\!--", "<!--") for b in re.findall(r"<script>\n(.*?)\n</script>", page, re.S)]
    for rel, digest in build.LIBS.items():
        pre, post = build.WRAP.get(rel, ("", ""))
        bodies = [b[len(pre):len(b) - len(post)] for b in blocks if b.startswith(pre) and b.endswith(post)]
        assert any(hashlib.sha256(x.encode("utf-8")).hexdigest() == digest for x in bodies), rel


def test_the_page_carries_every_librarys_licence_and_where_the_names_come_from():
    build = _build()
    page = _read(PAGE)
    for title, _ in build.LICENCES:
        assert "==== %s ====" % title in page, title
    assert "Census Bureau" in page and "Social Security Administration" in page
