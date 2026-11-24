// A paper glossary must preserve source meaning, permanent math slots and rich text.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const scope = vm.createContext({ DeepRead: {} });
for (const file of ["parallelInline", "parallelTerms"]) {
  const url = new URL("../addon/content/scripts/services/" + file + ".js", import.meta.url);
  vm.runInContext(readFileSync(url, "utf8"), scope);
}
const { ParallelTerms: T, ParallelInline: I } = scope.DeepRead;
const asJSON = (a) => JSON.parse(JSON.stringify(a));
const sources = [
  { page_idx: 0, type: "text", text: "We apply model predictive control (MPC) with a local temporal window." },
  {
    page_idx: 1,
    type: "text",
    text: "A local temporal window stabilizes model predictive control. Adaptive planning improves the final estimate."
  },
  { page_idx: 2, type: "text", text: "Adaptive planning changes the estimates." },
  { page_idx: 2, type: "text", text: "One stray setting. One stray setting." },
  { page_idx: 3, type: "text", text: "References" },
  { page_idx: 3, type: "text", text: "Publication Example. A journal." },
  { page_idx: 4, type: "text", text: "Publication Example. Another journal." }
];
const list = T.candidates(sources, ["Adaptive planning", "Adaptive planning objective"]);
assert.ok(list.some((t) => /^model predictive control$/i.test(t.source)));
assert.ok(list.some((t) => /^adaptive planning$/i.test(t.source)));
assert.ok(!list.some((t) => /^(?:local temporal|stray setting|publication example)$/i.test(t.source)));
assert.deepEqual(
  asJSON(
    T.shortLabels([
      ...Array.from("Loss").map((u) => ({ u })),
      { u: "α", spaceAfter: true },
      { u: "x", lineBreakAfter: true }
    ])
  ),
  []
);
const abort = new AbortController();
const candidates = [
  { source: "world models", excerpt: "Learned world models." },
  { source: "policy updates", excerpt: "Policy updates of a learner." }
];
const extracted = await T.extract(
  candidates,
  "zh",
  async () => ({
    content: JSON.stringify({
      terms: [
        { id: 0, translation: "世界模型" },
        { id: 10, translation: "错误" },
        { id: 0, translation: "第二个答案" },
        { id: 1, translation: "策略更新 97" },
        { id: 1, translation: "<bad>" }
      ]
    })
  }),
  abort.signal
);
assert.deepEqual(asJSON(extracted), [{ source: "world models", target: "世界模型" }]);
assert.deepEqual(
  asJSON(
    await T.extract(
      candidates,
      "en",
      () => {
        throw Error("unexpected paid request");
      },
      abort.signal
    )
  ),
  []
);
await assert.rejects(T.extract(candidates, "zh", async () => ({ content: "{}" }), abort.signal));
const terms = T.compile([
  ...extracted,
  { source: "latent world model", target: "潜在世界模型" },
  { source: "state-dependent controller", target: "状态相关控制器" }
]);
const input = {
  source: "A latent world model uses two world models and state-dependent controllers.",
  modelText: "A **latent world model** uses ⟦D0⟧ world models and state‑dependent controllers.",
  tokens: [{ id: "⟦D0⟧", kind: "number", source: "two", display: "2" }],
  language: "zh",
  translation: ""
};
const bound = T.constrain(input, terms);
assert.equal(bound.work.modelText, "A **⟦D1⟧** uses ⟦D0⟧ ⟦D2⟧ and ⟦D3⟧.");
assert.equal(bound.work.tokens.length, 4);
assert.equal(input.tokens.length, 1);
const translated = "**⟦D1⟧**使用⟦D0⟧个⟦D2⟧和⟦D3⟧。";
assert.ok(I.valid(bound.work, translated));
assert.ok(!I.valid(bound.work, translated.replace("⟦D3⟧", "")));
const text = bound.restore(translated);
assert.equal(text, "**潜在世界模型**使用⟦D0⟧个世界模型和状态相关控制器。");
assert.ok(I.valid(input, text));
assert.equal(T.constrain({ ...input, translation: text }, terms), null);
assert.ok(
  T.constrain({ ...input, translation: "**潜在世界模型**使用⟦D0⟧个模型和状态相关控制器。" }, terms),
  "a nested term does not count twice"
);
assert.equal(T.constrain({ ...input, modelText: "myworld models use unrelated words." }, terms), null);
assert.equal(T.constrain({ ...input, role: "ref_text" }, terms), null);
assert.equal(
  T.constrain({ ...input, modelText: "**World-models**", source: "World-models", tokens: [] }, terms).ready,
  "**世界模型**"
);
console.log(
  "parallelTerms: repeated concepts, complete phrases, checked glossary, plurals, emphasis, local labels and original formula slots passed"
);

const preview = T.preview(
  [
    { source: "World Models", modelText: "World Models", placed: true, matched: true, rect: [0, 0, 5, 10] },
    { source: "Introduction", placed: true, matched: true, rect: [0, 0, 5, 20] }
  ],
  candidates
);
assert.deepEqual(
  Array.from(preview, (u) => u.source),
  ["Introduction"],
  "a preview can run alongside glossary preparation without translating a potentially affected passage twice"
);
