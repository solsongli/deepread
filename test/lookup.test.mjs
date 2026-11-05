// Hover lookup must discard late PDF results and only report exact library matches.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let enabled = true;
let library = [];
const D = { Modules: { enabled: () => enabled }, log() {}, bilingual: (zh) => zh };
const Zotero = {
  Libraries: { userLibraryID: 1 },
  Search: class { addCondition() {} async search() { return library.map((_, i) => i); } },
  Items: { get: (ids) => ids.map((i) => library[i]) },
};
vm.runInNewContext(fs.readFileSync(new URL("../addon/content/scripts/reader/lookup.js", import.meta.url), "utf8"),
  { DeepRead: D, Zotero, Components: {}, setTimeout, clearTimeout });
const session = { hasResults: true, overlay: { _geometry: () => ({}), _clientToPdf: (_, x, y) => [x, y] } };
const chars = [..."Fig. 1 Fig. 2"].map((u, i) => ({ u, rect: [i * 10, 0, i * 10 + 10, 10] }));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function make() {
  const l = new D.Lookup(session);
  l.attached = true;
  l.find = (_, offset) => ({ kind: "figure", key: offset < 7 ? "first" : "second", start: offset < 7 ? 0 : 7, end: offset < 7 ? 6 : 13 });
  l.shown = [];
  l.show = (item) => l.shown.push(item.key);
  return l;
}

for (const stop of ["hide", "leave", "disable", "detach"]) {
  enabled = true;
  const l = make(), pending = deferred();
  l._pageChars = () => pending.promise;
  const task = l.probe(0, 15, 5);
  if (stop === "leave") l._onMove({ clientX: 999, clientY: 999, target: { closest: () => null } });
  else if (stop === "disable") enabled = false;
  else l[stop]();
  pending.resolve(chars);
  assert.equal(await task, null, `${stop} invalidates a pending lookup`);
  assert.equal(l.shown.length, 0, `${stop} cannot reopen a popup`);
  l.detach();
}
enabled = true;
{
  const l = make(), a = deferred(), b = deferred();
  let calls = 0;
  l._pageChars = () => (++calls === 1 ? a.promise : b.promise);
  const first = l.probe(0, 15, 5), second = l.probe(0, 85, 5);
  b.resolve(chars); await second;
  a.resolve(chars); await first;
  assert.deepEqual(l.shown, ["second"], "an old token cannot replace a newer result");
}
{
  const l = make();
  l._pageChars = async () => chars;
  await l.probe(0, 15, 5);
  l._onMove({ clientX: 85, clientY: 5, target: { closest: (s) => s.startsWith(".page") ? { dataset: { pageNumber: "1" } } : null } });
  await sleep(320);
  assert.deepEqual(l.shown, ["first", "second"], "closing the previous popup must preserve the next token's dwell");
  l.detach();
}
{
  const l = make();
  l._pageChars = async () => chars;
  const find = l.find;
  l.find = (...args) => ({ ...find(...args), key: "repeated-reference" });
  await l.probe(0, 15, 5);
  await l.probe(0, 85, 5);
  assert.equal(l.current.rect[0], 70, "repeated references on the same page must update their anchor");
  assert.equal(l.shown.length, 2);
  l.detach();
}
{
  const l = make();
  let calls = 0;
  l._pageChars = async () => { calls++; return chars; };
  l._onMove({ clientX: 15, clientY: 5, target: { closest: (s) => s.startsWith(".page") ? { dataset: { pageNumber: "1" } } : null } });
  l.hide(); await sleep(320);
  assert.equal(calls, 0, "closing before dwell cancels the pending probe");
  l._onMove({ clientX: 15, clientY: 5, target: { closest: () => ({}) } });
  await sleep(320);
  assert.equal(calls, 0, "translated text must not be mistaken for a source citation");
}
const item = (title, doi = "") => ({ getField: (field) => field === "DOI" ? doi : title });
const resetLibrary = (items) => { library = items; D.Lookup._libCache = new Map(); };
const exact = item("A complete title for exact verification", "https://doi.org/10.1000/ABC");
resetLibrary([item("Another paper", "10.1000/abc-extra"), exact]);
assert.equal(await D.Lookup.findInLibrary({ doi: "10.1000/abc" }), exact, "DOI contains is not an exact DOI match");
resetLibrary([item("A complete title for exact verification: a later extension")]);
assert.equal(await D.Lookup.findInLibrary({ title: "A complete title for exact verification" }), null, "partial title must not claim library membership");
library.push(exact);
assert.equal(await D.Lookup.findInLibrary({ title: "A complete title for exact verification" }), exact, "a missing reference can be imported while reading");
resetLibrary([item("A complete title for exact verification", "10.1000/different")]);
assert.equal(await D.Lookup.findInLibrary({ title: "A complete title for exact verification", doi: "10.1000/abc" }), null, "conflicting DOI must not be ignored for a matching title");
const sameTitle = "A complete title for exact verification";
for (const dois of [["10.1000/first", "10.1000/second"], ["", ""], ["10.1000/first", ""]]) {
  resetLibrary(dois.map((doi) => item(sameTitle, doi)));
  assert.equal(await D.Lookup.findInLibrary({ title: sameTitle }), null, "multiple equal titles with different or unknown DOIs stay ambiguous");
}
resetLibrary([item(sameTitle, "10.1000/abc"), item(sameTitle, "https://doi.org/10.1000/ABC")]);
assert.equal(await D.Lookup.findInLibrary({ title: sameTitle }), library[0], "known identical DOIs identify duplicate records of the same work");
resetLibrary([item(sameTitle)]);
assert.equal(await D.Lookup.findInLibrary({ title: sameTitle }), library[0]);
library.push(item(sameTitle, "10.1000/another"));
assert.equal(await D.Lookup.findInLibrary({ title: sameTitle }), null, "importing another same-title record must invalidate title-only certainty");
console.log("lookup: cancellation, latest request, token transitions, translated-text exclusion and exact library matching passed");
