/* Recover physical text frames from the PDF when a parser has flattened them. */
(function () {
  const glyph = (c) => c.u ?? c.c ?? "";
  const norm = (s) => DeepRead.ParallelInline.geometryText(s);
  const union = (chars) => DeepRead.Overlay.unionRect(chars.map((c) => c.rect));
  const text = (run) =>
    run
      .map((c) => glyph(c) + (c.spaceAfter || c.lineBreakAfter || c.paragraphBreakAfter ? " " : ""))
      .join("")
      .trim();
  const breaks = (c) => c.lineBreakAfter || c.paragraphBreakAfter;

  // PDF.js sometimes ends a line between a superscript and a subscript at
  // the same x position. Both are smaller than the adjacent baseline text.
  function repairScripts(chars) {
    let result = chars;
    for (let i = 1; i < chars.length; i++) {
      const a = chars[i - 1],
        b = chars[i],
        em = Math.max(a.fontSize, b.fontSize);
      if (!breaks(a) || !a.rect || !b.rect || a.rotation || b.rotation || !em) continue;
      const dx = b.rect[0] - a.rect[2],
        dy = a.baseline - b.baseline;
      if (dx > em * 0.3 || dx < -4.5 * em || dy < 0.35 * em || dy > 1.65 * em) continue;
      const limit =
        /CMEX|Extension/iu.test(a.fontName || "") && b.fontSize < a.fontSize * 0.82 && Math.abs(dx) < em * 0.65;
      const base =
        limit ||
        chars
          .slice(Math.max(0, i - 9), i + 10)
          .some((c) => c.fontSize > em * 1.2 && Math.abs(c.baseline - (a.baseline + b.baseline) / 2) < em);
      if (!base) continue;
      if (result === chars) result = chars.slice();
      result[i - 1] = {
        ...result[i - 1],
        lineBreakAfter: false,
        paragraphBreakAfter: false,
        spaceAfter: false
      };
      result[i] = { ...result[i], scriptContinuation: true };
    }
    return result;
  }

  function recover(items, chars, view) {
    const replaced = new Set(),
      additions = [];
    const tableBounds = [];
    if (!chars.length || !items.length) return { items, replaced, tableBounds };
    let printed = "",
      line = [];
    const offsets = [],
      rows = [];
    chars.forEach((c, i) => {
      const letters = norm(glyph(c));
      printed += letters;
      for (let j = 0; j < letters.length; j++) offsets.push(i);
      if (c.rect && !c.rotation && !c.diagonal) line.push(c);
      if (breaks(c) && line.length) {
        rows.push(line);
        line = [];
      }
    });
    if (line.length) rows.push(line);
    const ids = new Map(chars.map((c, i) => [c, i]));
    function locate(item) {
      const key = norm(item.text);
      if (!key || !item.bbox) return null;
      let hit = -1,
        found = null;
      while ((hit = printed.indexOf(key, hit + 1)) !== -1) {
        const start = offsets[hit],
          end = offsets[hit + key.length - 1] + 1;
        const first = chars[start].rect,
          last = chars[end - 1].rect;
        if (!first || !last) continue;
        const [l, t, r, b] = item.bbox;
        const inside = (g) => {
          const x = (((g[0] + g[2]) / 2 - view[0]) * 1000) / (view[2] - view[0]);
          const y = ((view[3] - (g[1] + g[3]) / 2) * 1000) / (view[3] - view[1]);
          return x >= l - 3 && x <= r + 3 && y >= t - 3 && y <= b + 3;
        };
        if (!inside(first) || !inside(last)) continue;
        if (found) return null;
        found = { start, end };
      }
      return found;
    }

    const streams = items.map((it, i) => {
      if (
        !["text", "equation", "list"].includes(it.type) ||
        !it.text ||
        it.physicalParts ||
        it.parentId != null
      )
        return null;
      const span = locate(it);
      return span && { ...span, item: it, id: it.id ?? `item:${i}` };
    });
    function boxFor(run) {
      const rect = union(run),
        [l, b, r, t] = view;
      return [
        ((rect[0] - l) / (r - l)) * 1000,
        ((t - rect[3]) / (t - b)) * 1000,
        ((rect[2] - l) / (r - l)) * 1000,
        ((t - rect[1]) / (t - b)) * 1000
      ];
    }
    function addFrame(run, original, role, suffix) {
      const frame = {
        type: role,
        text: text(run),
        page_idx: original.page_idx,
        id: original.id + ":physical:" + suffix,
        layoutPart:suffix.startsWith("contents-")?"contents":suffix.startsWith("algorithm-")?"algorithm":undefined,
        bbox: boxFor(run),
        inlineGlyphs: run
      };
      additions.push(frame);
      return frame;
    }

    const regionOf = (box) => [
      view[0] + (box[0] * (view[2] - view[0])) / 1000,
      view[3] - (box[3] * (view[3] - view[1])) / 1000,
      view[0] + (box[2] * (view[2] - view[0])) / 1000,
      view[3] - (box[1] * (view[3] - view[1])) / 1000
    ];
    const splitCells = (row, columnStarts = [], numericStarts) => {
      const cells = [];
      for (const c of row) {
        if (!glyph(c).trim()) continue;
        const prev = cells.at(-1)?.at(-1);
        const space = prev ? c.rect[0] - prev.rect[2] : 0;
        if (!prev || numericStarts?.has(c) || space > Math.max(c.fontSize, prev.fontSize) * 0.78 ||
            (space > c.fontSize * .2 && columnStarts.some(x => Math.abs(c.rect[0] - x) < c.fontSize * .15))) cells.push([]);
        else if (ids.get(c) > ids.get(prev) + 1) {
          const between = chars.slice(ids.get(prev) + 1, ids.get(c));
          if (between.every((g) => !glyph(g).trim())) cells.at(-1).push(...between);
        }
        cells.at(-1).push(c);
      }
      return cells;
    };
    const numberCell = s => /^[+−–—-]?(?:\d[\d.,/%×±−–-]*k?|[−–—-])$/iu.test(s.trim());
    const scoringModel = cells => cells.length >= 5 && /\b(?:low|medium|high|xhigh|max)$/u.test(text(cells[0])) &&
      /[A-Z][\w-]*\d|\b\d+[.\d-]*/u.test(text(cells[0])) && cells.filter(c => numberCell(text(c))).length >= 3;
    function splitTableCells(row, guides) {
      // Dense numerical tables separate values by a normal word space. Keep
      // a suffix of three or more printed measurements as individual fields.
      const words = [];
      let prev;
      for (const c of row) {
        if (!glyph(c).trim()) { prev = null; continue; }
        if (!prev || prev.spaceAfter || breaks(prev) || c.rect[0] - prev.rect[2] > c.fontSize*.2) words.push([]);
        words.at(-1).push(c);
        prev = c;
      }
      let start = words.length;
      while (start > 0 && numberCell(text(words[start-1]))) start--;
      const starts = words.length - start >= 3 ? new Set(words.slice(start).map(word => word[0])) : undefined;
      return splitCells(row, guides, starts);
    }
    function linedUp(a, b, inKnownTable = false) {
      if (!a || !b || a.cells.length < 3 || b.cells.length < 3) return false;
      const em = a.row[0].fontSize || 9;
      if (Math.abs(a.row[0].rect[1] - b.row[0].rect[1]) > em * 2.7) return false;
      const positions = (r) =>
        r.cells.map((cell) => {
          const a = cell[0].rect[0],
            z = cell.at(-1).rect[2];
          return [a, (a + z) / 2, z];
        });
      const aa = positions(a),
        bb = positions(b);
      const aligned = aa.filter((p) => bb.some((q) => p.some((v, i) => Math.abs(v - q[i]) < em * 0.95))).length;
      const gutters = aa.filter((p, i) => i && p[0] - aa[i - 1][2] > em * 2).length;
      // A narrow row-number column has a smaller first gutter than data columns.
      const numbered =
        /^\d+[.)]?$|^#$/u.test(text(a.cells[0])) &&
        /^\d+[.)]?$|^#$/u.test(text(b.cells[0])) &&
        aa[1][0] - aa[0][2] > em * 0.75;
      return aligned >= 3 && (inKnownTable || gutters >= 2 || (gutters >= 1 && numbered));
    }
    const printedRows = DeepRead.ParallelVisual.lines(chars);
    const claimedLabels = new Set();

    recoverAlgorithms();
    recoverContents();
    recoverPrintedLabels();
    recoverListingNotes();
    recoverTables();
    recoverMissingTableHeadings();
    recoverFigureLabels();
    recoverEquationNotes();
    splitWrappedParagraphs();
    joinInlineFormulas();
    // Some narrow headers print "Pick &" and "Place" on successive
    // baselines. Neither half has its own column or translation.
    for (const head of additions.filter(it => it.type === "table_label" && /\s(?:&|and|or|of)$/iu.test(it.text))) {
      const r = union(head.inlineGlyphs), em = head.inlineGlyphs[0].fontSize;
      const tails = additions.filter(it => {
        if (it === head || it.type !== "table_label" || it.visualOwner !== head.visualOwner ||
            !/^[\p{L}][\p{L}\p{N} -]{0,30}$/u.test(it.text)) return false;
        const b = union(it.inlineGlyphs);
        return r[3] > b[3] + em * .55 && r[3] - b[3] < em * 1.55 &&
          Math.abs(r[0]+r[2]-b[0]-b[2]) < em;
      });
      if (tails.length !== 1) continue;
      const [tail] = tails;
      head.text += " " + tail.text;
      head.inlineGlyphs = [...head.inlineGlyphs.slice(0,-1), {...head.inlineGlyphs.at(-1), lineBreakAfter:true}, ...tail.inlineGlyphs];
      head.bbox = boxFor(head.inlineGlyphs);
      additions.splice(additions.indexOf(tail),1);
    }
    const pairs = additions.filter(it=>it.type==="table_label" && /^[a-z]{2}[-–][a-z]{2}$/u.test(it.text));
    for (const cell of pairs) {
      const first = cell.inlineGlyphs[0];
      cell.languagePairs = pairs.some(other => other !== cell && other.visualOwner === cell.visualOwner &&
        Math.abs(other.inlineGlyphs[0].rect[1] - first.rect[1]) < first.fontSize*.4);
    }
    return {
      items: items.filter((it, i) => !replaced.has(it.id ?? `item:${i}`)).concat(additions),
      replaced,
      tableBounds
    };

    function recoverAlgorithms() {
      // In a numbered algorithm, code and comments share a baseline. Preserve
      // the instructions and formula ink, and give explanatory text its own box.
      const afterText = (run, offset) => {
        let pos = 0;
        return run.filter((c) => {
          const start = pos;
          pos += glyph(c).length + (c.spaceAfter || breaks(c) ? 1 : 0);
          return start >= offset;
        });
      };
      for (const caption of items.filter((it) => it.bbox && /^Algorithm\s+\d+\s+\p{Lu}/u.test(it.text || ""))) {
        const box = regionOf(caption.bbox),
          em = chars.find((c) => c.rect && Math.abs(c.rect[3] - box[3]) < 1)?.fontSize || 10;
        const sequence = [];
        let next = 1,
          previous = box[1],
          prelude = [];
        for (const row of rows) {
          const rect = union(row);
          if (rect[3] > box[1] + 1) continue;
          if (previous - rect[3] > em * 2.8 || rect[3] > previous + em * 2) break;
          const lineText = text(row),
            m = /^(\d{1,3}):\s*/u.exec(lineText);
          if (m && Number(m[1]) === next) {
            sequence.push({ rows: [row], prefix: m[0].length });
            next++;
          } else if (!sequence.length) {
            if (!prelude.length && !/^(?:Require|Ensure|Inputs?|Outputs?):/iu.test(lineText)) break;
            prelude.push(row);
          } else {
            const firstStep = sequence[0].rows[0][0].rect[0];
            if (
              m ||
              /^\p{Lu}[.\s]+\p{Lu}/u.test(lineText) ||
              (rect[0] <= firstStep + em * 0.5 && /^\p{Lu}\p{Ll}{1,}\s/u.test(lineText))
            )
              break;
            sequence.at(-1).rows.push(row);
          }
          previous = rect[1];
        }
        if (sequence.length < 4) continue;
        const top = prelude.length ? union(prelude[0])[3] : union(sequence[0].rows[0])[3];
        const last = union(sequence.at(-1).rows.at(-1))[1];
        const owned = items.filter(
          (it) =>
            it !== caption &&
            it.bbox &&
            ["text", "equation"].includes(it.type) &&
            regionOf(it.bbox)[3] <= top + 2 &&
            regionOf(it.bbox)[1] >= last - 2
        );
        if (!owned.length) continue;
        owned.forEach((it) => replaced.add(it.id ?? `item:${items.indexOf(it)}`));
        if (prelude.length) addFrame(prelude.flat(), caption, "text", "algorithm-input");
        for (const [i, line] of sequence.entries()) {
          const run = afterText(line.rows.flat(), line.prefix),
            body = text(run),
            mark = body.indexOf("▷");
          const pure = /^(?:(?:end\s+)?(?:for|if|while)\b|return\b)/iu.test(body);
          const note = mark >= 0 ? afterText(run, mark + 1) : null;
          if (note?.length) addFrame(note, caption, "text", "algorithm-comment-" + i);
          if (pure) {
            const loop = /^for each(?: [a-z-]+)+(?=\s+[(A-Z])/u.exec(body);
            if (loop) {
              const tail = afterText(run, loop[0].length);
              const prefix = tail.length ? run.slice(0, run.indexOf(tail[0])) : run;
              if (prefix.length) addFrame(prefix, caption, "algorithm_step", "algorithm-loop-" + i);
            }
            continue;
          }
          const main = note ? run.slice(0, run.indexOf(note[0]) - 1) : run;
          const prose = text(main).replace(/\b(?:state|repeat|for all|return|mean|std)\b/giu, "");
          if (main.length && /[A-Za-z]{3,}/u.test(prose))
            addFrame(main, caption, "algorithm_step", "algorithm-step-" + i);
        }
      }
    }

    function recoverContents() {
      // Keep section numbers, dot leaders and destination page numbers as
      // original ink. Require several destinations aligned at the right edge.
      const entries = [];
      for (const row of rows) {
        const s = text(row);
        const entry = /^(?:((?:[A-Z]|[IVXLCDM]+|\d+)(?:\.\d+)*\.?)\s+)?(.+?)\s+(\d{1,4})$/u.exec(s);
        if (!entry || !/[a-z]{2}/iu.test(entry[2]) || !row.at(-1).rect) continue;
        const label = entry[2].replace(/(?:\s*[.·…]){3,}\s*$/u, "").trim();
        if (!label || label.length > 185) continue;
        const titleStart = s.indexOf(label, entry[1]?.length || 0);
        let at = 0;
        const run = row.filter((c) => {
          const begin = at;
          at += glyph(c).length + (c.spaceAfter || breaks(c) ? 1 : 0);
          return begin < titleStart + label.length && begin + glyph(c).length > titleStart;
        });
        if (!run.length) continue;
        const dots = label !== entry[2].trim();
        const pageStart = row.at(-entry[3].length);
        if (!entry[1] && !dots && pageStart.rect[0] - run.at(-1).rect[2] < pageStart.fontSize * 2) continue;
        entries.push({ row, run, right: row.at(-1).rect[2], numberedLeaders: !!entry[1] && dots });
      }
      const toc = entries.filter(
        (e) => entries.filter((other) => Math.abs(e.right - other.right) < 5 && other.numberedLeaders).length >= 2
      );
      const covered = new Map();
      for (const e of toc) for (const c of e.row) covered.set(c, e);
      for (const s of streams) {
        if (!s) continue;
        const ink = chars.slice(s.start, s.end).filter((c) => norm(glyph(c)));
        if (!ink.length || !ink.every((c) => covered.has(c))) continue;
        const matches = [...new Set(ink.map((c) => covered.get(c)))];
        // An actual section heading following the contents is a separate frame.
        if (!matches.every((e) => s.start <= ids.get(e.row[0]) + 2 && s.end >= ids.get(e.row.at(-1)) - 2))
          continue;
        replaced.add(s.id);
        for (const e of matches) {
          const frame = addFrame(e.run, s.item, "text", "contents-" + ids.get(e.row[0]));
          const punctuation = e.row.slice(e.row.indexOf(e.run.at(-1)) + 1).filter(c => /^[.·…]$/u.test(glyph(c)));
          if (punctuation.length < 3) continue;
          const [a,b,c] = punctuation.map(g => g.rect);
          const pitch = b[0] - a[0];
          if (pitch > a[2] - a[0] && Math.abs(c[0] - b[0] - pitch) < .5)
            frame.contentsLeader = {dot:a,pitch};
        }
      }
    }

    function recoverPrintedLabels() {
      for (const s of streams) {
        if (!s || s.item.type !== "text" || replaced.has(s.id)) continue;
        const legend = /[A-Za-z][\w -]{2,}:\s*[A-Za-z]\s*=/.test(s.item.text);
        const spelling = /(?:\b[a-z] +){5,}/iu.test(s.item.text);
        if (!legend && !spelling) continue;
        const owned = rows.filter((row) => ids.get(row[0]) >= s.start - 2 && ids.get(row.at(-1)) < s.end + 3);
        if (!owned.length || norm(owned.map(text).join(" ")) !== norm(s.item.text)) continue;
        let labels;
        if (legend) {
          labels = owned.map((row) => {
            const at = row.findIndex((c) => glyph(c) === ":");
            return at > 0 &&
              /^[A-Za-z][A-Za-z -]{1,42}$/u.test(text(row.slice(0, at))) &&
              /=/u.test(text(row.slice(at + 1)))
              ? row.slice(0, at)
              : [];
          });
        } else {
          const cells = owned.map(row => splitCells(row));
          if (
            cells.length < 2 ||
            cells.some((c) => c.length < 2 || Math.abs(c[1][0].rect[0] - cells[0][1][0].rect[0]) > 4)
          )
            continue;
          labels = cells.map((c) => c[0]);
        }
        if (labels.some((run) => !run.length)) continue;
        replaced.add(s.id);
        for (const run of labels) {
          addFrame(run, s.item, legend ? "figure_label" : "table_label", "literal-label-" + ids.get(run[0]));
          run.forEach((c) => claimedLabels.add(c));
        }
      }
    }

    function recoverListingNotes() {
      const captions = items.filter(it => it.bbox && /^Listing\s+\d+[.:]/iu.test(it.text || ""));
      if (!captions.length) return;
      for (const row of rows) {
        const marker = row.findIndex(c => glyph(c) === "#");
        if (marker < 1 || !/^\d{1,3}$/u.test(text(row.slice(0,marker))) || !/[a-z]{2}/iu.test(text(row.slice(marker+1)))) continue;
        const glyphs = row.slice(marker+1).filter(c => glyph(c).trim());
        const r = union(glyphs), em = glyphs[0].fontSize;
        const owner = streams.find(s => s?.item.type === "equation" && ids.get(row[marker]) >= s.start &&
          ids.get(glyphs.at(-1)) < s.end+2);
        if (!owner || !captions.some(it => {
          const b = regionOf(it.bbox);
          return r[1] > b[3] && r[1]-b[3] < em*24 && r[0] < b[2] && r[2] > b[0];
        })) continue;
        const run = glyphs.map((c,i) => ({...c,spaceAfter:c.spaceAfter &&
          i+1<glyphs.length && glyphs[i+1].rect[0]-c.rect[2] > em*.3}));
        const note = addFrame(run,owner.item,"code_comment","comment-"+ids.get(glyphs[0]));
        note.visualOwner = owner.id;
        note.flushLeft = true;
      }
    }

    function recoverTables() {
      // Tables flattened by the text-layer parser lose every column boundary.
      // Identify a grid using repeated alignment across adjacent physical rows.
      // A table caption followed by a run of aligned columns is also strong
      // evidence when PDF reading order jumps from one cell to the next.
      const tableCaptions = items.filter(
        it => it.bbox && ((it.type === "text" && /^Table\s+(?:\d+\b|[IVXLCDM]+[.:])/iu.test(it.text)) ||
          (it.type === "table" && !it.table_body && it.table_caption?.length))
      );
      const headings = new Map();
      for (const s of streams) {
        if (!s || !s.item.text_level || replaced.has(s.id)) continue;
        const complete = DeepRead.Typography.match(chars.slice(s.start,s.end+8),s.item.text);
        const lines = DeepRead.ParallelVisual.lines(complete || chars.slice(s.start,s.end));
        if (lines.length !== 1 || !lines[0].every(DeepRead.Typography.bold)) continue;
        const cells = splitCells(lines[0]);
        if (cells.length < 3 || cells.some(cell => !/\p{L}/u.test(text(cell)))) continue;
        // An uncaptioned table needs stronger evidence than a heading with
        // gaps: the rows below must start on the same three column guides.
        headings.set(s.item,cells);
        tableCaptions.push(s.item);
      }
      for (const caption of tableCaptions) {
        if (replaced.has(caption.id)) continue;
        const parserBox = regionOf(caption.bbox);
        const cap = caption.type === "table" && locate({...caption, text: caption.table_caption.join(" ")});
        if (caption.type === "table" && !cap) continue;
        const box = cap ? union(chars.slice(cap.start, cap.end)) : parserBox;
        if (cap && parserBox[3] - box[3] > chars[cap.start].fontSize * 2.5) continue;
        // A short caption may span only half its table. Use the width of an
        // actual multirow parser block below it when its cell grid agrees.
        for (const s of streams) {
          if (!s || s.item === caption) continue;
          const below = regionOf(s.item.bbox);
          if (Math.abs(below[0] - box[0]) > 6 || below[2] <= box[2] ||
              box[1] - below[3] < -2 || box[1] - below[3] > 58) continue;
          const candidates = rows.filter(row => ids.get(row[0]) >= s.start - 2 && ids.get(row.at(-1)) < s.end + 2)
            .map(row => ({row, cells: splitTableCells(row)}));
          if (candidates.some((r, i) => linedUp(r, candidates[i + 1], true))) box[2] = below[2];
        }
        const head = headings.get(caption);
        const starts = head?.map(cell=>cell[0].rect[0]);
        const region = head ? [{row:head.flat(),cells:head,rect:union(head.flat())}] : [];
        if (starts) box[2] = Math.max(box[2],Math.min(view[2],starts.at(-1)+(starts.at(-1)-starts.at(-2))*.9));
        let last = box[1],
          size;
        for (const row of printedRows) {
          const cells = splitTableCells(row,starts).filter(cell =>
            cell[0].rect[0] >= box[0] - 6 && cell.at(-1).rect[2] <= box[2] + Math.max(6, 2 * cell[0].fontSize));
          if (!cells.length) continue;
          const sample = cells.flat(),
            rect = union(sample),
            em = DeepRead.Typography.metrics(sample)?.fontSize || 8;
          if (rect[3] > box[1] + 1) continue;
          if (head) {
            const aligned = cells.every(cell => {
              const x = cell[0].rect[0], end = cell.at(-1).rect[2];
              return starts.some((start,i) => Math.abs(x-start)<em*.85 &&
                end <= (i+1 < starts.length ? starts[i+1]+em*.15 : box[2]+em*2));
            });
            if (!aligned) break;
          }
          if (
            region.length &&
            /^(?:[A-Z]|\d+)(?:\.\d+)+\.?\s+\p{Lu}/u.test(text(sample)) &&
            sample.filter(DeepRead.Typography.bold).length > sample.length * 0.8
          )
            break;
          const gap = last - rect[3];
          if (gap > (size || em) * 3.2 || (size && em > size * 1.18 && /[a-z]{3}/i.test(text(sample)))) break;
          // A full-width line without cell boundaries marks a return to prose.
          if (/^Table\s+(?:\d+|[IVXLCDM]+)[.:\s]/iu.test(text(sample))) break;
          const prose = cells.length <= 2 && cells.some(cell =>
            (text(cell).match(/\b[a-zA-Z]{2,}\b/gu)?.length || 0) >= 6 && text(cell).length > 36);
          if (prose && !head) {
            if (region.some(r => r.cells.length >= 3) || gap > em * 1.5) break;
            region.length = 0;
            last = rect[1];
            continue; // a wrapped caption line printed above the column headings
          }
          size ||= em;
          region.push({ row: sample, cells, rect });
          last = rect[1];
        }
        const multi = region.filter(r => r.cells.length >= 3);
        if (head ? region.filter(r => r.cells.length === starts.length).length < 3 :
          multi.filter((r, i) => linedUp(r, multi[i - 1], true) || linedUp(r, multi[i + 1], true)).length < 3) continue;
        const gridStarts = region.flatMap(r => r.cells.slice(1).map(cell => cell[0].rect[0]));
        const guides = [...new Set(gridStarts.filter(x => gridStarts.some(y => y !== x && Math.abs(x - y) < .5) ||
          gridStarts.indexOf(x) !== gridStarts.lastIndexOf(x)))];
        if (!head) for (const r of region) r.cells = splitTableCells(r.row, guides);
        const tableInk = new Set(region.flatMap((r) => r.row));
        const gridTop = Math.max(...region.map(r => r.rect[3]));
        const inRegion = (c) =>
          tableInk.has(c) ||
          (c.rect &&
            c.rect[0] >= box[0] - 6 &&
            c.rect[2] <= box[2] + 6 &&
            c.rect[1] >= last - 1 &&
            c.rect[3] <= gridTop + 1);
        // Drop a parser box only if every one of its printed words is accounted for.
        const sources = streams.filter(
          (s) =>
            s &&
            !replaced.has(s.id) &&
            (head || s.item !== caption) &&
            chars
              .slice(s.start, s.end)
              .filter((c) => norm(glyph(c)))
              .every(inRegion)
        );
        if (!sources.length) continue;
        const eligible = new Set(sources.flatMap((s) => chars.slice(s.start, s.end)));
        const kept = streams.filter(s => s && !sources.includes(s) && !replaced.has(s.id));
        for (const line of region) {
          const groupHeading = line.cells.length === 1 && /^[\p{L}][\p{L}\d -]{1,42}$/u.test(text(line.row)) &&
            line.row.every(c => !glyph(c).trim() || DeepRead.Typography.italic(c) || DeepRead.Typography.bold(c));
          if (!head && line.cells.length < 2 && !groupHeading) continue;
          for (const c of line.row)
            if (!claimedLabels.has(c) && !kept.some(s => ids.get(c) >= s.start && ids.get(c) < s.end)) eligible.add(c);
        }
        for (const row of region) {
          if (row.row.some(c => eligible.has(c))) break;
          if (row.row.every(c => !glyph(c).trim() || DeepRead.Typography.bold(c)) &&
              !streams.some(s => s && !replaced.has(s.id) && row.row.some(c => ids.get(c) >= s.start && ids.get(c) < s.end)))
            for (const c of row.row) eligible.add(c);
        }
        sources.forEach((s) => replaced.add(s.id));
        const rawIdentifiers = /\b(?:raw|original)\b.{0,70}\bnames?\b/iu.test(caption.text);
        const nameColumns = (region[0]?.cells || [])
          .filter((cell) => /^(?:platform|model|dataset|identifier|name)$/iu.test(text(cell)))
          .map((cell) => cell[0].rect[0]);
        tableBounds.push(boxFor(region.flatMap((r) => r.row)));
        const lefts = region
          .filter((r) => r.cells.length >= 2)
          .map((r) => r.rect[0])
          .sort((a, b) => a - b);
        const columnsLeft = lefts[Math.floor(lefts.length / 2)];
        const cellBoxes = region.flatMap((row) => row.cells.map(union));
        let previous = [];
        for (const [index, row] of region.entries()) {
          const em = row.row[0].fontSize || 8;
          const newRow = row.rect[0] < columnsLeft + em * 1.5;
          const effortBadge = index && /^(?:low|medium|high|xhigh|max)$/u.test(text(region[index-1].row)) &&
            row.cells.filter(cell => numberCell(text(cell))).length >= 3;
          if (newRow) previous = [];
          for (const cell of row.cells) {
            if (!cell.some((c) => eligible.has(c))) continue;
            cell.forEach((c) => claimedLabels.add(c));
            if ((effortBadge || scoringModel(row.cells)) && (cell === row.cells[0] || cell === row.cells[1])) continue;
            const label = text(cell);
            if (
              index &&
              nameColumns.some((x) => Math.abs(x - cell[0].rect[0]) < em * 0.8) &&
              /^(?:[A-Z][\w'-]*(?:\s*(?:[+/,()-]\s*)?|$))+$/u.test(label)
            )
              continue;
            if (/^(?:max|min|low|medium|high|xhigh|sin|cos|log|exp)$/u.test(label) && cell.every((c) => c.fontSize < size * 0.85))
              continue;
            if (
              !/[a-z]{2}/iu.test(label) ||
              cell.every(DeepRead.Typography.monospace) ||
              (rawIdentifiers && index >= 2) ||
              /\w_\w/u.test(label) || /^[\w.]+\([\w, ]*\)$/u.test(label)
            )
              continue;
            if (
              (!/[a-z]{2}/u.test(label) && !/^(?:No|OK)$/u.test(label)) ||
              (!label.includes(" ") && /[a-z][A-Z]|[A-Za-z]\d|(?:Norm|Net)$/u.test(label))
            )
              continue;
            const prior =
              !newRow &&
              previous.find(
                (f) =>
                  Math.abs(f.last[0] - cell[0].rect[0]) < em &&
                  f.last[1] - cell[0].rect[1] > 0 &&
                  f.last[1] - cell[0].rect[1] < em * 1.7
              );
            if (prior) {
              const joined = [
                ...prior.run.slice(0, -1),
                { ...prior.run.at(-1), lineBreakAfter: true },
                ...cell
              ];
              prior.run = joined;
              prior.last = cell[0].rect;
              Object.assign(prior.frame, { inlineGlyphs: joined, text: text(joined), bbox: boxFor(joined) });
            } else {
              const frame = addFrame(cell, caption, "table_label", "grid-" + ids.get(cell[0]));
              if (caption.type === "table") frame.visualOwner = caption.id;
              const box = union(cell);
              const flush = cellBoxes.filter((b) => Math.abs(b[0] - box[0]) < em * 0.35);
              frame.flushLeft = flush.length >= 3 && flush.some((b) => Math.abs(b[2] - box[2]) > em);
              previous.push({ frame, run: cell, last: cell[0].rect });
            }
          }
        }
      }
      const gridRows = rows.map((row) => ({ row, cells: splitTableCells(row) }));
      const cellRows = new Map();
      // A two-column count table has only one gutter. Require at least
      // three consecutive right-aligned numeric values before claiming it.
      const countRow = r => r?.cells.length === 2 &&
        /\p{L}/u.test(text(r.cells[0])) &&
        /^\d[\d,.]*(?:\s*%)?$/u.test(text(r.cells[1])) &&
        r.cells[1][0].rect[0] - r.cells[0].at(-1).rect[2] > r.row[0].fontSize * 1.5;
      const sameColumns = (a, b) => {
        if (a?.cells.length !== 2 || b?.cells.length !== 2) return false;
        const em = a.row[0].fontSize;
        const step = a.row[0].baseline - b.row[0].baseline;
        return step > 0 && step < em * 2.8 &&
          Math.abs(a.cells[0][0].rect[0] - b.cells[0][0].rect[0]) < em * .45 &&
          Math.abs(a.cells[1].at(-1).rect[2] - b.cells[1].at(-1).rect[2]) < em * .45;
      };
      for (let i = 0; i < gridRows.length; i++) {
        if (!countRow(gridRows[i])) continue;
        let end = i + 1;
        while (countRow(gridRows[end]) && sameColumns(gridRows[end - 1], gridRows[end])) end++;
        if (end - i < 3) continue;
        const header = gridRows[i - 1];
        const hasHeader = sameColumns(header, gridRows[i]) && /\p{L}/u.test(text(header.cells[1]));
        const names = hasHeader && /\b(dataset|model|method|platform|identifier|name)s?\b/iu.test(text(header.cells[0]));
        for (const row of gridRows.slice(hasHeader ? i - 1 : i, end)) {
          row.countTable = true;
          row.keepName = names && row !== header && !/^total$/iu.test(text(row.cells[0]));
          for (const c of row.row) cellRows.set(c, row);
        }
        i = end - 1;
      }
      gridRows.forEach((r, i) => {
        if ([gridRows[i-1], gridRows[i+1]].some(other => other && linedUp(r, other,
          [r,other].every(line => line.cells.filter(cell => numberCell(text(cell))).length >= 3))))
          for (const c of r.row) cellRows.set(c, r);
      });
      // A group label printed between two runs of scores belongs to the same
      // table, including when a parser joins it to the preceding data rows.
      for (let i=1; i+1<gridRows.length; i++) {
        const group = gridRows[i], before = gridRows[i-1], after = gridRows[i+1];
        if (group.cells.length !== 1 || !/^[\p{L}][\p{L}\d -]{1,48}$/u.test(text(group.row))) continue;
        const em = group.row[0].fontSize;
        if ([before,after].every(r => cellRows.has(r.row[0]) && r.cells.filter(cell => numberCell(text(cell))).length >= 3 &&
          Math.abs(r.row[0].baseline-group.row[0].baseline)<em*2.7 &&
          Math.abs(r.row[0].rect[0]-group.row[0].rect[0])<em*2))
          for (const c of group.row) cellRows.set(c,group);
      }
      // A header may have been discarded as small text, even though the data
      // rows directly below form a reliable grid (including tick/cross fonts).
      for (const [i,first] of gridRows.entries()) {
        if (!cellRows.has(first.row[0]) || cellRows.has(gridRows[i-1]?.row[0]) ||
            first.cells.filter(cell => numberCell(text(cell))).length < 3) continue;
        const em = first.row[0].fontSize, data = union(first.row);
        for (const line of printedRows) {
          const r = union(line);
          if (r[1] < data[3]-1 || r[1]-data[3] > em*4 || Math.abs(line[0].fontSize-em) > em*.2) continue;
          const headings = splitCells(line).filter(cell => cell[0].rect[0] >= data[0]-em &&
            (cell[0].rect[0]+cell.at(-1).rect[2])/2 <= data[2]+em);
          if (headings.length < 2 || headings.some(cell => !/^[\p{L}][\p{L}\d./%() -]{0,35}$/u.test(text(cell)))) continue;
          for (const heading of headings) {
            if (heading.some(c => claimedLabels.has(c) || streams.some(s=>s && ids.get(c)>=s.start && ids.get(c)<s.end))) continue;
            const table = streams.find(s => s && ids.get(first.row[0]) >= s.start && ids.get(first.row[0]) < s.end);
            if (!table) continue;
            addFrame(heading, table.item, "table_label", "column-header-"+ids.get(heading[0]));
            heading.forEach(c=>claimedLabels.add(c));
          }
        }
      }
      for (const s of streams) {
        if (!s || replaced.has(s.id) || s.item.text_level || s.item.type !== "text") continue;
        const ink = chars.slice(s.start, s.end).filter((c) => norm(glyph(c)));
        if (!ink.length || !ink.every((c) => cellRows.has(c))) continue;
        const matched = [...new Set(ink.map((c) => cellRows.get(c)))];
        if (!matched.every((r) => s.start <= ids.get(r.row[0]) + 2 && s.end >= ids.get(r.row.at(-1)) - 2))
          continue;
        replaced.add(s.id);
        for (const row of matched)
          for (const run of row.cells) {
            const label = text(run);
            if (scoringModel(row.cells) && (run === row.cells[0] || run === row.cells[1])) continue;
            if (row.keepName && run === row.cells[0]) continue;
            if (
              !/[a-z]{2}/u.test(label) ||
              run.every(DeepRead.Typography.monospace) ||
              /[_/][\w]+[_/]|\w_\w/u.test(label)
            )
              continue;
            if (
              !/\s/u.test(label) &&
              !/^(?:method|model|configuration|role|name|dataset|environments?|size|time|type|average|mean|overall|total|baseline|yes|no|training|test|validation|accuracy|score|input|output|default|steps|parameters|layers|views|resolution|dispatch|wall)$/iu.test(
                label
              )
            )
              continue;
            const frame = addFrame(run, s.item, "table_label", "cell-" + ids.get(run[0]));
            if (row.countTable) {
              frame.flushLeft = run === row.cells[0];
              frame.flushRight = !frame.flushLeft;
            }
          }
      }
      // Some embedded vector tables print a whole column before the next.
      // Keep its numeric values in the original PDF and translate each label
      // at its own baseline. A prose column lacks this repeated field pattern.
      for (const s of streams) {
        if (!s || replaced.has(s.id) || s.item.type !== "text" || s.item.text_level) continue;
        const ink = chars.slice(s.start, s.end);
        const lines = DeepRead.ParallelVisual.lines(ink);
        if (lines.length < 3 || lines.some(line => text(line).length > 44)) continue;
        const labels = lines.map(text), boxes = lines.map(union), em = lines[0][0].fontSize;
        if (!boxes.every(b => Math.abs(b[0]-boxes[0][0]) < em*.7 ||
            Math.abs(b[2]-boxes[0][2]) < em*.7 || Math.abs(b[0]+b[2]-boxes[0][0]-boxes[0][2]) < em)) continue;
        const numeric = label => /^[\d\s.,×/%+±−–-]+$/u.test(label);
        const count = labels.filter(numeric).length;
        const repetitive = lines.length >= 5 && new Set(labels).size <= lines.length*.6;
        if (count < Math.max(2, lines.length-1) && !repetitive) continue;
        if (repetitive && labels.some(label => !numeric(label) && label.split(/\s+/u).length > 3)) continue;
        const column = union(ink);
        const owner = items.find(it => {
          if (!it.bbox || !["table","image","chart"].includes(it.type)) return false;
          const b = regionOf(it.bbox);
          return column[0] <= b[2]+em && column[2] >= b[0]-em && column[1] < b[3] && column[3] > b[1];
        });
        replaced.add(s.id);
        for (const [i, line] of lines.entries()) {
          line.forEach(c => claimedLabels.add(c));
          if (numeric(labels[i]) || !/[a-z]{2}/iu.test(labels[i])) continue;
          const frame = addFrame(line, s.item, "table_label", "column-" + ids.get(line[0]));
          frame.visualOwner = owner?.id;
          frame.flushLeft = Math.abs(boxes[i][0]-boxes[0][0]) < em*.35;
        }
      }
    }

    function recoverBoundedTable(table, cap, owned) {
      const area = regionOf(table.bbox);
      const sides = [[], []];
      // The parser's table box may include either a top or a bottom caption.
      // A physical row owns all its cells even if the parser dropped that row.
      for (const line of printedRows) {
        const cells = splitTableCells(line).filter(run => {
          const r = union(run);
          return r[0] >= area[0]-2 && r[2] <= area[2]+2 && r[1] >= area[1]-2 && r[3] <= area[3]+2;
        });
        if (!cells.length) continue;
        const row = cells.flat(), rect = union(row);
        if (rect[1] >= cap[3]-1) sides[0].push({row, cells, rect});
        else if (rect[3] <= cap[1]+1) sides[1].push({row, cells, rect});
      }
      for (const grid of sides) {
        const dataRows = grid.filter(r => r.cells.length >= 3 && r.cells.filter(cell =>
          /^[\d\s%.,/+±−–—×()[\]k-]+$/u.test(text(cell)) ||
          /^(?:O|Θ)\s*\(/u.test(text(cell))).length >= 2);
        const labeledRows = grid.filter(r => r.cells.length >= 3 && numberCell(text(r.cells.at(-1))));
        const evidence = dataRows.length >= 2 ? dataRows : labeledRows.length >= 3 ? labeledRows : [];
        if (!evidence.some((r,i) => linedUp(r, evidence[i+1], true))) continue;
        const dataLeft = Math.min(...evidence.map(r => r.rect[0]));
        const tabular = grid.filter(r => r.cells.length > 1 || text(r.row).length <= 95);
        const tableChars = new Set(tabular.flatMap(r => r.row));
        for (const frame of additions) {
          if (frame.type === "table_label" && frame.inlineGlyphs.every(c => tableChars.has(c))) frame.visualOwner = table.id;
        }
        for (const s of streams) {
          if (!s || replaced.has(s.id)) continue;
          const glyphs = chars.slice(s.start, s.end).filter(c => norm(glyph(c)));
          if (glyphs.length && glyphs.every(c => tableChars.has(c))) replaced.add(s.id);
        }
        const remaining = streams.filter(s => s && !replaced.has(s.id));
        for (const line of tabular) {
          const em = line.row[0].fontSize;
          // Body text accidentally enclosed by an old table box is a separate
          // source. It must never be hidden behind an unrelated cell label.
          for (const cell of line.cells) {
            if (cell.some(c => owned.has(c) || remaining.some(s => ids.get(c) >= s.start && ids.get(c) < s.end))) continue;
            const label = text(cell);
            if (!/[a-z]{2}/iu.test(label) || cell.every(DeepRead.Typography.monospace) ||
                /\w_\w|^(?:O|Θ)\s*\(|^[\w.]+\([\w, ]*\)$/u.test(label) ||
                (!/\s/u.test(label) && (/[a-z][A-Z]|[A-Z]{2,}|\d/u.test(label)) &&
                 !/^(?:F1|Top-?\d+)$/iu.test(label))) continue;
            const frame = addFrame(cell, table, "table_label", "grid-" + ids.get(cell[0]));
            frame.visualOwner = table.id;
            frame.flushLeft = Math.abs(cell[0].rect[0]-dataLeft) < em*.6;
            cell.forEach(c => { owned.add(c); claimedLabels.add(c); });
          }
        }
        tableBounds.push(boxFor([...tableChars]));
        return true;
      }
      return false;
    }

    function recoverMissingTableHeadings() {
      // The PDF text parser may keep a caption but drop small table cells.
      // Recover only the header of a nearby aligned grid, preserving its data.
      const alreadyOwned = new Set(additions.flatMap((frame) => frame.inlineGlyphs || []));
      for (const table of items) {
        if (table.type !== "table" || table.table_body || !table.bbox || !table.table_caption?.length) continue;
        const cap = locate({ ...table, text: table.table_caption.join(" ") });
        if (!cap) continue;
        const box = union(chars.slice(cap.start, cap.end));
        if (recoverBoundedTable(table, box, alreadyOwned)) continue;
        const candidates = printedRows
          .map((row) => {
            const inside = row.filter((c) => c.rect[0] >= box[0] - 8 && c.rect[2] <= box[2] + 8);
            const cells = splitCells(inside);
            return cells.length >= 3 ? { row: inside, cells, rect: union(inside) } : null;
          })
          .filter(Boolean);
        let heading,
          firstData,
          distance = Infinity;
        for (const [i, header] of candidates.entries()) {
          if (header.cells.filter((cell) => /[a-z]{3}/iu.test(text(cell)) && !/\d/u.test(text(cell))).length < 2)
            continue;
          let j = i;
          while (linedUp(candidates[j], candidates[j + 1], true)) j++;
          if (j === i) continue;
          const end = candidates[j];
          const data = candidates
            .slice(i + 1, j + 1)
            .some((row) => row.cells.filter((cell) => /\d|[✓×≤≥±]|O\s*\(/u.test(text(cell))).length >= 2);
          if (!data) continue;
          const gap =
            header.rect[3] < box[1]
              ? box[1] - header.rect[3]
              : end.rect[1] > box[3]
                ? end.rect[1] - box[3]
                : Infinity;
          if (gap < distance && gap <= (header.row[0].fontSize || 8) * 4) {
            heading = header;
            firstData = candidates[i + 1];
            distance = gap;
          }
        }
        if (!heading) continue;
        const extensions = printedRows
          .filter((row) => {
            const box = union(row);
            return box[3] <= heading.rect[1] + 1 && box[1] >= firstData.rect[3] - 1;
          })
          .flatMap(row => splitCells(row));
        for (const cell of heading.cells) {
          const label = text(cell);
          if (!/^[\p{L}\p{N}][\p{L}\p{N} .,()/-]*$/u.test(label) || !/[a-z]{3}/iu.test(label)) continue;
          const box = union(cell);
          const extra = extensions.find((run) => {
            const b = union(run);
            return (
              /^[A-Za-z][A-Za-z -]+$/u.test(text(run)) &&
              Math.abs(box[0] + box[2] - b[0] - b[2]) < cell[0].fontSize
            );
          });
          const glyphs = extra ? [...cell, ...extra] : cell;
          if (
            glyphs.some(
              (c) =>
                alreadyOwned.has(c) ||
                streams.some((s) => s && !replaced.has(s.id) && ids.get(c) >= s.start && ids.get(c) < s.end)
            )
          )
            continue;
          const joined = extra
            ? [...cell.slice(0, -1), { ...cell.at(-1), lineBreakAfter: true }, ...extra]
            : cell;
          const frame = addFrame(joined, table, "table_label", "header-" + ids.get(cell[0]));
          frame.visualOwner = table.id;
          frame.flushLeft = !extra;
          glyphs.forEach((c) => alreadyOwned.add(c));
        }
      }
    }

    function recoverFigureLabels() {
      // A vector diagram can have selectable labels but no parser figure
      // object. Recover short native labels in the open area beside a caption.
      const figures = items.filter(
        (it) =>
          it.bbox &&
          (["image", "figure", "chart"].includes(it.type) ||
            (it.type === "text" && /^(?:Fig(?:ure)?\.?|Chart)\s+\d+\b/iu.test(it.text)))
      );
      if (figures.length) {
        const diagramSources = new Set();
        // A text-layer parser can read across the columns of an infographic
        // before it reaches its printed caption. Use the tiny native font,
        // caption position and actual gaps between runs to restore each label.
        for (const s of streams) {
          if (!s || replaced.has(s.id) || s.item.type !== "text" || /^Fig(?:ure)?\.?\s+\d+/iu.test(s.item.text)) continue;
          const glyphs = chars.slice(s.start,s.end).filter(c => c.rect && !c.rotation);
          if (!glyphs.length) continue;
          const r = union(glyphs), cells = DeepRead.ParallelVisual.lines(glyphs).map(row => splitCells(row));
          const em = glyphs.find(c => glyph(c).trim())?.fontSize || 0;
          const caption = figures.find(fig => {
            if (fig.type !== "text") return false;
            const fs = streams.find(entry => entry?.item === fig);
            if (!fs || !(em > 0 && em < chars[fs.start].fontSize * .76)) return false;
            const box = regionOf(fig.bbox);
            return r[1] > box[3] && r[3] - box[3] < (view[3] - view[1]) * .43 &&
              r[0] >= box[0] - em && r[2] <= box[2] + em;
          });
          if (!caption) continue;
          const split = cells.some(row => row.some((cell,i) =>
            i && cell[0].rect[0] - row[i-1].at(-1).rect[2] > em * 2));
          if (!split && r[2] - r[0] > (view[2] - view[0]) * .19) continue;
          replaced.add(s.id);
          diagramSources.add(s.id);
          for (const run of split ? cells.flat() : [glyphs]) {
            if (run.some(c => claimedLabels.has(c)) || !/[a-z]{2}/iu.test(text(run))) continue;
            addFrame(run, caption, "figure_label", "diagram-" + ids.get(run[0]));
            run.forEach(c => claimedLabels.add(c));
          }
        }
        for (const s of streams) {
          if (!s?.item.text_level || replaced.has(s.id)) continue;
          const glyphs = chars.slice(s.start,s.end);
          const lines = DeepRead.ParallelVisual.lines(glyphs);
          if (lines.length !== 1) continue;
          const panels = splitCells(lines[0]), em = lines[0][0].fontSize;
          if (panels.length < 2 || !panels.every((cell,i) => /[a-z]{2}/iu.test(text(cell)) &&
              (!i || cell[0].rect[0]-panels[i-1].at(-1).rect[2] > em*2))) continue;
          const r = union(glyphs);
          const graphic = figures.find(it => {
            const b = regionOf(it.bbox);
            return it.type !== "text" && r[0] >= b[0]-em && r[2] <= b[2]+em &&
              Math.abs(r[1]-b[3]) < em*1.5 && r[2]-r[0] > (b[2]-b[0])*.5;
          });
          if (!graphic) continue;
          replaced.add(s.id);
          for (const cell of panels) {
            const frame = addFrame(cell, graphic, "figure_label", "panel-" + ids.get(cell[0]));
            frame.visualOwner = graphic.id;
            frame.panelHeading = true;
            cell.forEach(c => claimedLabels.add(c));
          }
        }
        const occupied = [], panelOpeners = [];
        for (const [i, item] of items.entries()) {
          if (!item.bbox || ["image", "figure", "chart"].includes(item.type)) continue;
          const span = streams[i];
          // A recovered label belongs inside the figure. Unlike intervening
          // body prose, it does not separate other labels from their caption.
          if (span && diagramSources.has(span.id)) continue;
          if (!span) {
            occupied.push(regionOf(item.bbox));
            continue;
          }
          for (const row of rows) {
            if (ids.get(row.at(-1)) < span.start || ids.get(row[0]) >= span.end) continue;
            const owned = row.filter((c) => ids.get(c) >= span.start && ids.get(c) < span.end);
            if (!owned.length) continue;
            const bounds = union(owned);
            occupied.push(bounds);
            const opener = /^\(([a-z])\)\s+\p{Lu}[^:]{1,35}:\s+\p{L}/u.exec(item.text || "");
            if (opener && ids.get(owned[0]) === span.start && ids.get(owned.at(-1)) >= span.end - 1)
              panelOpeners.push({ bounds, index:opener[1] });
          }
        }
        const rotated = [];
        let run = [];
        for (const c of chars) {
          const prior = run.at(-1);
          const gap = prior && c.rect && Math.max(prior.rect[1] - c.rect[3], c.rect[1] - prior.rect[3]);
          if (prior && (c.rotation !== prior.rotation || !c.rect ||
              gap > Math.max(prior.fontSize, c.fontSize) * .85 ||
              Math.abs(c.rect[0] - prior.rect[0]) > Math.max(prior.fontSize, c.fontSize))) {
            rotated.push(run);
            run = [];
          }
          if (c.rect && !c.diagonal && [90, 270].includes(c.rotation)) run.push(c);
          if (run.length && breaks(c)) {
            rotated.push(run);
            run = [];
          }
        }
        if (run.length) rotated.push(run);
        const stage = /^(?:round|stage|phase|iteration|frame)\s+\d+\s*:\s+\p{L}/iu;
        const printedCells = printedRows.map(row => splitCells(row));
        const stageCells = new Set(panelOpeners.length < 3 ? [] : printedCells.flatMap(row => {
          const stages = row.filter(cell => stage.test(text(cell)));
          return stages.length >= 3 ? stages.map(cell => cell[0]) : [];
        }));
        const labels = [...printedCells.flat(), ...rotated];
        for (const fig of figures) {
          const box = regionOf(fig.bbox),
            typed = fig.type !== "text",
            candidates = [];
          const captions = [
            ...(fig.image_caption || []),
            ...(fig.chart_caption || []),
            ...(fig.captionFrames || []).map((frame) => frame.text)
          ]
            .filter((s) => typeof s === "string");
          // A graphic's estimated box can enclose its caption. Match visible
          // letters; locate() excludes trailing punctuation from its range.
          const captionSpans = captions.map(text=>locate({...fig,text})).filter(Boolean);
          const captionKeys = captions.map(norm);
          const openers = typed ? [] : panelOpeners.filter(({bounds}) =>
            Math.abs(bounds[0] - box[0]) < 8 && bounds[1] > box[3] &&
            bounds[3] - box[3] < (view[3] - view[1]) * .48
          ).sort((a,b) => b.bounds[3] - a.bounds[3]);
          const panelSeparators = openers.length >= 3 && openers.every((opener,i) =>
            opener.index.charCodeAt(0) === 97 + i && (!i || openers[i - 1].bounds[1] - opener.bounds[3] > 24)
          ) ? new Set(openers.map(opener => opener.bounds)) : new Set();
          for (const rawCell of labels) {
            // Some vector diagrams draw an identical label twice, with a
            // fraction-of-a-point offset. Their sorted glyphs otherwise spell
            // "TTookk" and hide a valid numbered label.
            const cell = typed ? rawCell.filter((c,i) => {
              const prior = rawCell[i-1];
              return !prior || glyph(c)!==glyph(prior) || c.fontName!==prior.fontName ||
                Math.abs(c.rect[0]-prior.rect[0])>.06 || Math.abs(c.rect[1]-prior.rect[1])>c.fontSize*.09;
            }) : rawCell;
            const first = cell.findIndex(
              (c) => /[A-Za-z]/u.test(glyph(c)) && !/math|symbol/iu.test(c.fontName || "")
            );
            if (first < 0) continue;
            const dimensional = first > 0 && /^D$/iu.test(glyph(cell[first])) && /^\d$/u.test(glyph(cell[first-1])) &&
              cell[first].rect[0]-cell[first-1].rect[2] < cell[first].fontSize*.3;
            const run = cell.slice(dimensional ? first-1 : first);
            // PDF.js sometimes reports zero rotation for slanted chart ticks.
            // Two adjacent letters can fall within a horizontal row's tolerance
            // even though the original word climbs steadily across the plot.
            if (!run[0].rotation && run.length < 5) {
              const k = ids.get(run[0]);
              const rises = (a,b) => {
                if (!a?.rect || !b?.rect || a.fontName !== b.fontName) return 0;
                const dx = b.rect[0] - a.rect[0], dy = b.baseline - a.baseline;
                return dx > 0 && dx < a.fontSize * 1.3 && Math.abs(dy) > dx * .25 &&
                  Math.abs(dy) < Math.min(a.fontSize, dx * 2.5) ? Math.sign(dy) : 0;
              };
              if ([k-1,k,k+1].some(j => {
                const step = rises(chars[j-1],chars[j]);
                return step && step === rises(chars[j],chars[j+1]);
              })) continue;
            }
            const label = text(run),
              rect = union(run),
              x = (rect[0] + rect[2]) / 2,
              y = (rect[1] + rect[3]) / 2;
            const lastLetter=run.findLast(c=>norm(glyph(c)));
            if (/^(?:Fig(?:ure)?\.?|Chart|Table)\s+\d+\b/iu.test(label) ||
                captionSpans.some(s=>ids.get(run[0])>=s.start && ids.get(lastLetter)<s.end) ||
                captionKeys.includes(norm(label)))
              continue;
            if (
              x < box[0] - 3 ||
              x > box[2] + 3 ||
              (typed ? y < box[1] || y > box[3] : y < box[3] || y > box[3] + (view[3] - view[1]) * 0.48)
            )
              continue;
            if (occupied.some((b) => rect[2] > b[0] && rect[0] < b[2] && rect[3] > b[1] && rect[1] < b[3]))
              continue;
            // In a stack of figure panels, a lower panel's heading can sit
            // between this stage label and the shared figure caption.
            const staged = panelSeparators.size && y < openers[0].bounds[1] && stageCells.has(run[0]);
            if (!typed && occupied.some(b => b[1] > box[3] + 2 && b[3] < y && b[0] < x && b[2] > x &&
                !(staged && panelSeparators.has(b)))) continue;
            if (run.some((c) => claimedLabels.has(c)) || label.length > 75 || /[=<>⟨⟩_{}]/u.test(label))
              continue;
            const words = label.match(/[a-z]{2,}/giu) || [];
            const singleWord =
              /^(?:[a-z]\)\s+)?[A-Z]?[a-z]{2,}(?:-[a-z]{2,})*$/u.test(label) &&
              !/^(?:argmax|argmin|min|max|log|exp|sin|cos|tan|fps|flops|sigmoid|softmax)$/iu.test(label);
            const numberedLabel = /^(?:stage|step|phase|layer|level|view|frame|round|iteration)\s*[-:]?\s*\d+$/iu.test(label) ||
              typed && /^(?:sentence|token|tok)\s+(?:\d+|[A-Z])$/iu.test(label);
            if (words.length < 2 && !singleWord && !numberedLabel && !/^(?:frozen|trainable)$/iu.test(label)) continue;
            const capitalizedPhrase = words.length >= 2 && words.some(word => word.length >= 4);
            if (!typed && !/[a-z]{2}/u.test(label) && !capitalizedPhrase && !/^(?:frozen|trainable)$/iu.test(label)) continue;
            candidates.push(run);
          }
          if (!typed && candidates.length < 2 && !candidates.some((run) => run[0].rotation)) continue;
          for (const run of candidates) {
            if (run.some((c) => claimedLabels.has(c))) continue;
            let glyphs = run;
            const bounds = union(run), em = run[0].fontSize;
            // One cell's small note can wrap after a preposition or article.
            // Recover its last line only under a matched stage heading.
            if (panelSeparators.size && /\b(?:the|a|an|of|in|to|with|and|or)$/iu.test(text(run)) &&
                [...stageCells].some(c => Math.abs(c.rect[0] - bounds[0]) < em * .45 &&
                  c.rect[1] >= bounds[3] && c.rect[1] - bounds[3] < em && em < c.fontSize * .85)) {
              const tails = labels.filter(cell => {
                const next = union(cell), step = bounds[3] - next[3];
                return cell[0].fontName === run[0].fontName && Math.abs(cell[0].fontSize - em) < em * .1 &&
                  step > em * .85 && step < em * 1.55 && Math.abs(next[0] - bounds[0]) < em * .45 &&
                  next[2] <= bounds[2] + em * .5 && /^\p{Ll}[\p{L}\p{N} ,’'-]*[.!?][”’"]?$/u.test(text(cell)) &&
                  !cell.some(c => claimedLabels.has(c)) && !occupied.some(b =>
                    next[2] > b[0] && next[0] < b[2] && next[3] > b[1] && next[1] < b[3]);
              });
              if (tails.length === 1) {
                const [tail] = tails;
                glyphs = [...run.slice(0,-1), {...run.at(-1), lineBreakAfter:true}, ...tail];
                tail.forEach(c => claimedLabels.add(c));
              }
            }
            const frame = addFrame(glyphs, fig, "figure_label", "label-" + ids.get(run[0]));
            frame.visualOwner = typed ? fig.id : undefined;
            if (panelSeparators.size && (stageCells.has(run[0]) || glyphs !== run)) frame.flushLeft = true;
            run.forEach((c) => claimedLabels.add(c));
          }
          if (panelSeparators.size && stageCells.size) {
            const headings = [...stageCells].filter(c => DeepRead.Typography.bold(c) &&
              c.rect[0] >= box[0] - 1 && c.rect[0] <= box[2] && c.rect[1] > box[3] &&
              c.rect[3] < openers[0].bounds[1]);
            for (const frame of additions) {
              if (frame.type !== "figure_label" || !frame.inlineGlyphs ||
                  frame.inlineGlyphs.some(DeepRead.Typography.bold)) continue;
              const rect = union(frame.inlineGlyphs), em = frame.inlineGlyphs[0].fontSize;
              if (headings.some(c => em < c.fontSize * .85 && Math.abs(rect[0] - c.rect[0]) < em * .5 &&
                  c.rect[1] >= rect[3] && c.rect[1] - rect[3] < em)) frame.stageNote = true;
            }
          }
        }
      }
    }

    function recoverEquationNotes() {
      for (const item of items) {
        if (
          item.type !== "equation" ||
          !item.bbox ||
          replaced.has(item.id) ||
          !/\b(?:is|are|when|otherwise|where)\b/iu.test(item.text)
        )
          continue;
        const box = regionOf(item.bbox);
        for (const row of rows) {
          const run = row.filter(
            (c) =>
              c.rect[0] >= box[0] - 2 &&
              c.rect[2] <= box[2] + 2 &&
              c.rect[1] >= box[1] - 2 &&
              c.rect[3] <= box[3] + 2
          );
          const content = text(run);
          for (const match of content.matchAll(/\[([^\]]{10,150})\]/gu)) {
            if (
              !/\b(?:is|are|when|otherwise|where)\b/iu.test(match[1]) ||
              (match[1].match(/[a-z]{3,}/giu) || []).length < 3
            )
              continue;
            let at = 0;
            const span = run.filter((c) => {
              const start = at;
              at += glyph(c).length + (c.spaceAfter || breaks(c) ? 1 : 0);
              return start > match.index && start < match.index + match[0].length - 1;
            });
            if (span.length)
              addFrame(span, item, "formula_note", "note-" + ids.get(span[0])).visualOwner = item.id;
          }
        }
      }
    }

    function splitWrappedParagraphs() {
      // A paragraph wrapping a float may have one narrow column followed by
      // full-width lines underneath. Fit each shape separately, sharing context.
      for (const s of streams) {
        if (!s || replaced.has(s.id) || s.item.type !== "text" || s.item.text_level) continue;
        const parts = rows.filter((r) => ids.get(r[0]) >= s.start - 2 && ids.get(r.at(-1)) < s.end + 3);
        if (parts.length < 4) continue;
        const boxes = parts.map(union),
          first = boxes[0],
          em = parts[0][0].fontSize || 10;
        const at = boxes.findIndex(
          (r, i) =>
            i >= 3 &&
            Math.abs(r[0] - first[0]) < em &&
            r[2] - first[2] > Math.max(em * 5, (first[2] - first[0]) * 0.3) &&
            boxes.slice(0, i).every((b) => Math.abs(b[0] - first[0]) < em && b[2] < first[2] + em)
        );
        if (
          at < 0 ||
          !chars.some(
            (c, j) =>
              (j < s.start || j >= s.end) &&
              c.rect &&
              c.rect[0] > first[2] + em &&
              c.rect[0] < boxes[at][2] &&
              c.rect[1] >= boxes[at - 1][1] &&
              c.rect[3] <= first[3]
          )
        )
          continue;
        const groups = [parts.slice(0, at).flat(), parts.slice(at).flat()];
        if (norm(groups.map(text).join(" ")) !== norm(s.item.text)) continue;
        replaced.add(s.id);
        for (const [i, run] of groups.entries()) {
          addFrame(run, s.item, "text", "wrap-" + i);
          additions.at(-1).context = groups.map(text);
        }
      }
    }

    function joinInlineFormulas() {
      // Coalesce scripts split by the text layer. A formula at the start of a
      // wrapped line can still be inline when prose shares its baseline.
      let group = [];
      function finish() {
        if (group.length > 1 && group.some((s) => s.item.type === "text")) {
          const a = group[0],
            b = group.at(-1);
          let start = a.start,
            end = b.end;
          while (start > 0 && !breaks(chars[start - 1]) && /^[([]$/u.test(glyph(chars[start - 1]))) start--;
          while (end < chars.length && !breaks(chars[end - 1]) && /^[.,:;!?)\]]+$/u.test(glyph(chars[end])))
            end++;
          group.forEach((s) => replaced.add(s.id));
          addFrame(chars.slice(start, end), a.item, "text", "joined");
        }
        group = [];
      }
      for (const [index, s] of streams.entries()) {
        if (!s || replaced.has(s.id) || s.item.text_level) {
          finish();
          continue;
        }
        const prev = group.at(-1);
        if (prev) {
          const gap = chars.slice(prev.end - 1, s.start + 1);
          const a = chars[prev.end - 1],
            b = chars[s.start],
            em = Math.max(a.fontSize, b.fontSize) || 10;
          const wrap =
            group.length > 1 &&
            prev.item.type === "text" &&
            s.item.type === "text" &&
            /^\p{Ll}/u.test(s.item.text) &&
            !/[.!?:;]$/u.test(prev.item.text) &&
            s.item.bbox[0] < prev.item.bbox[2] &&
            a.baseline - b.baseline > 0 &&
            a.baseline - b.baseline < em * 1.7 &&
            b.rect[0] < a.rect[0] - em * 2;
          const next = streams[index + 1];
          const wrappedFormula = prev.item.type === "text" && s.item.type === "equation" &&
            next?.item.type === "text" && !next.item.text_level && !/[.!?:;]$/u.test(prev.item.text) &&
            a.baseline - b.baseline >= em * .75 && a.baseline - b.baseline < em * 1.65 &&
            Math.abs(b.rect[0] - regionOf(prev.item.bbox)[0]) < em &&
            b.rect[0] < a.rect[0] - em * 2 &&
            chars.slice(next.start, Math.min(next.end, next.start + 28)).some(c =>
              c.rect && c.fontSize >= em * .86 && /^[A-Za-z]/u.test(glyph(c)) &&
              c.rect[0] > b.rect[2] && Math.abs(c.baseline - b.baseline) < em * .28);
          const sameLine =
            !gap.slice(0, -1).some(breaks) &&
            (gap.some((c) => c.scriptContinuation) ||
              (Math.abs(a.baseline - b.baseline) < em * 0.7 && Math.abs(a.rect[2] - b.rect[0]) < em * 1.5));
          const mathGap =
            gap.length <= 34 &&
            gap.some((c) => c.scriptContinuation) &&
            !/[a-z]{3}/iu.test(text(gap).replace(/max|min|exp|sin|cos|log/giu, ""));
          if (s.start < prev.end || (s.start - prev.end > 8 && !mathGap) || (!sameLine && !wrap && !wrappedFormula)) finish();
        }
        group.push(s);
      }
      finish();
    }
  }
  DeepRead.ParallelFrames = { repairScripts, recover };
})();
