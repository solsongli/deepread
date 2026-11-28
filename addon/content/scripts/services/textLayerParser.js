/* DeepRead.TextLayerParser — built-in, zero-dependency PDF structure parser (provider "builtin").
 * Turns Zotero's structured text layer (per-page chars) into a MinerU-style content list using font
 * statistics, geometry and repetition heuristics. No network, no external service.
 * License: AGPL-3.0-or-later */

(function () {
  "use strict";

  const MATH_FONT_RE = /CMMI|CMSY|CMEX|CMR\d|MSAM|MSBM|Math|Symbol|STIX|Cambria Math/i;
  const BOLD_FONT_RE = /bold|black|heavy|semibold|demibold|[-,]Medi(?:Ital)?\b/i;
  const CAPTION_RE = /^(?:(?:Figure|Fig\.|Table|Tab\.)\s*(?:\d+|[IVXLCDM]+)\s*[:.]|[图表]\s*\d+)(?=[\s:.：。]|$)/i;
  const TABLE_CAPTION_RE = /^(?:Table|Tab\.|表)/i;
  const NUMBERED_RE = /^(?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)+\.?|[IVX]+\.|[A-Z]\.)\s+\p{Lu}/u;
  const SECTION_NAMES = new Set([
    "abstract", "introduction", "related work", "related works", "background", "method", "methods", "methodology",
    "experiments", "experiment", "results", "discussion", "conclusion", "conclusions", "acknowledgements",
    "acknowledgments", "acknowledgement", "acknowledgment", "references", "bibliography", "appendix",
    "preliminaries", "limitations", "摘要", "引言", "参考文献", "结论", "绪论", "致谢",
  ]);

  const round1 = (v) => Math.round(v * 10) / 10;
  const isSpaceCh = (c) => !c.u || !c.u.trim();
  const familyOf = (name) => String(name || "").replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0];
  const isBoldChar = (c) => c.bold === true || BOLD_FONT_RE.test(c.fontName || "");

  function modeOf(map) {
    let best = null, bestN = -1;
    for (const [k, n] of map) if (n > bestN) { best = k; bestN = n; }
    return best;
  }

  // ---- Page → lines -----------------------------------------------------------------------------
  function buildLines(chars, ctx) {
    const lines = [];
    let cur = [];
    const flush = (last) => {
      if (!cur.length) return;
      lines.push(makeLine(cur, last, ctx));
      cur = [];
    };
    for (const c of chars) {
      if (!c || (c.rotation && c.rotation !== 0) || c.diagonal) continue;
      cur.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) flush(!!c.paragraphBreakAfter);
    }
    flush(true);
    return lines.filter(Boolean);
  }

  function makeLine(chars, paraEnd, ctx) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const sizes = new Map();
    let n = 0, bold = 0, math = 0;
    for (const c of chars) {
      if (isSpaceCh(c) || !c.rect) continue;
      const r = c.rect;
      if (r[0] < x0) x0 = r[0];
      if (r[1] < y0) y0 = r[1];
      if (r[2] > x1) x1 = r[2];
      if (r[3] > y1) y1 = r[3];
      n++;
      const s = round1(c.fontSize || 0);
      sizes.set(s, (sizes.get(s) || 0) + 1);
      if (isBoldChar(c)) bold++;
      if (MATH_FONT_RE.test(c.fontName || "") && familyOf(c.fontName) !== ctx.bodyFamily) math++;
    }
    if (!n) return null;
    return {
      chars, paraEnd, x0, y0, x1, y1, n,
      size: modeOf(sizes),
      boldFrac: bold / n,
      mathFrac: math / n,
      baseline: chars.find((c) => !isSpaceCh(c) && c.baseline != null)?.baseline ?? y0,
    };
  }

  // ---- Lines → blocks ---------------------------------------------------------------------------
  function splitBlocks(lines, pageIndex) {
    const blocks = [];
    let cur = null;
    let prev = null;
    for (const ln of lines) {
      let split = !cur;
      if (!split && /^[FT图表]/iu.test(ln.chars[0]?.u || "") && CAPTION_RE.test(joinText([ln])) &&
          CAPTION_RE.test(joinText([cur.lines[0]]))) split = true;
      const runIn = prev && prev.boldFrac >= .8 && ln.boldFrac < .8 &&
        Math.abs(prev.size-ln.size) <= .12*Math.min(prev.size,ln.size) &&
        // A short, separately printed section title can itself be followed
        // by a bold lead-in. Keep the title independent; emphatic words in
        // the next paragraph do not extend the preceding heading.
        !(prev.paraEnd && prev.boldFrac===1 && prev.x1 < ln.x1-2*prev.size && NUMBERED_RE.test(joinText([prev]))) &&
        prev.baseline - ln.baseline >= prev.size * .7 && prev.baseline - ln.baseline <= prev.size * 1.6 &&
        Math.abs(prev.x0 - ln.x0) < prev.size * 1.2 &&
        // A run-in heading shares a physical line with regular prose, either
        // at the tail of the previous line or after its last bold word here.
        ((!isBoldChar(prev.chars.findLast(c => !isSpaceCh(c))) && /^\p{Ll}/u.test(ln.chars.find(c => !isSpaceCh(c)).u)) ||
          isBoldChar(ln.chars.find(c => !isSpaceCh(c))));
      if (!split && prev.paraEnd && !runIn) split = !shouldMerge(prev, ln);
      if (!split && !runIn) {
        const ds = Math.abs(ln.size - prev.size) / Math.min(ln.size, prev.size);
        const boldA = prev.boldFrac >= 0.8, boldB = ln.boldFrac >= 0.8;
        const gap = prev.baseline - ln.baseline;
        const sz = Math.max(ln.size, prev.size);
        if (ds > 0.12) split = true;
        else if (boldA !== boldB && (ln.n > 2 && prev.n > 2)) split = true;
        else if (gap > 2.0 * sz) split = true;
        else if (gap < -0.5 * sz) split = true;
      }
      if (split) {
        cur = { lines: [], pageIndex };
        blocks.push(cur);
      }
      cur.lines.push(ln);
      prev = ln;
    }
    for (const b of blocks) finishBlock(b);
    return blocks;
  }

  // The text layer sometimes ends a paragraph mid-sentence (e.g. a centred two-line note, or a line
  // interrupted by an inline formula). Re-join when the next line clearly continues the sentence.
  function shouldMerge(prev, ln) {
    const first = ln.chars.find((c) => !isSpaceCh(c));
    if (!first) return false;
    if (!/^\p{Ll}/u.test(first.u)) {
      // A wrapped numbered heading is often a pair of PDF paragraphs.
      // Its second line aligns with the first word after the number and
      // uses the very same heading face, including for an uppercase word.
      const word=prev.chars.find(c=>c.rect && /\p{L}/u.test(c.u));
      const heading = word && /^\p{Lu}/u.test(first.u) && /^\d+(?:\.\d+)+\s+\p{Lu}/u.test(joinText([prev])) &&
        (isBoldChar(word) || /ital|obliqu/i.test(word.fontName)) &&
        Math.abs(word.rect[0]-ln.x0) < .45*ln.size &&
        ln.chars.every(c=>isSpaceCh(c) || c.fontName===word.fontName);
      if (!heading) return false;
    }
    const lastText = prev.chars.map((c) => c.u).join("").trim();
    if (!lastText || /[.!?:;。！？：；]$/.test(lastText)) return false;
    if (prev.mathFrac >= 0.4 || ln.mathFrac >= 0.4) return false;
    if (Math.abs(prev.size - ln.size) / Math.min(prev.size, ln.size) > 0.05) return false;
    if ((prev.boldFrac >= 0.8) !== (ln.boldFrac >= 0.8)) return false;
    const gap = prev.baseline - ln.baseline;
    if (gap <= 0 || gap > 1.6 * prev.size) return false;
    const cx = (l) => (l.x0 + l.x1) / 2;
    if (Math.abs(prev.x0 - ln.x0) > 2.5 * prev.size && Math.abs(cx(prev) - cx(ln)) > 2.5 * prev.size) return false;
    return true;
  }

  function finishBlock(b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let n = 0, bold = 0, math = 0;
    const sizes = new Map();
    for (const ln of b.lines) {
      if (ln.x0 < x0) x0 = ln.x0;
      if (ln.y0 < y0) y0 = ln.y0;
      if (ln.x1 > x1) x1 = ln.x1;
      if (ln.y1 > y1) y1 = ln.y1;
      n += ln.n;
      bold += ln.boldFrac * ln.n;
      math += ln.mathFrac * ln.n;
      sizes.set(ln.size, (sizes.get(ln.size) || 0) + ln.n);
    }
    b.x0 = x0; b.y0 = y0; b.x1 = x1; b.y1 = y1;
    b.n = n;
    b.size = modeOf(sizes);
    b.maxSize = Math.max(...b.lines.map((l) => l.size));
    b.boldFrac = bold / n;
    b.mathFrac = math / n;
    b.nLines = b.lines.length;
    b.text = joinText(b.lines);
  }

  function joinText(lines) {
    let out = "";
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      let s = "";
      for (const c of ln.chars) {
        s += c.u;
        if (c.spaceAfter) s += " ";
      }
      s = s.replace(/\s+/g, " ");
      if (li < lines.length - 1) {
        const next = lines[li + 1].chars.find((c) => !isSpaceCh(c));
        const t = s.replace(/\s+$/, "");
        if (/[A-Za-zÀ-ɏ][-‐­]$/.test(t) && next && /^\p{Ll}/u.test(next.u)) {
          s = t.slice(0, -1);
        }
        else s = t + " ";
      }
      out += s;
    }
    return out.replace(/\s+/g, " ").trim();
  }

  // ---- Document-level statistics ----------------------------------------------------------------
  function bodyStats(pages) {
    const sizes = new Map(), fams = new Map();
    for (const p of pages) {
      for (const c of p.chars || []) {
        if (!c || isSpaceCh(c) || (c.rotation && c.rotation !== 0)) continue;
        const s = round1(c.fontSize || 0);
        if (s <= 0) continue;
        sizes.set(s, (sizes.get(s) || 0) + 1);
      }
    }
    const bodySize = modeOf(sizes) || 10;
    for (const p of pages) {
      for (const c of p.chars || []) {
        if (!c || isSpaceCh(c) || Math.abs(round1(c.fontSize || 0) - bodySize) > 0.3) continue;
        const f = familyOf(c.fontName);
        fams.set(f, (fams.get(f) || 0) + 1);
      }
    }
    return { bodySize, bodyFamily: modeOf(fams) || "" };
  }

  const normKey = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

  function isPageNumber(t) {
    t = t.trim();
    if (t.length > 8) return false;
    return /^[-–—\s]*(\d{1,4}|[ivxlcdm]{1,6}|[IVXLCDM]{1,6})[-–—\s]*$/.test(t) || /^(page\s*)?\d{1,4}\s*(of|\/)\s*\d{1,4}$/i.test(t);
  }

  // ---- Main assembly ----------------------------------------------------------------------------
  function buildContentList(pages, {includePublicationNotes = false} = {}) {
    pages = pages || [];
    const stats = bodyStats(pages);
    const { bodySize, bodyFamily } = stats;
    const ctx = { bodyFamily };
    const sorted = pages.slice().sort((a, b) => a.pageIndex - b.pageIndex);

    // 1. blocks per page
    const per = sorted.map((p) => {
      const vb = p.viewBox || [0, 0, 612, 792];
      const lines = buildLines(p.chars || [], ctx);
      const blocks = splitBlocks(lines, p.pageIndex);
      const H = vb[3] - vb[1];
      for (const b of blocks) {
        const cy = ((vb[3] - (b.y0 + b.y1) / 2) - vb[1]) / H; // 0 = top
        b.relTop = (vb[3] - b.y1 - vb[1]) / H;
        b.relBottom = (vb[3] - b.y0 - vb[1]) / H;
        b.band = cy < 0.08 ? "top" : cy > 0.92 ? "bottom" : "";
      }
      return { page: p, vb, blocks };
    });
    const nPages = per.length;

    // 2. headers / footers / page numbers
    const keyPages = new Map(), posPages = new Map();
    for (const pg of per) {
      const seenK = new Set(), seenP = new Set();
      for (const b of pg.blocks) {
        if (!b.band) continue;
        const k = normKey(b.text);
        const pk = `${b.band}|${Math.round(b.x0 / 24)}|${Math.round(b.y0 / 12)}`;
        b.posKey = pk;
        if (!seenK.has(k)) { seenK.add(k); keyPages.set(k, (keyPages.get(k) || 0) + 1); }
        if (!seenP.has(pk)) { seenP.add(pk); posPages.set(pk, (posPages.get(pk) || 0) + 1); }
      }
    }
    for (const pg of per) {
      pg.blocks = pg.blocks.filter((b) => {
        if (!b.text) return false;
        if (!/[^\s\p{P}]/u.test(b.text)) return false;
        if (b.band && isPageNumber(b.text)) return false;
        if (b.band) {
          if (keyPages.get(normKey(b.text)) >= 3) return false;
          if (nPages >= 4 && posPages.get(b.posKey) >= Math.max(3, nPages * 0.6) && b.text.length < 120) return false;
        }
        if (/^arXiv:\d/.test(b.text) && b.nLines <= 2 && b.n < 80) return false;
        return true;
      });
    }

    const items = [];
    for (let pi = 0; pi < per.length; pi++) {
      const pg = per[pi];
      processPage(pg, stats, (pg.page.physicalPageIndex ?? pg.page.pageIndex) === 0, items, includePublicationNotes);
    }
    return items.map((it) => it.item);
  }

  const isAnchor = (b, stats) => {
    if (b.nLines === 1 && b.text.length <= 100 && (NUMBERED_RE.test(b.text) || isSectionName(b.text))
      && /[a-z]{3,}/i.test(b.text) && isHeading(b, stats)) return true;
    // Journal templates often print the abstract in a second typeface.
    // A substantial multi-sentence passage is still a prose boundary.
    const proseInOtherFace = b.nLines >= 3 && b.n >= 180 && /[a-z][.!?]\s+[A-Z]/u.test(b.text);
    if (b.nLines >= 2 && b.n >= 60 && b.size >= stats.bodySize * 0.8 && b.size <= stats.bodySize * 1.25
      && b.mathFrac < 0.4 && (proseInOtherFace || familyOf(b.lines[0].chars[0].fontName) === stats.bodyFamily)) {
      const letters = (b.text.match(/\p{L}/gu) || []).length;
      const digits = (b.text.match(/\d/g) || []).length;
      return letters / b.text.length >= 0.6 && digits / b.text.length < 0.12 && /[a-z]{3,}/.test(b.text);
    }
    return false;
  };
  const overlapX = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

  function numericTableAbove(caption, blocks) {
    const above = [], below = [];
    for (const block of blocks) {
      if (block === caption || block.isCaption || overlapX(block, caption) < (block.x1 - block.x0) * .65) continue;
      for (const line of block.lines) {
        const top = line.y0 - caption.y1, bottom = caption.y0 - line.y1;
        const gap = top >= 0 ? top : bottom;
        if (gap < 0 || gap > 6 * caption.size) continue;
        const separated = line.chars.some((c, i, row) => i && c.rect && row[i - 1].rect &&
          c.rect[0] - row[i - 1].rect[2] > line.size * .65);
        if (!separated) continue;
        const text = line.chars.map(c => c.u + (c.spaceAfter ? " " : "")).join("");
        if ((text.match(/\b\d+(?:\.\d+)?\b|(?:^|\s)[–−-](?=\s|$)/gu) || []).length >= 2)
          (top >= 0 ? above : below).push(gap);
      }
    }
    return above.length >= 2 && Math.min(...above) < caption.size * 3.2 &&
      Math.min(...above) + caption.size * .6 < Math.min(...below);
  }

  function processPage(pg, stats, isFirst, items, includePublicationNotes) {
    const { bodySize } = stats;
    const { vb, blocks } = pg;
    const pageIndex = pg.page.pageIndex;
    const W = vb[2] - vb[0], H = vb[3] - vb[1];
    const caps = blocks.filter((b) => CAPTION_RE.test(b.text) && b.nLines <= 12);
    for (const c of caps) c.isCaption = true;

    // On page one a figure beside the abstract can appear to extend above
    // the author list. Resolve the title before estimating its graphic frame.
    const title = isFirst && blocks.filter(b => !b.isCaption && !isSectionName(b.text) &&
      b.relBottom <= 0.55 && b.nLines <= 4 && b.maxSize >= bodySize * 1.2 &&
      /\p{L}{2,}\s+\p{L}{2,}/u.test(b.text) && !isEquation(b, stats, W))
      .reduce((best, b) => !best || b.maxSize > best.maxSize + 0.05 ? b : best, null);
    const section = title && blocks.find(b => b.y1 <= title.y0 && isSectionName(b.text));
    const anchor = b => isAnchor(b, stats) || b === title ||
      (section && b.y1 <= title.y0 + 1 && b.y0 >= section.y1 - 1);

    // figure / table regions from captions
    const regions = [];
    for (const c of caps) {
      const isTable = TABLE_CAPTION_RE.test(c.text);
      const anchors = blocks.filter((b) => b !== c && (b.isCaption || anchor(b))
        && overlapX(b, c) > 0.3 * Math.min(b.x1 - b.x0, c.x1 - c.x0));
      let y0, y1; // pdf coords (y1 > y0)
      if (isTable && !numericTableAbove(c, blocks)) {
        // region below caption until next anchor below, or page bottom margin
        const below = anchors.filter((b) => b.y1 <= c.y0 + 2).sort((a, b) => b.y1 - a.y1)[0];
        y1 = c.y0 - 1;
        y0 = below ? below.y1 + 2 : vb[1] + 0.07 * H;
        // bottom-of-page footnotes can be anchors; fall back to page margin when region would be empty
      }
      else {
        const above = anchors.filter((b) => b.y0 >= c.y1 - 2).sort((a, b) => a.y0 - b.y0)[0];
        y0 = c.y1 + 1;
        y1 = above ? above.y0 - 2 : vb[3] - 0.07 * H;
      }
      const height = y1 - y0;
      if (height < 2.5 * bodySize) { regions.push({ cap: c, isTable, rect: null }); continue; }
      let x0 = c.x0, x1 = c.x1;
      const inside = blocks.filter((b) => !b.isCaption && b.y0 >= y0 - 1 && b.y1 <= y1 + 1 && overlapX(b, c) > 0 && !anchor(b));
      for (const b of inside) {
        x0 = Math.min(x0, b.x0);
        x1 = Math.max(x1, b.x1);
        b.dropped = true;
      }
      // blocks only partly overlapping horizontally but vertically inside (full-width tables/figures)
      regions.push({ cap: c, isTable, rect: [x0, y0, x1, y1] });
    }
    // second pass: drop blocks fully inside any region (use region x-extents)
    for (const r of regions) {
      if (!r.rect) continue;
      for (const b of blocks) {
        if (b === r.cap || b.isCaption || b.dropped) continue;
        if (b.x0 >= r.rect[0] - 2 && b.x1 <= r.rect[2] + 2 && b.y0 >= r.rect[1] - 1 && b.y1 <= r.rect[3] + 1 && !anchor(b)) b.dropped = true;
      }
    }

    const out = [];
    for (const b of blocks) {
      if (b.dropped) continue;
      const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
      if (bh > 6 * bw && bh > 0.1 * H && (b.x1 < vb[0] + 0.08 * W || b.x0 > vb[2] - 0.08 * W)) continue;
      // small fragments (figure labels, axis ticks) that are not footnotes
      if (!b.isCaption && b.size < bodySize * 0.85 && b.n < 40 && b.relBottom < 0.8) continue;
      let it = null;
      if (b.isCaption) {
        const reg = regions.find((r) => r.cap === b);
        const rect = reg && reg.rect ? [Math.min(b.x0, reg.rect[0]), Math.min(b.y0, reg.rect[1]), Math.max(b.x1, reg.rect[2]), Math.max(b.y1, reg.rect[3])] : [b.x0, b.y0, b.x1, b.y1];
        const bbox = toBBox(rect, vb);
        if (reg && reg.isTable) it = { type: "table", img_path: "", table_caption: [b.text], table_body: "", table_footnote: [], bbox, page_idx: pageIndex };
        else it = { type: "image", img_path: "", image_caption: [b.text], image_footnote: [], bbox, page_idx: pageIndex };
      }
      else if (isEquation(b, stats, W)) {
        it = { type: "equation", text: b.text, text_format: "text", bbox: toBBox([b.x0, b.y0, b.x1, b.y1], vb), page_idx: pageIndex };
      }
      else {
        const lvl = isHeading(b, stats) ? 1 : 0;
        it = { type: "text", text: b.text, bbox: toBBox([b.x0, b.y0, b.x1, b.y1], vb), page_idx: pageIndex };
        if (lvl) { it.text_level = 1; b.heading = true; }
      }
      out.push({ item: it, block: b });
    }

    // pieces of one display equation (numerator / denominator / equation number) → one item
    for (let i = out.length - 1; i > 0; i--) {
      const a = out[i - 1], b = out[i];
      if (a.item.type !== "equation" || b.item.type !== "equation") continue;
      const A = a.block, B = b.block;
      const near = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) > -0.5 * bodySize && Math.abs(A.y0 - B.y0) < 3 * bodySize;
      if (!near) continue;
      const rect = [Math.min(A.x0, B.x0), Math.min(A.y0, B.y0), Math.max(A.x1, B.x1), Math.max(A.y1, B.y1)];
      Object.assign(A, { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3], text: `${A.text} ${B.text}` });
      a.item.text = A.text;
      a.item.bbox = toBBox(rect, vb);
      out.splice(i, 1);
    }
    // front matter (authors, affiliations, emails) between the title and the first section is plain text
    if (isFirst) {
      const secIdx = out.findIndex((o) => o.item.type === "text" && isSectionName(o.block.text));
      if (secIdx > 0) for (let i = 0; i < secIdx; i++) delete out[i].item.text_level;
    }
    // paper title: largest-font block in the upper half of page one
    if (isFirst) {
      let best = out.find(o => o.block === title);
      if (!best) for (const o of out) {
        const b = o.block;
        if (o.item.type !== "text" || b.relBottom > 0.55 || b.nLines > 4) continue;
        if (!best || b.maxSize > best.block.maxSize + 0.05) best = o;
      }
      if (best && best.block.maxSize >= bodySize * 1.2) best.item.text_level = 1;
    }
    if (isFirst) mergeFrontMatter(out, includePublicationNotes);
    for (const o of out) items.push(o);
  }

  // First page: drop permission/copyright notices above the title (other pre-title text moves after it),
  // and merge the author / affiliation grid between the title and the first section into one block.
  function mergeFrontMatter(out, includePublicationNotes) {
    const titleIdx = out.findIndex((o) => o.item.text_level === 1);
    if (titleIdx < 0) return;
    const pre = out.splice(0, titleIdx);
    const keep = pre.filter((o) => {
      if (o.item.type !== "text" || !/permission|copyright|licen[cs]e|©/i.test(o.item.text)) return true;
      if (includePublicationNotes) o.item.type = "header";
      return includePublicationNotes;
    });
    out.splice(1, 0, ...keep);
    const secIdx = out.findIndex((o, i) => i > 0 && o.item.type === "text" && isSectionName(o.block.text));
    if (secIdx < 0) return;
    const cand = [];
    for (let i = 1; i < secIdx; i++) {
      const it = out[i].item;
      if (it.type === "text" && !it.text_level && it.text.length <= 300 && !keep.some((k) => k === out[i])) cand.push(i);
    }
    if (cand.length < 2) return;
    const first = out[cand[0]].item;
    const texts = cand.map((i) => out[i].item.text);
    const bb = cand.map((i) => out[i].item.bbox);
    first.text = texts.join(" · ");
    first.bbox = [Math.min(...bb.map((b) => b[0])), Math.min(...bb.map((b) => b[1])), Math.max(...bb.map((b) => b[2])), Math.max(...bb.map((b) => b[3]))];
    for (let k = cand.length - 1; k >= 1; k--) out.splice(cand[k], 1);
  }

  function toBBox(r, vb) {
    const w = vb[2] - vb[0], h = vb[3] - vb[1];
    const cl = (v) => Math.max(0, Math.min(1000, Math.round(v)));
    return [
      cl((r[0] - vb[0]) / w * 1000),
      cl((vb[3] - r[3]) / h * 1000),
      cl((r[2] - vb[0]) / w * 1000),
      cl((vb[3] - r[1]) / h * 1000),
    ];
  }

  function isEquation(b, stats, W) {
    if (b.n > 400 || b.nLines > 6) return false;
    if (b.mathFrac >= 0.4) {
      // running text with some math fonts: require few real words
      const words = b.text.split(/\s+/).filter((w) => /^\p{L}{4,}$/u.test(w)).length;
      if (words <= 6 || b.mathFrac >= 0.6) return true;
    }
    if (/\(\d+(?:\.\d+)?\)\s*$/.test(b.text) && b.nLines <= 3 && b.text.length <= 140) {
      const words = b.text.split(/\s+/).filter((w) => /^\p{L}{4,}$/u.test(w)).length;
      if (b.mathFrac >= 0.15 || words <= 3) return true;
    }
    return false;
  }

  function isSectionName(t) {
    const stripped = t.replace(/^(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s*/u, "").trim();
    return t.length <= 40 && SECTION_NAMES.has(stripped.toLowerCase().replace(/[.:：]$/, ""));
  }

  function isHeading(b, stats) {
    const t = b.text;
    const { bodySize } = stats;
    if (b.nLines > 2 || t.length > 150 || t.length < 2) return false;
    const stripped = t.replace(/^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[A-Z]\.|第.{1,3}[章节])\s*/u, "").trim();
    const known = SECTION_NAMES.has(stripped.toLowerCase().replace(/[.:：]$/, ""));
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters < 2 || letters / t.length < 0.5) return false;
    if (/[,;:]$/.test(t)) return false;
    if (/[.!?。]$/.test(t) && !/^\d+(\.\d+)*\.$/.test(t) && !known) return false;
    if (known && b.nLines === 1 && stripped.length === t.replace(/[.:：]$/, "").length - (t.length - stripped.length) + 0 && true) {
      if (t.length <= 40) return true;
    }
    const big = b.size >= bodySize * 1.12;
    const bold = b.boldFrac >= 0.8;
    if (b.mathFrac > 0.3) return false;
    if (big || bold) return /^\p{Lu}|^\d|^[一-鿿]/u.test(t);
    if (NUMBERED_RE.test(t) && (bold || big)) return true;
    return false;
  }

  // ---- Markdown ---------------------------------------------------------------------------------
  function toMarkdown(contentList) {
    const parts = [];
    for (const it of contentList) {
      if (it.type === "text") parts.push(it.text_level ? `${"#".repeat(it.text_level)} ${it.text}` : it.text);
      else if (it.type === "equation") parts.push(`$$${it.text}$$`);
      else if (it.type === "image") parts.push((it.image_caption || []).map((c) => `*${c}*`).join("\n"));
      else if (it.type === "table") parts.push((it.table_caption || []).map((c) => `*${c}*`).join("\n"));
    }
    return parts.filter(Boolean).join("\n\n") + "\n";
  }

  // ---- Entry point ------------------------------------------------------------------------------
  async function parse({ pdfApp, onStatus, signal } = {}) {
    if (!pdfApp || !pdfApp.pdfDocument) throw new Error("PDF reader is not ready");
    const doc = pdfApp.pdfDocument;
    const total = doc.numPages;
    const pages = [];
    const abortIfNeeded = () => {
      if (signal && signal.aborted) {
        const e = new Error("Aborted");
        e.name = "AbortError";
        throw e;
      }
    };
    for (let i = 0; i < total; i++) {
      abortIfNeeded();
      const d = await doc.getPageData({ pageIndex: i });
      pages.push({ pageIndex: i, physicalPageIndex: (pdfApp.firstPhysicalPage || 0) + i, viewBox: Array.from(d.viewBox || [0, 0, 612, 792]), chars: d.chars || [] });
      if (onStatus && (i % 3 === 2 || i === total - 1)) {
        onStatus({ phase: "running", message: `Reading text layer ${i + 1}/${total}`, extractedPages: i + 1, totalPages: total });
      }
    }
    abortIfNeeded();
    const contentList = buildContentList(pages);
    return { contentList, markdown: toMarkdown(contentList) };
  }

  // Older built-in parses may have absorbed a differently typeset abstract
  // into the first figure. Recover the missing blocks and keep the figure ID.
  function restoreCachedParagraphs(items, page) {
    let fresh;
    const reparse = () => fresh ||= buildContentList([{pageIndex:page.index, viewBox:page.view, chars:page.chars}],
      {includePublicationNotes:true});
    // A previously separate bold line may share its baseline with the first
    // plain words of a paragraph. Require an exact contiguous text match.
    const repaired = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i], next = items[i+1];
      if (item.type==="text" && !item.text_level && item.bbox && NUMBERED_RE.test(item.text || "")) {
        const physical=reparse();
        const index=physical.findIndex((title,j)=>{
          const body=physical[j+1];
          return title.type==="text" && title.text_level && body?.type==="text" && !body.text_level &&
            title.text+" "+body.text===item.text && [title,body].every(it=>it.bbox?.every((v,k)=>
              k<2 ? v>=item.bbox[k]-2 : v<=item.bbox[k]+2));
        });
        if (index>=0) {
          repaired.push({...physical[index],id:item.id}, {...physical[index+1],id:"native-heading-body-"+page.index+"-"+index});
          continue;
        }
      }
      if (item.type === "text" && next?.type === "text" && /^abstract\s*[—–:.-]\s*\S/iu.test(item.text)) {
        const whole = reparse().find(it => it.type === "text" && it.text.startsWith(item.text+" "));
        if (whole) {
          let joined=item.text, j=i;
          while (items[j+1]?.type === "text" && whole.text.startsWith(joined+" "+items[j+1].text))
            joined += " "+items[++j].text;
          if (joined === whole.text) {
            repaired.push({...whole,id:item.id});
            i=j;
            continue;
          }
        }
      }
      if (item.text_level && next?.type === "text") {
        if (page.index===0 && item.text_level===1 && !next.text_level && item.bbox && next.bbox) {
          const printed=reparse(), compact=text=>text.replace(/[\s·]+/gu,"");
          const index=printed.findIndex((title,j)=>{
            const byline=printed[j+1];
            return title.type==="text" && title.text_level===1 && byline?.type==="text" && !byline.text_level &&
              item.text.startsWith(title.text+" ") && title.bbox?.every((v,k)=>
                k<2 ? v>=item.bbox[k]-2 : v<=item.bbox[k]+2) &&
              compact(title.text+byline.text)===compact(item.text+next.text);
          });
          if (index>=0) {
            repaired.push({...printed[index],id:item.id},{...printed[index+1],id:next.id});
            i++;
            continue;
          }
        }
        const merged = reparse().find(it => !!it.text_level === !!next.text_level && it.text === item.text+" "+next.text);
        if (merged) {
          repaired.push({...merged,id:item.id});
          i++;
          continue;
        }
      }
      repaired.push(item);
    }
    items = repaired;
    const cachedTables = items.filter(it => it.type === "table" && it.table_caption?.length && !it.table_body && it.bbox);
    for (const old of cachedTables) {
      const parsed = reparse();
      const sameCaption = parsed.filter(it => it.type === "table" && it.table_caption?.join(" ") === old.table_caption.join(" "));
      if (sameCaption.length !== 1) continue;
      const [table] = sameCaption;
      if (!table.bbox.some((v, i) => Math.abs(v - old.bbox[i]) > 15)) continue;
      const inside = (it, box) => it.type === "text" && it.bbox &&
        it.bbox[0] >= box[0]-2 && it.bbox[1] >= box[1]-2 &&
        it.bbox[2] <= box[2]+2 && it.bbox[3] <= box[3]+2;
      const belongs = (it, list) => list.some(item => item.type === "text" && item.text === it.text &&
        item.bbox?.every((v, i) => Math.abs(v-it.bbox[i]) <= 2));
      // Reconcile only the area whose ownership changed. Old table cells
      // are recovered from the physical glyph grid; displaced prose keeps
      // its position before or after the caption in PDF reading order.
      const restore = it => inside(it, old.bbox) && !inside(it, table.bbox) && !belongs(it, items);
      const ti = parsed.indexOf(table);
      const recover = rows => rows.filter(restore).map(it => ({...it,id:"native-table-text-"+page.index+"-"+parsed.indexOf(it)}));
      items = items.flatMap(it => it === old ? [
        ...recover(parsed.slice(0,ti)), {...old,bbox:table.bbox}, ...recover(parsed.slice(ti+1))
      ] : inside(it, table.bbox) && !belongs(it, parsed) ? [] : [it]);
    }
    // An older figure region can swallow a neighbouring caption entirely.
    // Recover physically printed captions together with their corrected bounds.
    const caption = it => it.image_caption?.[0] || it.table_caption?.[0];
    if (items.some(caption)) {
      const graphics = reparse().filter(caption);
      // A full-width figure caption and the next column's table caption can
      // share a PDF paragraph marker. Upgrade only an exact two-caption match.
      items = items.flatMap(old => {
        const combined = caption(old);
        if (!combined) return [old];
        const first = graphics.find(g => combined.startsWith(caption(g) + " "));
        const second = first && graphics.find(g => caption(g) === combined.slice(caption(first).length + 1));
        return second ? [{...first,id:old.id}, {...second,id:"native-caption-"+page.index+"-"+graphics.indexOf(second)}] : [old];
      });
      for (const g of graphics) {
        const label = caption(g);
        if (items.some(it => (caption(it) || it.text) === label)) continue;
        const shorter = items.find(it => caption(it)?.length > 20 && label.startsWith(caption(it)+" "));
        if (shorter) {
          const tail = label.slice(caption(shorter).length).trim();
          items = items.filter(it => !(it.type === "text" && tail.includes(it.text) && it.bbox &&
            it.bbox.every((v,i) => i < 2 ? v >= g.bbox[i]-2 : v <= g.bbox[i]+2)));
          items[items.indexOf(shorter)] = {...shorter,...g,id:shorter.id};
        } else if (!items.some(it => caption(it)?.startsWith(label+" "))) {
          items.push({...g,id:"native-caption-"+items.length});
        }
      }
      const corrected = new Map(graphics.map(g => [caption(g),g.bbox]));
      items = items.map(it => it.type === "image" && corrected.has(caption(it)) ? {...it,bbox:corrected.get(caption(it))} : it);
    }
    if (page.index !== 0) return items;
    for (const note of reparse().filter(it => it.type === "header")) {
      if (!items.some(it => it.text === note.text)) items.push({...note,id:"native-notice-"+items.length});
    }
    const heading = items.findIndex(it => /^\s*abstract\s*$/iu.test(it.text || ""));
    const oldFigure = items[heading+1];
    if (heading < 0 || oldFigure?.type !== "image" || !oldFigure.image_caption?.length) return items;
    reparse();
    const start = fresh.findIndex(it => /^abstract$/iu.test(it.text?.trim() || ""));
    const end = fresh.findIndex(it => it.image_caption?.[0] === oldFigure.image_caption[0]);
    if (start < 0 || end <= start+1) return items;
    const recovered = fresh.slice(start+1,end);
    if (!recovered.every(it => it.type === "text") || !recovered.some(it => it.text.length > 150)) return items;
    return [
      ...items.slice(0,heading+1),
      ...recovered.map((item,i) => ({...item,id:"native-abstract-"+i})),
      {...oldFigure,bbox:fresh[end].bbox},
      ...items.slice(heading+2)
    ];
  }
  DeepRead.TextLayerParser = { parse, buildContentList, restoreCachedParagraphs, toMarkdown };
})();
