// Identity Swap benchmark: invented tax documents with every personal value labelled.
//
// The same seed always makes the same documents, so a score moves only when the rules move. Every
// person is invented: first names from public lists, and surnames that are either common (on the
// census list) or made from syllables (on no list at all, as rare surnames are in real life).
// Places are real cities with real ZIP codes, as the rules check them against the ZIP table.
//
// Each document: { kind, text, values: [{ kind, value }] }. `kind` of a value is what a reader
// would call it: person, first, last, ssn, ein, phone, email, street, city, zip, acct, dob, business.
// Each document also carries words that must NOT be hidden (form words, IRS terms, public payers):
// the scorer counts any of them hidden as a wrong hide.
"use strict";

function rng(seed) {
  // mulberry32: small, fast, the same on every machine
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Marisol", "Daniel", "Priya", "Thomas", "Jennifer", "Michael", "Aarav", "Elena", "Sofia", "Mateo", "Grace", "Hannah",
  "Omar", "Fatima", "Wei", "Lucia", "Andre", "Keisha", "Rafael", "Ingrid", "Tobias", "Naomi", "Diego", "Amara", "Victor", "Leah",
  "Samuel", "Yusuf", "Chloe", "Nathan", "Isabel", "Kofi", "Mei", "Dmitri", "Rosa", "Caleb", "Anika", "Lorenzo", "Zara", "Felix"];
const COMMON_LAST = ["Johnson", "Martinez", "Nguyen", "Patel", "Robinson", "Okafor", "Kim", "Hernandez", "Sullivan", "Fischer",
  "Rivera", "Chen", "Walker", "Morales", "Brennan", "Castillo", "Lindqvist", "Abernathy", "Delgado", "Whitaker"];
const SYL_A = ["Quill", "Thorn", "Vask", "Brem", "Ost", "Mar", "Kell", "Dun", "Ash", "Fen", "Gal", "Hollo", "Rook", "Sable", "Wren", "Zell"];
const SYL_B = ["feather", "wick", "dottir", "berg", "mire", "holt", "stead", "vale", "ridge", "crane", "more", "by", "lund", "ward"];
const PLACES = [["Tucson", "AZ", "85711"], ["Denver", "CO", "80202"], ["Brooklyn", "NY", "11215"], ["Austin", "TX", "78704"],
  ["Orlando", "FL", "32801"], ["Charlotte", "NC", "28202"], ["Portland", "OR", "97205"], ["Columbus", "OH", "43215"],
  ["Madison", "WI", "53703"], ["Boise", "ID", "83702"], ["Raleigh", "NC", "27601"], ["Omaha", "NE", "68102"]];
const STREETS = ["Saguaro Blossom Rd", "Linden Ave", "Cedar Glen Rd", "Maple Ridge Dr", "Juniper Ct", "Harbor View Ln",
  "Willow Bend Way", "Prairie Rose Blvd", "Copper Canyon Pl", "Old Mill St"];
const BIZ_HEAD = ["Brightspan", "Northwind", "Copperleaf", "Bluegate", "Silverline", "Ironbridge", "Tallgrass", "Redfern"];
const BIZ_TAIL = ["Digital LLC", "Consulting LLC", "Builders Inc", "Analytics LLC", "Dental PLLC", "Logistics Inc"];
// words that must stay: forms, schedules, IRS terms, public payers, months
const KEEP = ["Schedule C", "Form 1040", "Form W-2", "Child Tax Credit", "Qualified Business Income", "Internal Revenue Service",
  "Social Security", "Medicare", "Federal", "March", "April", "Box 12", "Section 179", "Wells Fargo", "Vanguard", "Fidelity",
  "Will the grace period", "Mark the bill", "Chase Bank", "Charles Schwab", "Jordan Furniture", "Form 1099-NEC", "Nonemployee compensation",
  "Payer", "Recipient", "Estimated tax", "Grace", "Bill"];
const PARTICLE_LAST = ["O'Neil", "O'Brien", "McAllister", "Raman-Iyer", "Garcia-Lopez", "St. Clair", "DeLuca", "van der Berg"];

function make(seed = 2026, count = 600) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const digits = (n) => Array.from({ length: n }, () => Math.floor(r() * 10)).join("");
  const rare = () => pick(SYL_A) + pick(SYL_B);
  const ssn = () => {
    // a valid-looking SSN: no 000, 666 or 9xx area, no 00 group, no 0000 serial
    const area = String(1 + Math.floor(r() * 664) + (r() < 0.01 ? 1 : 0)).padStart(3, "0").replace(/^666$/, "667");
    return area + "-" + String(1 + Math.floor(r() * 98)).padStart(2, "0") + "-" + String(1 + Math.floor(r() * 9998)).padStart(4, "0");
  };
  const ein = () => String(10 + Math.floor(r() * 89)) + "-" + digits(7);
  const phone = (area) => "(" + area + ") 555-01" + digits(2);
  const dob = () => String(1 + Math.floor(r() * 12)).padStart(2, "0") + "/" + String(1 + Math.floor(r() * 28)).padStart(2, "0") + "/" + (1950 + Math.floor(r() * 55));
  const household = () => {
    const last = r() < 0.5 ? rare() : pick(COMMON_LAST);
    const [city, st, zip] = pick(PLACES);
    const p = { first: pick(FIRST), mid: String.fromCharCode(65 + Math.floor(r() * 26)), last, spouse: pick(FIRST), child: pick(FIRST),
      ssn: ssn(), sssn: ssn(), dob: dob(), street: (100 + Math.floor(r() * 9800)) + " " + pick(["E", "W", "N", "S", ""]) + " " + pick(STREETS),
      // a client's own phone: never a toll-free area code, which the rules leave as a business line
      city, st, zip, area: String(pick([201, 212, 303, 312, 404, 415, 480, 503, 512, 520, 602, 617, 704, 713, 919, 971])), acct: digits(10), biz: pick(BIZ_HEAD) + " " + pick(BIZ_TAIL), ein: ein() };
    p.street = p.street.replace(/\s+/g, " ");
    p.phone = phone(p.area);
    p.email = (p.first + "." + p.last.charAt(0)).toLowerCase() + "@" + pick(["gmail.com", "outlook.com", "yahoo.com"]);
    return p;
  };
  const V = (kind, value) => ({ kind, value });
  const templates = [
    // a client's email to the preparer
    (p) => ({ kind: "email", text: [
      "Hi, please review the return for " + p.first + " " + p.mid + " " + p.last + " (SSN " + p.ssn + ") and my spouse " + p.spouse + " " + p.last + ".",
      "Our address is " + p.street + ", " + p.city + ", " + p.st + " " + p.zip + ". Call me at " + p.phone + " or write to " + p.email + ".",
      "I started at " + p.biz + " in March. Can you check the Child Tax Credit for our daughter " + p.child + " " + p.last + "?",
      "Thanks, " + p.first].join("\n"),
    values: [V("person", p.first + " " + p.mid + " " + p.last), V("ssn", p.ssn), V("person", p.spouse + " " + p.last), V("street", p.street), V("city", p.city), V("zip", p.zip),
      V("phone", p.phone), V("email", p.email), V("business", p.biz), V("person", p.child + " " + p.last), V("first", p.first)] }),
    // a W-2 as its text reads out of the PDF
    (p) => ({ kind: "w2", text: [
      "Form W-2 Wage and Tax Statement 2025", "a Employee's social security number", p.ssn,
      "b Employer identification number (EIN)", p.ein, "c Employer's name, address, and ZIP code", p.biz.toUpperCase(),
      "e Employee's first name and initial Last name", (p.first + " " + p.mid + " " + p.last).toUpperCase(),
      "f Employee's address and ZIP code", p.street.toUpperCase(), (p.city + ", " + p.st + " " + p.zip).toUpperCase(),
      "1 Wages, tips, other compensation 84210.00", "2 Federal income tax withheld 9880.00", "3 Social Security wages 84210.00", "Box 12 D 6500.00"].join("\n"),
    values: [V("ssn", p.ssn), V("ein", p.ein), V("business", p.biz.toUpperCase()), V("person", (p.first + " " + p.mid + " " + p.last).toUpperCase()),
      V("street", p.street.toUpperCase()), V("city", p.city.toUpperCase()), V("zip", p.zip)] }),
    // a preparer's notes, surname first as file and folder names put it
    (p) => ({ kind: "notes", text: [
      p.last + ", " + p.first + " " + p.mid + " - 2025 engagement notes",
      "Taxpayer: " + p.first + " " + p.last + ", DOB " + p.dob + ". Spouse: " + p.spouse + " " + p.last + ", SSN " + p.sssn + ".",
      "Dependent: " + p.child + " " + p.last + ". Qualified Business Income from " + p.biz + " on Schedule C.",
      "Refund to account " + p.acct + " at Wells Fargo. Section 179 election on the truck."].join("\n"),
    values: [V("person", p.last + ", " + p.first + " " + p.mid), V("last", p.last), V("first", p.first), V("person", p.first + " " + p.last), V("dob", p.dob), V("person", p.spouse + " " + p.last),
      V("ssn", p.sssn), V("person", p.child + " " + p.last), V("business", p.biz), V("acct", p.acct)] }),
    // a scan's text as OCR returns it: lost spaces, glued initials
    (p) => ({ kind: "ocr", text: [
      "Notice to Taxpayer", "Name: " + p.first + " " + p.mid + p.last, "SSN:" + p.ssn,
      "Address: " + p.street + ", " + p.city + ", " + p.st + p.zip, "Spouse: " + p.spouse + " " + p.last, "Internal Revenue Service, Form 1040"].join("\n"),
    ocr: true,
    values: [V("person", p.first + " " + p.mid + " " + p.last), V("ssn", p.ssn), V("street", p.street), V("city", p.city), V("zip", p.zip), V("person", p.spouse + " " + p.last)] }),
    // a CSV export from tax software: "Last, First M" in quotes, a 9-digit SSN with no dashes
    (p) => {
      const plain = p.ssn.replace(/-/g, "");
      return { kind: "csv", text: ["Client,SSN,Phone,Email,Balance", '"' + p.last + ", " + p.first + " " + p.mid + '",' + plain + "," + p.phone + "," + p.email + ",1284.00",
        '"' + p.last + ", " + p.spouse + '",' + p.sssn.replace(/-/g, "") + ",,,0.00"].join("\n"),
      values: [V("person", p.last + ", " + p.first + " " + p.mid), V("ssn", plain), V("phone", p.phone), V("email", p.email), V("person", p.last + ", " + p.spouse), V("ssn", p.sssn)] };
    },
    // a 1099-NEC as its text reads out of the PDF
    (p) => ({ kind: "1099", text: ["Form 1099-NEC Nonemployee compensation 2025", "PAYER'S name, street address, city or town, state", p.biz,
      "PAYER'S TIN " + p.ein, "RECIPIENT'S TIN " + p.ssn, "RECIPIENT'S name", p.first + " " + p.last, "Street address (including apt. no.)", p.street,
      p.city + ", " + p.st + " " + p.zip, "Account number (see instructions) " + p.acct, "1 Nonemployee compensation 18,400.00"].join("\n"),
    values: [V("business", p.biz), V("ein", p.ein), V("ssn", p.ssn), V("person", p.first + " " + p.last), V("street", p.street), V("city", p.city), V("zip", p.zip), V("acct", p.acct)] }),
    // a letter: hyphenated and Irish surnames, an honorific, Jr.
    (p) => {
      const last = PARTICLE_LAST[Math.floor(p.ssn.charCodeAt(4) % PARTICLE_LAST.length)];
      return { kind: "letter", text: ["Dear Mr. " + last + ",", "We prepared the 2025 return for " + p.first + " " + last + " Jr. and " + p.spouse + " " + last + ".",
        "Estimated tax payments are due in April. Mail them from " + p.street + ", " + p.city + ", " + p.st + " " + p.zip + "."].join("\n"),
      values: [V("last", last), V("person", p.first + " " + last), V("person", p.spouse + " " + last), V("street", p.street), V("city", p.city), V("zip", p.zip)] };
    },
    // a note full of words that look like names and are not
    (p) => ({ kind: "traps", text: ["Will the grace period apply to the late payment? Mark the bill as paid.",
      "The transfer from Chase Bank to Charles Schwab cleared. Jordan Furniture sent the invoice.",
      "Grace said the Bill passed. Client " + p.first + " " + p.last + ", born " + p.dob + ", signed today."].join("\n"),
    values: [V("person", p.first + " " + p.last), V("dob", p.dob)] }),
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = household();
    const doc = templates[i % templates.length](p);
    // a word that must stay is not one when it is also this household's own name ("Grace")
    const own = new Set(doc.values.flatMap((v) => v.value.toUpperCase().split(/[\s,]+/)));
    doc.keep = KEEP.filter((k) => doc.text.includes(k) && !k.toUpperCase().split(/\s+/).some((w) => own.has(w)));
    out.push(doc);
  }
  return out;
}

module.exports = { make };
