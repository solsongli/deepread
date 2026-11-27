// Tests for DeepRead.LLM against a local OpenAI-compatible server. Run: node test/llm.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

// ---- fake server ----
let behavior = "normal";
let counters = {};
let requests = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sseChunks() {
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const d = (c) => ev({ choices: [{ delta: { content: c } }] });
  const text = [
    ": keep-alive\n\n",
    d("<thi"), d("nk>reasoning here</think>"), d("\n\nHel"), d("lo "), d("wor"), d("ld"),
    "\n\n",
    ev({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join("");
  // split into small chunks, including mid-line boundaries
  const out = [];
  for (let i = 0; i < text.length; i += 7) out.push(text.slice(i, i + 7));
  return out;
}

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    const body = data ? JSON.parse(data) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    counters[behavior] = (counters[behavior] || 0) + 1;
    const n = counters[behavior];
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const ok = (content = "OK") => json(200, { choices: [{ message: { content } }], usage: { total_tokens: 3 } });
    switch (behavior) {
      case "normal": return ok("hello");
      case "reasoning400":
        return body.reasoning_effort ? json(400,{error:{message:"Unsupported reasoning_effort"}}) : ok("hello");
      case "think": return ok("<think>hmm</think>\nanswer");
      case "schema400":
        if (body.response_format?.type === "json_schema") {
          return json(400, { error: { message: "Unsupported response_format json_schema" } });
        }
        return ok("{\"a\":1}");
      case "always400rf":
        if (body.response_format) return json(400, { error: { message: "bad response_format" } });
        return ok("{}");
      case "429x2":
        if (n <= 2) return json(429, { error: "slow down" }, { "Retry-After": "0" });
        return ok("after429");
      case "429always": return json(429, { error: "rate limited" }, { "Retry-After": "0" });
      case "500once":
        if (n === 1) return json(500, { error: "boom" });
        return ok("after500");
      case "400plain": return json(400, { error: "invalid thing" });
      case "stream":
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const c of sseChunks()) { res.write(c); await sleep(2); }
        return res.end();
      case "slow":
        await sleep(3000);
        try { return ok("late"); } catch { return; }
      default: return json(404, {});
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---- vm context ----
const sandbox = {
  fetch, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout, console, URL,
  Zotero: { debug() {}, locale: "en-US", Prefs: { get() {} } },
  DeepRead: {},
};
const ctx = vm.createContext(sandbox);
for (const f of ["util.js", "l10n.js", "services/llm.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
let config;
function setConfig(over = {}) {
  config = {
    baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", model: "m1", jsonMode: "json_schema",
    temperature: 0.5, extraHeaders: { "X-Extra": "yes" }, ...over,
  };
}
setConfig();
sandbox.DeepRead.prefs = { llmConfig: () => config };
const LLM = sandbox.DeepRead.LLM;

const schemaFormat = { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } };
const msgs = [{ role: "user", content: "hi" }];

function reset(b, over) {
  behavior = b; counters = {}; requests = [];
  LLM._modeCache.clear();
  setConfig(over);
}
async function rejects(p) {
  try { await p; } catch (e) { return e; }
  assert.fail("expected rejection");
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("isConfigured", () => {
  assert.equal(LLM.isConfigured({ baseURL: "http://x", model: "m" }), true);
  assert.equal(LLM.isConfigured({ baseURL: "", model: "m" }), false);
  assert.equal(LLM.isConfigured({ baseURL: "http://x", model: " " }), false);
});

test("complete: normal reply, headers, body", async () => {
  reset("normal");
  const r = await LLM.complete({ messages: msgs, system: "sys", maxTokens: 50 });
  assert.equal(r.content, "hello");
  assert.equal(r.usage.total_tokens, 3);
  assert.ok(r.raw.choices);
  const q = requests[0];
  assert.equal(q.url, "/v1/chat/completions");
  assert.equal(q.headers.authorization, "Bearer sk-test");
  assert.equal(q.headers["x-extra"], "yes");
  assert.equal(q.body.model, "m1");
  assert.equal(q.body.stream, false);
  assert.equal(q.body.max_tokens, 50);
  assert.equal(q.body.temperature, 0.5);
  assert.deepEqual(q.body.messages[0], { role: "system", content: "sys" });
  assert.equal("response_format" in q.body, false);
});

test("complete: no max_tokens / no auth when absent", async () => {
  reset("normal", { apiKey: "" });
  await LLM.complete({ messages: msgs });
  assert.equal("max_tokens" in requests[0].body, false);
  assert.equal(requests[0].headers.authorization, undefined);
});

test("complete: strips <think>", async () => {
  reset("think");
  assert.equal((await LLM.complete({ messages: msgs })).content, "answer");
});

test("jsonMode rules: schema / object / none", async () => {
  reset("normal");
  await LLM.complete({ messages: msgs, responseFormat: schemaFormat });
  assert.equal(requests[0].body.response_format.type, "json_schema");
  reset("normal", { jsonMode: "json_object" });
  await LLM.complete({ messages: msgs, responseFormat: schemaFormat });
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  reset("normal", { jsonMode: "none" });
  await LLM.complete({ messages: msgs, responseFormat: schemaFormat });
  assert.equal("response_format" in requests[0].body, false);
});

test("jsonMode downgrade json_schema -> json_object, cached", async () => {
  reset("schema400");
  const r = await LLM.complete({ messages: msgs, responseFormat: schemaFormat });
  assert.equal(r.content, "{\"a\":1}");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.response_format.type, "json_object");
  await LLM.complete({ messages: msgs, responseFormat: schemaFormat });
  assert.equal(requests.length, 3, "second call must not repeat the failed attempt");
  assert.equal(requests[2].body.response_format.type, "json_object");
});

test("jsonMode downgrade all the way to none", async () => {
  reset("always400rf");
  const r = await LLM.complete({ messages: msgs, responseFormat: schemaFormat });
  assert.equal(r.content, "{}");
  assert.equal(requests.length, 3);
  assert.equal("response_format" in requests[2].body, false);
});

test("low translation effort falls back once on an incompatible reasoning endpoint", async () => {
  reset("reasoning400",{model:"gpt-6.1-sol"});
  const options={messages:msgs,reasoningEffort:"low",responseFormat:schemaFormat};
  assert.equal((await LLM.complete(options)).content,"hello");
  assert.equal(requests[0].body.reasoning_effort,"low");
  assert.equal(requests[0].body.temperature,undefined);
  assert.equal(requests[1].body.reasoning_effort,undefined);
  await LLM.complete(options);
  assert.equal(requests.length,3);
  assert.equal(requests[2].body.reasoning_effort,undefined);
  reset("normal",{model:"custom"});
  await LLM.complete(options);
  assert.equal(requests[0].body.reasoning_effort,undefined);
  assert.equal(requests[0].body.temperature,.5);
});

test("429 with Retry-After 0 twice then success", async () => {
  reset("429x2");
  const r = await LLM.complete({ messages: msgs });
  assert.equal(r.content, "after429");
  assert.equal(requests.length, 3);
});

test("429 forever -> error after 3 retries with status", async () => {
  reset("429always");
  const e = await rejects(LLM.complete({ messages: msgs }));
  assert.equal(requests.length, 4);
  assert.equal(e.status, 429);
  assert.match(e.message, /LLM HTTP 429/);
  assert.ok(e.message.includes("rate limited"));
});

test("500 once then success (retry)", async () => {
  reset("500once");
  const t0 = Date.now();
  const r = await LLM.complete({ messages: msgs });
  assert.equal(r.content, "after500");
  assert.equal(requests.length, 2);
  assert.ok(Date.now() - t0 >= 900, "should back off ~1s");
});

test("other 4xx not retried; message format", async () => {
  reset("400plain");
  const e = await rejects(LLM.complete({ messages: msgs, responseFormat: schemaFormat }));
  assert.equal(requests.length, 1);
  assert.equal(e.status, 400);
  assert.ok(e.message.includes("400") && e.message.includes("invalid thing"));
});

test("timeout throws error mentioning timeout", async () => {
  reset("slow");
  const e = await rejects(LLM.complete({ messages: msgs, timeoutMs: 200 }));
  assert.match(e.message, /timeout/i);
  assert.equal(requests.length, 1);
});

test("abort: AbortError, no retry", async () => {
  reset("slow");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const e = await rejects(LLM.complete({ messages: msgs, signal: ac.signal }));
  assert.equal(e.name, "AbortError");
  assert.equal(requests.length, 1);
  // pre-aborted
  const e2 = await rejects(LLM.complete({ messages: msgs, signal: ac.signal }));
  assert.equal(e2.name, "AbortError");
  assert.equal(requests.length, 1);
});

test("stream: chunked SSE, keep-alive, think prefix, DONE", async () => {
  reset("stream");
  const deltas = []; let lastFull = "";
  const full = await LLM.stream({
    messages: msgs, system: "s",
    onDelta: (d, f) => { deltas.push(d); lastFull = f; assert.ok(!f.includes("think"), "think leaked"); },
  });
  assert.equal(full, "Hello world");
  assert.equal(lastFull, "Hello world");
  assert.equal(deltas.join(""), "Hello world");
  assert.ok(deltas.length > 1);
  assert.equal(requests[0].body.stream, true);
});

test("stream: HTTP error format", async () => {
  reset("429always");
  const e = await rejects(LLM.stream({ messages: msgs }));
  assert.equal(e.status, 429);
  assert.match(e.message, /LLM HTTP 429/);
});

test("stream: abort", async () => {
  reset("slow");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const e = await rejects(LLM.stream({ messages: msgs, signal: ac.signal }));
  assert.equal(e.name, "AbortError");
});

test("testConnection ok / failure never throws", async () => {
  reset("normal");
  const r = await LLM.testConnection();
  assert.equal(r.ok, true);
  assert.ok(r.message.includes("m1") && /ms/.test(r.message));
  assert.equal(requests[0].body.max_tokens, 8);
  reset("400plain");
  const bad = await LLM.testConnection();
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes("400"));
  const none = await LLM.testConnection({ baseURL: "", model: "" });
  assert.equal(none.ok, false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}
server.closeAllConnections?.();
server.close();
console.log(failed ? `${failed} test(s) failed` : `all ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
