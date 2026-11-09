// Drives web/attach.js in node, with pdf-lib and fflate taken out of the built page, for
// test_the_identity_swap_swaps_attachments_for_ai.py. Reads a job (a message and a folder of
// attachments), swaps every attachment with one plan, writes each swapped file to "out", and
// prints one JSON object with what happened to each.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const W = path.join(ROOT, "web");
const page = fs.readFileSync(path.join(ROOT, "identity-swap.html"), "utf8");
globalThis.self = globalThis;
const blocks = [...page.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1].replace(/<\\\/script/g, "</script").replace(/<\\!--/g, "<!--"));
for (const [sign, name] of [["PDFDocument", "PDFLib"], ["unzipSync", "fflate"]]) {
  const src = blocks.find((b) => b.includes(sign) && !b.includes("PDFSwapEngine"));
  if (!src) throw Error("the page carries no " + name);
  vm.runInThisContext(src, { filename: name + ".js" });
}
for (const f of ["data.js", "places.js", "names.js"]) require(path.join(W, f));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
globalThis.PDFSwapOffice = require(path.join(W, "office.js"));
globalThis.PDFSwapFolder = require(path.join(W, "folder.js"));
const H = globalThis.PDFSwapHush = require(path.join(W, "hush.js"));
const A = require(path.join(W, "attach.js"));

(async () => {
  const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const atts = [];
  for (const n of fs.readdirSync(job.in).sort()) atts.push(await A.read(n, new Uint8Array(fs.readFileSync(path.join(job.in, n)))));
  // as the page reads them: the message, and each attachment's name and text, as one
  const all = [job.message, ...atts.filter((a) => !a.problem).flatMap((a) => [a.name.replace(/_/g, " ").replace(/\.[^.]+$/, ""), a.text])].join("\n\n");
  const plan = H.find(all, { key: H.newKey() });
  const out = [];
  for (const a of atts) {
    const r = await A.swap(a, plan);
    if (r.bytes) fs.writeFileSync(path.join(job.out, r.name), r.bytes);
    out.push({ in: a.name, name: r.name || null, how: r.how || null, problem: r.problem || null, notes: r.notes || [] });
  }
  process.stdout.write(JSON.stringify({ message: H.hush(job.message, plan, H.newKey()).text, files: out, tags: plan.map((p) => p.tag) }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
