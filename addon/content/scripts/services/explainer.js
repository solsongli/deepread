/*
 * Explainer: per-paragraph "AI 讲解" (tutor-style explanation, not a translation) for the margin cards.
 * One LLM request per page batch; results are streamed to the UI page by page.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const MIN_CHARS = 40;
  const MAX_BATCH_CHARS = 6000;
  const MAX_PREV_CHARS = 1500;
  const MAX_CONTEXT_CHARS = 3000;
  const MAX_NEIGHBOR_CHARS = 1200;
  const ELIGIBLE_TYPES = new Set(["text", "text_with_equation"]);
  const MARKER = "Paragraphs to explain (JSON):";
  // A paragraph's role in the paper's argument (shown as the card's tinted header).
  const ROLES = ["background", "gap", "prior", "contribution", "method", "result", "limitation"];

  const SYSTEM_PROMPT = [
    "You are a patient tutor helping a reader understand an academic paper, one paragraph at a time.",
    "For every paragraph you are given, write a short explanation in your own words:",
    "- say in plain language what the paragraph states and what it means;",
    "- say why it matters, i.e. its role in the paper's argument;",
    "- clarify the key terms, symbols and formulas it uses.",
    "Connect it to earlier content of the paper when that helps.",
    "Rules: explain, do not translate. Do not repeat the given summary. Do not add facts the paper does not support.",
    "Each explanation is 2 to 5 sentences, with no preamble such as \"This paragraph says\". Markdown is allowed (use **bold** for key terms); write math as $...$.",
    "Also label each paragraph's role in the argument with exactly one of: background (context the work builds on), gap (what is missing or fails so far), prior (prior approaches being described), contribution (what this paper proposes or claims), method (how the approach works), result (experiments, evidence, findings), limitation (limits, failure cases, future work).",
    "Return only a JSON object, with each key copied exactly from the input.",
  ].join("\n");

  const TASK_PROMPT = [
    "Explain each of the paragraphs below for a reader who is new to the topic.",
    "Respond with JSON only, in exactly this shape:",
    "{\"explanations\":[{\"key\":\"<key of the paragraph>\",\"role\":\"<one role>\",\"explanation\":\"<your explanation>\"}]}",
    "Include one entry for every item, and keep the keys exactly as given.",
  ].join("\n");

  // Grouped mode: the model may merge consecutive paragraphs that discuss the same thing into one card.
  const GROUP_SYSTEM_NOTE = [
    "You may merge consecutive paragraphs into one card when they explain the same point, step or result (for example a paragraph that continues the previous one's argument). A merged card has one role and one explanation that covers all of its paragraphs; it may be a bit longer, 3 to 7 sentences.",
    "Every card also gets a short title naming what the card is about.",
  ].join("\n");

  const GROUP_TASK_PROMPT = [
    "Explain the paragraphs below for a reader who is new to the topic, grouped into cards.",
    "Respond with JSON only, in exactly this shape:",
    "{\"cards\":[{\"keys\":[\"<key>\",\"<key>\"],\"role\":\"<one role>\",\"title\":\"<short title>\",\"explanation\":\"<your explanation>\"}]}",
    "Rules for cards:",
    "- The keys of one card must be consecutive in the order given. Never skip a paragraph inside a card.",
    "- Merge only paragraphs that explain the same point, step or result (a paragraph that continues the previous one's argument). Use up to 8 short fragments in one card, but never merge an entire section with unrelated claims.",
    "- Prefer one card for one complete idea. Merge parser fragments and continuations of the same argument; split at topic or section changes, never just because a PDF block ended.",
    "- Every input key appears in exactly one card, and keys are copied exactly as given.",
    "- A merged card's explanation covers all of its paragraphs (3 to 7 sentences).",
    "- The title is 4 to 14 words (or at most 16 characters for Chinese, Japanese or Korean) naming what the card is about, in the target language.",
  ].join("\n");

  const str = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());

  function abortError() {
    const e = new Error("Aborted");
    e.name = "AbortError";
    return e;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function isAbort(e, signal) {
    return (e && e.name === "AbortError") || !!(signal && signal.aborted);
  }

  function languageInstruction(targetLang) {
    const langs = DeepRead.PARSE_LANGUAGES || {};
    const lang = langs[targetLang] || langs.zh;
    return lang?.instruction || "Simplified Chinese";
  }

  function systemPrompt(targetLang, group) {
    const base = group ? `${SYSTEM_PROMPT}\n${GROUP_SYSTEM_NOTE}` : SYSTEM_PROMPT;
    return `${base}\nWrite all explanations${group ? " and titles" : ""} in ${languageInstruction(targetLang)}.`;
  }

  function key(pageIndex, paragraphIndex) {
    return `p_${pageIndex}_${paragraphIndex}`;
  }

  function eligible(paragraph) {
    if (!paragraph || !ELIGIBLE_TYPES.has(paragraph.paragraphType)) return false;
    return str(paragraph.paragraphText).length >= MIN_CHARS;
  }

  function pageBatches(hierarchicalData, opts = {}) {
    const only = opts.only || null;
    const batches = [];
    for (const page of hierarchicalData || []) {
      let items = [];
      let size = 0;
      const flush = () => {
        if (items.length) batches.push({ pageIndex: page.pageIndex, items });
        items = [];
        size = 0;
      };
      for (const p of page.paragraphs || []) {
        if (!eligible(p)) { flush(); continue; }
        const k = key(page.pageIndex, p.paragraphIndex);
        if (only && !only.has(k)) { flush(); continue; }
        const text = str(p.paragraphText);
        if (items.length && size + text.length > MAX_BATCH_CHARS) flush();
        items.push({ key: k, text, summary: str(p.paragraphSummary) });
        size += text.length;
      }
      flush();
    }
    return batches;
  }

  /**
   * Lenient parse of a model reply (cards, or the legacy explanations / map / array shapes).
   * `expected`: ordered array of the batch keys (a Set also works, in insertion order).
   * → Map(leadKey -> text) with .roles (every member key -> role), .groups (leadKey -> keys, >= 2 keys only),
   *   .titles (leadKey -> title) and .covered (Set of all lead and member keys).
   */
  function parseReply(content, expected) {
    let s = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    let value = null;
    try {
      value = JSON.parse(s);
    }
    catch (e) {
      for (const [open, close] of [["{", "}"], ["[", "]"]]) {
        const a = s.indexOf(open);
        const b = s.lastIndexOf(close);
        if (a < 0 || b <= a) continue;
        try {
          value = JSON.parse(s.slice(a, b + 1));
          break;
        }
        catch (e2) { /* try next shape */ }
      }
    }
    const out = new Map();
    out.roles = new Map();
    out.groups = new Map();
    out.titles = new Map();
    out.covered = new Set();
    if (!value || typeof value !== "object") return out;
    const order = expected ? new Map([...expected].map((k, i) => [k, i])) : null;
    const cards = [];
    const single = (k, t, role) => cards.push({ keys: [k], text: t, role });
    let list = null;
    if (Array.isArray(value)) list = value;
    else if (Array.isArray(value.cards)) list = value.cards;
    else if (Array.isArray(value.explanations)) list = value.explanations;
    if (list) {
      for (const it of list) {
        if (!it || typeof it !== "object") continue;
        const keys = Array.isArray(it.keys) ? it.keys : [it.key];
        cards.push({ keys, text: it.explanation ?? it.text ?? it.explain, role: it.role, title: it.title });
      }
    }
    else {
      const map = value.explanations && typeof value.explanations === "object" ? value.explanations : value;
      for (const [k, t] of Object.entries(map)) {
        if (typeof t === "string") single(k, t);
        else if (t && typeof t === "object") single(k, t.explanation ?? t.text, t.role);
      }
    }
    for (const card of cards) {
      const text = str(card.text);
      let keys = [...new Set(card.keys.map(str).filter((k) => k && !out.covered.has(k) && (!order || order.has(k))))];
      if (!text || !keys.length) continue;
      if (order) {
        keys.sort((x, y) => order.get(x) - order.get(y));
        let n = 1; // keep the first consecutive run, starting at the first key
        while (n < keys.length && order.get(keys[n]) === order.get(keys[n - 1]) + 1) n++;
        keys = keys.slice(0, n);
      }
      const lead = keys[0];
      out.set(lead, text);
      for (const k of keys) out.covered.add(k);
      const role = str(card.role).toLowerCase();
      if (ROLES.includes(role)) for (const k of keys) out.roles.set(k, role);
      if (keys.length > 1) out.groups.set(lead, keys);
      const title = str(card.title);
      if (title && title.length <= 60) out.titles.set(lead, title);
    }
    return out;
  }

  function buildUserMessage(items, { paperContext, previous, neighbors, group }) {
    const parts = [];
    if (str(paperContext)) parts.push(`Paper context:\n${str(paperContext).slice(0, MAX_CONTEXT_CHARS)}`);
    if (str(previous)) parts.push(`Summaries of the previous page (for connecting to earlier content):\n${str(previous)}`);
    if (neighbors && neighbors.length) {
      parts.push(`Preceding paragraphs:\n${neighbors.map((t) => String(t).slice(0, MAX_NEIGHBOR_CHARS)).join("\n\n")}`);
    }
    parts.push(group ? GROUP_TASK_PROMPT : TASK_PROMPT);
    parts.push(`${MARKER}\n${JSON.stringify({ items })}`);
    return parts.join("\n\n");
  }

  function previousPageSummaries(hierarchicalData, pageIndex) {
    const pages = hierarchicalData || [];
    const at = pages.findIndex((p) => p.pageIndex === pageIndex);
    const prev = at > 0 ? pages[at - 1] : null;
    if (!prev) return "";
    const lines = [];
    let total = 0;
    for (const p of prev.paragraphs || []) {
      const line = str(p.paragraphSummary).replace(/\s+/g, " ");
      if (!line) continue;
      if (total + line.length > MAX_PREV_CHARS) break;
      lines.push(`- ${line}`);
      total += line.length + 3;
    }
    return lines.join("\n");
  }

  async function request(items, ctx, opts) {
    const res = await DeepRead.LLM.complete({
      system: systemPrompt(opts.targetLang, ctx.group),
      messages: [{ role: "user", content: buildUserMessage(items, ctx) }],
      responseFormat: { type: "json_object" },
      temperature: 0.4,
      signal: opts.signal,
      config: opts.config,
    });
    return parseReply(res && res.content, items.map((i) => i.key));
  }

  /** One request, retried once on a (non-abort) failure. */
  async function requestWithRetry(items, ctx, opts) {
    throwIfAborted(opts.signal);
    try {
      return await request(items, ctx, opts);
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      DeepRead.log?.("explainer request failed, retrying:", e?.message || e);
    }
    throwIfAborted(opts.signal);
    try {
      return await request(items, ctx, opts);
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      throw e;
    }
  }

  /**
   * → Map(leadKey → text) with .roles (key → role, all member keys), .groups (leadKey → keys, merged cards only), .titles (leadKey → title).
   * onPage(pageIndex, Map(leadKey → text), roles, { groups, titles }). opts.group (default true) lets the model merge consecutive paragraphs.
   */
  async function explainPages(hierarchicalData, opts = {}) {
    const results = new Map();
    results.roles = new Map();
    results.groups = new Map();
    results.titles = new Map();
    const group = opts.group !== false;
    const batches = pageBatches(hierarchicalData, { only: opts.only });
    const total = batches.length;
    const cfgConcurrency = Number(DeepRead.prefs?.llmConfig?.()?.concurrency) || 4;
    const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || Math.min(4, cfgConcurrency), total || 1));
    let done = 0;
    let next = 0;
    const progress = (extra) => {
      if (typeof opts.onProgress === "function") opts.onProgress({ done, total, ...extra });
    };

    async function runBatch(batch) {
      const ctx = {
        paperContext: opts.paperContext,
        previous: previousPageSummaries(hierarchicalData, batch.pageIndex),
        group,
      };
      const got = new Map();
      got.roles = new Map();
      got.groups = new Map();
      got.titles = new Map();
      const covered = new Set();
      const take = (reply) => {
        for (const [k, t] of reply) got.set(k, t);
        for (const [k, r] of reply.roles || []) got.roles.set(k, r);
        for (const [k, g] of reply.groups || []) got.groups.set(k, g);
        for (const [k, t] of reply.titles || []) got.titles.set(k, t);
        for (const k of reply.covered || reply.keys()) covered.add(k);
      };
      let error = null;
      try {
        take(await requestWithRetry(batch.items, ctx, opts));
        const missing = batch.items.filter((i) => !covered.has(i.key));
        if (missing.length) {
          try {
            take(await request(missing, ctx, opts));
          }
          catch (e) {
            if (isAbort(e, opts.signal)) throw abortError();
            error = e;
          }
        }
      }
      catch (e) {
        if (isAbort(e, opts.signal)) throw abortError();
        error = e;
      }
      for (const [k, t] of got) results.set(k, t);
      for (const [k, r] of got.roles) results.roles.set(k, r);
      for (const [k, g] of got.groups) results.groups.set(k, g);
      for (const [k, t] of got.titles) results.titles.set(k, t);
      if (got.size && typeof opts.onPage === "function") {
        opts.onPage(batch.pageIndex, got, got.roles, { groups: got.groups, titles: got.titles });
      }
      done++;
      progress(error ? { pageIndex: batch.pageIndex, error } : {});
    }

    async function worker() {
      while (next < batches.length) {
        throwIfAborted(opts.signal);
        await runBatch(batches[next++]);
      }
    }

    throwIfAborted(opts.signal);
    progress();
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
    return results;
  }

  async function explainOne(paragraph, opts = {}) {
    const k = key(opts.pageIndex, paragraph.paragraphIndex);
    const items = [{ key: k, text: str(paragraph.paragraphText), summary: str(paragraph.paragraphSummary) }];
    const neighbors = (opts.neighbors || []).slice(-2).map(str).filter(Boolean);
    const ctx = { paperContext: opts.paperContext, neighbors };
    const got = await requestWithRetry(items, ctx, opts);
    const text = got.get(k);
    if (!text) throw new Error("The model returned no explanation");
    if (opts.withRole) return { text, role: got.roles?.get(k) || "" };
    return text;
  }

  DeepRead.Explainer = {
    SYSTEM_PROMPT,
    TASK_PROMPT,
    ROLES,
    key,
    eligible,
    pageBatches,
    explainPages,
    explainOne,
    _parseReply: parseReply,
  };
})();
