/* Identity Swap: hushing text for an AI chat, and restoring the AI's answer. Rules only.
 *
 * A preparer pastes a client email, a note or a document's text. Every name, SSN, EIN, phone,
 * email, address, account number, ID and birth date is replaced with a tag such as [PERSON-1],
 * [SSN-1] or [ADDRESS-1]. The hushed text goes to whichever AI the preparer uses; the AI answers
 * in tags; the answer is pasted back and every tag becomes the real value again.
 *
 * The key (which tag stands for which value) lives in this tab's memory and is gone when the tab
 * closes. It can be saved as a file locked with a passphrase (AES-256-GCM, the key drawn from the
 * passphrase with PBKDF2-SHA-256), so an answer can be restored days later. Nothing here touches
 * the network: the page that carries it forbids every request.
 *
 * One value keeps one tag for as long as the key is kept, across every paste, so a household
 * reads the same in every message. The same finding rules the folder swap uses find the values
 * (pii.js); a person's name in running text is also read from a run of capitalized words that
 * holds a found name ("Marisol J Quillfeather"). A list of words to always hide (a client's
 * name, an employer, a nickname) is hidden whether or not anything else finds it.
 *
 * Finding is a safety net, not a guarantee: the hushed text is searched again for every value
 * hidden, and for anything that still reads as personal, before it is offered to copy.
 */
const PDFSwapHush = (() => {
  "use strict";
  const PII = () => globalThis.PDFSwapPII;

  // which tag each kind of value takes; a state alone is left as it is (it identifies nobody and
  // a tax answer often turns on it)
  const TAG = { name: "PERSON", business: "BUSINESS", ssn: "SSN", ssn4: "SSN", ein: "EIN", phone: "PHONE", email: "EMAIL", street: "ADDRESS", unit: "UNIT",
    city: "CITY", zip: "ZIP", zip4: "ZIP", acct: "ACCOUNT", idnum: "ID", dob: "DOB", iddate: "DATE", custom: "HIDDEN" };
  // kinds whose digits are the value, however they are spaced or punctuated
  const DIGITS = new Set(["ssn", "ein", "phone", "acct", "idnum"]);
  // kinds that are numbers, so no letter glued to them ("AZ85711") may hide them
  const NUMBERS = new Set(["zip", "zip4", "dob", "iddate"]);
  // a word that opens a sentence or a greeting is never part of a name run
  const OPENER = new Set(("hi hello hey dear thanks thank please regards best sincerely cheers attn attention re fwd fw cc " +
    "mr mrs ms miss dr mx sir madam call ask tell email text meet see contact per note send forward ping remind invite").split(" "));
  const TAG_TEXT = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
  const LOOKS_LIKE_TAG = /\\?\[\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\\?\]/g;

  const norm = (v) => String(v).replace(/\s+/g, " ").trim().toUpperCase();
  const digitsOf = (v) => String(v).replace(/\D/g, "");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordy = (s) => /^[\p{L}\p{N}]/u.test(s) || /[\p{L}\p{N}]$/u.test(s);

  /** An empty key: which tag stands for which value. */
  function newKey() { return { entries: [], counters: {} }; }

  /** The entry a value already has in the key, or null. Digits-only kinds match on their digits. */
  function lookup(key, kind, value) {
    const n = norm(value), d = digitsOf(value);
    return key.entries.find((e) => norm(e.value) === n || (DIGITS.has(kind) && DIGITS.has(e.kind) && d.length >= 4 && digitsOf(e.value) === d)) || null;
  }
  function nextTag(key, base) {
    const taken = new Set(key.entries.map((e) => e.tag));
    let n = key.counters[base] || 0, tag;
    do { tag = base + "-" + ++n; } while (taken.has(tag));
    key.counters[base] = n;
    return tag;
  }

  const DATE = "(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{4})";
  const BORN = new RegExp("\\b(?:born(?:\\s+on)?|birth\\s*date|date\\s+of\\s+birth|d\\.?o\\.?b\\.?|birthday)\\s*[:\\-]?\\s*(" + DATE + ")", "gi");
  const COMPANY = /((?:[\p{Lu}][\p{L}0-9&'’.-]*[ \t]+){1,4}(?:LLC|L\.L\.C\.|PLLC|LLP|Inc\.?|INC\.?|Corp\.?|CORP\.?|Co\.|CO\.|Company|COMPANY|Ltd\.?|LTD\.?))(?![\p{L}])/gu;

  // ---------------------------------------------------------------- text read from a picture
  const STATE_CODES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR";
  /** Text an OCR engine read, with the spaces it tends to lose put back, so the rules read it as
   * a person would: "Marisol JQuillfeather" is "Marisol J Quillfeather", "AZ85711" is "AZ 85711",
   * "SSN:481-27-3306" is "SSN: 481-27-3306". Only for text read from a picture: a document's own
   * text is never changed. */
  function ocrText(text) {
    return String(text)
      .replace(/\b(\p{Lu})(\p{Lu}\p{Ll}{2,})/gu, "$1 $2")
      .replace(new RegExp("\\b(" + STATE_CODES + ")(\\d{5})(?!\\d)", "g"), "$1 $2")
      .replace(/([\p{L}]):(?=[\p{L}\p{N}(])/gu, "$1: ");
  }

  // ---------------------------------------------------------------- people in running text
  // a run of capitalized words; a surname's lowercase particles ride inside it ("van der Berg", "de la Cruz")
  const RUN = /[\p{Lu}][\p{L}'’-]*\.?(?:[ \t]+(?:(?:van|von|der|den|de|del|della|la|le|da|di|du|dos|bin|al)[ \t]+)*[\p{Lu}][\p{L}'’-]*\.?)*/gu;
  const PARTICLE = /^(?:van|von|der|den|de|del|della|la|le|da|di|du|dos|bin|al)$/;
  const isInitial = (w) => /^\p{Lu}\.?$/u.test(w);
  const SUFFIX = /^(?:Jr|Sr|II|III|IV)\.?$/;
  const HONORIFIC = /^(?:Mr|Mrs|Ms|Dr|Mx|St)\.$/;
  const bare = (w) => w.replace(/[.,]$/, "").replace(/['’]s$/i, "");
  // a label that says a person's name comes next
  const PERSON_LABEL = /\b(?:taxpayer|spouse|client|dependent|child(?:\s*#?\d+)?|son|daughter|employee|recipient|beneficiary|owner|partner|member|shareholder|preparer|patient|tenant|borrower|contact|attn|attention|from|to|cc|for|with|meet|call|email|ask|tell|text|thanks|thank you|hi|hello|hey|dear)\s*[:,-]?\s*$/i;
  // a role and a colon: what follows is a person's name, whatever the lists say of its words
  const ROLE_LABEL = /\b(?:taxpayer|spouse|client|dependent|child(?:\s*#?\d+)?|son|daughter|employee|recipient|beneficiary|owner|partner|shareholder|patient|tenant|borrower|name|attn|attention)(?:['’]s)?(?:\s+name)?\s*:?\s*$/i;
  // a form's label on the line above ("RECIPIENT'S name", "Employee's first name and initial Last name")
  const LABEL_LINE = /\b(?:name|recipient|employee|taxpayer|spouse|borrower|student|beneficiary|owner)(?:['’]s)?(?:\s+name)?[^\n]{0,40}\n\s*$/i;
  // words that name a part of a form or a document, never a person ("Schedule C Corporation")
  const FORM_WORD = new Set("schedule form part section box line exhibit table appendix plan option class type unit building suite apt room floor phase item step chapter article figure page grade category tier level zone area sector block lot map team all everyone folks again".split(" "));
  const LAST_FIRST = /(?<=^|["'\t;,]|\n)[ \t]*([\p{Lu}][\p{L}'’-]+),[ \t]+([\p{Lu}][\p{L}'’-]+)(?:[ \t]+(\p{Lu})\.?)?[ \t]*(?=["'\t;,]|\n|$|[ \t]+-)/gmu;
  const GREETING = /\b(?:hi|hello|hey|dear|thanks|thank you)\s*,?\s*$/i;

  /** Each person's name as written in the text. A stretch of capitalized words is a person when
   * it holds a name already found, or reads first name then surname ("Jennifer Lopez"), or
   * follows a label that names a person ("Taxpayer: Thomas O'Neil Jr."). A first name alone is a
   * person after a greeting ("Hi Sarah,"). "Raman-Iyer" and "O'Neil" are judged by their parts. */
  function personRuns(text, found, other = new Set()) {
    const P = PII(), out = [];
    // a particle word ("van der Berg") is judged by its capitalized part
    const core = (w) => w.split(" ").at(-1);
    const parts = (w) => bare(w).split(/[-–'’]/).filter((x) => x.length > 1);
    const known = (w) => found.has(bare(w).toUpperCase()) || parts(w).some((x) => found.has(x.toUpperCase()));
    const first = (w) => P.firstName(bare(w)) || known(w);
    const last = (w0) => { const w = core(w0); return parts(w).length > 0 && parts(w).every((x) => P.surname(x) || found.has(x.toUpperCase())) || known(w); };
    const opener = (w) => OPENER.has(bare(w).toLowerCase());
    // a city, a state code or an acronym ("Denver", "CO", "IRS") is never a name word
    const STATE = new Set(STATE_CODES.split("|"));
    const place = (w) => other.has(bare(w).toUpperCase()) || STATE.has(bare(w)) ||
      /^\p{Lu}{2,4}$/u.test(bare(w)) && !found.has(bare(w).toUpperCase()) && !P.firstName(bare(w)) && !P.surname(bare(w));
    // after a label that names a person ("Spouse:"), a capitalized word no list holds is still a
    // name, up to the next field ("Amount", "SSN")
    const FIELD = /^(?:amount|address|ssn|tin|ein|phone|tel|email|e-mail|date|dob|total|due|tax|account|acct|employer|age|relationship|income|wages|balance|id)$/i;
    const name = (w0) => { const w = core(w0); return !opener(w) && !place(w) && (first(w) || last(w) || P.plainName(bare(w)) || /^(?:O['’]|Mc|Mac|De|Di|Da|La|Le|Van|St\.?)\p{Lu}\p{Ll}/u.test(w)); };
    // a family's surname: a capitalized word that follows two or more different first names
    // ("Marisol J Quillfeather", "Daniel Quillfeather"), whatever the lists say of it
    const after = new Map();
    for (const m of text.matchAll(/([\p{Lu}][\p{L}'’-]+)[ \t]+(?:\p{Lu}\.?[ \t]+)?([\p{Lu}][\p{L}'’-]+)/gu)) {
      if (!P.firstName(m[1]) || opener(m[1]) || place(m[2])) continue;
      const k = bare(m[2]).toUpperCase();
      if (!after.has(k)) after.set(k, new Set());
      after.get(k).add(m[1].toUpperCase());
    }
    for (const [w, firsts] of after) if (firsts.size >= 2) found.add(w);
    for (const m of text.matchAll(RUN)) {
      // a particle joins the surname after it, so "van der Berg" is one word of the name
      const words = [];
      let pre = "";
      for (const w of m[0].split(/[ \t]+/)) { if (PARTICLE.test(w)) { pre += w + " "; continue; } words.push(pre + w); pre = ""; }
      const at = []; let k = m.index;
      for (const w of words) { k = text.indexOf(w, k); at.push(k); k += w.length; }
      for (let i = 0; i < words.length;) {
        const after = ROLE_LABEL.test(text.slice(Math.max(0, at[i] - 30), at[i]));
        const plainCap = (w0) => { const w = core(w0); return !FIELD.test(bare(w)) && !opener(w) && !place(w) && !FORM_WORD.has(bare(w).toLowerCase()) && /^\p{Lu}(?:\p{Ll}|\p{Lu}{2,})/u.test(w); };
        const soft = !after && PERSON_LABEL.test(text.slice(Math.max(0, at[i] - 30), at[i]));
        // "Priya K Kelllund", "Marisol J Quillfeather": a capitalized word, an initial and a capitalized
        // word are a person, whether or not the lists know either name, unless a form word is in it
        const afterInitial = (k) => k >= i + 2 && isInitial(words[k - 1]) && plainCap(words[k - 2]);
        const ok = (w, k) => name(w) || ((after || soft) && k - i < 4 || afterInitial(k) || k === i && isInitial(words[i + 1] || "") && plainCap(words[i + 2] || "")) && plainCap(w);
        if (!ok(words[i], i)) { i++; continue; }
        let j = i;
        while (j < words.length && (ok(words[j], j) || isInitial(words[j]) || SUFFIX.test(words[j]) && j > i)) {
          j++;
          // a suffix ends a name, and so does a full stop after a word longer than an initial
          if (SUFFIX.test(words[j - 1]) || /\.$/.test(words[j - 1]) && !isInitial(words[j - 1]) && !HONORIFIC.test(words[j - 1])) break;
        }
        let end = j;
        while (end > i && !ok(words[end - 1], end - 1) && !SUFFIX.test(words[end - 1])) end--;
        let span = words.slice(i, end);
        const before = text.slice(Math.max(0, at[i] - 30), at[i]), i0 = i;
        const afterSpan = end > 0 ? text.slice(at[end - 1] + words[end - 1].length, at[end - 1] + words[end - 1].length + 3) : "";
        i = j;
        // a word before a person already known is not part of them ("Call Daniel Quillfeather")
        while (span.length > 2 && !known(span[0]) && span.slice(1).filter((w) => !isInitial(w) && !SUFFIX.test(w)).length >= 2 &&
          span.slice(1).filter((w) => !isInitial(w) && !SUFFIX.test(w)).every(known)) span.shift();
        const named = span.filter((w) => !isInitial(w) && !SUFFIX.test(w));
        if (!named.length) continue;
        // a bank, a brokerage, a school or an agency is never a person ("Wells Fargo", "Charles Schwab")
        if (P.institution(span.join(" "))) continue;
        const nameish = (w) => name(w);
        // after a role and a colon ("Spouse:"), the words are a name; after a softer word ("my spouse",
        // "for", "call") only when one of them is a name the lists know
        const above = text.slice(Math.max(0, at[i0] - 90), at[i0]);
        const labelled = ROLE_LABEL.test(before) || LABEL_LINE.test(above) || PERSON_LABEL.test(before) && named.some(nameish);
        const initialed = span.length === 3 && isInitial(span[1]) && named.every((w) => !FORM_WORD.has(bare(w).toLowerCase()) && !opener(w));
        const vouched = named.some(known) || labelled || initialed || named.length >= 2 && first(named[0]) && last(named[named.length - 1]);
        // one word alone: a known name, or after a greeting ("Thanks, Priya"), a first name or a
        // capitalized word that ends the line or the clause
        const greeted = GREETING.test(before) && (first(named[0]) || /^\s*(?:[,.!]|$)/.test(afterSpan) && !FORM_WORD.has(bare(named[0]).toLowerCase()));
        if (named.length >= 2 ? !vouched : !(known(named[0]) || greeted)) continue;
        let phrase = span.join(" ").replace(/,$/, "");
        // "Quillfeather's" is the name; the 's stays in the text
        phrase = phrase.replace(/['’]s$/i, "");
        // a run that ends a sentence keeps its full stop out of the name, unless it is an initial or Jr.
        const tail = span[span.length - 1];
        if (/\.$/.test(phrase) && !isInitial(tail) && !SUFFIX.test(tail)) phrase = phrase.slice(0, -1);
        out.push({ phrase, first: bare(named[0]), last: named.length > 1 ? bare(named[named.length - 1]) : null });
      }
    }
    // "Quillfeather, Marisol J" as a spreadsheet, a CSV export or a folder name writes a client: a
    // whole field or line, the surname, a comma, the first name and an initial
    for (const m of text.matchAll(LAST_FIRST)) {
      const [, lastW, firstW] = m;
      if (P.institution(lastW + " " + firstW) || [lastW, firstW].some((w) => FORM_WORD.has(w.toLowerCase()) || FIELD.test(w) || OPENER.has(w.toLowerCase()) || STATE_CODES.split("|").includes(w))) continue;
      if (!(first(firstW) || last(lastW) || known(lastW) || known(firstW) || m[3])) continue;
      out.push({ phrase: m[0].trim().replace(/^["'\t;,]+|["'\t;,]+$/g, "").trim(), first: firstW, last: lastW });
    }
    return out;
  }

  /** What to hide in `text`: one entry per value, each with its tag (reusing the key's tag for a
   * value it already holds) and every form it is written in. Nothing is added to the key until
   * the text is hushed. */
  function find(text, { key = newKey(), alwaysHide = [] } = {}) {
    const P = PII();
    const { items } = P.detect([P.textProfile(text, "pasted.txt")]);
    const draft = { entries: key.entries.slice(), counters: { ...key.counters } };
    const plan = [];
    const take = (kind, value, forms, source) => {
      value = String(value).trim();
      if (!value || !/[\p{L}\p{N}]/u.test(value)) return null;
      // a business's first word on its own ("Brightspan") is the business already found in full
      const had = plan.find((p) => norm(p.value) === norm(value) || kind === "business" && p.kind === "business" && norm(p.value).startsWith(norm(value) + " ") || (DIGITS.has(kind) && DIGITS.has(p.kind) && digitsOf(value).length >= 4 && digitsOf(p.value) === digitsOf(value)));
      if (had) { for (const f of forms) if (!had.forms.includes(f)) had.forms.push(f); return had; }
      const old = lookup(draft, kind, value);
      const tag = old ? old.tag : nextTag(draft, kindTag(kind, source));
      if (!old) draft.entries.push({ tag, kind, value });
      const entry = { tag, kind, value, forms: [...new Set([value, ...forms])], checked: true, source, reused: !!old };
      plan.push(entry);
      return entry;
    };

    // the words to always hide come first, so they win over a smaller find inside them
    for (const w of alwaysHide) if (String(w).trim()) take("custom", w, [], "your list");

    // people: the full name first, then each of its words where it stands alone
    const found = new Set([...items.values()].filter((i) => i.kind === "name" && i.checked).map((i) => i.display.toUpperCase()));
    // a person hidden in an earlier paste is known in this one too
    for (const e of key.entries) if (e.kind === "name") for (const w of String(e.value).split(/\s+/)) if (!isInitial(w)) found.add(bare(w).toUpperCase());
    const people = [], singles = [];
    const other = new Set([...items.values()].filter((i) => i.kind === "city" || i.kind === "state" || i.kind === "business").map((i) => i.display.toUpperCase()));
    for (const run of personRuns(text, found, other)) {
      // one word alone ("Hi Sarah,", "the Quillfeathers") is a name word, found below, not a person
      if (!run.last) { if (!found.has(norm(run.first))) singles.push(run.first); continue; }
      let id = norm(run.first) + "|" + norm(run.last || "");
      // "Quillfeather Marisol", as a file or folder name often puts it, is "Marisol Quillfeather"
      const flipped = norm(run.last) + "|" + norm(run.first);
      if (!people.some((p) => p.id === id) && !draft.entries.some((e) => e.person === id) &&
          (people.some((p) => p.id === flipped) || draft.entries.some((e) => e.person === flipped))) id = flipped;
      let person = people.find((p) => p.id === id);
      if (!person) {
        // "Marisol J Quillfeather" and "Marisol Quillfeather" are one person
        const old = draft.entries.find((e) => e.kind === "name" && e.person === id);
        const tag = old ? old.tag : nextTag(draft, "PERSON");
        person = { id, tag, first: run.first, last: run.last, phrases: new Set() };
        if (!old) draft.entries.push({ tag, kind: "name", value: run.phrase, person: id });
        people.push(person);
      }
      person.phrases.add(run.phrase);
    }
    for (const person of people) {
      const [value, ...more] = [...person.phrases].sort((a, b) => b.length - a.length);
      const e = { tag: person.tag, kind: "name", value, forms: [...new Set([value, ...more])], checked: true, source: "name", reused: key.entries.some((k) => k.tag === person.tag), person: person.id };
      plan.push(e);
      if (person.last) {
        // a first name or surname on its own ("Dear Marisol", "the Quillfeathers") is this person's
        if (!plan.some((p) => norm(p.value) === norm(person.first))) plan.push(partOf(draft, person, "FIRST", person.first));
        if (!plan.some((p) => norm(p.value) === norm(person.last))) plan.push(partOf(draft, person, "LAST", person.last));
      }
    }
    for (const w of singles) if (!plan.some((p) => norm(p.value) === norm(w))) take("name", w, [], "name");
    // a name word the finder found that no run explained
    for (const it of items.values()) {
      // a lone initial is never hidden by itself: it would hide every "J" in the text
      if (it.kind !== "name" || !it.checked || it.display.length < 2 || plan.some((p) => norm(p.value) === norm(it.display))) continue;
      take("name", it.display, [...(it.forms ? it.forms.keys() : [])], "name");
    }
    // an account number after its label, with words between ("Account number (see instructions) 9923613648")
    for (const m of text.matchAll(/\b(?:account|acct)\.?\b[^\d\n]{0,40}?(\d[\d-]{5,}\d)(?!\d)/gi)) take("acct", m[1], [], "acct");
    // a birth date in any common form, after the words that say it is one
    for (const m of text.matchAll(BORN)) take("dob", m[1], [], "dob");
    // a business by its legal ending ("Acme Plumbing Inc"), when the finder had no file to judge it by
    for (const m of text.matchAll(COMPANY)) {
      // a label before the name is not the name ("Employer Brightspan Digital LLC")
      const name = m[1].trim().replace(/^(?:(?:employer|payer|payor|client|company|business|firm|vendor|customer|lender|from|to|for|at|with)(?:['’]s)?:?\s+)+/i, "");
      if (name.split(/\s+/).length > 1 && !/\b(?:bank|university|college|insurance|internal revenue|department)\b/i.test(name)) take("business", name, [], "business");
    }
    // everything else the finder found, in the order it reads
    for (const it of items.values()) {
      if (it.kind === "name" || it.kind === "state" || !it.checked || !TAG[it.kind]) continue;
      take(it.kind, it.display, [...(it.variants || []), ...(it.forms ? it.forms.keys() : [])], it.kind);
    }
    // whatever the key already hides, wherever it turns up again ("the Quillfeathers' accountant")
    for (const e of key.entries) {
      if (plan.some((p) => p.tag === e.tag || norm(p.value) === norm(e.value))) continue;
      const forms = e.forms && e.forms.length ? e.forms : [e.value];
      if (forms.some((f) => new RegExp(patternFor(e, f), "iu").test(text))) plan.push({ tag: e.tag, kind: e.kind, value: e.value, forms: forms.slice(), checked: true, source: "key", reused: true, person: e.person });
    }
    // a business's full name ("Brightspan Digital LLC") is the business, not just its first word
    const BIZ = /\b(?:LLC|L\.L\.C\.|PLLC|LLP|Inc\.?|Corp\.?|Co\.|Company|Ltd\.?)(?![A-Za-z])/;
    for (const e of plan.filter((p) => p.kind === "business")) {
      const rx = new RegExp("(?<![\\p{L}\\p{N}])" + esc(e.value) + "(?:[ \\t]+[\\p{Lu}][\\p{L}&'’.-]*){0,4}", "giu");
      for (const m of text.matchAll(rx)) {
        const full = m[0].match(new RegExp("^.*?" + BIZ.source))?.[0];
        if (full && !e.forms.includes(full)) e.forms.unshift(full);
      }
    }
    return plan;
  }
  function kindTag(kind, source) { return kind === "custom" ? "HIDDEN" : TAG[kind] || "HIDDEN"; }
  function partOf(draft, person, part, word) {
    // a surname the household shares keeps the tag it was first given
    const had = draft.entries.find((e) => e.kind === "name" && !e.person && norm(e.value) === norm(word));
    if (had) return { tag: had.tag, kind: "name", value: word, forms: [word], checked: true, source: "name", reused: true, part };
    const tag = person.tag + "-" + part;
    if (!draft.entries.some((e) => e.tag === tag)) draft.entries.push({ tag, kind: "name", value: word });
    return { tag, kind: "name", value: word, forms: [word], checked: true, source: "name", reused: false, part };
  }

  // ---------------------------------------------------------------- hushing
  /** One pattern per form: whole words only (so "Ann" never hides inside "Annual"), any
   * capitals; a number of digits however it is spaced ("481-27-3306", "481 27 3306",
   * "481273306"). */
  function patternFor(entry, form) {
    if (DIGITS.has(entry.kind) && digitsOf(form).length >= 4) {
      const d = digitsOf(form).split("");
      // a phone's area code in brackets is hidden with its brackets: "([PHONE-1]" would be odd
      return (entry.kind === "phone" ? "(?:\\(\\s?)?" : "") + "(?<!\\d)" + d.join("[\\s.\\-/()]{0,2}") + "(?!\\d)";
    }
    if (NUMBERS.has(entry.kind) && /^\d/.test(form)) return "(?<!\\d)" + esc(form).replace(/\s+/g, "\\s+") + "(?!\\d)";
    const body = esc(form).replace(/\s+/g, "\\s+");
    return (wordy(form) ? "(?<![\\p{L}\\p{N}])" : "") + body + (wordy(form) ? "(?![\\p{L}\\p{N}])" : "");
  }
  function matcher(entries) {
    const pairs = [];
    for (const e of entries) for (const f of e.forms) pairs.push({ e, f });
    // the longest form first, so a full name is hidden before its first name
    pairs.sort((a, b) => b.f.length - a.f.length);
    if (!pairs.length) return null;
    return { rx: new RegExp(pairs.map((p) => "(" + patternFor(p.e, p.f) + ")").join("|"), "giu"), pairs };
  }

  /** The text with every ticked entry replaced by its tag, and the key grown by those entries. */
  function hush(text, plan, key = newKey()) {
    const on = plan.filter((p) => p.checked);
    const m = matcher(on);
    let count = 0;
    const hushed = m ? text.replace(m.rx, (...args) => {
      const groups = args.slice(1, 1 + m.pairs.length);
      const k = groups.findIndex((g) => g !== undefined);
      count++;
      return "[" + m.pairs[k].e.tag + "]";
    }) : text;
    for (const e of on) {
      const had = key.entries.find((k) => k.tag === e.tag);
      if (had) { had.forms = [...new Set([...(had.forms || [had.value]), ...e.forms])]; continue; }
      key.entries.push({ tag: e.tag, kind: e.kind, value: e.value, forms: e.forms.slice(), person: e.person });
      const base = e.tag.replace(/-\d+(?:-(?:FIRST|LAST))?$/, "");
      const n = +(/-(\d+)(?:-(?:FIRST|LAST))?$/.exec(e.tag) || [0, 0])[1];
      if (n > (key.counters[base] || 0)) key.counters[base] = n;
    }
    return { text: hushed, count, leaks: leaks(hushed, on) };
  }

  /** The swaps a file needs, for the folder swap's own engines (PDF, Word, Excel, PowerPoint):
   * each place a ticked entry matches in the file's text, as the exact characters printed there,
   * with its tag. An engine replaces exact text, so "481 27 3306" and "481-27-3306" are each a
   * row of their own. Longest first, so a full name is replaced before its first name. */
  function rowsFor(text, plan) {
    const on = plan.filter((p) => p.checked);
    const m = matcher(on);
    const rows = new Map();
    if (m) for (const hit of String(text).matchAll(m.rx)) {
      const k = hit.slice(1, 1 + m.pairs.length).findIndex((g) => g !== undefined);
      const find = hit[0], replace = "[" + m.pairs[k].e.tag + "]";
      if (!rows.has(find)) rows.set(find, { find, replace, label: m.pairs[k].e.kind, tag: m.pairs[k].e.tag });
    }
    return [...rows.values()].sort((a, b) => b.find.length - a.find.length).map((r, i) => ({ id: i + 1, ...r }));
  }

  /** Every hidden value still in the hushed text (none, when hushing worked), and anything else
   * the finder still reads as personal there. */
  function leaks(hushed, entries) {
    const plain = hushed.replace(LOOKS_LIKE_TAG, " ");
    const left = [];
    for (const e of entries) for (const f of e.forms) {
      if (new RegExp(patternFor(e, f), "iu").test(plain)) { left.push({ tag: e.tag, value: e.value, why: "still in the text" }); break; }
    }
    const P = PII();
    const { items } = P.detect([P.textProfile(plain, "hushed.txt")]);
    for (const it of items.values()) {
      if (!it.checked || it.kind === "state") continue;
      left.push({ tag: null, value: it.display, kind: it.kind, why: "still reads as " + (TAG[it.kind] || it.kind).toLowerCase() });
    }
    return left;
  }

  // ---------------------------------------------------------------- restoring
  /** The AI's answer with every tag the key knows replaced by its value. An AI may write a tag
   * with spaces inside the brackets or escape the brackets as Markdown; both still restore. Tags
   * the key does not know are listed, never guessed. */
  function restore(answer, key) {
    const byTag = new Map(key.entries.map((e) => [e.tag.toUpperCase(), e.value]));
    const restored = new Map(), unknown = new Set();
    const text = String(answer).replace(LOOKS_LIKE_TAG, (all, tag) => {
      const v = byTag.get(tag.toUpperCase());
      if (v === undefined) { unknown.add(tag); return all; }
      restored.set(tag.toUpperCase(), (restored.get(tag.toUpperCase()) || 0) + 1);
      return v;
    });
    // a tag the user renamed to a word without a number ("[SPOUSE]") restores too
    const plainTags = key.entries.filter((e) => !/-/.test(e.tag));
    const out = plainTags.length ? text.replace(new RegExp("\\\\?\\[\\s*(" + plainTags.map((e) => esc(e.tag)).join("|") + ")\\s*\\\\?\\]", "gi"), (all, tag) => {
      restored.set(tag.toUpperCase(), (restored.get(tag.toUpperCase()) || 0) + 1);
      return byTag.get(tag.toUpperCase());
    }) : text;
    return { text: out, restored: [...restored].map(([tag, n]) => ({ tag, n })), unknown: [...unknown] };
  }

  /** A new name for a tag in the plan and the key: capitals, digits and hyphens, unused. Its first
   * and last name tags follow it ("PERSON-2" to "SPOUSE" makes "SPOUSE-FIRST"). */
  function renameTag(plan, key, from, to) {
    to = String(to).trim().replace(/^\[|\]$/g, "").toUpperCase();
    if (!TAG_TEXT.test(to)) return "Use capital letters, digits and hyphens, e.g. SPOUSE or CHILD-1.";
    const all = new Set([...plan.map((p) => p.tag), ...key.entries.map((e) => e.tag)]);
    if (to !== from && all.has(to)) return "[" + to + "] already stands for something else.";
    const move = (t) => (t === from ? to : t.startsWith(from + "-") && /-(FIRST|LAST)$/.test(t) ? to + t.slice(from.length) : t);
    for (const p of plan) p.tag = move(p.tag);
    for (const e of key.entries) e.tag = move(e.tag);
    return null;
  }

  // ---------------------------------------------------------------- the locked key
  const FORMAT = "identity-swap-hush-key", ITERATIONS = 600000;
  const b64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function derive(passphrase, salt, iterations) {
    const subtle = globalThis.crypto.subtle;
    const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  /** The key, and the words to always hide, as a file only the passphrase opens. */
  async function lock(key, alwaysHide, passphrase) {
    if (!passphrase || passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ entries: key.entries, counters: key.counters, alwaysHide }));
    const data = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, await derive(passphrase, salt, ITERATIONS), plain));
    return JSON.stringify({ format: FORMAT, version: 1, cipher: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) });
  }
  /** The key and the words to always hide, from a locked file and its passphrase. */
  async function unlock(fileText, passphrase) {
    let f;
    try { f = JSON.parse(fileText); } catch (e) { throw new Error("This is not a saved key."); }
    if (!f || f.format !== FORMAT || f.version !== 1) throw new Error("This is not a saved key.");
    let plain;
    try {
      plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.iv) }, await derive(passphrase, unb64(f.salt), f.iterations), unb64(f.data));
    } catch (e) { throw new Error("That passphrase does not open this key."); }
    const got = JSON.parse(new TextDecoder().decode(plain));
    return { key: { entries: got.entries || [], counters: got.counters || {} }, alwaysHide: got.alwaysHide || [] };
  }

  return { TAG, newKey, find, hush, rowsFor, ocrText, leaks, restore, renameTag, lock, unlock, personRuns };
})();
globalThis.PDFSwapHush = PDFSwapHush;
if (typeof module !== "undefined") module.exports = PDFSwapHush;
