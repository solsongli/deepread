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
    const splitCells = (row) => {
      const cells = [];
      for (const c of row) {
        if (!glyph(c).trim()) continue;
        const prev = cells.at(-1)?.at(-1);
        if (!prev || c.rect[0] - prev.rect[2] > Math.max(c.fontSize, prev.fontSize) * 0.78) cells.push([]);
        else if (ids.get(c) > ids.get(prev) + 1) {
          const between = chars.slice(ids.get(prev) + 1, ids.get(c));
          if (between.every((g) => !glyph(g).trim())) cells.at(-1).push(...between);
        }
        cells.at(-1).push(c);
      }
      return cells;
    };
    function linedUp(a, b) {
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
      return aligned >= 3 && (gutters >= 2 || (gutters >= 1 && numbered));
    }
    const printedRows = DeepRead.ParallelVisual.lines(chars);
    const claimedLabels = new Set();

    recoverAlgorithms();
    recoverContents();
    recoverPrintedLabels();
    recoverTables();
    recoverFigureLabels();
    recoverEquationNotes();
    splitWrappedParagraphs();
    joinInlineFormulas();
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
        const entry = /^((?:[A-Z]|[IVXLCDM]+|\d+)(?:\.\d+)*\.?)\s+(.+?)\s+(\d{1,4})$/u.exec(s);
        if (!entry || !/[a-z]{2}/iu.test(entry[2]) || !row.at(-1).rect) continue;
        const label = entry[2].replace(/(?:\s*[.·…]){3,}\s*$/u, "").trim();
        if (!label || label.length > 185) continue;
        const titleStart = s.indexOf(label, entry[1].length);
        let at = 0;
        const run = row.filter((c) => {
          const begin = at;
          at += glyph(c).length + (c.spaceAfter || breaks(c) ? 1 : 0);
          return begin < titleStart + label.length && begin + glyph(c).length > titleStart;
        });
        if (run.length) entries.push({ row, run, right: row.at(-1).rect[2], dots: label !== entry[2].trim() });
      }
      const toc = entries.filter(
        (e) => entries.filter((other) => Math.abs(e.right - other.right) < 5 && other.dots).length >= 2
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
        for (const e of matches) addFrame(e.run, s.item, "text", "contents-" + ids.get(e.row[0]));
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
          const cells = owned.map(splitCells);
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

    function recoverTables() {
      // Tables flattened by the text-layer parser lose every column boundary.
      // Identify a grid using repeated alignment across adjacent physical rows.
      // A table caption followed by a run of aligned columns is also strong
      // evidence when PDF reading order jumps from one cell to the next.
      const tableCaptions = items.filter(
        (it) => it.type === "text" && it.bbox && /^Table\s+\d+\b/iu.test(it.text)
      );
      for (const caption of tableCaptions) {
        const box = regionOf(caption.bbox);
        const region = [];
        let last = box[1],
          size;
        for (const row of printedRows) {
          const cells = splitCells(row.filter((c) => c.rect[0] >= box[0] - 6 && c.rect[2] <= box[2] + 6));
          if (!cells.length) continue;
          const sample = cells.flat(),
            rect = union(sample),
            em = DeepRead.Typography.metrics(sample)?.fontSize || 8;
          if (rect[3] > box[1] + 1) continue;
          if (
            region.length &&
            /^(?:[A-Z]|\d+)(?:\.\d+)+\.?\s+\p{Lu}/u.test(text(sample)) &&
            sample.filter(DeepRead.Typography.bold).length > sample.length * 0.8
          )
            break;
          const gap = last - rect[3];
          if (gap > (size || em) * 3.2 || (size && em > size * 1.18 && /[a-z]{3}/i.test(text(sample)))) break;
          // A full-width line without cell boundaries marks a return to prose.
          if (cells.length === 1 && rect[2] - rect[0] > (box[2] - box[0]) * 0.8 && text(sample).length > 85)
            break;
          size ||= em;
          region.push({ row: sample, cells, rect });
          last = rect[1];
        }
        if (region.filter((r, i) => linedUp(r, region[i - 1]) || linedUp(r, region[i + 1])).length < 3)
          continue;
        const tableInk = new Set(region.flatMap((r) => r.row));
        const inRegion = (c) =>
          tableInk.has(c) ||
          (c.rect &&
            c.rect[0] >= box[0] - 6 &&
            c.rect[2] <= box[2] + 6 &&
            c.rect[1] >= last - 1 &&
            c.rect[3] <= box[1] + 1);
        // Drop a parser box only if every one of its printed words is accounted for.
        const sources = streams.filter(
          (s) =>
            s &&
            !replaced.has(s.id) &&
            s.item !== caption &&
            chars
              .slice(s.start, s.end)
              .filter((c) => norm(glyph(c)))
              .every(inRegion)
        );
        if (!sources.length) continue;
        const eligible = new Set(sources.flatMap((s) => chars.slice(s.start, s.end)));
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
          const newRow = row.cells.length >= 2 && row.rect[0] < columnsLeft + em * 1.5;
          if (newRow) previous = [];
          for (const cell of row.cells) {
            if (!cell.some((c) => eligible.has(c))) continue;
            cell.forEach((c) => claimedLabels.add(c));
            const label = text(cell);
            if (
              index &&
              nameColumns.some((x) => Math.abs(x - cell[0].rect[0]) < em * 0.8) &&
              /^(?:[A-Z][\w'-]*(?:\s*(?:[+/,()-]\s*)?|$))+$/u.test(label)
            )
              continue;
            if (/^(?:max|min|sin|cos|log|exp)$/u.test(label) && cell.every((c) => c.fontSize < size * 0.85))
              continue;
            if (
              !/[a-z]{2}/iu.test(label) ||
              cell.every(DeepRead.Typography.monospace) ||
              (rawIdentifiers && index >= 2) ||
              /\w_\w/u.test(label)
            )
              continue;
            if (
              !/[a-z]{2}/u.test(label) ||
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
              const box = union(cell);
              const flush = cellBoxes.filter((b) => Math.abs(b[0] - box[0]) < em * 0.35);
              frame.flushLeft = flush.length >= 3 && flush.some((b) => Math.abs(b[2] - box[2]) > em);
              previous.push({ frame, run: cell, last: cell[0].rect });
            }
          }
        }
      }
      const gridRows = rows.map((row) => ({ row, cells: splitCells(row) }));
      const cellRows = new Map();
      gridRows.forEach((r, i) => {
        if (linedUp(r, gridRows[i - 1]) || linedUp(r, gridRows[i + 1]))
          for (const c of r.row) cellRows.set(c, r);
      });
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
            if (
              !/[a-z]{2}/u.test(label) ||
              run.every(DeepRead.Typography.monospace) ||
              /[_/][\w]+[_/]|\w_\w/u.test(label)
            )
              continue;
            if (
              !/\s/u.test(label) &&
              !/^(?:method|model|configuration|role|name|dataset|size|time|type|average|mean|overall|total|baseline|yes|no|training|test|validation|accuracy|score|input|output|default|steps|parameters|layers|views|resolution|dispatch|wall)$/iu.test(
                label
              )
            )
              continue;
            addFrame(run, s.item, "table_label", "cell-" + ids.get(run[0]));
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
        const occupied = [];
        for (const [i, item] of items.entries()) {
          if (!item.bbox || ["image", "figure", "chart"].includes(item.type)) continue;
          const span = streams[i];
          if (!span) {
            occupied.push(regionOf(item.bbox));
            continue;
          }
          for (const row of rows) {
            if (ids.get(row.at(-1)) < span.start || ids.get(row[0]) >= span.end) continue;
            const owned = row.filter((c) => ids.get(c) >= span.start && ids.get(c) < span.end);
            if (owned.length) occupied.push(union(owned));
          }
        }
        const rotated = [];
        let run = [];
        for (const c of chars) {
          if (run.length && (c.rotation !== run[0].rotation || !c.rect)) {
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
        const labels = [...printedRows.flatMap(splitCells), ...rotated];
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
          for (const cell of labels) {
            const first = cell.findIndex(
              (c) => /[A-Za-z]/u.test(glyph(c)) && !/math|symbol/iu.test(c.fontName || "")
            );
            if (first < 0) continue;
            const run = cell.slice(first);
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
            if (!typed && occupied.some((b) => b[1] > box[3] + 2 && b[3] < y && b[0] < x && b[2] > x)) continue;
            if (run.some((c) => claimedLabels.has(c)) || label.length > 75 || /[=<>⟨⟩_{}]/u.test(label))
              continue;
            const words = label.match(/[a-z]{2,}/giu) || [];
            const singleWord =
              /^[A-Z]?[a-z]{2,}(?:-[a-z]{2,})*$/u.test(label) &&
              !/^(?:argmax|argmin|min|max|log|exp|sin|cos|tan|fps|flops|sigmoid|softmax)$/iu.test(label);
            if (words.length < 2 && !singleWord && !/^(?:frozen|trainable)$/iu.test(label)) continue;
            if (!typed && !/[a-z]{2}/u.test(label) && !/^(?:frozen|trainable)$/iu.test(label)) continue;
            candidates.push(run);
          }
          if (!typed && candidates.length < 2 && !candidates.some((run) => run[0].rotation)) continue;
          for (const run of candidates) {
            if (run.some((c) => claimedLabels.has(c))) continue;
            addFrame(run, fig, "figure_label", "label-" + ids.get(run[0]));
            additions.at(-1).visualOwner = typed ? fig.id : undefined;
            run.forEach((c) => claimedLabels.add(c));
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
      // Coalesce parser fragments only where the physical PDF itself puts two
      // sides of a broken script in the same line. Retain display equations.
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
      for (const s of streams) {
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
          const sameLine =
            !gap.slice(0, -1).some(breaks) &&
            (gap.some((c) => c.scriptContinuation) ||
              (Math.abs(a.baseline - b.baseline) < em * 0.7 && Math.abs(a.rect[2] - b.rect[0]) < em * 1.5));
          const mathGap =
            gap.length <= 34 &&
            gap.some((c) => c.scriptContinuation) &&
            !/[a-z]{3}/iu.test(text(gap).replace(/max|min|exp|sin|cos|log/giu, ""));
          if (s.start < prev.end || (s.start - prev.end > 8 && !mathGap) || (!sameLine && !wrap)) finish();
        }
        group.push(s);
      }
      finish();
    }
  }
  DeepRead.ParallelFrames = { repairScripts, recover };
})();
