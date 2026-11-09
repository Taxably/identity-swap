// Drives web/hush.js (and the finding in pii.js it stands on) over invented client messages,
// with no page. Prints one JSON object for test_the_identity_swap_hushes_text_for_ai_and_restores_it.py.
const path = require("path");
const W = path.join(__dirname, "..", "web");
require(path.join(W, "data.js"));
require(path.join(W, "places.js"));
require(path.join(W, "names.js"));
globalThis.PDFSwapEngine = require(path.join(W, "engine.js"));
globalThis.PDFSwapPII = require(path.join(W, "pii.js"));
const H = require(path.join(W, "hush.js"));

const EMAIL = [
  "Hi, please review the return for Marisol J Quillfeather (SSN 481-27-3306) and her spouse Daniel Quillfeather.",
  "Address: 4417 E Saguaro Blossom Rd, Tucson, AZ 85711. Phone (520) 555-0142, email marisol.q@gmail.com.",
  "Dependent: Elena Quillfeather, DOB 03/14/2015. Employer: Brightspan Digital LLC, EIN 82-1234567. Account number 0012345678.",
  "Dear Marisol, your SSN on file is 481273306. Marisol's W-2 from Brightspan shows wages. The Quillfeather family moved. Ask Kip about it.",
].join("\n");
const SECOND = "Follow up: Daniel Quillfeather called from 520.555.0142 about the Brightspan W-2.";
const PLAIN = "Please review Schedule C for the Form 1040. The IRS sent a CP2000 notice in March. Can you check whether the Child Tax Credit applies for tax year 2025? Also confirm the Section 179 election and the Qualified Business Income deduction.";
const LABELLED = "Spouse: Priya Raman-Iyer, SSN 123-45-6789. Taxpayer: Thomas O'Neil Jr. Child 1: Aarav Raman, born 2016-05-02. Mailing address 77 Linden Ave Apt 4B, Brooklyn, NY 11215.";
const PEOPLE = "Hi Sarah, Jennifer Lopez and Michael Chen both work at Acme Plumbing Inc in Denver, CO 80202. Call Michael at 303.555.0199.";

(async () => {
  const key = H.newKey();
  const plan = H.find(EMAIL, { key, alwaysHide: ["Kip"] });
  const first = H.hush(EMAIL, plan, key);
  const second = H.hush(SECOND, H.find(SECOND, { key }), key);
  const answer = "Dear [PERSON-1-FIRST], \\[SSN-1\\] is right; [ PERSON-2 ] lives at [ADDRESS-1]. [FOO-9] is new.";
  const restored = H.restore(answer, key);
  const renamedKey = H.newKey();
  const renamedPlan = H.find(EMAIL, { key: renamedKey });
  H.hush(EMAIL, renamedPlan, renamedKey);
  const renameError = H.renameTag(renamedPlan, renamedKey, "PERSON-2", "PERSON-1");
  H.renameTag(renamedPlan, renamedKey, "PERSON-2", "spouse");
  const afterRename = H.hush(EMAIL, H.find(EMAIL, { key: renamedKey }), renamedKey);
  const locked = await H.lock(key, ["Kip"], "correct horse battery");
  const opened = await H.unlock(locked, "correct horse battery");
  let wrong = null;
  try { await H.unlock(locked, "wrong passphrase"); } catch (e) { wrong = e.message; }
  const other = (t, clients = []) => { const k = H.newKey(); return H.hush(t, H.find(t, { key: k, clients }), k); };
  const RARE = "Can you look at the 1099 for Kofi Ostfeather? Priya Vaskberg called. Mrs. Raman-Iyer sent the K-1.";
  const clients = H.clientList('Client Name,SSN\n"Ostfeather, Kofi",1\n"Vaskberg, Priya & Dev",2\nRaman-Iyer,3\n');
  const CARDS = "Paid with 4111 1111 1111 1111; the other card 4111-1111-1111-1112 was declined. Routing 021000021.";
  process.stdout.write(JSON.stringify({
    email: EMAIL, first, second, restored, renameError, afterRename: afterRename.text,
    renamedTags: renamedKey.entries.map((e) => e.tag),
    locked, opened: { tags: opened.key.entries.length, keyTags: key.entries.length, alwaysHide: opened.alwaysHide }, wrong,
    plain: other(PLAIN), labelled: other(LABELLED), people: other(PEOPLE),
    clients, rareWithout: other(RARE).text, rareWith: other(RARE, clients).text, cards: other(CARDS).text,
  }));
})();
