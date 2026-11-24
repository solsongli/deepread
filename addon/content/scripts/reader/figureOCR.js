/* Locate printed English plot labels without changing the original chart data.
 * The OCR worker loads only packaged code and English language data. */
(function () {
  const raw = (o) => o?.wrappedJSObject || o;
  const keyFor = (index) => "figure-labels:v1:" + index;
  const identity = [1, 0, 0, 1, 0, 0];
  function compose([a, b, c, d, e, f], [g, h, i, j, k, l]) {
    return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
  }

  async function embeddedImages(reader, index) {
    const { app, pdfWin } = reader.session.overlay;
    const pdf = raw(await app.pdfDocument.getPage(index + 1)),
      lib = raw(pdfWin).pdfjsLib;
    if (!lib?.OPS || !pdf.getOperatorList) return [];
    const ops = lib.OPS,
      list = raw(await pdf.getOperatorList()),
      stack = [],
      boxes = [];
    const [a, b, c, d] = pdf.view,
      area = (c - a) * (d - b);
    let matrix = identity;
    for (let i = 0; i < list.fnArray.length; i++) {
      const op = list.fnArray[i],
        args = list.argsArray[i];
      if (op === ops.save || op === ops.paintFormXObjectBegin) {
        stack.push(matrix);
        if (op === ops.paintFormXObjectBegin && args?.[0]) matrix = compose(matrix, args[0]);
      } else if (op === ops.restore || op === ops.paintFormXObjectEnd) matrix = stack.pop() || identity;
      else if (op === ops.transform) matrix = compose(matrix, args);
      else if (op === ops.paintImageXObject || op === ops.paintInlineImageXObject) {
        const [w, skewY, skewX, h, x, y] = matrix;
        if (Math.abs(skewX) > 0.05 || Math.abs(skewY) > 0.05 || w < 70 || h < 28 || area <= 0) continue;
        const fraction = (w * h) / area;
        if (fraction < 0.012 || fraction > 0.8 || (y + h > b + (d - b) * 0.9 && w < (c - a) * 0.4)) continue;
        if (x < a - 1 || y < b - 1 || x + w > c + 1 || y + h > d + 1) continue;
        const rect = [x, y, x + w, y + h];
        if (!boxes.some((other) => rect.every((v, j) => Math.abs(v - other[j]) < 1))) boxes.push(rect);
      }
    }
    return boxes;
  }

  function tsvLines(tsv) {
    const byLine = new Map();
    for (const line of tsv.split(/\r?\n/)) {
      const values = line.split("\t");
      if (values[0] !== "5" || !values[11]?.trim()) continue;
      const [x, y, w, h, confidence] = values.slice(6, 11).map(Number);
      if (!(w > 0 && h > 0 && Number.isFinite(confidence))) continue;
      const key = values.slice(1, 5).join("/");
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push({ x, y, w, h, confidence, text: values.slice(11).join(" ").trim() });
    }
    const output = [];
    for (const words of byLine.values()) {
      const text = words.map((w) => w.text).join(" ");
      const supportedPhrase = words.filter((w) => w.confidence >= 90).length >= 3;
      if (
        !/[a-z]{2}/.test(text) ||
        text.length < 3 ||
        text.length > 140 ||
        words.some((w) => w.confidence < (supportedPhrase ? 78 : 84)) ||
        words.reduce((s, w) => s + w.confidence, 0) / words.length < 89
      )
        continue;
      const x = Math.min(...words.map((w) => w.x)),
        y = Math.min(...words.map((w) => w.y));
      const X = Math.max(...words.map((w) => w.x + w.w)),
        Y = Math.max(...words.map((w) => w.y + w.h));
      if (
        X - x < (Y - y) * 0.75 ||
        words.some((w, i) => i && w.x - words[i - 1].x - words[i - 1].w > 2.5 * (Y - y))
      )
        continue;
      output.push({ x, y, X, Y, text });
    }
    return output;
  }

  function whiteBackground(data, x, y) {
    const j = (y * data.width + x) * 4,
      p = data.data;
    return (
      Math.min(p[j], p[j + 1], p[j + 2]) >= 229 &&
      Math.max(p[j], p[j + 1], p[j + 2]) - Math.min(p[j], p[j + 1], p[j + 2]) < 13
    );
  }

  function labelBoxes(tsv, image, source, scale, chars) {
    const labels = [];
    for (const line of tsvLines(tsv)) {
      const { x, y, X, Y, text } = line;
      if (x < 3 || y < 3 || X > image.width - 3 || Y > image.height - 3) continue;
      let ring = 0,
        clear = 0,
        colored = 0,
        ink = 0;
      for (let row = y - 2; row <= Y + 1; row++)
        for (let col = x - 2; col <= X + 1; col++) {
          const j = (row * image.width + col) * 4,
            p = image.data;
          if (row < y || row >= Y || col < x || col >= X) {
            ring++;
            if (whiteBackground(image, col, row)) clear++;
            continue;
          }
          if (Math.min(p[j], p[j + 1], p[j + 2]) < 170) {
            ink++;
            if (Math.max(p[j], p[j + 1], p[j + 2]) - Math.min(p[j], p[j + 1], p[j + 2]) > 45) colored++;
          }
        }
      if (clear < ring * 0.93 || ink < 5 || colored > ink * 0.15) continue;
      const mask = [
        source[0] + (x - 2) / scale,
        source[3] - (Y + 2) / scale,
        source[0] + (X + 2) / scale,
        source[3] - (y - 2) / scale
      ];
      if (
        chars.some(
          (c) =>
            c.rect &&
            (c.rect[0] + c.rect[2]) / 2 >= mask[0] &&
            (c.rect[0] + c.rect[2]) / 2 <= mask[2] &&
            (c.rect[1] + c.rect[3]) / 2 >= mask[1] &&
            (c.rect[1] + c.rect[3]) / 2 <= mask[3]
        )
      )
        continue;
      const size = (Y - y) / scale / (/[gjpqy]/.test(text) ? 0.9 : 0.75);
      if (size < 3 || size > 30) continue;
      // Allow a short translation to use blank paper next to the label. Stop
      // as soon as any neighbouring mark, grid or colour key is encountered.
      let edge = X + 2;
      for (; edge < Math.min(image.width - 1, X + size * scale * 2.8); edge++) {
        let white = true;
        for (let py = y - 2; py <= Y + 1; py++)
          if (!whiteBackground(image, edge, py)) {
            white = false;
            break;
          }
        if (!white) break;
      }
      const centered =
        y / image.height < 0.22 && text.includes(" ") && x > image.width * 0.12 && X < image.width * 0.87;
      const freeRows = (start, step) => {
        let n = 0;
        for (; n < size * scale * 0.7; n++) {
          const py = start + step * n;
          if (py < 0 || py >= image.height) break;
          let clear = true;
          for (let px = x - 1; px <= X + 1; px++)
            if (!whiteBackground(image, px, py)) {
              clear = false;
              break;
            }
          if (!clear) break;
        }
        return Math.max(0, n - 1) / scale;
      };
      const rect = [mask[0], mask[1], centered ? mask[2] : source[0] + edge / scale, mask[3]];
      labels.push({ text, rect, mask, size, centered, above: freeRows(y - 3, -1), below: freeRows(Y + 2, 1) });
    }
    const sizes = labels.map((l) => l.size);
    for (const [i, label] of labels.entries()) {
      const peers = labels
        .flatMap((other, j) =>
          !label.centered &&
          !other.centered &&
          Math.abs(other.rect[0] - label.rect[0]) < label.size &&
          Math.abs(sizes[j] - sizes[i]) < sizes[i] * 0.25
            ? [sizes[j]]
            : []
        )
        .sort((a, b) => a - b);
      const nominal = peers.length >= 3 ? peers[Math.floor(peers.length / 2)] : sizes[i];
      const top = label.mask[3] + label.above,
        bottom = label.mask[1] - label.below;
      const centre = (label.mask[1] + label.mask[3]) / 2;
      const spacing = Math.min(
        Infinity,
        ...labels
          .filter((other) => other !== label && Math.abs(other.mask[0] - label.mask[0]) < nominal)
          .map((other) => Math.abs((other.mask[1] + other.mask[3]) / 2 - centre))
      );
      label.size = Math.min(nominal * (peers.length >= 3 ? 1.25 : 1.16), (top - bottom) / 1.09, spacing * 0.72);
      const height = label.size * 1.09,
        mid = (label.mask[3] + label.mask[1]) / 2;
      label.rect[1] = Math.max(bottom, Math.min(top - height, mid - height / 2));
      label.rect[3] = label.rect[1] + height;
      delete label.above;
      delete label.below;
    }
    const title = labels.find((label) => label.centered)?.text;
    if (title) for (const label of labels) label.hint = title;
    return labels;
  }

  async function discover(reader, page) {
    if (page.imageCandidates !== undefined) return;
    const cache = await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint, keyFor(page.index));
    page.rasterLabels = Array.isArray(cache) ? cache : [];
    if (Array.isArray(cache)) {
      page.imageCandidates = [];
      return;
    }
    try {
      page.imageCandidates = await embeddedImages(reader, page.index);
    } catch (error) {
      page.imageCandidates = [];
      page.figureError = true;
      DeepRead.log("Could not inspect embedded images", String(error));
    }
  }

  async function recognize(reader, page, signal) {
    await discover(reader, page);
    if (!page.imageCandidates.length || signal.aborted) return;
    const overlay = reader.session.overlay,
      win = overlay.pdfWin,
      pdf = raw(await overlay.app.pdfDocument.getPage(page.index + 1));
    let worker, task, rejectPending;
    const abort = () => {
      task?.cancel();
      worker?.terminate();
      rejectPending?.(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    const labels = [];
    try {
      for (const rect of page.imageCandidates) {
        if (signal.aborted) break;
        const scale = Math.min(4.8, 1800 / (rect[2] - rect[0]), 1500 / (rect[3] - rect[1]));
        const viewport = raw(pdf.getViewport(Components.utils.cloneInto({ scale, rotation: 0 }, win)));
        const bounds = DeepRead.ParallelInk.project(rect, viewport.transform);
        const canvas = overlay.pdfDoc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        canvas.width = Math.max(1, Math.ceil(bounds.width));
        canvas.height = Math.max(1, Math.ceil(bounds.height));
        try {
          const ctx = canvas.getContext("2d");
          const args = raw(Components.utils.createObjectIn(win));
          args.canvasContext = raw(ctx);
          args.viewport = viewport;
          args.transform = Components.utils.cloneInto([1, 0, 0, 1, -bounds.left, -bounds.top], win);
          task = raw(pdf.render(args));
          await task.promise;
          task = null;
          if (signal.aborted) break;
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let white = 0,
            total = 0;
          for (let y = 4; y < image.height; y += 12)
            for (let x = 4; x < image.width; x += 12) {
              total++;
              if (whiteBackground(image, x, y)) white++;
            }
          if (!total || white / total < 0.5) continue;
          // A colour swatch can be read as an extra letter of its legend
          // entry. Remove chromatic ink only from the worker's scratch input.
          // The original pixels still decide which label areas may be erased.
          const neutral = ctx.createImageData(image.width, image.height);
          neutral.data.set(image.data);
          for (let i = 0; i < neutral.data.length; i += 4) {
            const p = neutral.data;
            if (Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]) > 38)
              p[i] = p[i + 1] = p[i + 2] = 255;
          }
          ctx.putImageData(neutral, 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          const bytes = await blob.arrayBuffer();
          if (signal.aborted) break;
          worker ||= new (Zotero.getMainWindow().ChromeWorker)(
            "chrome://deepread/content/scripts/reader/figureOCRWorker.js"
          );
          const tsv = await new Promise((resolve, reject) => {
            rejectPending = reject;
            worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.tsv));
            worker.onerror = (e) => reject(new Error(e.message || "OCR worker failed"));
            worker.postMessage(bytes, [bytes]);
          });
          rejectPending = null;
          labels.push(...labelBoxes(tsv, image, rect, scale, page.chars));
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
      if (signal.aborted) return;
      await DeepRead.Store.saveComparisonData(reader.session.key, page.fingerprint, keyFor(page.index), labels);
      page.rasterLabels = labels;
      page.imageCandidates = [];
    } finally {
      signal.removeEventListener("abort", abort);
      worker?.terminate();
    }
  }

  DeepRead.FigureOCR = { discover, recognize };
})();
