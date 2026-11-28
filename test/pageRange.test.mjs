import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const scope = vm.createContext({ DeepRead: { bilingual: (zh, en) => en } });
vm.runInContext(
  readFileSync(new URL("../addon/content/scripts/services/pageRange.js", import.meta.url), "utf8"),
  scope
);
const range = scope.DeepRead.PageRange;
const json = (x) => JSON.parse(JSON.stringify(x));
assert.deepEqual(json(range.parse("7–，1, 3 - 5,4,3", 8)), [0, 2, 3, 4, 6, 7]);
assert.deepEqual(json(range.parse(" -3 , 5-", 6)), [0, 1, 2, 4, 5]);
assert.deepEqual(json(range.parse("１、３－５", 8)), [0, 2, 3, 4]);
assert.equal(range.format(range.parse("4,2,3,7", 7)), "2-4,7");
for (const bad of ["", "0", "1,", "1,,2", "4-2", "-", "3-9", "1.0", "1 2", "NaN", "3--5"])
  assert.throws(() => range.parse(bad, 8));
for (const bad of [[], [NaN], [-1], [4], ["2"]]) assert.throws(() => range.normalized(bad, 4));
assert.deepEqual(json(range.normalized([3, 0, 3], 4)), [0, 3]);
const first = {
  id: 0,
  page_idx: 0,
  text: "before",
  physicalParts: [
    { page_idx: 0, text: "before" },
    { page_idx: 1, text: "after" }
  ]
};
const outside = { id: 1, page_idx: 2, text: "outside" };
const mapped = json(range.remap([first, outside], [5, 6]));
assert.equal(mapped.length, 1);
assert.equal(mapped[0].page_idx, 5);
assert.deepEqual(
  mapped[0].physicalParts.map((it) => it.page_idx),
  [5, 6]
);
assert.equal(first.physicalParts[1].page_idx, 1);
console.log("Physical PDF page ranges and parser coordinates pass");

// A completed MinerU job may cover several original pages. A download retry
// from one of those pages must keep its page map and avoid a second upload.
Object.assign(scope, {
  AbortController,
  setTimeout,
  clearTimeout,
  IOUtils: { read: async () => new Uint8Array([1]) }
});
scope.DeepRead.prefs = { get: () => "" };
vm.runInContext(
  readFileSync(new URL("../addon/content/scripts/services/parser.js", import.meta.url), "utf8"),
  scope
);
const parser = scope.DeepRead.Parser;
const download = parser._download.bind(parser);
let uploads = 0,
  disableDownload = true,
  expired = false;
parser._mineruRequestUpload = async () => ({ uploadURL: "upload", batchID: "job-" + ++uploads });
parser._mineruPut = async () => {};
parser._mineruPoll = async ({ batchID }) => {
  if (expired && batchID === "job-1") throw Object.assign(new Error("Task not found"), { code: "-60012" });
  return { full_zip_url: "current-signed-url" };
};
parser._download = async () => {
  if (disableDownload) throw new Error("Result host unreachable");
  return new Uint8Array([1]);
};
parser._extractZip = async () => {};
const args = { cfg: {}, status: () => {}, signal: new AbortController().signal, firstPage: 5, pageCount: 3 };
let saved;
try {
  await parser._mineruParse(args);
} catch (error) {
  saved = error.downloadJob;
}
assert.equal(saved.batchID, "job-1");
assert.deepEqual(Object.keys(saved).sort(), ["base", "batchID", "count", "first"]);
disableDownload = false;
const retry = { ...args, firstPage: 6, pageCount: 1, resumeDownload: saved };
assert.deepEqual(json(await parser._mineruParse(retry)), { first: 5, count: 3 });
assert.equal(uploads, 1);
expired = true;
assert.deepEqual(json(await parser._mineruParse(retry)), { first: 6, count: 1 });
assert.equal(uploads, 2);
console.log(
  "MinerU download resumes a completed batch and replaces an expired one for only the chosen pages"
);

class ResultRequest {
  constructor({ mozAnon }) {
    assert.equal(mozAnon, true);
    this.channel = { setTRRMode: (mode) => { this.mode = mode; } };
  }
  open(method, url) {
    assert.equal(method, "GET");
    this.url = url;
  }
  send() {
    retries.push({ url: this.url, mode: this.mode });
    this.status = 200;
    this.response = new Uint8Array([0x50, 0x4b]).buffer;
    this.onload();
    this.onloadend();
  }
}
const retries = [];
const cdn = "https://cdn-mineru.openxlab.org.cn";
Object.assign(scope, {
  fetch: async () => { throw new TypeError("NetworkError"); },
  Components: { interfaces: { nsIRequest: { TRR_ONLY_MODE: 3 } } },
  Zotero: { getMainWindow: () => ({ XMLHttpRequest: ResultRequest }) }
});
for (const url of [cdn + "/result.zip", cdn + ".example.invalid/result.zip"]) {
  const bytes = await download(url, null, args.signal, "download result zip");
  assert.deepEqual([...bytes], [0x50, 0x4b]);
}
assert.deepEqual(retries.map(r => r.mode), [3, undefined]);
console.log("Only the official MinerU result CDN retries with secure DNS");
