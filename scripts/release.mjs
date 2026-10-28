#!/usr/bin/env node
// Publish a DeepRead release so installed copies update themselves.
//
//   npm run release -- 0.3.2        (or without a version to release the manifest's current version)
//
// Steps: bump version → unit tests → build XPI → commit + tag + push → GitHub Release with the XPI →
// prepend the version to update.json (read by Zotero via manifest.applications.zotero.update_url) → push.
// The XPI is published before update.json points at it, so clients never see a dangling link.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "solsongli/deepread";
const ADDON_ID = "deepread@lsy-aia.github.io";
const KEEP = 10; // versions kept in update.json

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const readJSON = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const writeJSON = (file, data) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);

if (out("git", ["status", "--porcelain"])) {
  console.error("Working tree is not clean; commit or stash first.");
  process.exit(1);
}
if (out("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") {
  console.error("Releases are made from main.");
  process.exit(1);
}

const manifest = readJSON("addon/manifest.json");
const version = process.argv[2] || manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  process.exit(1);
}
const tag = `v${version}`;
if (out("git", ["tag", "--list", tag])) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

// 1. version bump
manifest.version = version;
writeJSON("addon/manifest.json", manifest);
const pkg = readJSON("package.json");
pkg.version = version;
writeJSON("package.json", pkg);
const lock = readJSON("package-lock.json");
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeJSON("package-lock.json", lock);
const readmePath = path.join(root, "README.md");
fs.writeFileSync(readmePath, fs.readFileSync(readmePath, "utf8").replace(/当前版本 \*\*v\d+\.\d+\.\d+\*\*/, `当前版本 **${tag}**`));

// 2. tests + build
run("npm", ["test"]);
run("node", ["scripts/build.mjs"]);
const xpiName = `deepread-${version}.xpi`;
const xpiPath = path.join(root, "build", xpiName);
const hash = crypto.createHash("sha256").update(fs.readFileSync(xpiPath)).digest("hex");

// 3. commit, tag, push, publish the XPI
if (out("git", ["status", "--porcelain"])) {
  run("git", ["commit", "-am", `Release ${tag}`]);
}
run("git", ["tag", "-a", tag, "-m", `DeepRead ${tag}`]);
run("git", ["push", "origin", "main", tag]);
const notesFile = path.join(root, "build", `notes-${version}.md`);
fs.writeFileSync(notesFile, [
  `DeepRead ${tag}`,
  "",
  ...changelogSection(version),
  "安装 / Install: Zotero → 工具 / Tools → 插件 / Plugins → ⚙ → 从文件安装附加组件 / Install Add-on From File → 选择 / choose `" + xpiName + "`.",
  "已安装的 DeepRead 会自动更新到此版本 / Installed copies update automatically.",
  "",
  `SHA-256: \`${hash}\``,
].join("\n"));
run("gh", ["release", "create", tag, xpiPath, "--repo", REPO, "--title", `DeepRead ${tag}`, "--notes-file", notesFile, "--generate-notes"]);

// 4. point update.json at the new XPI
const updatePath = "update.json";
const update = fs.existsSync(path.join(root, updatePath)) ? readJSON(updatePath) : { addons: {} };
const entry = update.addons[ADDON_ID] || { updates: [] };
const zotero = manifest.applications.zotero;
entry.updates = [
  {
    version,
    update_link: `https://github.com/${REPO}/releases/download/${tag}/${xpiName}`,
    update_hash: `sha256:${hash}`,
    applications: { zotero: { strict_min_version: zotero.strict_min_version, strict_max_version: zotero.strict_max_version } },
  },
  ...entry.updates.filter((u) => u.version !== version),
].slice(0, KEEP);
update.addons[ADDON_ID] = entry;
writeJSON(updatePath, update);
run("git", ["add", updatePath]);
run("git", ["commit", "-m", `update.json: ${tag}`]);
run("git", ["push", "origin", "main"]);

console.log(`\nReleased ${tag}: https://github.com/${REPO}/releases/tag/${tag}`);

/** The "## vX.Y.Z" section of CHANGELOG.md (without its heading), followed by a blank line. */
function changelogSection(version) {
  const file = path.join(root, "CHANGELOG.md");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## v${version}`);
  if (start < 0) {
    console.warn(`CHANGELOG.md has no "## v${version}" section; release notes will only have install instructions`);
    return [];
  }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(start + 1, end).join("\n").trim().split("\n"), ""];
}
