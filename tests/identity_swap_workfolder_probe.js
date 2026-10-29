// Drives web/'s finding over a firm's own work folder rather than a client's: subfolders named for
// tasks ("Entity Formation", "Raw Source Exports"), contracts that say "the Company", markdown
// tables, acronyms, a building named for a person, and among them a few real people. Invented
// people only. Prints one JSON object for
// test_the_identity_swap_reads_a_work_folder_not_its_headings.py to judge.
const path = require("path");
const W = path.join(__dirname, "..", "web");
require(path.join(W, "data.js"));
require(path.join(W, "places.js"));
require(path.join(W, "names.js"));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
const F = require(path.join(W, "folder.js"));
const E = globalThis.PDFSwapEngine, P = globalThis.PDFSwapPII;

const ROOT = "Firm Work";
const FILES = [
  ["/Entity Formation/Operating agreement.pdf", [
    "OPERATING AGREEMENT OF BRISKWATER HOLLOW LLC",
    "A Limited Liability Company",
    "TERMS OF AN AGREEMENT BETWEEN THE COMPANY AND ITS MEMBERS",
    "1. Directors. The Company shall be managed by its members.",
    "2. Exercise of Repurchase Option. The Company may repurchase the units.",
    "3. Indemnity of Indemnitee. The Company shall indemnify the member.",
    "4. Transfer. The Company shall record every transfer.",
    "5. Practice. The Company shall keep its books in the usual way.",
    "Because Company records are kept by the manager, the member may ask for them.",
    "PAYMENT WILL BE RUN FROM THE COMPANY ACCOUNT",
    "WHAT THE COMPANY OWES",
    "MUNICIPALITY FEES APPLY PER LLC",
    "Designated Activity Company",
    "Formation Statutory Public Benefit LLC",
    "Member: Ottoline R. Vasquez-Brandt",
    "the entity formation was filed in the usual way, and the source of every export is logged",
  ]],
  ["/Nirav Assignment Remediation/Open Checklist.md", [
    "# Open Checklist",
    "| Board | Id | Items |",
    "|---|---|---|",
    "| Resolved Items Log | 14 | Raw Source Exports |",
    "**Corwin Halvorsby**, President | **Delphine Achterberg**",
    "Delphine Achterberg (Tax Intern)",
    "PART VIII — OPEN ITEMS, BY DEADLINE",
    "Repo | Open PRs | Content",
    "IP Fencing/IP Whitelisting",
    "Google Drive / OneDrive Download Instructions",
    "HTML Exports and Word Exports from Microsoft Macintosh Word",
    "Mail it to the John G. Townsend Building",
    "Items Reauired To Avoid Processina Delays",
    "Second Employer LLC paid wages, and Thornquist Tile LLC paid the rest.",
    "the open items, the resolved items, the build scripts and the repo hygiene are tracked here",
  ]],
  ["/Raw Source Exports/notes.txt", ["exports from the raw source, archived by download"]],
  ["/Resolved Items Log/log.txt", ["a log of the items resolved"]],
  ["/Build Scripts/readme.txt", ["scripts to build the page"]],
  ["/Arizona Foreign Qualification/notes.txt", ["a foreign qualification in Arizona"]],
  ["/IP Filings/notes.txt", ["the filings for IP"]],
  ["/HTML Exports/notes.txt", ["exports as html"]],
  ["/Governance Remediation/notes.txt", ["governance remediation"]],
  ["/Supporting Schedules/notes.txt", ["supporting schedules"]],
  ["/Drive Download Archive/notes.txt", ["an archive of the drive download"]],
  ["/Repo Hygiene/notes.txt", ["repo hygiene"]],
  ["/Halvorsby, Corwin/2025 W2.pdf", [
    "Employee's name",
    "CORWIN T HALVORSBY",
    "4417 E SAGUARO BLOSSOM RD",
    "TUCSON AZ 85711",
  ]],
];

const profs = FILES.map(([p, lines]) => P.textProfile(lines.join("\n"), ROOT + p));
const { items, phrases, clients } = P.detect(profs, { clientFolders: F.clientFolders(profs.map((p) => p.path), P.everydayWords(profs)) });
P.attachContexts(items, profs, phrases);
P.generate(items);
const rows = P.allRows(items, phrases);
const prepared = E.prepareRows(rows.map((r) => ({ ...r })));
const text = FILES.map(([, lines]) => lines.join("\n")).join("\n");

// a business printed in a subset font that carries only its own letters: a stand-in is still
// found, from those letters
const own = P.textProfile("Paid to Quorvyx LLC", ROOT + "/Halvorsby, Corwin/receipt.pdf");
const sub = P.detect([own], { clientFolders: [] });
const q = sub.items.get("business:QUORVYX");
const font = { widths: new Map([..."Quorvyx"].map((ch) => [ch, 500])), problem: null, any: false };
q.ctx = new Map([["receipt#0#Quorvyx", { font, form: "Quorvyx" }]]);
P.regenerate(sub.items, q);
process.stdout.write(JSON.stringify({
  clients: clients.map((c) => c.name),
  items: [...items.values()].map((i) => ({ kind: i.kind, display: i.display, replacement: i.replacement, checked: i.checked, mode: i.mode || null, phraseOnly: i.phraseOnly ? [...i.phraseOnly] : [], count: i.count })),
  before: text.split("\n"),
  after: E.swapPlain(text, prepared)[0].split("\n"),
  subset: { display: q.display, replacement: q.replacement },
}));
