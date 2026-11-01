// Builds a Firefox-ready copy of the extension in dist/firefox.
// Firefox MV3 needs background.scripts (no service workers) and a gecko id; Chrome rejects both,
// so extension/manifest.json stays Chrome/Edge-only and this script derives the Firefox one.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = path.join(root, "extension");
const out = path.join(root, "dist", "firefox");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
manifest.background = { scripts: ["vault.js", "background.js"] };
manifest.browser_specific_settings = {
  gecko: { id: "hide-my-text@shararrs.example", strict_min_version: "115.0" }
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Firefox build written to " + out);
