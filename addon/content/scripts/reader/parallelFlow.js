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

  function arrange(entries, page, hasInk) {
    for (const e of entries) {
      e.frame = turn(e.rect, e.angle, page.width, page.height);
      e.occupied = e.rect;
    }
    const base = page.styleProfile.base,
      styled = entries.filter((e) => e.style);
    // A one-line heading's source box can be only as wide as its ink.
    // Borrow blank space within the same text column before breaking its translation.
    for (const e of styled) {
      if (
        !["heading", "subheading", "documentTitle", "reference"].includes(e.style.role) ||
        e.unit.rects.length !== 1 ||
        !(e.metrics.lines?.length > 1) ||
        !e.metrics.rewrap
      )
        continue;
      const frame = e.frame,
        middle = frame.left + frame.width / 2;
      const columnRole = e.style.role === "reference" ? "reference" : "body";
      const columns = styled.filter((o) => o.angle === e.angle && o.style.role === columnRole);
      let column;
      if (e.style.role === "documentTitle" && e.unit.centered && columns.length) {
        const left = Math.min(...columns.map((o) => o.frame.left));
        const end = Math.max(...columns.map((o) => right(o.frame)));
        column = { left, width: end - left };
      } else {
        column = columns
          .map((o) => o.frame)
          .filter(
            (r) =>
              Math.min(Math.abs(r.top - bottom(frame)), Math.abs(frame.top - bottom(r))) < base * 8 &&
              r.width > frame.width &&
              (Math.abs(r.left - frame.left) <= base * 1.65 ||
                (e.unit.centered && Math.abs(r.left + r.width / 2 - middle) < base))
          )
          .sort((a, b) => Math.abs(a.top - bottom(frame)) - Math.abs(b.top - bottom(frame)))[0];
      }
      if (!column) continue;
      const room = e.unit.centered
        ? Math.min(frame.left - column.left, right(column) - right(frame))
        : right(column) - right(frame);
      if (room < 1) continue;
      const strips = [{ ...frame, left: right(frame), width: room }];
      if (e.unit.centered) strips.push({ ...frame, left: frame.left - room, width: room });
      if (
        strips.some((r) => {
          const box = screen(r, e.angle, page);
          return hasInk(box) || entries.some((o) => o !== e && overlaps(box, o.occupied));
        })
      )
        continue;
      if (e.unit.centered) frame.left -= room;
      frame.width += room * strips.length;
      e.metrics = e.metrics.rewrap(frame.width);
      e.rect = e.occupied = screen(frame, e.angle, page);
    }
    for (const e of styled) {
      if (!e.metrics.wide || !e.metrics.rewrap || e.unit.justified) continue;
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
    const scale = page.transform ? Math.hypot(page.transform[0], page.transform[1]) : 1;
    for (const e of styled) {
      // Use the original baseline even when a title gained side room or the
      // source bounds include a tall superscript. OCR-only frames use their top.
      let top = e.frame.top;
      if (Number.isFinite(e.unit.sourceBaseline) && Number.isFinite(e.metrics.firstBaseline)) {
        const source = turn(e.sourceRect || e.rect, e.angle, page.width, page.height);
        top = source.top + (e.unit.rect[3] - e.unit.sourceBaseline) * scale - e.metrics.firstBaseline;
      }
      e.top = Math.max(0, top);
      const inset = e.metrics.lines?.[0]?.top || 0;
      e.occupied = screen(
        {
          ...e.frame,
          top: e.top + inset,
          height: Math.max(0.3, Math.min(e.metrics.inkHeight, bottom(e.frame) - e.top) - inset)
        },
        e.angle,
        page
      );
    }
    for (const e of styled.sort(
      (a, b) => a.angle - b.angle || a.top - b.top || a.frame.left - b.frame.left
    )) {
      const { frame, angle } = e,
        preferred = e.top,
        axisHeight = angle % 2 ? page.width : page.height;
      let metrics = e.metrics;
      const others = entries
        .filter((o) => o !== e)
        .map((o) => turn(o.occupied, angle, page.width, page.height));
      const across = (r) => Math.min(right(r), right(frame)) - Math.max(r.left, frame.left) > 0.3;
      let limit = Math.min(
        axisHeight,
        bottom(frame) + Math.max(4 * base, Math.min(axisHeight * 0.08, 6 * base))
      );
      for (const r of others) if (across(r) && r.top > preferred + 0.3) limit = Math.min(limit, r.top);
      for (const r of page.folios || []) {
        const f = turn(r, angle, page.width, page.height);
        if (f.top > preferred && f.top > axisHeight * 0.86) limit = Math.min(limit, f.top - base * 0.65);
      }
      const free = (r) => !others.some((o) => overlaps(o, r)) && !hasInk(screen(r, angle, page));
      function availableAt(top) {
        if (top < 0 || top >= limit) return 0;
        if (metrics.lines?.length) {
          let last = 0;
          for (const line of metrics.lines) {
            const rect = {
              left: frame.left + line.left,
              top: top + line.top,
              width: line.width,
              height: line.height
            };
            if (bottom(rect) > limit + 0.15 || !free(rect)) break;
            last = line.top + line.height;
          }
          return Math.min(metrics.inkHeight, last);
        }
        const height = Math.min(limit - top, metrics.inkHeight);
        const original = Math.max(0, bottom(frame) - top);
        return height <= original || free({ ...frame, top: top + original, height: height - original })
          ? height
          : original;
      }
      e.height = availableAt(preferred);
      if (metrics.addedRow && e.height < metrics.inkHeight - 0.45) {
        metrics = e.metrics = metrics.rewrap(parseFloat(e.block.style.width), false);
        e.height = availableAt(preferred);
      }
      // A nearby rule, tall formula or very long translation can need a
      // fraction of an em of clearance. Move only the affected frame, and
      // only if that recovers an entire line. Other anchors stay reserved.
      for (
        let shift = 0.25;
        metrics.inkHeight - e.height > 0.45 && shift <= e.style.size * 0.45;
        shift += 0.25
      ) {
        for (const top of [preferred - shift, preferred + shift]) {
          const height = availableAt(top);
          if (height > e.height + 0.45) {
            e.height = height;
            e.top = top;
          }
        }
      }
      e.overflow = metrics.wide || metrics.inkHeight > e.height + 0.45;
      e.paintRect = screen({ ...frame, top: e.top, height: e.height }, angle, page);
      const inset = metrics.lines?.[0]?.top || 0;
      e.occupied = screen(
        { ...frame, top: e.top + inset, height: Math.max(0, e.height - inset) },
        angle,
        page
      );
    }
  }

  function render(entries, page, canvas) {
    if (!entries.some((e) => e.style)) return;
    page.folios ??= folios(page);
    arrange(entries, page, backdrop(canvas, page));
    page.typeAnchors = [];
    for (const e of entries) {
      if (!e.style) continue;
      const r = e.paintRect,
        block = e.block,
        angle = e.angle;
      block.style.left = r.left + (angle === 1 || angle === 2 ? r.width : 0) + "px";
      block.style.top = r.top + (angle === 2 || angle === 3 ? r.height : 0) + "px";
      block.style.height = e.height + "px";
      if (/heading|Title|Caption/iu.test(e.style.role)) {
        const source = DeepRead.ParallelInk.project(e.unit.rect, page.transform);
        page.typeAnchors.push({
          role: e.style.role,
          source,
          dx: r.left - source.left,
          dy: r.top - source.top
        });
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
