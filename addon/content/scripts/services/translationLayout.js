/* Source-structured translation layout for the reader.
 * Indent/marker rules adapted from RetainPDF (MIT, Copyright (c) 2026 RetainPDF contributors),
 * render/layout/payload/{first_line_indent,line_structure}.py at a665c2aea2cd0860c737e7f9685d8071fbef1b3a.
 * See content/lib/retainpdf/LICENSE and docs/TRANSLATION_LAYOUT.md.
 * Plugin code: AGPL-3.0-or-later. */
(function () {
  const MARKER = /^(\s*)([•‣◦▪●]|[-*]|\(?\d{1,3}[.)、]|\(?[A-Za-z][.)])\s+/u;
  const markerOf = (s) => /^\s*([•‣◦▪●])/.exec(s)?.[1] || MARKER.exec(s)?.[2] || "";
  const median = (a, fallback = 0) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : fallback; };
  const norm = (s) => String(s || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const trimTranslation = (s, unit) => {
    // Newlines inside a unit are model wrapping; only source units create hard breaks.
    const text = String(s || "").trim().replace(/\s*\n+\s*/g, " ");
    return unit.kind === "list-item" ? text.replace(/^(\*\*)?\s*[•‣◦▪●]\s*/, "$1")
      .replace(/^(\*\*)?\s*(?:[*-]|\(?\d{1,3}[.)、]|\(?[A-Za-z][.)])\s+/, "$1") : text;
  };

  function analyze(text, mapping = [], chars = [], { type = "text" } = {}) {
    // Display equations keep the existing math translation/rendering path.
    if (!["text", "list"].includes(type)) return null;
    const lines = [];
    let line = null;
    for (let i = 0; i < text.length; i++) {
      if (!text[i].trim()) continue;
      const c = chars[mapping[i]], r = c?.rect;
      if (!r?.length || r.length !== 4 || !r.every(Number.isFinite)) continue;
      const cy = (r[1] + r[3]) / 2, size = c.fontSize || r[3] - r[1] || 10;
      if (!line || Math.abs(cy - line.cy) > Math.max(line.size, size) * 0.55) {
        line = { start: i, end: i + 1, x: r[0], right: r[2], top: r[3], bottom: r[1], cy, size };
        lines.push(line);
      }
      else { line.end = i + 1; line.x = Math.min(line.x, r[0]); line.right = Math.max(line.right, r[2]); line.bottom = Math.min(line.bottom, r[1]); }
    }
    if (!lines.length) {
      const chunks = String(text).split(/\n\s*\n/).filter((s) => s.trim());
      return { version: 1, units: (chunks.length ? chunks : [text]).map((s, i) => {
        const marker = markerOf(s);
        return { id: `u${i}`, kind: marker ? "list-item" : "paragraph", marker, sourceText: s.trim(), styledText: s.trim(), indentEm: 0, insetEm: 0, hangingEm: 1.2, share: 1 / Math.max(1, chunks.length) };
      }) };
    }
    const bodySize = median(lines.map((l) => l.size), 10);
    const pitch = median(lines.slice(1).map((l, i) => lines[i].cy - l.cy).filter((x) => x > bodySize * 0.6 && x < bodySize * 2), bodySize * 1.2);
    const bins = new Map();
    for (const l of lines) { const x = Math.round(l.x / (bodySize * 0.2)) * bodySize * 0.2; bins.set(x, (bins.get(x) || 0) + 1); }
    const left = [...bins].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const starts = [0];
    const markers = lines.map((l) => markerOf(text.slice(l.start, l.end)));
    const listContext = type === "list" || markers.filter(Boolean).length >= 2;
    // Consecutive run-in headings may start at the same x with no extra
    // leading. Require a repeated emphasis pattern followed by normal prose.
    const leadStyle = line => {
      if (!/[\p{Lu}\p{Script=Han}]/u.test(text[line.start])) return "";
      const style = c => DeepRead.Typography.bold(c) ? "bold" : DeepRead.Typography.italic(c) ? "italic" : "";
      const lead=style(chars[mapping[line.start]]);
      if (!lead) return "";
      let j=line.start+1;
      while(j<line.end && (/\s/.test(text[j]) || style(chars[mapping[j]])===lead)) j++;
      const words=text.slice(line.start,j).trim();
      return words.length>=3 && words.length<=60 && words.split(/\s+/).length<=7 &&
        /^[\p{L}]/u.test(text[j]||"") && j+3<line.end && !style(chars[mapping[j]]) ? lead : "";
    };
    const firstLead=leadStyle(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1], current = lines[i];
      const end = text.slice(prev.start, prev.end).trim();
      const complete = /[.!?。！？:：;；]["'”’)\]]*$/.test(end);
      const indent = (current.x - left) / bodySize;
      const hasMarker = markers[i] && (listContext || /^[•‣◦▪●]$/.test(markers[i]));
      const hardGap = prev.cy - current.cy > pitch * 1.45;
      const indented = indent >= 0.45 && indent <= 2.2 && Math.abs(current.x - prev.x) > bodySize * 0.3;
      const runIn=firstLead && Math.abs(current.x-lines[0].x)<bodySize*.4 && leadStyle(current)===firstLead;
      if (hasMarker || (!listContext && complete && (hardGap || indented || runIn))) starts.push(i);
    }
    const blockTop = lines[0].top, bottom = Math.min(...lines.map((l) => l.bottom));
    const height = Math.max(bodySize, blockTop - bottom), minLeft = Math.min(...lines.map((l) => l.x));
    const units = starts.map((at, i) => {
      const endLine = (starts[i + 1] ?? lines.length) - 1;
      const start = lines[at].start, end = lines[endLine].end;
      const raw = text.slice(start, end), unitLines = lines.slice(at, endLine + 1);
      const marker = markers[at] || (listContext && at === 0 ? markers.find(Boolean) || "•" : "");
      const baseline = median(unitLines.slice(1).map((l) => l.x), lines[at].x);
      const indentEm = (lines[at].x - baseline) / bodySize;
      const styled = DeepRead.Typography?.styledSentence({ text: raw, charMapping: mapping.slice(start, end) }, chars) || raw;
      return { id: `u${i}`, kind: marker ? "list-item" : "paragraph", marker,
        sourceText: raw.replace(/\s+/g, " ").trim(), styledText: styled.replace(/\s+/g, " ").trim(),
        indentEm: !marker && indentEm >= 0.3 && indentEm <= 2.2 ? indentEm : 0,
        insetEm: marker ? Math.max(0, Math.min(4, (lines[at].x - minLeft) / bodySize)) : 0,
        hangingEm: marker ? Math.max(1.1, Math.min(3, (baseline - lines[at].x) / bodySize)) : 0,
        share: Math.max(0.01, (lines[at].top - (starts[i + 1] !== undefined ? lines[starts[i + 1]].top : bottom)) / height),
      };
    });
    return { version: 1, units };
  }

  function accept(layout, returned) {
    if (!layout?.units?.length || !Array.isArray(returned)) return null;
    const byId = new Map();
    for (const item of returned) {
      if (!item || typeof item.unit_id !== "string" || typeof item.translation !== "string" || !item.translation.trim() || byId.has(item.unit_id)) return null;
      byId.set(item.unit_id, item.translation);
    }
    if (byId.size !== layout.units.length || layout.units.some((u) => !byId.has(u.id))) return null;
    return { ...layout, units: layout.units.map((u) => ({ ...u, translation: trimTranslation(byId.get(u.id), u) })) };
  }
  const ready = (layout) => !!layout?.units?.length && layout.units.every((u) => typeof u.translation === "string" && u.translation.trim());

  function fromPoints(layout, paragraph) {
    if (!layout?.units?.length) return null;
    const points = paragraph.points || (paragraph.point_split || []).map((indices, i) => ({ sentenceIndices: indices, translation: paragraph.point_translations?.[i] }));
    if (!points.length || points.some((p) => !p.translation?.trim())) return null;
    if (layout.units.length === 1) return accept(layout, [{ unit_id: layout.units[0].id, translation: points.map((p) => p.translation).join(" ") }]);
    const buckets = layout.units.map(() => []), sources = layout.units.map((u) => norm(u.sourceText));
    for (const p of points) {
      const source = norm((p.sentenceIndices || []).map((i) => paragraph.sentences?.[i]?.text || "").join(" "));
      const owners = sources.flatMap((s, i) => source.length >= 8 && s.includes(source) ? [i] : []);
      if (owners.length !== 1) return null;
      buckets[owners[0]].push(p.translation);
    }
    return buckets.every((b) => b.length) ? accept(layout, layout.units.map((u, i) => ({ unit_id: u.id, translation: buckets[i].join(" ") }))) : null;
  }

  function markdown(layout) {
    if (!ready(layout)) return "";
    return layout.units.map((u) => `${u.kind === "list-item" ? `${u.marker} ` : ""}${u.translation}`).join("\n\n");
  }

  async function requestUnits(items, { request, targetLang, signal, repair, context }) {
    const messages = [{ role: "user", content: `Source layout units (JSON):\n${JSON.stringify(items)}` }];
    if (context?.length) messages.push({ role: "user", content: `Neighbouring source fragments in reading order (JSON):\n${JSON.stringify(context)}\nIf the fragments form a sentence interrupted by a page break or figure, translate it in context. Return only the part belonging to each requested unit ID.` });
    const protection = items.some(u=>u.protected) ? ' Each ⟦D…⟧ token represents the exact expression described in that unit’s protected list. Write around the token in natural target-language order and copy its ID exactly once. The reader inserts its final content. Do not spell out its value, change its case, add symbols or reverse a comparison.' : '';
    const simplified = /^(?:zh|zh-CN|zh-Hans)$/iu.test(targetLang);
    const style = simplified
      ? "Write clear simplified Chinese suitable for a published research paper. Use natural Chinese syntax and conventional field terms. Keep a paper title, section heading, caption and caption label in their original roles. Keep acronyms and method names recognizable."
      : "";
    const roboticsTerms = simplified && items.some(u=>/receding[-‐‑ ]horizon control/iu.test(u.source_text))
      ? "Use 滚动时域控制 for receding-horizon control." : "";
    const system = [
      `Translate source_text into ${DeepRead.PARSE_LANGUAGES?.[targetLang]?.instruction || targetLang}. ${style}`,
      "Translate each unit completely. Follow the original reasoning and preserve every claim, action, object, condition, negation, comparison, ordering, cause, degree of certainty and conclusion. Keep sentence boundaries readable. Preserve the source's paragraph lead-ins, emphasis and italic runs. A multi-line passage needs a full translation. source_lines describes the printed frame. It is not a length limit.",
      "Translate the content in the requested unit only. A unit can start or end mid-sentence. Read preceding_context, following_context and source_context for meaning, without adding their clauses, values or conclusions. Keep all author names, affiliations, dates and field labels associated. For bibliography text preserve author names, years and page ranges, translate the title and retain venue emphasis.",
      "For table_label and figure_label, use a short conventional label that fits its own region, preserving direction, acronyms, units and symbols. For code_comment translate the comment only. Omit list markers, which the renderer restores. Keep bold as **bold** and italic as *italic*.",
      protection,
      roboticsTerms,
      repair ? "The previous reply was incomplete or violated a protected expression. Translate each missing unit again in full and check every ID, qualifier, premise and placeholder before returning it." : "",
      "Return only JSON with a translations array of objects with id and translation. Return each requested id exactly once, verbatim."
    ].filter(Boolean).join("\n");
    const response = await request({system,messages,responseFormat:{type:"json_object"},temperature:0.1,
      reasoningEffort:repair ? undefined : "low",signal});
    if (signal?.aborted) { const e = new Error("Aborted"); e.name = "AbortError"; throw e; }
    const text = String(response?.content || "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    let translations;
    try { translations = JSON.parse(text)?.translations; } catch { /* A truncated reply is retried by its caller. */ }
    return Array.isArray(translations) ? translations.filter(t => t && typeof t.id === "string") : [];
  }

  async function complete(paragraphs, { request, targetLang = "zh", signal, strict = false, contextFor, repair = false } = {}) {
    const result = paragraphs.map((p) => ({ ...p, translationLayout: p.translationLayout }));
    const missing = [];
    result.forEach((p, i) => {
      if (ready(p.translationLayout)) return;
      const local = fromPoints(p.translationLayout, p);
      if (local) p.translationLayout = local;
      else if (p.translationLayout?.units?.length) missing.push(i);
    });
    for (let at = 0; at < missing.length; at += 4) {
      if (signal?.aborted) { const e = new Error("Aborted"); e.name = "AbortError"; throw e; }
      const indices = missing.slice(at, at + 4);
      const items = indices.flatMap((i) => result[i].translationLayout.units.map((u) => ({
        id: `${i}:${u.id}`, kind: u.kind, source_text: u.styledText || u.sourceText,
        ...(u.hint ? {source_context:u.hint} : {}),
        ...(u.protected?.length ? { protected: u.protected } : {}),
      })));
      try {
        const translations = await requestUnits(items, { request, targetLang, signal, repair, context: contextFor?.(indices) });
        for (const i of indices) {
          const candidate = translations.filter((t) => typeof t.id === "string" && t.id.startsWith(`${i}:`)).map((t) => ({ unit_id: t.id.slice(String(i).length + 1), translation: t.translation }));
          const accepted = accept(result[i].translationLayout, candidate);
          if (accepted) result[i].translationLayout = accepted;
          else if (strict) throw new Error(DeepRead.bilingual("模型未按段落返回完整译文", "Model returned incomplete translation units"));
        }
      }
      catch (error) {
        if (strict || error?.name === "AbortError" || signal?.aborted) throw error;
        DeepRead.log?.("layout translation unavailable; retaining original text", String(error));
      }
    }
    return result;
  }
  DeepRead.TranslationLayout = { analyze, accept, fromPoints, ready, markdown, requestUnits, complete };
})();
