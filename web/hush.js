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
  // a word that opens a sentence or a greeting is never part of a name run
  const OPENER = new Set(("hi hello hey dear thanks thank please regards best sincerely cheers attn attention re fwd fw cc " +
    "mr mrs ms miss dr mx sir madam").split(" "));
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
  const COMPANY = /((?:[\p{Lu}][\p{L}0-9&'’.-]*[ \t]+){1,4}(?:LLC|L\.L\.C\.|PLLC|LLP|Inc\.?|Corp\.?|Co\.|Company|Ltd\.?))(?![\p{L}])/gu;

  // ---------------------------------------------------------------- people in running text
  const RUN = /[\p{Lu}][\p{L}'’-]*\.?(?:[ \t]+[\p{Lu}][\p{L}'’-]*\.?)*/gu;
  const isInitial = (w) => /^\p{Lu}\.?$/u.test(w);
  const SUFFIX = /^(?:Jr|Sr|II|III|IV)\.?$/;
  const bare = (w) => w.replace(/[.,]$/, "").replace(/['’]s$/i, "");
  // a label that says a person's name comes next
  const PERSON_LABEL = /\b(?:taxpayer|spouse|client|dependent|child(?:\s*#?\d+)?|son|daughter|employee|recipient|beneficiary|owner|partner|member|shareholder|preparer|patient|tenant|borrower|contact|attn|attention|from|to|cc|for|with|meet|call|email|ask|tell|text|thanks|thank you|hi|hello|hey|dear)\s*[:,-]?\s*$/i;
  const GREETING = /\b(?:hi|hello|hey|dear|thanks|thank you)\s*,?\s*$/i;

  /** Each person's name as written in the text. A stretch of capitalized words is a person when
   * it holds a name already found, or reads first name then surname ("Jennifer Lopez"), or
   * follows a label that names a person ("Taxpayer: Thomas O'Neil Jr."). A first name alone is a
   * person after a greeting ("Hi Sarah,"). "Raman-Iyer" and "O'Neil" are judged by their parts. */
  function personRuns(text, found, other = new Set()) {
    const P = PII(), out = [];
    const parts = (w) => bare(w).split(/[-–'’]/).filter((x) => x.length > 1);
    const known = (w) => found.has(bare(w).toUpperCase()) || parts(w).some((x) => found.has(x.toUpperCase()));
    const first = (w) => P.firstName(bare(w)) || known(w);
    const last = (w) => parts(w).length > 0 && parts(w).every((x) => P.surname(x) || found.has(x.toUpperCase())) || known(w);
    const opener = (w) => OPENER.has(bare(w).toLowerCase());
    // a city, a state code or an acronym ("Denver", "CO", "IRS") is never a name word
    const place = (w) => other.has(bare(w).toUpperCase()) || /^\p{Lu}{2,4}$/u.test(bare(w)) && !found.has(bare(w).toUpperCase());
    const name = (w) => !opener(w) && !place(w) && (first(w) || last(w) || P.plainName(bare(w)) || /^O['’]\p{Lu}/u.test(w) || /^Mc\p{Lu}/u.test(w));
    for (const m of text.matchAll(RUN)) {
      const words = m[0].split(/[ \t]+/);
      // offsets of each word, for what precedes it
      const at = []; let k = m.index;
      for (const w of words) { k = text.indexOf(w, k); at.push(k); k += w.length; }
      for (let i = 0; i < words.length;) {
        if (!name(words[i])) { i++; continue; }
        let j = i;
        while (j < words.length && (name(words[j]) || isInitial(words[j]) || SUFFIX.test(words[j]) && j > i)) { j++; if (SUFFIX.test(words[j - 1])) break; }
        let end = j;
        while (end > i && !name(words[end - 1]) && !SUFFIX.test(words[end - 1])) end--;
        const span = words.slice(i, end);
        const before = text.slice(Math.max(0, at[i] - 30), at[i]);
        i = j;
        const named = span.filter((w) => !isInitial(w) && !SUFFIX.test(w));
        if (!named.length) continue;
        const labelled = PERSON_LABEL.test(before);
        const vouched = named.some(known) || labelled || named.length >= 2 && first(named[0]) && last(named[named.length - 1]);
        if (named.length >= 2 ? !vouched : !(known(named[0]) || GREETING.test(before) && first(named[0]))) continue;
        let phrase = span.join(" ").replace(/,$/, "");
        // "Quillfeather's" is the name; the 's stays in the text
        phrase = phrase.replace(/['’]s$/i, "");
        // a run that ends a sentence keeps its full stop out of the name, unless it is an initial or Jr.
        const tail = span[span.length - 1];
        if (/\.$/.test(phrase) && !isInitial(tail) && !SUFFIX.test(tail)) phrase = phrase.slice(0, -1);
        out.push({ phrase, first: bare(named[0]), last: named.length > 1 ? bare(named[named.length - 1]) : null });
      }
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
    // a birth date in any common form, after the words that say it is one
    for (const m of text.matchAll(BORN)) take("dob", m[1], [], "dob");
    // a business by its legal ending ("Acme Plumbing Inc"), when the finder had no file to judge it by
    for (const m of text.matchAll(COMPANY)) if (!/\b(?:bank|university|college|insurance|internal revenue|department)\b/i.test(m[1])) take("business", m[1].trim(), [], "business");
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

  return { TAG, newKey, find, hush, rowsFor, leaks, restore, renameTag, lock, unlock, personRuns };
})();
globalThis.PDFSwapHush = PDFSwapHush;
if (typeof module !== "undefined") module.exports = PDFSwapHush;
