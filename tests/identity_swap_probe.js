// Drives web/'s finding and choosing over text-only profiles (no PDF library),
// on a synthetic client folder shaped like a firm's real one, with invented people. Prints one
// JSON object for test_the_identity_swap_finds_people_and_places_not_form_words.py to judge.
const path = require("path");
const W = path.join(__dirname, "..", "web");
require(path.join(W, "data.js"));
require(path.join(W, "places.js"));
require(path.join(W, "names.js"));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
const F = require(path.join(W, "folder.js"));
const E = globalThis.PDFSwapEngine, P = globalThis.PDFSwapPII;

const RETURN = [
  "Form 1040 U.S. Individual Income Tax Return 2025",
  "Your first name and middle initial Last name Your social security number",
  "MARISOL J QUILLFEATHER 481-27-3306",
  "Home address (number and street). If you have a P.O. box, see instructions. Apt. no.",
  "4417 E SAGUARO BLOSSOM RD",
  "City, town, or post office. If you have a foreign address, also complete spaces below. State ZIP code",
  "TUCSON AZ 85711",
  "Identity Protection PIN, see instructions",
  "Qualifying surviving spouse (QSS)",
  "Dependents: First name Last name Relationship to you",
  "DAUGHTER ELENA QUILLFEATHER",
  "Protection of Joint Overpayment",
  "an Identity",
  "15 Subtract ln 14 from ln 13",
  "43 When did you place the vehicle in service",
  "Your occupation CONSULTANT",
  "AZ",
  "Business owner's name",
  "SOLE PROPRIETOR",
  "Paid Preparer Use Only Preparer's name",
  "NOLAN R. VASQUEZ, CPA",
  "Firm's name (or yours if self-employed)",
  "(PREPARER'S IF SELF-EMPLOYED)",
  "DESERT LEDGER TAX LLC",
  "3100 VISTA RIDGE PKWY STE 200",
  "ORLANDO, FL 32801",
  "Mail to: 1200 Ocean Breeze Way, West Palm Beach, FL 33401",
  "Lake house: 210 Cedar Glen Rd, Hot Springs National Park, AR 71901",
  "AZ Form 140 Arizona Resident Personal Income Tax Return",
  "the taxpayer is self-employed and claims a relationship with the dependent for identity protection",
].join("\n");
const NEC = [
  "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.",
  "BRIGHTSPAN DIGITAL LLC",
  "PO BOX 4400",
  "CHARLOTTE, NC 28299-4400",
  "RECIPIENT'S name",
  "ORCHID LANE CONSULTING LLC",
  "4417 E SAGUARO BLOSSOM RD",
  "TUCSON, AZ 85711-1209",
  "Owner: Marisol Quillfeather",
  "Dear Marisol,",
].join("\n");

const root = "Quillfeather, Marisol J";
const paths = [
  root + "/Firm docs shared with client/2025/FINAL 1040 COPY - Quillfeather, Marisol (2025).pdf",
  root + "/Client uploaded documents/2025/2025 1099-NEC Brightspan Digital LLC - Orchid Lane Consulting LLC.pdf",
  root + "/Private/Bridge Document.xlsx",
  root + "/Client uploaded documents/2025/._2025 1099-NEC.pdf",
  root + "/__MACOSX/Private/._Bridge Document.xlsx",
];

// a second household: dependents named only in running text and in a table, a middle initial,
// an employer written without LLC or Inc, an SSN a spreadsheet keeps as a number
const FAMILY_ROOT = "Ostrander, Wilhelmina T";
const FAMILY = [
  ["/2025/Engagement letter.docx", [
    "Dear Wilhelmina Ostrander,",
    "This year we have Leopold Ostrander as your spouse and Marigold Ostrander and Caspian Ostrander as dependents.",
    "Wilhelmina T Ostrander",
  ]],
  ["/2025/Household.xlsx", [
    "Taxpayer   Wilhelmina T Ostrander",
    "SSN   538204471",
    "Dependent 1   Marigold Ostrander",
    "Dependent 2   Caspian Ostrander",
    "Employer:   Thornbury Survey Group",
    // a spouse a reader read with one space between the fields, whose first name no table holds
    // and whose surname is also a word; and a label followed by a form's own words
    "Spouse: Dmitri Vance SSN 529-61-0447",
    "Spouse: Not Applicable",
  ]],
  ["/2025/dependents.csv", ["Name,Relationship", "Marigold Ostrander,Daughter", "Caspian Ostrander,Son"]],
  ["/2025/W2.pdf", [
    "c Employer's name, address, and ZIP code",
    "Thornbury Survey Group, 18 N Pine St, Duluth, MN 55802",
    "the survey was mailed in March",
    "Card payment 0412 / thornbury.shop",
  ]],
];
function family() {
  const profs = FAMILY.map(([p, lines]) => P.textProfile(lines.join("\n"), FAMILY_ROOT + p));
  const clients = F.clientFolders(profs.map((p) => p.path));
  const { items, phrases } = P.detect(profs, { clientFolders: clients });
  P.attachContexts(items, profs);
  P.generate(items);
  const rows = P.allRows(items, phrases);
  const prepared = E.prepareRows(rows.map((r) => ({ ...r })));
  const text = FAMILY.map(([, lines]) => lines.join("\n")).join("\n");
  return {
    items: [...items.values()].map((i) => ({ kind: i.kind, display: i.display, replacement: i.replacement, checked: i.checked, kept: !!i.kept, mode: i.mode || null })),
    rows: rows.map((r) => ({ find: r.find, replace: r.replace })),
    before: text.split("\n"),
    after: E.swapPlain(text, prepared)[0].split("\n"),
    female: (globalThis.PDFSWAP_NAMES.female || "").split(" "),
    male: (globalThis.PDFSWAP_NAMES.male || "").split(" "),
  };
}

// an ID card as the reader gives it: small labels lost or misread ("3 poe" for "3 DOB", "sais"
// for "4b EXP"), an issue date run into the next field ("202215"), a DD number with no label left;
// a fax of the same card read with two letters for digits; and a letter that is not a card
const CARD_ROOT = "Harrowgate, Quenby O";
const CARD = [
  ["/2025/DL front.png", true, [
    "4d DLN K41702953",
    "3 poe 07/19/1979   sais 07/19/2031",
    "1 HARROWGATE",
    "2 QUENBY ODETTE",
    "8 2290 N JUNCO HOLLOW DR",
    "FLAGSTAFF, AZ 86004",
    "RN we 1 sa1ss 06/11/202215 Sex F",
    "500 7741203CX88301456",
  ]],
  ["/2025/DL fax.tif", true, ["4d DLN K4I7O2953", "1 HARROWGATE"]],
  ["/2025/Invoice.pdf", false, ["Invoice 06/11/2022 for Quenby Harrowgate", "Reference 7741203CX88301456"]],
];
function idcard() {
  const profs = CARD.map(([p, card, lines]) => {
    const prof = P.textProfile(lines.join("\n"), CARD_ROOT + p);
    for (const b of prof.blocks) b.idCard = card;
    return prof;
  });
  const clients = F.clientFolders(profs.map((p) => p.path));
  const { items, phrases } = P.detect(profs, { clientFolders: clients });
  P.attachContexts(items, profs);
  P.generate(items);
  return {
    items: [...items.values()].map((i) => ({ kind: i.kind, display: i.display, replacement: i.replacement, files: [...i.files] })),
    rows: P.allRows(items, phrases).map((r) => ({ find: r.find, replace: r.replace })),
  };
}

function run(stateTicked) {
  const profs = [P.textProfile(RETURN, paths[0]), P.textProfile(NEC, paths[1])];
  const clients = F.clientFolders(paths);
  const { items, phrases } = P.detect(profs, { clientFolders: clients });
  P.attachContexts(items, profs);
  P.generate(items);
  if (stateTicked) { const az = items.get("state:AZ"); az.checked = true; P.follow(items, az); }
  const rows = P.allRows(items, phrases);
  const prepared = E.prepareRows(rows.map((r) => ({ ...r })));
  return {
    clients: clients.map((c) => c.name),
    kinds: paths.map((p) => F.kindOf(p)),
    items: [...items.values()].map((i) => ({ kind: i.kind, display: i.display, replacement: i.replacement, checked: i.checked, kept: !!i.kept, state: i.state || null, city: i.city || null, key: i.key })),
    before: (RETURN + "\n" + NEC).split("\n"),
    after: E.swapPlain(RETURN + "\n" + NEC, prepared)[0].split("\n"),
    paths,
    renamed: paths.map((p) => P.renamePath(p, prepared)),
  };
}
process.stdout.write(JSON.stringify({ kept: run(false), moved: run(true), family: family(), idcard: idcard() }));
