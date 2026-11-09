// Identity Swap companion: the page's own finding and tagging rules (web/pii.js, web/hush.js),
// for swap_attachments.py. One rule set serves the page and the companion, so a tag means the same
// in both. Reads one JSON request on stdin, writes one JSON answer on stdout. Touches no network.
//
//   {"op": "plan", "texts": [...], "alwaysHide": [...], "key": {...}?}  ->  {"plan": [...]}
//   {"op": "swap", "texts": [...], "plan": [...]}                         ->  {"texts": [...]}
//   {"op": "rows", "text": "...", "plan": [...]}                          ->  {"rows": [...]}
//   {"op": "leaks", "text": "...", "plan": [...]}                         ->  {"leaks": [...]}
//   {"op": "ocr", "texts": [...]}                                         ->  {"texts": [...]}
//   {"op": "key", "plan": [...], "key": {...}?}                           ->  {"key": {...}}
const path = require("path");
const W = path.join(__dirname, "..", "web");
for (const f of ["data.js", "places.js", "names.js"]) require(path.join(W, f));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
const H = require(path.join(W, "hush.js"));

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const q = JSON.parse(input);
  const key = q.key || H.newKey();
  let out;
  if (q.op === "plan") out = { plan: H.find(q.texts.join("\n\n"), { key, alwaysHide: q.alwaysHide || [], clients: q.clients || [] }) };
  else if (q.op === "clients") out = { people: H.clientList(q.text) };
  else if (q.op === "swap") out = { texts: q.texts.map((t) => H.hush(t, q.plan, H.newKey()).text) };
  else if (q.op === "rows") out = { rows: H.rowsFor(q.text, q.plan) };
  else if (q.op === "leaks") out = { leaks: H.leaks(q.text, q.plan.filter((p) => p.checked)) };
  else if (q.op === "ocr") out = { texts: q.texts.map(H.ocrText) };
  else if (q.op === "key") { H.hush("", q.plan, key); out = { key }; }
  else throw new Error("unknown op " + q.op);
  process.stdout.write(JSON.stringify(out));
});
