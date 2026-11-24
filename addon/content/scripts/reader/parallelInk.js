/* Project PDF coordinates and reinsert inline glyphs from the original PDF.js raster.
 * Only mathematical ink is copied. Surrounding translated prose remains selectable text.
 * License: AGPL-3.0-or-later */
(function () {
  const node = (doc, tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  function project(rect, t) {
    const [a, b, c, d, e, f] = t;
    const x1 = a * rect[0] + c * rect[1] + e,
      x2 = a * rect[2] + c * rect[3] + e;
    const y1 = b * rect[0] + d * rect[1] + f,
      y2 = b * rect[2] + d * rect[3] + f;
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }
  function orientation(unit, page) {
    const [a, b, c, d] = page.transform,
      [dx, dy] = unit.direction || [1, 0];
    return (Math.round((Math.atan2(b * dx + d * dy, a * dx + c * dy) * 2) / Math.PI) + 4) % 4;
  }
  function sampleBounds(rect, page, pixels) {
    const r = project(rect, page.transform),
      kx = pixels.width / page.width,
      ky = pixels.height / page.height;
    return {
      x0: Math.max(0, Math.floor(r.left * kx)),
      y0: Math.max(0, Math.floor(r.top * ky)),
      x1: Math.min(pixels.width, Math.ceil((r.left + r.width) * kx)),
      y1: Math.min(pixels.height, Math.ceil((r.top + r.height) * ky)),
      kx,
      ky
    };
  }
  // Table rules often touch the top/bottom of a text box. Estimate the flat
  // cell colour inside the box and leave straight rules crossing it intact.
  function labelPatch(pixels, box, page, em) {
    const { x0, y0, x1, y1, kx, ky } = sampleBounds(box, page, pixels);
    const w = x1 - x0,
      h = y1 - y0;
    if (w < 2 || h < 2) return null;
    const bins = new Map(),
      p = pixels.data;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const k = 4 * (y * pixels.width + x),
          r = p[k],
          g = p[k + 1],
          b = p[k + 2],
          bin = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        const cell = bins.get(bin);
        if (cell) cell.n++;
        else bins.set(bin, { n: 1, r, g, b });
      }
    const bg = [...bins.values()].sort((a, b) => b.n - a.n)[0];
    if (bg.n < w * h * 0.43) return null;
    function ink(x, y) {
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return false;
      const k = 4 * (y * pixels.width + x);
      return Math.max(Math.abs(p[k] - bg.r), Math.abs(p[k + 1] - bg.g), Math.abs(p[k + 2] - bg.b)) > 30;
    }
    const horizontal = new Set(),
      vertical = new Set();
    for (let y = y0; y < y1; y++) {
      if (!ink(x0 - 2, y) || !ink(x1 + 1, y)) continue;
      let count = 0;
      for (let x = x0; x < x1; x++) if (ink(x, y)) count++;
      if (count > w * 0.84) horizontal.add(y);
    }
    for (let x = x0; x < x1; x++) {
      if (!ink(x, y0 - 2) || !ink(x, y1 + 1)) continue;
      let count = 0;
      for (let y = y0; y < y1; y++) if (ink(x, y)) count++;
      if (count > h * 0.84) vertical.add(x);
    }
    const free = (start, sign) => {
      let n = 0;
      while (n < 2 * em * kx) {
        const col = start + sign * n;
        if (col < 0 || col >= pixels.width) break;
        let occupied = false;
        for (let y = y0; y < y1; y++)
          if (!horizontal.has(y) && ink(col, y)) {
            occupied = true;
            break;
          }
        if (occupied) break;
        n++;
      }
      return Math.max(0, (n - 1) / kx);
    };
    return {
      color: [bg.r, bg.g, bg.b],
      left: free(x0 - 1, -1),
      right: free(x1, 1),
      erase(ctx) {
        const patch = ctx.getImageData(x0, y0, w, h);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            if (horizontal.has(y) || vertical.has(x)) continue;
            const k = 4 * ((y - y0) * w + x - x0);
            patch.data[k] = bg.r;
            patch.data[k + 1] = bg.g;
            patch.data[k + 2] = bg.b;
          }
        ctx.putImageData(patch, x0, y0);
      }
    };
  }

  function inkColor(token, page, pixels) {
    let dark = 0,
      colored = 0,
      red = 0,
      green = 0,
      blue = 0;
    for (const rect of token.samples || []) {
      const { x0, y0, x1, y1 } = sampleBounds(rect, page, pixels);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const at = (y * pixels.width + x) * 4,
            r = pixels.data[at],
            g = pixels.data[at + 1],
            b = pixels.data[at + 2];
          if (Math.min(r, g, b) > 125) continue;
          dark++;
          if (Math.max(r, g, b) - Math.min(r, g, b) < 75) continue;
          red += r;
          green += g;
          blue += b;
          colored++;
        }
    }
    return colored >= 3 && colored > dark * 0.6
      ? `rgb(${Math.round(red / colored)},${Math.round(green / colored)},${Math.round(blue / colored)})`
      : "";
  }
  function sourceLink(token, page) {
    const links = page.links || [];
    for (const box of token.samples || []) {
      const x = (box[0] + box[2]) / 2,
        y = (box[1] + box[3]) / 2;
      const found = links.findIndex(
        (l) =>
          l.rect && x >= l.rect[0] - 0.5 && x <= l.rect[2] + 0.5 && y >= l.rect[1] - 0.5 && y <= l.rect[3] + 0.5
      );
      if (found >= 0) return found;
    }
    return -1;
  }
  function formula(doc, token, unit, page, source, pixels) {
    const { x0, y0, x1, y1, kx, ky } = sampleBounds(token.clip, page, pixels);
    const tight = sampleBounds(token.rect, page, pixels);
    if (x1 <= x0 || y1 <= y0) return doc.createTextNode(token.display);
    // Trim only paper-coloured margins. Missing Unicode parentheses and radical
    // strokes inside this bounded region must remain part of the original symbol.
    const at = (y0 * pixels.width + x0) * 4,
      bg = pixels.data.subarray(at, at + 3);
    let left = x1,
      top = y1,
      right = x0,
      bottom = y0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const j = (y * pixels.width + x) * 4;
        if (
          Math.max(
            Math.abs(pixels.data[j] - bg[0]),
            Math.abs(pixels.data[j + 1] - bg[1]),
            Math.abs(pixels.data[j + 2] - bg[2])
          ) < 45
        )
          continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    // For dark boxes or scans, keep the original measured glyph extent as well.
    left = Math.max(x0, Math.min(left - 1, tight.x0));
    top = Math.max(y0, Math.min(top - 1, tight.y0));
    right = Math.min(x1, Math.max(right + 1, tight.x1));
    bottom = Math.min(y1, Math.max(bottom + 1, tight.y1));
    const w = Math.max(1, right - left),
      ht = Math.max(1, bottom - top),
      angle = orientation(unit, page);
    const bitmap = node(doc, "canvas");
    bitmap.dataset.mathCrop=[left/kx,top/ky,w/kx,ht/ky,angle].join(" ");
    drawCrop(bitmap,source,left,top,w,ht,angle);
    const [a, b, c, d, e, f] = page.transform,
      em = unit.size * Math.hypot(a, b);
    const baseX = a * token.rect[0] + c * token.baseline + e,
      baseY = b * token.rect[0] + d * token.baseline + f;
    const widthEm = (angle % 2 ? ht / ky : w / kx) / em,
      heightEm = (angle % 2 ? w / kx : ht / ky) / em;
    const delta = [bottom / ky - baseY, baseX - left / kx, baseY - top / ky, right / kx - baseX][angle];
    const depthEm = Math.max(0, Math.min(heightEm, delta / em));
    const span = node(doc, "span");
    span.className = "dr-parallel-atom";
    span.setAttribute("role", "math");
    span.setAttribute("aria-label", token.display);
    Object.assign(span.dataset, { widthEm, heightEm, depthEm });
    Object.assign(span.style, { width: widthEm + "em", height: heightEm + "em", verticalAlign: -depthEm + "em" });
    bitmap.setAttribute("aria-hidden", "true");
    const accessible = node(doc, "span");
    accessible.className = "dr-parallel-atom-text";
    accessible.textContent = token.display;
    span.append(bitmap, accessible);
    return span;
  }
  function drawCrop(bitmap, source, left, top, w, h, angle) {
    const width = Math.max(1, Math.round(w)),
      height = Math.max(1, Math.round(h));
    bitmap.width = angle % 2 ? height : width;
    bitmap.height = angle % 2 ? width : height;
    const ctx = bitmap.getContext("2d");
    if (angle === 1) ctx.setTransform(0, -1, 1, 0, 0, width);
    else if (angle === 2) ctx.setTransform(-1, 0, 0, -1, width, height);
    else if (angle === 3) ctx.setTransform(0, 1, -1, 0, height, 0);
    ctx.drawImage(source, left, top, w, h, 0, 0, width, height);
  }

  function sharpen(root, source, page) {
    const sx = source.width / page.width,
      sy = source.height / page.height;
    for (const bitmap of root.querySelectorAll("canvas[data-math-crop]")) {
      const [x, y, w, h, angle] = bitmap.dataset.mathCrop.split(" ").map(Number);
      if (bitmap.width >= Math.round(angle % 2 ? h * sy : w * sx)) continue;
      drawCrop(bitmap, source, x * sx, y * sy, w * sx, h * sy, angle);
    }
  }

  function materialize(doc, frag, unit, page, source, pixels) {
    const byID = new Map((unit.tokens || []).map((t) => [t.id, t]));
    if (!byID.size) return frag;
    const walker = doc.createTreeWalker(frag, 4),
      nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const text of nodes) {
      const parts = text.nodeValue.split(/(⟦D+\d+⟧)/u);
      if (parts.length === 1) continue;
      const filled = doc.createDocumentFragment();
      for (const part of parts) {
        const token = byID.get(part);
        if (!token) {
          filled.append(part);
          continue;
        }
        if (token.kind === "math" && pixels && token.clip) {
          filled.append(formula(doc, token, unit, page, source, pixels));
          continue;
        }
        if (token.kind === "tex") {
          const tex = token.display.replace(/^\$|\$$|^\\\(|\\\)$/gu, "").trim();
          filled.append(DeepRead.Overlay.inlineMarkdown(doc, "\\(" + tex + "\\)"));
          continue;
        }
        const link = sourceLink(token, page),
          el = node(doc, link >= 0 ? "a" : "span");
        if (link >= 0) {
          el.href = "#";
          el.dataset.sourceLink = link;
        }
        if (unit.headingNumber?.id === token.id) {
          el.className = "dr-parallel-heading-number";
          el.style.width = unit.headingNumber.width + "px";
        }
        if (token.mono || token.kind==="code") el.classList.add("dr-paper-code");
        if (pixels) el.style.color = inkColor(token, page, pixels);
        let value = doc.createTextNode(token.display);
        if (token.bold) {
          const strong = node(doc, "strong");
          strong.append(value);
          value = strong;
        }
        if (token.italic) {
          const em = node(doc, "em");
          em.append(value);
          value = em;
        }
        el.append(value);
        filled.append(el);
      }
      text.replaceWith(filled);
    }
    if (/^zh(?:-|$)/i.test(page.language)) DeepRead.PaperType.spaceChinese(frag);
    return frag;
  }
  DeepRead.ParallelInk = { project, orientation, materialize, sharpen, inkColor, sourceLink, labelPatch };
})();
