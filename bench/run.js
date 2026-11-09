// Identity Swap benchmark: scores the finding rules (web/pii.js, web/hush.js) on the invented
// documents bench/corpus.js makes, and fails when any score falls below bench/baseline.json.
//
//   node bench/run.js            score, compare with the baseline, exit 1 on a drop
//   node bench/run.js --update   score and write the scores as the new baseline
//   node bench/run.js --misses   also print every value missed and every word wrongly hidden
//
// A value is FOUND when nothing of it is left in the swapped text: no word of a name, no form of
// a number. A hide is WRONG when a plan entry stands for nothing labelled, or when a word that must
// stay (a form, an IRS term, a public payer) is gone from the swapped text. Text a scan's OCR
// returns is cleaned as the companion cleans it (hush.js ocrText) before it is read.
"use strict";
const fs = require("fs"), path = require("path");
const W = path.join(__dirname, "..", "web");
for (const f of ["data.js", "places.js", "names.js"]) require(path.join(W, f));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
const H = require(path.join(W, "hush.js"));
const { make } = require("./corpus.js");

const BASELINE = path.join(__dirname, "baseline.json");
const NAMEY = new Set(["person", "first", "last"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp("(?<![\\p{L}\\p{N}])" + esc(word) + "(?![\\p{L}\\p{N}])", "iu").test(text);
const digitsOf = (s) => s.replace(/\D/g, "");

/** Whether anything of a labelled value is still in the swapped text. */
function left(hushed, v) {
  if (NAMEY.has(v.kind)) return v.value.split(/\s+/).filter((w) => w.length > 1).some((w) => has(hushed, w));
  if (["ssn", "ein", "phone", "acct", "zip"].includes(v.kind)) return digitsOf(hushed.replace(/\[[^\]]*\]/g, " ")).includes(digitsOf(v.value)) || has(hushed, v.value);
  return has(hushed, v.value);
}
/** Whether a plan entry stands for something labelled: every word of it is a word of a labelled value. */
const SPLIT = (s) => s.toUpperCase().split(/[\s,-]+/).map((w) => w.replace(/\.$/, "")).filter((w) => w && !/^(JR|SR|II|III|IV)$/.test(w));
function labelled(entry, doc) {
  const words = new Set(doc.values.flatMap((v) => SPLIT(v.value)));
  const d = digitsOf(entry.value);
  if (d.length >= 4 && doc.values.some((v) => digitsOf(v.value) === d)) return true;
  return SPLIT(entry.value).every((w) => words.has(w));
}

function score(docs, show, withClients = false) {
  const kinds = {}, misses = [], wrongs = [];
  let entries = 0, wrong = 0, keeps = 0, keptBroken = 0;
  for (const doc of docs) {
    const text = doc.ocr ? H.ocrText(doc.text) : doc.text;
    // with the firm's client list: the household's own people, as a client list export names them
    const clients = withClients ? doc.values.filter((v) => v.kind === "person").map((v) => { const m = /^([^,]+),\s*(\S+)/.exec(v.value); const w = v.value.split(/\s+/); return m ? [m[2], m[1]] : [w[0], w.at(-1)]; }) : [];
    const plan = H.find(text, { key: H.newKey(), clients });
    const hushed = H.hush(text, plan, H.newKey()).text;
    for (const v of doc.values) {
      const k = (kinds[v.kind] = kinds[v.kind] || { total: 0, found: 0 });
      k.total++;
      if (left(hushed, v)) misses.push(doc.kind + " " + v.kind + ": " + v.value); else k.found++;
    }
    for (const e of plan) {
      entries++;
      if (!labelled(e, doc)) { wrong++; wrongs.push(doc.kind + " [" + e.tag + "] " + e.value); }
    }
    for (const k of doc.keep) { keeps++; if (!hushed.includes(k)) { keptBroken++; wrongs.push(doc.kind + " keep: " + k); } }
  }
  const out = { recall: {}, wrongRate: +(wrong / Math.max(1, entries)).toFixed(4), keepBroken: keptBroken, counts: { docs: docs.length, entries, keeps } };
  for (const [k, v] of Object.entries(kinds).sort()) out.recall[k] = +(v.found / v.total).toFixed(4);
  if (show) {
    const tally = (list) => [...list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log("\nMissed (most common first):"); for (const [m, n] of tally(misses)) console.log("  " + n + " x " + m);
    console.log("\nWrongly hidden:"); for (const [m, n] of tally(wrongs)) console.log("  " + n + " x " + m);
  }
  out.table = Object.entries(kinds).sort().map(([k, v]) => ({ kind: k, total: v.total, found: v.found }));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const got = score(make(2026, 600), args.includes("--misses"));
  console.log("Identity Swap benchmark: " + got.counts.docs + " invented documents, seed 2026\n");
  console.log("kind       found / total   recall");
  for (const r of got.table) console.log(r.kind.padEnd(10) + String(r.found).padStart(6) + " / " + String(r.total).padEnd(6) + "  " + (100 * r.found / r.total).toFixed(2) + "%");
  console.log("\nwrongly hidden: " + (100 * got.wrongRate).toFixed(2) + "% of " + got.counts.entries + " hidden values; words that must stay, removed: " + got.keepBroken + " of " + got.counts.keeps);
  const firm = score(make(2026, 600), false, true);
  console.log("with the firm's client list: names " + (100 * firm.recall.person).toFixed(2) + "%, wrongly hidden " + (100 * firm.wrongRate).toFixed(2) + "%");
  const base = { recall: got.recall, wrongRate: got.wrongRate, keepBroken: got.keepBroken, withClients: { person: firm.recall.person, wrongRate: firm.wrongRate } };
  if (args.includes("--update")) { fs.writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n"); console.log("\nbaseline written"); return 0; }
  if (!fs.existsSync(BASELINE)) { console.log("\nno baseline yet: run with --update"); return 1; }
  const was = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const drops = [];
  for (const [k, v] of Object.entries(was.recall)) if ((got.recall[k] ?? 0) < v) drops.push(k + " recall " + v + " -> " + (got.recall[k] ?? 0));
  if (got.wrongRate > was.wrongRate) drops.push("wrongly hidden " + was.wrongRate + " -> " + got.wrongRate);
  if (was.withClients && firm.recall.person < was.withClients.person) drops.push("names with the client list " + was.withClients.person + " -> " + firm.recall.person);
  if (got.keepBroken > was.keepBroken) drops.push("words that must stay, removed " + was.keepBroken + " -> " + got.keepBroken);
  if (drops.length) { console.log("\nWORSE THAN THE BASELINE:\n  " + drops.join("\n  ")); return 1; }
  const better = Object.entries(got.recall).some(([k, v]) => v > (was.recall[k] ?? 0)) || got.wrongRate < was.wrongRate || got.keepBroken < was.keepBroken;
  console.log("\nno score fell below the baseline" + (better ? "; some rose: run with --update to raise the baseline" : ""));
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { score, make };
