/* Map translated source units to physical PDF frames for the facing-page reader.
 * License: AGPL-3.0-or-later */
(function () {
  const visual = new Set(["image", "figure", "chart", "table"]);
  const protectedTypes = new Set([...visual, "equation", "interline_equation", "formula", "code", "code_block"]);
  const prose = new Set(["text", "title", "list", "text_with_equation"]);
  const normalized = (text) => String(text || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1];
  const union = (rects) => rects.length ? DeepRead.Overlay.unionRect(rects) : null;
  const glyphText = (c) => c.u ?? c.c ?? "";

  function fromPermille(rect, view) {
    if (!valid(rect)) return null;
    const w = (view[2] - view[0]) / 1000, h = (view[3] - view[1]) / 1000;
    return [view[0] + rect[0] * w, view[3] - rect[3] * h, view[0] + rect[2] * w, view[3] - rect[1] * h];
  }

  function inside(rect, x, y, pad = 0) {
    return rect && x >= rect[0] - pad && x <= rect[2] + pad && y >= rect[1] - pad && y <= rect[3] + pad;
  }

  function charactersIn(rect, chars) {
    if (!rect) return [];
    return chars.filter((c) => valid(c.rect) && inside(rect, (c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2, 1));
  }

  function match(chars, source) {
    const needle = normalized(source);
    if (!needle) return [];
    if (normalized(chars.map(glyphText).join("")) === needle) return chars;
    return DeepRead.Typography.match(chars, source) || [];
  }

  function glyphStream(chars) {
    let text = "";
    const mapping = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const run = glyphText(c) + (c.lineBreakAfter || c.paragraphBreakAfter ? "\n" : c.spaceAfter ? " " : "");
      text += run;
      for (let j = 0; j < run.length; j++) mapping.push(i);
    }
    return { text, mapping };
  }

  function linesOf(chars) {
    const rects = [];
    let line = [];
    for (const c of chars) {
      if (valid(c.rect) && glyphText(c).trim()) {
        if (line.length && Math.abs(c.rect[1] - line[0][1]) > Math.max(2, (c.fontSize || 10) * 0.65)) {
          rects.push(union(line)); line = [];
        }
        line.push(c.rect);
      }
      if (line.length && (c.lineBreakAfter || c.paragraphBreakAfter)) { rects.push(union(line)); line = []; }
    }
    if (line.length) rects.push(union(line));
    return rects;
  }

  function sourceParagraph(item, i) {
    let text = item.text;
    if (visual.has(item.type)) text = item.image_caption || item.table_caption || item.chart_caption || [];
    else if (item.type === "list") text = item.list_items;
    if (Array.isArray(text)) text = text.filter((x) => typeof x === "string").join("\n\n");
    return { paragraphText: typeof text === "string" ? text.trim() : "", paragraphIndex: i, minerUid: item.id ?? `item:${i}`,
      paragraphType: item.text_level === 1 ? "title" : item.type, bbox: item.bbox };
  }

  // Cached paragraph IDs are physical IDs. A joined translation may cross a page or
  // an image, so only use its identified per-fragment text in a physical frame.
  function plan({ paragraphs = [], items = [], chars = [], view, reuse = true, continuationFor }) {
    const units = [], barriers = [];
    const parsed = items.map(sourceParagraph);
    const sources = [...paragraphs];
    const used = new Set(paragraphs.map((p) => p.minerUid).filter((id) => id != null));
    const known = new Set(paragraphs.map((p) => JSON.stringify([normalized(p.paragraphText), p.bbox])));
    for (const p of parsed) {
      if (protectedTypes.has(p.paragraphType)) barriers.push({ rect: fromPermille(p.bbox, view), owner: p.minerUid });
      if (!used.has(p.minerUid) && !known.has(JSON.stringify([normalized(p.paragraphText), p.bbox]))) sources.push(p);
    }
    for (const p of sources) {
      const type = p.paragraphType || "text", caption = visual.has(type);
      const existingRects = (p.rects || []).filter(valid);
      const region = union(existingRects) || fromPermille(p.bbox, view);
      if (!caption && !prose.has(type)) {
        if (region) barriers.push({ rect: region, owner: p.minerUid });
        continue;
      }
      if (!p.paragraphText?.trim()) continue;
      const bounded = charactersIn(region, chars);
      let glyphs = match(bounded, p.paragraphText);
      if (!glyphs.length && caption) glyphs = match(chars, p.paragraphText);
      const stream = glyphStream(glyphs);
      const oldLayout = p.translationLayout?.units;
      let layout = oldLayout?.length ? oldLayout : DeepRead.TranslationLayout.analyze(stream.text || p.paragraphText,
        stream.mapping, glyphs, { type: type === "list" ? "list" : "text" }).units;
      if (reuse && p.points?.length && layout.some((u) => !u.translation)) {
        const restored = DeepRead.TranslationLayout.fromPoints({ version: 1, units: layout }, p);
        if (restored) layout = layout.map((u, i) => u.translation ? u : restored.units[i]);
      }
      const pointTexts = (p.points || []).map((pt) => pt.translation?.trim());
      const pointTranslation = pointTexts.every(Boolean) ? pointTexts.join(" ") : "";
      const joined = reuse && continuationFor?.(p);
      const fragment = joined?.fragments?.find((part) => part.key === `p_${p.pageIndex}_${p.paragraphIndex}`)?.text;
      for (const u of layout) {
        const single = layout.length === 1;
        const source = u.sourceText || p.paragraphText;
        const local = single ? glyphs : match(glyphs.length ? glyphs : bounded, source);
        let rects = linesOf(local);
        // Whole-figure boxes are not caption frames. For OCR-only prose a typed
        // text box is usable; never guess a split between unmapped list items.
        if (!rects.length && !caption && single && region && !bounded.some((c) => glyphText(c).trim())) {
          rects = existingRects.length ? existingRects : [region];
        }
        const rect = union(rects);
        const sourceSize = DeepRead.Typography.metrics(local)?.fontSize || p.typography?.fontSize || 0;
        const size = sourceSize || Math.min(caption ? 9 : 10, rect ? rect[3] - rect[1] : 10);
        const orient = local.find((c) => c.rotation != null)?.rotation || 0;
        const angle = orient * Math.PI / 180;
        // A parser can join the tail of one column to the head of another, or
        // enclose a floating object in the blank space between two text runs.
        // Such text is still translated but cannot safely cover this rectangle.
        const disconnected = rects.some((r, i) => i > 0 && !orient && (
          r[1] > rects[i - 1][3] + size * 2 || rects[i - 1][1] - r[3] > size * 2.8
          || (Math.abs(r[3] - rects[i - 1][3]) < size * 0.5 && r[0] - rects[i - 1][2] > 3 * size)));
        const pitches = rects.slice(1).map((r, i) => (rects[i][3] - r[3]) / size).filter((n) => n > 0.7 && n < 2).sort((a, b) => a - b);
        units.push({ source, styled: u.styledText || source, marker: u.marker || "", indent: u.indentEm || 0,
          hanging: u.hangingEm || 0, rect, rects, size, direction: [Math.cos(angle), Math.sin(angle)],
          pitch: pitches[Math.floor(pitches.length / 2)], title: type === "title", caption,
          owner: p.minerUid, matched: !!local.length, mixed: type === "text_with_equation" || disconnected
            || local.some((c) => /CMMI|CMSY|CMEX|\bMath\b|Symbol/i.test(c.fontName || "")),
          translation: reuse ? (single && fragment || u.translation || (single ? pointTranslation : "")) : "" });
      }
    }
    const bbox = (r) => ({ left: r[0], top: r[1], right: r[2], bottom: r[3] });
    const { layoutRectsOverlap } = DeepRead.ParallelTypeset.engine().FitModelParts.rects;
    const overlaps = (a, b, tolerance) => layoutRectsOverlap(bbox(a), bbox(b), tolerance);
    for (const unit of units) {
      const r = unit.rect;
      const obstructed = (candidate, tolerance) => barriers.some((b) => b.rect && overlaps(candidate, b.rect, tolerance)
        && !(unit.caption && unit.matched && unit.owner != null && b.owner === unit.owner))
        || units.some((other) => other !== unit && valid(other.rect) && overlaps(candidate, other.rect, tolerance));
      unit.placed = !!(valid(r) && inside(view, r[0], r[1], 1) && inside(view, r[2], r[3], 1)
        && !unit.mixed && !obstructed(r, 0.6));
      if (unit.placed) {
        // PDF text-layer metrics can fall just inside the ink, especially italic tails.
        // Allow a narrow bleed on the background only when no neighbouring frame is hit.
        const pad = unit.matched ? Math.min(1.3, unit.size * 0.12) : 0;
        unit.masks = unit.rects.map((line) => {
          const mask = [Math.max(view[0], line[0] - pad), Math.max(view[1], line[1] - pad), Math.min(view[2], line[2] + pad), Math.min(view[3], line[3] + pad)];
          return obstructed(mask, 0) ? line : mask;
        });
        const textLines = unit.rects.slice(0, -1);
        unit.justified = textLines.length >= 2 && textLines.filter((line) => r[2] - line[2] < unit.size).length > textLines.length / 2;
      }
    }
    return units;
  }

  const identity = (u) => JSON.stringify([u.source, u.styled, u.rect, u.marker]);
  function hydrate(units, entries) {
    const bySource = new Map((entries || []).map((e) => [e.identity, e.text]));
    for (const u of units) if (!u.translation) u.translation = bySource.get(identity(u)) || "";
  }
  function records(units) {
    return units.filter((u) => u.translation).map((u) => ({ identity: identity(u), text: u.translation }));
  }

  function interruptedContext(items, pageIndex) {
    const nearby = items.filter((item) => Math.abs(item.page_idx - pageIndex) <= 1).map((item, i) => {
      const p = sourceParagraph(item, i);
      return { page_idx: item.page_idx, paragraph_idx: i, paragraph_text: p.paragraphText, paragraph_type: p.paragraphType, bbox: p.bbox };
    });
    const bySource = new Map();
    for (const group of DeepRead.Continuations.candidates(nearby)) {
      const texts = group.parts.map((p) => p.paragraph_text);
      for (const p of group.parts) if (p.page_idx === pageIndex) bySource.set(normalized(p.paragraph_text), texts);
    }
    return bySource;
  }

  async function translate(units, { language, signal, request, context }) {
    const pending = units.filter((u) => !u.translation);
    if (!pending.length) return;
    const input = pending.map((u) => ({ translationLayout: { units: [{ id: "u0", kind: u.marker ? "list-item" : "paragraph",
      sourceText: u.source, styledText: u.styled, marker: u.marker }] } }));
    const translated = await DeepRead.TranslationLayout.complete(input, { request, targetLang: language, signal, strict: true,
      contextFor: (indices) => [...new Set(indices.map((i) => context?.get(normalized(pending[i].source))).filter(Boolean))],
    });
    if (signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    if (translated.some((p) => !DeepRead.TranslationLayout.ready(p.translationLayout))) {
      throw new Error(DeepRead.bilingual("模型返回的译文不完整，请重试本页", "Incomplete translation; retry this page"));
    }
    translated.forEach((p, i) => { pending[i].translation = p.translationLayout.units[0].translation; });
  }
  DeepRead.ParallelPage = { plan, hydrate, records, translate, interruptedContext };
})();
