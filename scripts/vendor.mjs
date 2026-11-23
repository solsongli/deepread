// Copies the browser builds of vendored front-end libraries from node_modules
// into addon/content/lib/. Idempotent: target folders are cleaned first.
// Run with: npm run vendor
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (...p) => join(root, "node_modules", ...p);
const lib = (...p) => join(root, "addon", "content", "lib", ...p);

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`vendor: missing ${path} (did you run npm install?)`);
  return path;
}

function copyInto(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(requireFile(src), dest);
  console.log(`  ${src.slice(root.length + 1)} -> ${dest.slice(root.length + 1)}`);
}

// ---- marked (MIT): UMD build defines the global `marked` when run as a classic script.
const markedDir = lib("marked");
rmSync(markedDir, { recursive: true, force: true });
console.log("marked:");
copyInto(nm("marked", "lib", "marked.umd.js"), join(markedDir, "marked.js"));
copyInto(nm("marked", "LICENSE"), join(markedDir, "LICENSE"));

// ---- KaTeX (MIT): core JS/CSS, auto-render contrib, and woff2 fonts only.
const katexDir = lib("katex");
rmSync(katexDir, { recursive: true, force: true });
console.log("katex:");
const katexDist = nm("katex", "dist");
copyInto(join(katexDist, "katex.min.js"), join(katexDir, "katex.min.js"));
copyInto(join(katexDist, "katex.min.css"), join(katexDir, "katex.min.css"));
copyInto(join(katexDist, "contrib", "auto-render.min.js"), join(katexDir, "auto-render.min.js"));
const fontsSrc = join(katexDist, "fonts");
const fontsDest = join(katexDir, "fonts");
mkdirSync(fontsDest, { recursive: true });
const woff2 = readdirSync(requireFile(fontsSrc)).filter((f) => f.endsWith(".woff2"));
if (woff2.length === 0) throw new Error("vendor: no .woff2 fonts found in katex dist");
for (const f of woff2) copyFileSync(join(fontsSrc, f), join(fontsDest, f));
console.log(`  dist/fonts/*.woff2 (${woff2.length} files) -> ${fontsDest.slice(root.length + 1)}`);
copyInto(nm("katex", "LICENSE"), join(katexDir, "LICENSE"));

// Only loaded when saving translated pages. Carry notices for the bundled dependencies.
const pdfDir = lib("pdf-lib");
copyInto(nm("pdf-lib", "dist", "pdf-lib.min.js"), join(pdfDir, "pdf-lib.min.js"));
copyInto(nm("pdf-lib", "LICENSE.md"), join(pdfDir, "LICENSE"));
for (const [pkg, file, name] of [["@pdf-lib/standard-fonts", "LICENSE.md", "standard-fonts"], ["@pdf-lib/upng", "LICENSE", "upng"],
  ["pako", "LICENSE", "pako"], ["tslib", "LICENSE.txt", "tslib"], ["tslib", "CopyrightNotice.txt", "tslib-copyright"]]) {
  copyInto(nm(pkg, file), join(pdfDir, "licenses", name + ".txt"));
}

console.log("vendor: done");
