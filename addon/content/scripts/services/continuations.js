/* Confirm and translate paragraphs interrupted by page breaks or figures.
 * Physical source blocks and their coordinates are never rewritten.
 * License: AGPL-3.0-or-later */
(function () {
  const TEXT = new Set(["text", "text_with_equation"]);
  const VISUAL = new Set(["image", "table", "chart", "figure"]);
  const keyOf = (p) => `p_${p.page_idx}_${p.paragraph_idx}`;
  const typeOf = (p) => p.paragraph_type || p.paragraphType || p.type || "text";
  const textOf = (p) => String(p.paragraph_text || p.paragraphText || p.text || "").trim();
  const isVisual = (p) => VISUAL.has(typeOf(p)) || (typeOf(p) === "text"
    && /^(?:(?:fig(?:ure)?\.?|table|tab\.)\s*\d+\s*[:.]|[图表]\s*\d+\s*[:：])/i.test(textOf(p)));
  const box = (p) => Array.isArray(p.bbox) && p.bbox.length === 4 && p.bbox.every(Number.isFinite) ? p.bbox : null;
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));

  function boundary(a, b, visuals) {
    const A = box(a), B = box(b);
    if (!A || !B || textOf(a).length < 20 || textOf(b).length < 8) return null;
    const sizeA = a.typography?.fontSize, sizeB = b.typography?.fontSize;
    if (sizeA && sizeB && Math.abs(sizeA - sizeB) / Math.max(sizeA, sizeB) > 0.2) return null;
    if (b.page_idx === a.page_idx) {
      if (!visuals.length || B[1] < A[3] - 5 || overlap(A, B) < Math.min(A[2] - A[0], B[2] - B[0]) * 0.6) return null;
      const between = visuals.some((v) => {
        const V = box(v);
        return v.page_idx === a.page_idx && V && V[1] >= A[3] - 25 && V[3] <= B[1] + 25
          && overlap(A, V) > 0 && overlap(B, V) > 0;
      });
      return between ? "figure" : null;
    }
    if (b.page_idx !== a.page_idx + 1) return null;
    // A figure can occupy the rest of the old page or the top of the next page.
    const atEnd = A[3] >= 550 || visuals.some((v) => v.page_idx === a.page_idx && box(v)?.[3] >= 750 && box(v)[1] >= A[3] - 25);
    const atStart = B[1] <= 450 || visuals.some((v) => v.page_idx === b.page_idx && box(v)?.[1] <= 200 && box(v)[3] <= B[1] + 25);
    const unfinished = !/[.!?。！？:：;；][\s"'”’)]*$/.test(textOf(a)) && /^[\p{L}\p{N}(（$]/u.test(textOf(b));
    return (atEnd && atStart) || unfinished ? "page" : null;
  }

  function candidates(paragraphs, { visuals: extraVisuals = [] } = {}) {
    const units = [];
    const visuals = [...(paragraphs || []).filter(isVisual), ...(extraVisuals || []).filter(isVisual)];
    let previous = null;
    for (const p of paragraphs || []) {
      if (isVisual(p)) continue;
      if (!TEXT.has(typeOf(p)) || p.continuationChecked) { previous = null; continue; }
      const gap = previous && boundary(previous, p, visuals);
      if (gap) {
        const last = units.at(-1);
        if (last?.parts.at(-1) === previous && last.parts.length < 6
            && last.parts.reduce((n, x) => n + textOf(x).length, 0) + textOf(p).length <= 12000) {
          last.parts.push(p); last.boundaries.push(gap);
        }
        else if (!last || last.parts.at(-1) !== previous) {
          if (textOf(previous).length + textOf(p).length <= 12000) units.push({ parts: [previous, p], boundaries: [gap] });
        }
      }
      previous = p;
    }
    return units;
  }

  function parse(content) {
    const text = String(content || "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "")
      .replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    const value = JSON.parse(text);
    if (!Array.isArray(value.groups)) throw new Error("Invalid continuation response");
    return value.groups;
  }

  function abort(signal) {
    if (signal?.aborted) { const error = new Error("Aborted"); error.name = "AbortError"; throw error; }
  }

  async function reconcile(paragraphs, { complete, targetLang = "zh", signal, visuals = [] } = {}) {
    abort(signal);
    const units = candidates(paragraphs, { visuals });
    const result = (paragraphs || []).map((p) => ({ ...p, continuationChecked: true }));
    const byKey = new Map(result.map((p) => [keyOf(p), p]));
    const used = new Set();
    let count = 0, failures = 0;
    // One request covers several candidate boundaries. No request when nothing is interrupted.
    const batches = [];
    let batch = [], chars = 0;
    for (const unit of units) {
      const length = unit.parts.reduce((n, p) => n + textOf(p).length, 0);
      if (batch.length && (batch.length >= 4 || chars + length > 14000)) { batches.push(batch); batch = []; chars = 0; }
      batch.push(unit); chars += length;
    }
    if (batch.length) batches.push(batch);
    const language = DeepRead.PARSE_LANGUAGES?.[targetLang]?.instruction || (targetLang === "zh" ? "Simplified Chinese" : targetLang);
    for (const entries of batches) {
      abort(signal);
      const payload = entries.map((u) => ({ boundaries: u.boundaries, parts: u.parts.map((p) => ({
        key: keyOf(p), page: p.page_idx + 1, text: p.sourceStyledText || textOf(p),
      })) }));
      try {
        const response = await complete({
          system: `Determine whether neighboring text fragments form ONE original paragraph interrupted by a page break or a floating figure/table. Geometry only nominates candidates; it is NOT evidence of semantic continuity. Join only when the second fragment completes the first sentence or clearly continues the same original paragraph. A common topic alone is not sufficient. Never merge new sections, independent paragraphs, captions, lists or references. When uncertain, leave separate. For every confirmed group, translate ALL source fragments together into ${language}, producing one coherent complete paragraph. Resolve line-end hyphenation by meaning; preserve terms, numbers, qualifiers and source **bold**/*italic*. Use concise language without omissions. Do not concatenate separately translated fragments. Return JSON only: {"groups":[{"keys":["p_0_1","p_1_0"],"translation":"complete jointly translated paragraph"}]}. Keys must be a contiguous subsequence of 2 or more parts of ONE candidate, in source order, and occur in only one group. Return {"groups":[]} if none qualify.`,
          messages: [{ role: "user", content: `Interrupted paragraph candidates (JSON):\n${JSON.stringify(payload)}` }],
          responseFormat: { type: "json_object" }, temperature: 0.1, maxTokens: 8192, signal,
        });
        abort(signal);
        for (const group of parse(response?.content)) {
          const keys = group?.keys, translation = typeof group?.translation === "string" ? group.translation.trim() : "";
          if (!Array.isArray(keys) || keys.length < 2 || !translation || new Set(keys).size !== keys.length || keys.some((k) => used.has(k))) continue;
          const unit = entries.find((u) => {
            const order = u.parts.map(keyOf), start = order.indexOf(keys[0]);
            return start >= 0 && keys.every((k, i) => order[start + i] === k);
          });
          if (!unit) continue;
          const lead = keys[0];
          byKey.get(lead).continuation = { lead, keys: [...keys], translation, version: 1 };
          for (const key of keys.slice(1)) byKey.get(key).continuation = { lead, version: 1 };
          for (const key of keys) used.add(key);
          count++;
        }
      }
      catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        failures++;
        for (const u of entries) for (const p of u.parts) byKey.get(keyOf(p)).continuationChecked = false;
        DeepRead.log?.("continuation translation unavailable; retaining original translations", String(error));
      }
    }
    for (const p of result) delete p.sourceStyledText;
    return { paragraphs: result, count, failures };
  }
  DeepRead.Continuations = { boundary, candidates, reconcile, isVisual };
})();
