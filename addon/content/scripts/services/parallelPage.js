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
        const last = line.at(-1);
        const height = last && Math.max(last[3] - last[1], c.rect[3] - c.rect[1], c.fontSize || 0);
        const scriptOnLine = last && c.rect[0] >= last[2] - height * 0.2 && c.rect[0] < last[2] + height &&
          c.rect[1] <= last[3] + height * 0.15 && c.rect[3] >= last[1] - height * 0.15;
        if (last && !scriptOnLine && Math.abs(c.rect[1] - line[0][1]) > Math.max(2, height * 0.65)) {
          rects.push(union(line)); line = [];
        }
        line.push(c.rect);
      }
      if (line.length && (c.lineBreakAfter || c.paragraphBreakAfter)) { rects.push(union(line)); line = []; }
    }
    if (line.length) rects.push(union(line));
    return rects;
  }

  function markerLength(chars, marker) {
    if (!marker) return 0;
    let i = 0, prefix = "";
    while (i < chars.length && prefix.length < marker.length) prefix += glyphText(chars[i++]).trim();
    if (prefix !== marker) return 0;
    while (i < chars.length && !glyphText(chars[i]).trim()) i++;
    return i;
  }

  function withoutMarker(text, marker) {
    if (!marker || !text) return text;
    const prefix = text.match(/^\s*\*{0,3}/u)[0];
    const bare = text.slice(prefix.length);
    return bare.startsWith(marker) ? prefix + bare.slice(marker.length).trimStart() : text;
  }

  function sourceParagraph(item, i) {
    let text = item.text;
    if (visual.has(item.type)) text = item.image_caption || item.table_caption || item.chart_caption || [];
    else if (item.type === "list") text = item.list_items;
    if (Array.isArray(text)) text = text.filter((x) => typeof x === "string").join("\n\n");
    return { paragraphText: typeof text === "string" ? text.trim() : "", paragraphIndex: i, minerUid: item.id ?? `item:${i}`,
      paragraphType: item.text_level === 1 ? "title" : item.type, bbox: item.bbox };
  }

  function joinSplitFormula(sources, chars, view) {
    const output = [];
    for (const p of sources) {
      const prev = output.at(-1);
      if (!prev || prev.paragraphType !== "text" || p.paragraphType !== "text" ||
          !/^\s*(?:[A-Za-z]\s*[=<>≤≥]|[_^=])/u.test(p.paragraphText)) {
        output.push(p);
        continue;
      }
      const box = fromPermille(prev.bbox, view), next = fromPermille(p.bbox, view);
      if (!box || !next || next[3] < box[1] || next[1] > box[3]) { output.push(p); continue; }
      const left = match(charactersIn(box, chars), prev.paragraphText);
      const right = match(charactersIn(next, chars), p.paragraphText);
      const tail = left.at(-1), head = right[0];
      const a = chars.indexOf(tail), b = chars.indexOf(head);
      const em = Math.max(tail?.fontSize || 0, head?.fontSize || 0);
      if (a < 0 || b <= a || b-a > 4 || chars.slice(a+1,b).some(c=>glyphText(c).trim()) ||
          Math.abs(tail.rect[2]-head.rect[0]) > em*3 || Math.abs(tail.rect[1]-head.rect[1]) > em*1.8) {
        output.push(p);
        continue;
      }
      // MinerU can end a box with the superscript and start the next with the
      // subscript of the very same formula. Join only adjacent physical glyphs.
      const glyphs = [...left.slice(0,-1), {...tail, lineBreakAfter:false, paragraphBreakAfter:false, spaceAfter:false}, ...right];
      output[output.length-1] = { paragraphType:"text", paragraphText:prev.paragraphText+" "+p.paragraphText,
        minerUid:prev.minerUid, bbox:union([prev.bbox,p.bbox]), inlineGlyphs:glyphs };
    }
    return output;
  }

  function equationTag(chars) {
    const end = chars.findIndex(c => c.lineBreakAfter || c.paragraphBreakAfter);
    if (end < 1 || end > 12 || end+1 >= chars.length) return null;
    const first = chars.slice(0,end+1);
    const label = first.map(glyphText).join("").trim();
    if (!/^\(\s*\d+[a-z]?\s*\)$/iu.test(label)) return null;
    const following = chars[end+1], size = following.fontSize || 10;
    if (!following.rect || first[0].rect[0] < following.rect[0]+size*4 ||
        first[0].rect[1] < following.rect[1]+size*.55) return null;
    return {label, end:end+1, rect:union(first.map(c=>c.rect).filter(valid))};
  }

  function uncoveredHeadings(sources, chars, view) {
    const frames=sources.map(p=>fromPermille(p.bbox,view) || union((p.rects || []).filter(valid))).filter(valid);
    if (!frames.length) return [];
    const result=[];
    let line=[];
    function finish() {
      const text=glyphStream(line).text.trim();
      if (!/^(?:[IVXLCDM]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\p{Lu}/u.test(text) ||
          text.length>120 || !/[a-z]{3}/iu.test(text) || /[!?;:]$/u.test(text)) return;
      const rect=union(line.map(c=>c.rect)), size=Math.max(...line.map(c=>c.fontSize || 0));
      if (!size || line.some(c=>frames.some(r=>inside(r,(c.rect[0]+c.rect[2])/2,(c.rect[1]+c.rect[3])/2,1)))) return;
      // A numbered heading between text blocks may be absent from the parser.
      // Never recover text inside figure/table boxes, such as an axis title.
      const column=frames.find(r=>r[0]<=rect[0]+size && r[2]>=rect[2]-size &&
        (Math.abs(r[1]-rect[3])<size*4 || Math.abs(rect[1]-r[3])<size*4));
      if (!column) return;
      const centered=rect[0]-column[0]>size && Math.abs((column[2]-rect[2])-(rect[0]-column[0]))<size;
      result.push({paragraphType:"title",paragraphText:text,rects:[rect],inlineGlyphs:line,centered,
        minerUid:"pdf-heading:"+rect.join(",")});
    }
    for (const c of chars) {
      if (valid(c.rect) && !c.rotation && !c.diagonal) line.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) { if (line.length) finish(); line=[]; }
    }
    if (line.length) finish();
    return result;
  }

  // Cached paragraph IDs are physical IDs. A joined translation may cross a page or
  // an image, so only use its identified per-fragment text in a physical frame.
  function plan({ paragraphs = [], items = [], chars = [], view, reuse = true, continuationFor, language = 'zh' }) {
    const units = [], barriers = [];
    const parsed = items.map(sourceParagraph);
    // Cards can combine prose + a display equation + its explanation. For a
    // page translation the original parser frames own these three positions.
    const parsedIDs = new Set(parsed.map(p => p.minerUid));
    const sources = paragraphs.filter(p => p.paragraphType !== 'text_with_equation' || !parsedIDs.has(p.minerUid));
    const used = new Set(sources.map((p) => p.minerUid).filter((id) => id != null));
    const known = new Set(sources.map((p) => JSON.stringify([normalized(p.paragraphText), p.bbox])));
    for (const p of parsed) {
      if (protectedTypes.has(p.paragraphType)) barriers.push({ rect: fromPermille(p.bbox, view), owner: p.minerUid });
      if (!used.has(p.minerUid) && !known.has(JSON.stringify([normalized(p.paragraphText), p.bbox]))) sources.push(p);
    }
    sources.push(...uncoveredHeadings(sources,chars,view));
    for (const p of joinSplitFormula(sources, chars, view)) {
      const type = p.paragraphType || "text", caption = visual.has(type);
      const existingRects = (p.rects || []).filter(valid);
      const region = union(existingRects) || fromPermille(p.bbox, view);
      const displayMath = /^(?:\$\$(?:(?!\$\$)[\s\S])+\$\$|\\\[(?:(?!\\\])[\s\S])+\\\])$/u.test(p.paragraphText?.trim() || "");
      if ((!caption && !prose.has(type)) || displayMath) {
        if (region) barriers.push({ rect: region, owner: p.minerUid });
        continue;
      }
      if (!p.paragraphText?.trim()) continue;
      const bounded = charactersIn(region, chars);
      const ocr = DeepRead.ParallelInline.alignOCR(bounded,p.paragraphText);
      let glyphs = p.inlineGlyphs || (ocr ? bounded : match(bounded, p.paragraphText));
      if (!glyphs.length && caption) glyphs = match(chars, p.paragraphText);
      const tag = equationTag(glyphs);
      if (tag) {
        barriers.push({rect:tag.rect, owner:p.minerUid});
        glyphs = glyphs.slice(tag.end);
      }
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
        let source = u.sourceText || p.paragraphText;
        if (tag && source.startsWith(tag.label)) source = source.slice(tag.label.length).trimStart();
        const local = single ? glyphs : match(glyphs.length ? glyphs : bounded, source);
        let rects = linesOf(local);
        // Whole-figure boxes are not caption frames. For OCR-only prose a typed
        // text box is usable; never guess a split between unmapped list items.
        if (!rects.length && !caption && single && region && !bounded.some((c) => glyphText(c).trim())) {
          rects = existingRects.length ? existingRects : [region];
        }
        const rect = union(rects);
        const sourceSize = DeepRead.Typography.metrics(local)?.fontSize || p.typography?.fontSize || 0;
        const size = p.centered && local.length ? Math.max(...local.map(c=>c.fontSize || 0),sourceSize) :
          sourceSize || Math.min(caption ? 9 : 10, rect ? rect[3] - rect[1] : 10);
        const orient = local.find((c) => c.rotation != null)?.rotation || 0;
        const angle = orient * Math.PI / 180;
        // A parser can join the tail of one column to the head of another, or
        // enclose a floating object in the blank space between two text runs.
        // Such text is still translated but cannot safely cover this rectangle.
        const disconnected = rects.some((r, i) => i > 0 && !orient && (
          r[1] > rects[i - 1][3] + size * 2 || rects[i - 1][1] - r[3] > size * 2.8
          || (Math.abs(r[3] - rects[i - 1][3]) < size * 0.5 && r[0] - rects[i - 1][2] > 3 * size)));
        const pitches = rects.slice(1).map((r, i) => (rects[i][3] - r[3]) / size).filter((n) => n > 0.7 && n < 2).sort((a, b) => a - b);
        const firstBody = markerLength(local, u.marker);
        const inline = DeepRead.ParallelInline.describe(local.slice(firstBody), withoutMarker(source, u.marker),
          withoutMarker(u.styledText, u.marker), size, language, ocr);
        // Some OCR engines label an isolated equation as text. It belongs to
        // the original artwork even if a neighbouring text box overlaps it.
        const words = inline.modelText.replace(/⟦D+\d+⟧/gu, "").replace(/\b(?:log|ln|exp|sin|cos|tan|max|min)\b/gu, "");
        if (inline.tokens.some(t => t.kind === "tex" || t.kind === "math") && !/[\p{L}\p{N}]/u.test(words)) {
          if (rect || region) barriers.push({ rect: rect || region, owner: p.minerUid });
          continue;
        }
        const bodyChars = local.filter(c => glyphText(c).trim());
        const primaryFace = bodyChars.find(c => c.fontSize >= size*0.85)?.fontName || '';
        const block = { source, ...inline, marker: u.marker || "", indent: u.indentEm || 0,
          hanging: u.hangingEm || 0, rect, rects, size, direction: [Math.cos(angle), Math.sin(angle)],
          pitch: pitches[Math.floor(pitches.length / 2)], title: type === "title", caption,
          sans: /sans|NimbusSan|Helvetica|Arial/i.test(primaryFace), allItalic: bodyChars.length>0 && bodyChars.every(DeepRead.Typography.italic),
          boldTitle: !bodyChars.length || bodyChars.filter(DeepRead.Typography.bold).length>bodyChars.length/2,
          owner: p.minerUid, matched: !!local.length, mixed: disconnected || (type === 'text_with_equation' && !local.length && !inline.tokens.some(t=>t.kind==='tex')) };
        if (block.allItalic && rects.length===1 && /^[A-Z]\.$/u.test(block.marker)) block.title=true;
        const label = inline.tokens[0];
        block.centered=!!p.centered;
        if (block.title && !block.marker && ["number","section"].includes(label?.kind) && label.start===0 && label.rect) {
          const following=bodyChars.find(c=>c.rect?.[0]>=label.rect[2]-.1 && c.rect[2]>label.rect[2]+.1);
          if (following && following.rect[0]-label.rect[2]>size*.35)
            block.headingNumber={id:label.id, width:following.rect[0]-label.rect[0]};
        }
        if (firstBody && rect && local[firstBody]?.rect && !orient) {
          block.markerRect = union(local.slice(0,firstBody).filter(c=>glyphText(c).trim()).map(c=>c.rect).filter(valid));
          block.markerIndent = Math.max(0,(local[firstBody].rect[0]-rect[0])/size);
          if (rects.length>1) block.hanging = Math.max(0,(rects[1][0]-rect[0])/size);
        }
        const old = reuse ? (single && fragment || u.translation || (single ? pointTranslation : '')) : '';
        block.translation = DeepRead.ParallelInline.fromLegacy(block, old);
        units.push(block);
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
        // The Latin glyph box can be shorter than one CJK em. Descenders may
        // use a little clear leading below it, without moving the paragraph top.
        const clearance=Math.min(2.2,unit.size*.22,r[1]-view[1]);
        if (clearance>0 && !obstructed([r[0],r[1]-clearance,r[2],r[1]],0)) unit.clearance=clearance;
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
    const bodyPitches=new Map();
    const styleKey=u=>Math.round(u.size*2);
    for (const u of units) {
      if (u.title || u.caption || !u.pitch) continue;
      const key=styleKey(u);
      if (!bodyPitches.has(key)) bodyPitches.set(key,[]);
      bodyPitches.get(key).push(u.pitch);
    }
    for (const pitches of bodyPitches.values()) pitches.sort((a,b)=>a-b);
    for (const u of units) {
      const samples=bodyPitches.get(styleKey(u));
      u.bodyPitch=samples?.length ? samples[Math.floor(samples.length/2)] : 1.2;
    }
    return units;
  }

  const identity = (u) => JSON.stringify([u.source, u.styled, u.rect, u.marker]);
  const contract = (u) => JSON.stringify([u.modelText, (u.tokens || []).map(s=>[s.kind,s.source,s.display])]);
  function hydrate(units, entries) {
    const bySource = new Map((entries || []).map((e) => [e.identity, e]));
    // Before protected expressions, style detection and the last punctuation
    // glyph were part of the cache key. Recover only one matching physical frame.
    const legacy = new Map();
    for (const entry of entries || []) {
      if (entry.contract) continue;
      let parts;
      try { parts = JSON.parse(entry.identity); } catch { continue; }
      if (!Array.isArray(parts) || !valid(parts[2])) continue;
      const key = JSON.stringify([parts[0], parts[3]]);
      if (!legacy.has(key)) legacy.set(key, []);
      legacy.get(key).push({ rect: parts[2], entry });
    }
    for (const u of units) {
      if (u.translation) continue;
      let cached = bySource.get(identity(u));
      if (!cached && valid(u.rect)) {
        const candidates = (legacy.get(JSON.stringify([u.source, u.marker])) || []).filter(({rect}) =>
          u.rect.every((v, i) => Math.abs(v - rect[i]) <= (i === 2 ? u.size * 1.15 : 0.75)));
        if (candidates.length === 1) cached = candidates[0].entry;
      }
      if (!cached) continue;
      if (cached.contract === contract(u) && DeepRead.ParallelInline.valid(u,cached.text)) u.translation=cached.text;
      else if (!cached.contract) u.translation=DeepRead.ParallelInline.fromLegacy(u,cached.text);
    }
  }
  function records(units) {
    return units.filter((u) => u.translation).map((u) => ({ identity: identity(u), contract: contract(u), text: u.translation }));
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
    async function attempt(group, repair = false) {
      const input = group.map((u) => ({ translationLayout: { units: [{ id: 'u0', kind: u.marker ? 'list-item' : 'paragraph',
        sourceText: u.source, styledText: u.modelText || u.styled, marker: u.marker,
        protected: (u.tokens || []).map(s => ({ id:s.id, source:s.source, meaning:s.display })) }] } }));
      const result = await DeepRead.TranslationLayout.complete(input, { request, targetLang: language, signal, strict: true, repair,
        contextFor: (indices) => [...new Set(indices.map((i) => context?.get(normalized(group[i].source))).filter(Boolean))],
      });
      if (signal.aborted) throw Object.assign(new Error('Aborted'), { name:'AbortError' });
      return result.map(p => p.translationLayout.units[0].translation);
    }
    const texts=await attempt(pending);
    const invalid=pending.map((u,i)=>i).filter(i=>!DeepRead.ParallelInline.valid(pending[i],texts[i]));
    if (invalid.length) {
      const retried=await attempt(invalid.map(i=>pending[i]),true);
      invalid.forEach((i,j)=>{ texts[i]=retried[j]; });
      if (invalid.some(i=>!DeepRead.ParallelInline.valid(pending[i],texts[i]))) {
        throw new Error(DeepRead.bilingual('模型未保留原文的公式、数值、术语或强调，请重试本页。','The model changed a protected expression or emphasis. Retry this page.'));
      }
    }
    pending.forEach((u,i)=>{ u.translation=texts[i]; });
  }
  DeepRead.ParallelPage = { plan, hydrate, records, translate, interruptedContext };
})();
