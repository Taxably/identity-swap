// Opens a .swapkey with the page's own code (web/hush.js), as the page would: prints its tags.
const fs = require("fs"), path = require("path");
const H = require(path.join(__dirname, "..", "web", "hush.js"));
H.unlock(fs.readFileSync(process.argv[2], "utf8"), process.argv[3])
  .then((got) => process.stdout.write(JSON.stringify({ tags: got.key.entries.map((e) => e.tag), values: got.key.entries.map((e) => e.value), alwaysHide: got.alwaysHide,
    restored: H.restore("Dear [PERSON-1-FIRST], your SSN is [SSN-1].", got.key).text })))
  .catch((e) => { process.stderr.write(e.message); process.exit(1); });
