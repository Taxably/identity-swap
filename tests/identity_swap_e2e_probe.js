// Drives the built page (identity-swap.html) in Chromium, as a preparer would, through every flow:
// the text swap (paste, tags, rename, client list, words to always hide, copy), attachments
// (swapped and downloaded), restoring an answer and a file, the locked key (save, forget, open,
// wrong passphrase), the check-it-yourself panel, and the folder swap (as a .zip). Every file the
// page downloads is saved under "out" for test_the_page_works_end_to_end.py to open and judge.
// Prints one JSON object.
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

(async () => {
  const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = {}, errors = [], requests = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Content Security Policy|example\.com|Failed to fetch/.test(m.text())) errors.push(m.text()); });
  p.on("request", (r) => { if (!/^(data|blob|file):/.test(r.url())) requests.push(r.url()); });
  const saveDownload = async (click, dir) => {
    const [dl] = await Promise.all([p.waitForEvent("download"), click()]);
    const dest = path.join(job.out, dir, dl.suggestedFilename());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await dl.saveAs(dest);
    return dl.suggestedFilename();
  };
  await p.goto("file://" + job.page);
  // the folder swap writes a .zip when the browser cannot write a folder: the test takes that road
  await p.evaluate(() => { delete window.showDirectoryPicker; window.showDirectoryPicker = undefined; });

  // ---------------------------------------------------------------- the text swap
  await p.click("[data-mode=hush]");
  await p.click("#hushListBox summary");
  await p.fill("#hushList", "Kip");
  await p.setInputFiles("#clientList", job.clients);
  await p.waitForFunction(() => /client/.test(document.querySelector("#clientMsg").textContent));
  out.clientMsg = await p.textContent("#clientMsg");
  await p.fill("#hushIn", job.message);
  await p.waitForFunction(() => document.querySelector("#hushOut").value.includes("["), null, { timeout: 30000 });
  await p.waitForTimeout(400);
  out.swapped = await p.inputValue("#hushOut");
  out.check = await p.textContent("#hushCheck");
  // rename the spouse's tag, as a preparer would to help the AI
  const tags = p.locator("#hushTable input[type=text]");
  for (let i = 0; i < await tags.count(); i++) {
    if (await tags.nth(i).inputValue() === "PERSON-2") { await tags.nth(i).fill("SPOUSE"); await tags.nth(i).press("Tab"); break; }
  }
  await p.waitForTimeout(400);
  out.renamed = await p.inputValue("#hushOut");
  await p.click("#hushCopy");
  await p.waitForTimeout(300);
  out.copyMsg = await p.textContent("#hushCopyMsg");
  out.clipboard = await p.evaluate(() => navigator.clipboard.readText());

  // ---------------------------------------------------------------- attachments
  await p.setInputFiles("#hushFile", job.attachments);
  await p.waitForFunction((n) => {
    const rows = document.querySelectorAll("#attOut .att");
    return rows.length >= n && ![...document.querySelectorAll("#attOut .count")].some((c) => c.textContent === "swapping");
  }, job.attachments.length, { timeout: 600000 });
  out.attachments = await p.$$eval("#attOut .att", (rows) => rows.map((r) => r.textContent));
  out.attachmentFiles = [];
  for (let i = 0; i < await p.locator("#attOut button").count(); i++) out.attachmentFiles.push(await saveDownload(() => p.locator("#attOut button").nth(i).click(), "attachments"));

  // ---------------------------------------------------------------- restoring an answer
  await p.fill("#restoreIn", job.answer);
  await p.dispatchEvent("#restoreIn", "input");
  out.restored = await p.inputValue("#restoreOut");
  out.restoreMsg = await p.textContent("#restoreMsg");
  // and a file the AI handed back: the swapped Word file
  const docx = out.attachmentFiles.find((f) => f.endsWith(".docx"));
  await p.setInputFiles("#restoreFile", path.join(job.out, "attachments", docx));
  await p.waitForFunction(() => document.querySelector("#restoreFiles button") || /not restored/.test(document.querySelector("#restoreFiles").textContent), null, { timeout: 60000 });
  out.restoredFile = await saveDownload(() => p.locator("#restoreFiles button").first().click(), "restored");

  // ---------------------------------------------------------------- the locked key
  await p.click("text=Save it locked, to restore answers later");
  await p.fill("#keyPass", "correct horse battery");
  await p.fill("#keyPass2", "correct horse battery");
  out.keyFile = await saveDownload(() => p.click("#keySave"), "key");
  await p.click("#keyForget");
  await p.fill("#restoreIn", job.answer + " ");
  await p.dispatchEvent("#restoreIn", "input");
  out.afterForget = await p.inputValue("#restoreOut");
  await p.click("text=Open a saved key");
  await p.fill("#keyOpenPass", "wrong passphrase");
  await p.setInputFiles("#keyOpen", path.join(job.out, "key", out.keyFile));
  await p.waitForTimeout(3000);
  out.wrongPass = await p.textContent("#keyMsg");
  await p.fill("#keyOpenPass", "correct horse battery");
  await p.setInputFiles("#keyOpen", path.join(job.out, "key", out.keyFile));
  await p.waitForFunction(() => /^Opened/.test(document.querySelector("#keyMsg").textContent), null, { timeout: 30000 });
  out.keyMsg = await p.textContent("#keyMsg");
  await p.fill("#restoreIn", job.answer);
  await p.dispatchEvent("#restoreIn", "input");
  out.afterOpen = await p.inputValue("#restoreOut");

  // ---------------------------------------------------------------- check it yourself
  await p.click("#checkTry");
  await p.waitForFunction(() => /Refused|went through/.test(document.querySelector("#checkMsg").textContent), null, { timeout: 15000 });
  out.checkTry = await p.textContent("#checkMsg");
  out.checkCounts = await p.textContent("#checkCounts");

  // ---------------------------------------------------------------- the folder swap
  await p.click("[data-mode=swap]");
  await p.setInputFiles("#pickInput", job.folder);
  await p.waitForFunction(() => !document.querySelector("#step3").classList.contains("locked") && document.querySelector("#runControls button.teal"), null, { timeout: 600000 });
  out.folderSummary = await p.textContent("#readOut");
  out.folderZip = await saveDownload(() => p.click("#runControls button.teal"), "folder");
  await p.waitForFunction(() => /Done in|Stopped/.test(document.querySelector("#runProgress").textContent), null, { timeout: 600000 });
  out.folderResult = await p.textContent("#runResults");

  out.requests = requests;
  out.errors = errors;
  process.stdout.write(JSON.stringify(out));
  await browser.close();
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
