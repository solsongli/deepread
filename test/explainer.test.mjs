// Tests for DeepRead.Explainer. Run: node test/explainer.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

const requests = [];
let handler = null;
const ctx = { console, setTimeout, clearTimeout, Zotero: { debug() {}, locale: "zh-CN", Prefs: { get() {} } } };
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.DeepRead = {};
ctx.DeepRead.prefs = { language: () => "zh", llmConfig: () => ({ baseURL: "x", model: "m", concurrency: 8 }) };
ctx.DeepRead.LLM = {
  async complete(args) {
    requests.push(args);
    return handler(args, requests.length);
  },
};
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/explainer.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const E = ctx.DeepRead.Explainer;
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects from the vm realm have a foreign prototype

let failures = 0;
async function test(name, fn) {
  requests.length = 0;
  try {
    await fn();
    console.log(`PASS ${name}`);
  }
  catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${e.stack || e}`);
  }
}

const LONG = "This is a sufficiently long body paragraph of the paper, with enough text to be explained.";
const para = (i, type = "text", text = LONG) => ({ paragraphIndex: i, paragraphType: type, paragraphText: text, paragraphSummary: `sum ${i}`, points: [] });
const data = () => [
  { pageIndex: 0, paragraphs: [para(0, "title", "Introduction to the whole thing, a heading"), para(1), para(2, "equation"), para(3, "image"), para(4, "table"), para(5, "text", "short")] },
  { pageIndex: 1, paragraphs: [para(0), para(1, "text_with_equation")] },
];
const itemsOf = (args) => JSON.parse(args.messages.at(-1).content.split("Paragraphs to explain (JSON):\n")[1]).items;
const reply = (items, suffix = "") => ({ content: JSON.stringify({ explanations: items.map((i) => ({ key: i.key, explanation: `E ${i.key}${suffix}` })) }) });

await test("key and eligible", () => {
  assert.equal(E.key(3, 7), "p_3_7");
  assert.equal(E.eligible(para(0)), true);
  assert.equal(E.eligible(para(0, "text_with_equation")), true);
  for (const t of ["title", "equation", "image", "table"]) assert.equal(E.eligible(para(0, t)), false);
  assert.equal(E.eligible(para(0, "text", "short")), false);
});

await test("pageBatches: skips ineligible, splits big pages, respects only", () => {
  const b = E.pageBatches(data());
  assert.deepEqual(plain(b.map((x) => [x.pageIndex, x.items.map((i) => i.key)])), [[0, ["p_0_1"]], [1, ["p_1_0", "p_1_1"]]]);
  assert.equal(b[0].items[0].summary, "sum 1");
  const big = [{ pageIndex: 2, paragraphs: [0, 1, 2, 3].map((i) => para(i, "text", "x".repeat(2500))) }];
  const split = E.pageBatches(big);
  assert.deepEqual(plain(split.map((x) => x.items.length)), [2, 2]);
  assert.ok(split.every((x) => x.pageIndex === 2));
  const only = E.pageBatches(data(), { only: new Set(["p_1_1"]) });
  assert.deepEqual(plain(only.map((x) => x.items.map((i) => i.key))), [["p_1_1"]]);
});

await test("full run retries a missing key once and fills it", async () => {
  handler = (args, n) => {
    const items = itemsOf(args);
    if (n === 1 || items.length > 1) {
      // first request for any batch: drop the last item
      if (items.length > 1) return reply(items.slice(0, -1));
    }
    return reply(items);
  };
  const pages = [];
  const progress = [];
  const out = await E.explainPages(data(), { targetLang: "zh", paperContext: "Title: T", onPage: (p, m) => pages.push([p, [...m.keys()]]), onProgress: (p) => progress.push(p), concurrency: 1 });
  assert.deepEqual([...out.keys()].sort(), ["p_0_1", "p_1_0", "p_1_1"]);
  // page 1: first request has 2 items, retry has only the missing one
  const p1 = requests.filter((r) => itemsOf(r).some((i) => i.key.startsWith("p_1_")));
  assert.deepEqual(p1.map((r) => itemsOf(r).length), [2, 1]);
  assert.deepEqual(itemsOf(p1[1]).map((i) => i.key), ["p_1_1"]);
  assert.deepEqual(pages, [[0, ["p_0_1"]], [1, ["p_1_0", "p_1_1"]]]);
  assert.deepEqual(plain(progress.at(-1)), { done: 2, total: 2 });
  // request shape
  const first = requests[0];
  assert.deepEqual(plain(first.responseFormat), { type: "json_object" });
  assert.equal(first.temperature, 0.4);
  assert.match(first.system, /Simplified Chinese/);
  const user = first.messages.at(-1).content;
  assert.match(user, /Title: T/);
  assert.match(user, /^Paragraphs to explain \(JSON\):\n\{"items":\[/m);
  // page 1 request carries page 0 summaries
  assert.match(p1[0].messages.at(-1).content, /- sum 1/);
});

await test("a key still missing after the retry is left out without throwing", async () => {
  handler = (args) => reply(itemsOf(args).filter((i) => i.key !== "p_1_1"));
  const out = await E.explainPages(data(), { concurrency: 1 });
  assert.equal(out.has("p_1_1"), false);
  assert.equal(out.has("p_1_0"), true);
});

await test("lenient parsing: fenced, bare array, map, think block", async () => {
  const one = [{ key: "p_0_1", text: LONG, summary: "" }];
  const set = new Set(["p_0_1"]);
  const P = E._parseReply;
  assert.equal(P("```json\n{\"explanations\":[{\"key\":\"p_0_1\",\"explanation\":\"A\"}]}\n```", set).get("p_0_1"), "A");
  assert.equal(P("<think>hmm {x}</think>[{\"key\":\"p_0_1\",\"explanation\":\"B\"}]", set).get("p_0_1"), "B");
  assert.equal(P("{\"p_0_1\":\"C\"}", set).get("p_0_1"), "C");
  assert.equal(P("Sure! {\"explanations\":{\"p_0_1\":\"D\"}} done", set).get("p_0_1"), "D");
  assert.equal(P("{\"p_9_9\":\"nope\"}", set).size, 0);
  assert.equal(P("not json", set).size, 0);
  handler = () => ({ content: "```json\n[{\"key\":\"p_0_1\",\"explanation\":\"Z\"}]\n```" });
  const out = await E.explainPages([{ pageIndex: 0, paragraphs: [para(1)] }]);
  assert.equal(out.get("p_0_1"), "Z");
  assert.equal(one.length, 1);
});

await test("request error is retried once, then omitted and reported", async () => {
  let calls = 0;
  handler = (args) => {
    const items = itemsOf(args);
    if (items[0].key === "p_1_0") { calls++; throw new Error("HTTP 500"); }
    return reply(items);
  };
  const progress = [];
  const pages = [];
  const out = await E.explainPages(data(), { concurrency: 1, onProgress: (p) => progress.push(p), onPage: (p) => pages.push(p) });
  assert.equal(calls, 2);
  assert.deepEqual([...out.keys()], ["p_0_1"]);
  assert.deepEqual(pages, [0]);
  const err = progress.find((p) => p.error);
  assert.ok(err && /HTTP 500/.test(err.error.message));
  assert.equal(err.done, 2);
  // a transient failure that succeeds on retry
  let n = 0;
  handler = (args) => { if (n++ === 0) throw new Error("flaky"); return reply(itemsOf(args)); };
  const ok = await E.explainPages([{ pageIndex: 0, paragraphs: [para(1)] }]);
  assert.equal(ok.size, 1);
});

await test("onPage fires per batch as soon as it is done", async () => {
  handler = (args) => reply(itemsOf(args));
  const seen = [];
  const big = [{ pageIndex: 0, paragraphs: [0, 1, 2].map((i) => para(i, "text", "y".repeat(3500))) }, { pageIndex: 1, paragraphs: [para(0)] }];
  await E.explainPages(big, { concurrency: 1, onPage: (p, m) => seen.push([p, m.size]) });
  assert.deepEqual(seen, [[0, 1], [0, 1], [0, 1], [1, 1]]);
});

await test("abort throws AbortError", async () => {
  handler = (args) => reply(itemsOf(args));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(E.explainPages(data(), { signal: ac.signal }), (e) => e.name === "AbortError");
  const ac2 = new AbortController();
  handler = () => { ac2.abort(); const e = new Error("x"); e.name = "AbortError"; throw e; };
  await assert.rejects(E.explainPages(data(), { signal: ac2.signal, concurrency: 1 }), (e) => e.name === "AbortError");
  assert.equal(requests.length, 1);
});

await test("explainOne", async () => {
  handler = (args) => reply(itemsOf(args), "!");
  const text = await E.explainOne(para(4), { pageIndex: 3, targetLang: "en", paperContext: "Ctx", neighbors: ["n1", "n2", "n3"] });
  assert.equal(text, "E p_3_4!");
  const user = requests[0].messages.at(-1).content;
  assert.match(requests[0].system, /English/);
  assert.match(user, /n2/);
  assert.match(user, /n3/);
  assert.doesNotMatch(user, /n1/);
  handler = () => ({ content: "{}" });
  await assert.rejects(E.explainOne(para(4), { pageIndex: 3 }));
});

await test("roles: known roles kept (case-insensitive), unknown dropped, flow to onPage and explainOne", async () => {
  const set = new Set(["p_0_1", "p_0_2", "p_0_3"]);
  const P = E._parseReply;
  const got = P(JSON.stringify({ explanations: [
    { key: "p_0_1", role: "Method", explanation: "A" },
    { key: "p_0_2", role: "summary", explanation: "B" },
    { key: "p_0_3", explanation: "C" },
  ] }), set);
  assert.equal(got.get("p_0_2"), "B");
  assert.deepEqual(plain([...got.roles]), [["p_0_1", "method"]]);
  handler = (args) => ({ content: JSON.stringify({ explanations: itemsOf(args).map((i, n) => ({ key: i.key, role: n ? "result" : "gap", explanation: "x" })) }) });
  const pages = [];
  const out = await E.explainPages(data(), { concurrency: 1, onPage: (p, m, r) => pages.push([p, [...r.values()]]) });
  assert.deepEqual(plain([...out.roles]), [["p_0_1", "gap"], ["p_1_0", "gap"], ["p_1_1", "result"]]);
  assert.deepEqual(pages, [[0, ["gap"]], [1, ["gap", "result"]]]);
  assert.match(requests[0].system, /role/);
  const one = await E.explainOne(para(4), { pageIndex: 3, withRole: true });
  assert.deepEqual(plain(one), { text: "x", role: "gap" });
  assert.deepEqual(plain([...E.ROLES]), ["background", "gap", "prior", "contribution", "method", "result", "limitation"]);
});

const cardsReply = (cards) => ({ content: JSON.stringify({ cards }) });
const ORDER = ["p_0_1", "p_0_2", "p_0_3", "p_0_4"];

await test("cards parsing: lead-only text, roles for all members, groups, titles, covered", () => {
  const got = E._parseReply(JSON.stringify({ cards: [
    { keys: ["p_0_2", "p_0_1"], role: "Method", title: "  Merged title ", explanation: "A" },
    { keys: ["p_0_3"], role: "bogus", explanation: "B" },
  ] }), ORDER);
  assert.deepEqual(plain([...got]), [["p_0_1", "A"], ["p_0_3", "B"]]);
  assert.deepEqual(plain([...got.roles]), [["p_0_1", "method"], ["p_0_2", "method"]]);
  assert.deepEqual(plain([...got.groups]), [["p_0_1", ["p_0_1", "p_0_2"]]]);
  assert.deepEqual(plain([...got.titles]), [["p_0_1", "Merged title"]]);
  assert.deepEqual([...got.covered].sort(), ["p_0_1", "p_0_2", "p_0_3"]);
  const long = E._parseReply(JSON.stringify({ cards: [{ keys: ["p_0_1"], title: "t".repeat(61), explanation: "A" }] }), ORDER);
  assert.equal(long.titles.size, 0);
});

await test("cards parsing: non-consecutive keys keep the first run, unknown keys dropped", () => {
  const got = E._parseReply(JSON.stringify({ cards: [
    { keys: ["p_0_1", "p_0_2", "p_0_4", "p_9_9"], explanation: "A" },
    { keys: ["p_9_9"], explanation: "ghost" },
    { keys: [], explanation: "empty" },
  ] }), ORDER);
  assert.deepEqual(plain([...got.groups]), [["p_0_1", ["p_0_1", "p_0_2"]]]);
  assert.deepEqual([...got.covered].sort(), ["p_0_1", "p_0_2"]);
  assert.equal(got.size, 1);
  // a Set is still accepted
  assert.equal(E._parseReply(JSON.stringify({ cards: [{ keys: ["p_0_1", "p_0_2"], explanation: "A" }] }), new Set(ORDER)).groups.size, 1);
});

await test("cards parsing: a key used by an earlier card is dropped from later cards", () => {
  const got = E._parseReply(JSON.stringify({ cards: [
    { keys: ["p_0_1", "p_0_2"], explanation: "A" },
    { keys: ["p_0_2", "p_0_3"], explanation: "B" },
    { keys: ["p_0_1"], explanation: "dup" },
  ] }), ORDER);
  assert.deepEqual(plain([...got]), [["p_0_1", "A"], ["p_0_3", "B"]]);
  assert.equal(got.groups.size, 1);
});

await test("cards parsing: legacy shapes mixed with cards become single-key cards", () => {
  const legacy = E._parseReply(JSON.stringify({ explanations: [{ key: "p_0_1", role: "gap", explanation: "A" }] }), ORDER);
  assert.deepEqual(plain([...legacy.covered]), ["p_0_1"]);
  assert.equal(legacy.groups.size, 0);
  assert.equal(E._parseReply("{\"p_0_2\":\"M\"}", ORDER).get("p_0_2"), "M");
  assert.equal(E._parseReply("[{\"key\":\"p_0_3\",\"explanation\":\"L\"}]", ORDER).get("p_0_3"), "L");
  const mixed = E._parseReply(JSON.stringify({ cards: [{ keys: ["p_0_1", "p_0_2"], explanation: "A" }, { key: "p_0_3", explanation: "B" }] }), ORDER);
  assert.deepEqual(plain([...mixed]), [["p_0_1", "A"], ["p_0_3", "B"]]);
});

await test("grouping prompt states the cards shape and rules; group:false keeps the old prompt", async () => {
  handler = (args) => reply(itemsOf(args));
  await E.explainPages(data(), { concurrency: 1 });
  const user = requests[0].messages.at(-1).content;
  assert.match(user, /"cards":\[\{"keys":/);
  assert.match(user, /consecutive/);
  assert.match(user, /up to 8 short fragments/i);
  assert.match(user, /exactly one card/);
  requests.length = 0;
  await E.explainPages(data(), { concurrency: 1, group: false });
  const old = requests[0].messages.at(-1).content;
  assert.ok(old.includes(E.TASK_PROMPT));
  assert.doesNotMatch(old, /"cards"/);
  assert.doesNotMatch(requests[0].system, /merge/);
  assert.ok(requests[0].system.startsWith(`${E.SYSTEM_PROMPT}\nWrite all explanations in `));
  assert.doesNotMatch(requests[0].system, /titles/);
});

const threeParas = () => [{ pageIndex: 0, paragraphs: [para(0), para(1), para(2)] }, { pageIndex: 1, paragraphs: [para(0)] }];

await test("explainPages aggregates cards and passes extra to onPage", async () => {
  handler = (args) => {
    const items = itemsOf(args);
    if (items.length >= 3) return cardsReply([{ keys: [items[0].key, items[1].key], role: "method", title: "T", explanation: "M" }, { keys: [items[2].key], explanation: "S" }]);
    return cardsReply(items.map((i) => ({ keys: [i.key], explanation: `E ${i.key}` })));
  };
  const pages = [];
  const out = await E.explainPages(threeParas(), { concurrency: 1, onPage: (p, m, r, x) => pages.push([p, [...m.keys()], [...r.keys()], [...x.groups.keys()], [...x.titles.values()]]) });
  assert.deepEqual([...out.keys()], ["p_0_0", "p_0_2", "p_1_0"]);
  assert.deepEqual(plain([...out.roles]), [["p_0_0", "method"], ["p_0_1", "method"]]);
  assert.deepEqual(plain([...out.groups]), [["p_0_0", ["p_0_0", "p_0_1"]]]);
  assert.deepEqual(plain([...out.titles]), [["p_0_0", "T"]]);
  assert.deepEqual(pages, [[0, ["p_0_0", "p_0_2"], ["p_0_0", "p_0_1"], ["p_0_0"], ["T"]], [1, ["p_1_0"], [], [], []]]);
  assert.equal(requests.length, 2);
});

await test("retry only for keys not covered by a card", async () => {
  handler = (args, n) => {
    const items = itemsOf(args);
    if (n === 1) return cardsReply([{ keys: ["p_0_0", "p_0_1"], explanation: "M" }]); // p_0_2 missing
    return cardsReply(items.map((i) => ({ keys: [i.key], explanation: `R ${i.key}` })));
  };
  const out = await E.explainPages([{ pageIndex: 0, paragraphs: [para(0), para(1), para(2)] }], { concurrency: 1 });
  assert.equal(requests.length, 2);
  assert.deepEqual(itemsOf(requests[1]).map((i) => i.key), ["p_0_2"]);
  assert.match(requests[1].messages.at(-1).content, /"cards"/);
  assert.deepEqual([...out.keys()], ["p_0_0", "p_0_2"]);
  assert.equal(out.get("p_0_2"), "R p_0_2");
});

if (failures) {
  console.log(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all explainer tests passed");
