/* Place measured lines in continuous source columns, between fixed artwork.
 * License: AGPL-3.0-or-later */
(function () {
  const right = (r) => r.left + r.width,
    bottom = (r) => r.top + r.height;
  function turn(r, q, w, h) {
    if (q === 1) return { left: r.top, top: w - right(r), width: r.height, height: r.width };
    if (q === 2) return { left: w - right(r), top: h - bottom(r), width: r.width, height: r.height };
    if (q === 3) return { left: h - bottom(r), top: r.left, width: r.height, height: r.width };
    return { ...r };
  }
  const screen = (frame, q, page) =>
    turn(frame, (4 - q) % 4, q % 2 ? page.height : page.width, q % 2 ? page.width : page.height);
  const overlaps = (a, b, t = 0.3) =>
    Math.min(right(a), right(b)) - Math.max(a.left, b.left) > t &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top) > t;

  // Integral image of ink left on the page after the English paragraphs were
  // erased. Even a thin rule or a formula missed by the parser separates runs.
  function backdrop(canvas, page) {
    const scale = Math.min(1, 1000 / Math.max(page.width, page.height));
    const sample = canvas.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    sample.width = Math.ceil(page.width * scale);
    sample.height = Math.ceil(page.height * scale);
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    const w = sample.width,
      h = sample.height,
      stride = w + 1,
      sums = new Uint32Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
      let count = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 211) count++;
        sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + count;
      }
    }
    sample.width = sample.height = 0;
    return (r) => {
      const x0 = Math.max(0, Math.ceil(r.left * scale)),
        x1 = Math.min(w, Math.floor(right(r) * scale));
      const y0 = Math.max(0, Math.ceil(r.top * scale)),
        y1 = Math.min(h, Math.floor(bottom(r) * scale));
      return (
        x1 > x0 &&
        y1 > y0 &&
        sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0] > 0
      );
    };
  }

  function folios(page) {
    const boxes = [],
      view = page.view;
    let run = [];
    function finish() {
      if (!run.length) return;
      const text = run
        .map((c) => c.u ?? c.c ?? "")
        .join("")
        .replace(/\s+/gu, "");
      if (!/^(?:page)?(?:\d{1,4}|[ivxlcdm]{1,6})(?:\/\d{1,4})?$/iu.test(text)) return;
      const rect = DeepRead.Overlay.unionRect(run.map((c) => c.rect));
      if (rect[3] <= view[1] + (view[3] - view[1]) * 0.075)
        boxes.push(DeepRead.ParallelInk.project(rect, page.transform));
    }
    for (const c of page.chars || []) {
      if (c.rect) run.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) {
        finish();
        run = [];
      }
    }
    finish();
    return boxes;
  }

  function family(entry) {
    const role = entry.style?.role;
    if (role?.endsWith("Caption")) return entry.unit.captionGroup;
    if (["body", "heading", "subheading", "list"].includes(role)) return "prose";
    return role;
  }
  function compatible(a, b, base) {
    const r = a.frame,
      s = b.frame,
      gap = s.top - bottom(r);
    if (
      !a.style ||
      !b.style ||
      a.angle !== b.angle ||
      family(a) !== family(b) ||
      ["documentTitle", "contents"].includes(a.style.role) ||
      gap < -1.4 ||
      gap > base * 2.1
    )
      return false;
    const centeredHeading = (unit, head, column) =>
      unit.centered &&
      head.left >= column.left - base * 0.3 &&
      right(head) <= right(column) + base * 0.3 &&
      Math.abs(head.left + head.width / 2 - column.left - column.width / 2) < base * 1.2;
    if (
      Math.abs(r.left - s.left) > base * 1.7 &&
      !centeredHeading(a.unit, r, s) &&
      !centeredHeading(b.unit, s, r)
    )
      return false;
    // A change from half width beside a float to full width below it is an anchor.
    return (
      a.unit.rects.length === 1 ||
      b.unit.rects.length === 1 ||
      Math.abs(r.width - s.width) <= Math.max(base * 2.6, Math.min(r.width, s.width) * 0.18)
    );
  }
  function gapAfter(a, b) {
    if (a.unit.captionGroup != null && a.unit.captionGroup === b.unit.captionGroup) return 0;
    if (a.unit.context && b.unit.context && a.unit.context[0] === b.unit.context[0]) return 0;
    if (
      a.style.role === "body" &&
      b.style.role === "body" &&
      b.frame.top - bottom(a.frame) < a.style.size * 0.6 &&
      !/[.!?。！？:：]["'”’)]*$/u.test(a.unit.source.trim()) &&
      /^\p{Ll}/u.test(b.unit.source.trim())
    )
      return 0;
    return Math.max(a.style.after, b.style.before);
  }

  function arrange(entries, page, hasInk) {
    for (const e of entries) {
      e.frame = turn(e.rect, e.angle, page.width, page.height);
      e.occupied = e.rect;
    }
    const base = page.styleProfile.base,
      styled = entries.filter((e) => e.style);
    for (const e of styled) {
      if (!e.metrics.wide || !e.metrics.rewrap) continue;
      const amount = Math.ceil(e.metrics.excess + 1);
      const edge = e.angle % 2 ? page.height : page.width;
      if (!(amount > 0 && amount <= base * 4 && right(e.frame) + amount < edge)) continue;
      const strip = screen(
        { left: right(e.frame), top: e.frame.top, width: amount, height: e.frame.height },
        e.angle,
        page
      );
      if (hasInk(strip) || entries.some((o) => o !== e && overlaps(strip, o.occupied))) continue;
      e.frame.width += amount;
      e.metrics = e.metrics.rewrap(e.frame.width);
      e.rect = e.occupied = screen(e.frame, e.angle, page);
    }
    let groupID = 0;
    function commit(e, top, height, group, gap, overflow) {
      e.top = top;
      e.height = height;
      e.group = group;
      e.gap = gap;
      e.overflow = overflow;
      e.occupied = screen({ ...e.frame, top, height }, e.angle, page);
    }
    function place(group) {
      const first = group[0],
        id = ++groupID,
        axisHeight = first.angle % 2 ? page.width : page.height;
      const outsiders = entries.filter((e) => !group.includes(e));
      const extra = Math.max(4 * base, Math.min(axisHeight * 0.08, 6 * base));
      const last = group.at(-1);
      const footer = (page.folios || [])
        .map((r) => turn(r, first.angle, page.width, page.height))
        .filter((r) => r.top >= bottom(last.frame) + 1 && r.top > axisHeight * 0.86)
        .reduce((limit, r) => Math.min(limit, r.top - base * 0.65), axisHeight);
      const lower = Math.min(footer, bottom(last.frame) + extra);
      function clear(e, top, height) {
        const rect = screen({ ...e.frame, top, height }, e.angle, page);
        if (top < 0 || top + height > lower + 0.05) return false;
        const blocked = (box) => outsiders.some((o) => overlaps(box, o.occupied)) || hasInk(box);
        if (!blocked(rect)) return true;
        if (height !== e.metrics.inkHeight || !e.metrics.lines?.length) return false;
        return e.metrics.lines.every(
          (line) =>
            !blocked(
              screen(
                { left: e.frame.left + line.left, top: top + line.top, width: line.width, height: line.height },
                e.angle,
                page
              )
            )
        );
      }
      const offsets = [0],
        gaps = [0];
      for (let i = 1; i < group.length; i++) {
        const a = group[i - 1],
          b = group[i];
        gaps[i] = gapAfter(a, b);
        offsets[i] = offsets[i - 1] + a.metrics.height + gaps[i];
      }
      const firstTop = first.frame.top;
      let preferred = firstTop;
      // A sentence that introduces a displayed equation stays with it. Any
      // spare space belongs at the edge of this column run, not in the sentence.
      const equation =
        last.style.role === "body" &&
        /(?:[:：,，]|\b(?:by|as|where|is))\s*$/iu.test(last.unit.source) &&
        (page.equations || [])
          .map((r) => turn(r, first.angle, page.width, page.height))
          .some(
            (r) =>
              r.top >= bottom(last.frame) - 1 &&
              r.top - bottom(last.frame) < base * 2.4 &&
              r.left < right(last.frame) &&
              right(r) > last.frame.left
          );
      if (equation)
        preferred += Math.min(
          base * 4,
          Math.max(0, bottom(last.frame) - firstTop - offsets.at(-1) - last.metrics.inkHeight)
        );
      let failure = 0;
      for (let start = preferred; start >= firstTop - base * 2.5; start -= 1) {
        const bad = group.findIndex(
          (e, i) => e.metrics.wide || !clear(e, start + offsets[i], e.metrics.inkHeight)
        );
        if (bad < 0) {
          group.forEach((e, i) => commit(e, start + offsets[i], e.metrics.inkHeight, id, gaps[i], false));
          return;
        }
        if (start === preferred) failure = bad;
      }
      if (group.length > 1) {
        const at = Math.max(1, failure);
        place(group.slice(0, at));
        place(group.slice(at));
        return;
      }
      // Keep all text reachable in a constrained frame. The existing export
      // path carries the complete passage onto a supplement in this case.
      let height = first.frame.height;
      if (first.metrics.inkHeight > height) {
        for (let h = height + 1; h <= Math.min(first.metrics.inkHeight + 1, lower - firstTop); h++)
          if (clear(first, firstTop + height, h - height)) height = h;
          else break;
      }
      commit(
        first,
        firstTop,
        Math.min(height, first.metrics.inkHeight),
        id,
        0,
        first.metrics.wide || first.metrics.inkHeight > height + 0.45
      );
    }
    const used = new Set();
    for (const e of styled.sort(
      (a, b) => a.angle - b.angle || a.frame.top - b.frame.top || a.frame.left - b.frame.left
    )) {
      if (used.has(e)) continue;
      const chain = [e];
      used.add(e);
      let last = e;
      while (true) {
        const next = styled.find(
          (b) => !used.has(b) && b.frame.top > last.frame.top + 1 && compatible(last, b, base)
        );
        if (!next) break;
        const a = last.frame,
          b = next.frame;
        const between = {
          left: Math.max(a.left, b.left),
          top: bottom(a),
          width: Math.min(right(a), right(b)) - Math.max(a.left, b.left),
          height: b.top - bottom(a)
        };
        const region = screen(between, last.angle, page);
        if (
          between.height > 0 &&
          (hasInk(region) || entries.some((o) => o !== last && o !== next && overlaps(region, o.rect)))
        )
          break;
        chain.push(next);
        used.add(next);
        last = next;
      }
      place(chain);
    }
  }

  function render(entries, page, canvas) {
    if (!entries.some((e) => e.style)) return;
    page.folios ??= folios(page);
    arrange(entries, page, backdrop(canvas, page));
    page.typeAnchors = [];
    for (const e of entries) {
      if (!e.style) continue;
      const r = e.occupied,
        block = e.block,
        angle = e.angle;
      block.style.left = r.left + (angle === 1 || angle === 2 ? r.width : 0) + "px";
      block.style.top = r.top + (angle === 2 || angle === 3 ? r.height : 0) + "px";
      block.style.height = e.height + "px";
      block.dataset.flow = String(e.group);
      block.dataset.paragraphGap = String(e.gap);
      if (/heading|Title|Caption/iu.test(e.style.role)) {
        const source = DeepRead.ParallelInk.project(e.unit.rect, page.transform);
        page.typeAnchors.push({ role: e.style.role, source, dx: r.left - source.left, dy: r.top - source.top });
      }
      if (e.overflow) {
        DeepRead.ParallelTypeset.markOverflow(block);
        page.supplements.push(e.unit);
      }
    }
  }
  function destination(anchors, name, x, y) {
    const label = typeof name === "string" ? name : "";
    if (/^(?:equation|equ|cite|footnote)\b/iu.test(label)) return { x, y };
    const heading = /^(?:chapter|section|subsection|subsubsection|appendix)\b/iu.test(label);
    const caption = /^(?:figure|table|algorithm)\b/iu.test(label);
    let best = null,
      distance = Infinity;
    for (const a of anchors || []) {
      if ((heading && !/heading|Title/iu.test(a.role)) || (caption && !a.role.endsWith("Caption"))) continue;
      const s = a.source,
        above = s.top - y;
      // Named section targets commonly sit a line above the printed heading.
      // An arbitrary destination must actually touch its source frame.
      if (x < s.left - 12 || x > right(s) + 2 || above > (heading || caption ? 24 : 1) || above < -s.height)
        continue;
      if (Math.abs(above) < distance) {
        best = a;
        distance = Math.abs(above);
      }
    }
    return best ? { x: x + best.dx, y: y + best.dy } : { x, y };
  }
  DeepRead.ParallelFlow = { render, arrange, destination };
})();
