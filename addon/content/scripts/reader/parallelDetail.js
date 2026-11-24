/* Render the open PDF again at viewing or print density without reflowing text.
 * License: AGPL-3.0-or-later */
(function () {
  const baseDensity = (reader, page) => reader.source.canvas.width / page.width;

  async function raster(reader, page, density, signal) {
    const owner = reader.controller?.signal;
    const limit = Math.min(
      Math.ceil(density),
      6,
      6144 / Math.max(page.width, page.height),
      Math.sqrt(12000000 / (page.width * page.height))
    );
    if (
      reader.page !== page ||
      owner?.aborted ||
      signal?.aborted ||
      !page.renderInto ||
      limit <= baseDensity(reader, page) * 1.1
    )
      return null;
    if (page.detailDensity >= limit - 0.01) return page.detailCanvas;
    if (page.detailJob) {
      await page.detailJob;
      if (page.detailDensity >= limit - 0.01) return page.detailCanvas;
      if (reader.page !== page || owner?.aborted || signal?.aborted || page.detailFailed) return null;
      return raster(reader, page, density, signal);
    }
    if (page.detailFailed) return null;
    const job = (async () => {
      // PDF.js registers remapped glyphs on its own document. A canvas from
      // the outer reader paints the private font codes as missing-glyph boxes.
      const canvas = reader.session.overlay.pdfDoc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.ceil(page.width * limit);
      canvas.height = Math.ceil(page.height * limit);
      let task;
      const abort = () => task?.cancel();
      owner?.addEventListener("abort", abort, { once: true });
      if (signal !== owner) signal?.addEventListener("abort", abort, { once: true });
      try {
        task = page.renderInto(canvas, limit);
        await task.promise;
        if (reader.page !== page || owner?.aborted || signal?.aborted) return null;
        const old = page.detailCanvas;
        page.detailCanvas = canvas;
        page.detailDensity = limit;
        canvas.className = "dr-parallel-detail";
        canvas.setAttribute("aria-hidden", "true");
        if (old) {
          old.remove();
          old.width = old.height = 0;
        }
        return canvas;
      } catch (error) {
        if (!owner?.aborted && !signal?.aborted) {
          page.detailFailed = true;
          DeepRead.log("Higher-resolution page unavailable", String(error));
        }
        return null;
      } finally {
        owner?.removeEventListener("abort", abort);
        if (signal !== owner) signal?.removeEventListener("abort", abort);
        if (canvas !== page.detailCanvas) canvas.width = canvas.height = 0;
      }
    })();
    page.detailJob = job;
    try {
      return await job;
    } finally {
      if (page.detailJob === job) page.detailJob = null;
    }
  }

  function present(reader, page, detail) {
    if (
      !detail ||
      reader.page !== page ||
      reader.exportJob ||
      !page.dirtyRects ||
      page.screenDensity <= baseDensity(reader, page) * 1.1
    )
      return;
    if (detail.parentNode === reader.source.stage && page.targetDetail?.parentNode === reader.target.stage)
      return;
    const source = reader.source.canvas,
      translated = reader.target.canvas;
    const result = page.targetDetail || reader.doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    page.targetDetail = result;
    result.className = "dr-parallel-detail";
    result.setAttribute("aria-hidden", "true");
    result.width = detail.width;
    result.height = detail.height;
    const ctx = result.getContext("2d");
    ctx.drawImage(detail, 0, 0);
    const sx = source.width / page.width,
      sy = source.height / page.height;
    const dx = result.width / source.width,
      dy = result.height / source.height;
    // Only these rectangles differ between the original and the cleaned
    // backing canvas. Chinese text and inline formulas are DOM layers above it.
    for (const r of page.dirtyRects) {
      const x = Math.max(0, Math.floor(r.left * sx)),
        y = Math.max(0, Math.floor(r.top * sy));
      const w = Math.min(source.width, Math.ceil((r.left + r.width) * sx)) - x;
      const h = Math.min(source.height, Math.ceil((r.top + r.height) * sy)) - y;
      if (w > 0 && h > 0) ctx.drawImage(translated, x, y, w, h, x * dx, y * dy, w * dx, h * dy);
    }
    source.after(detail);
    translated.after(result);
    DeepRead.ParallelInk.sharpen(reader.target.stage, detail, page);
    DeepRead.ParallelInk.sharpen(reader.extra, detail, page);
  }

  function refresh(reader, page) {
    if (!page?.screenDensity || reader.exportJob || !page.dirtyRects) return;
    if (page.screenDensity <= baseDensity(reader, page) * 1.1) {
      page.detailCanvas?.remove();
      page.targetDetail?.remove();
      return;
    }
    raster(reader, page, page.screenDensity, reader.controller.signal)
      .then((detail) => present(reader, page, detail))
      .catch((error) => DeepRead.log("Could not display page detail", String(error)));
  }

  function release(page) {
    if (!page) return;
    for (const canvas of [page.detailCanvas, page.targetDetail]) {
      if (canvas) {
        canvas.remove();
        canvas.width = canvas.height = 0;
      }
    }
    page.detailCanvas = page.targetDetail = null;
  }
  DeepRead.ParallelDetail = { raster, refresh, release };
})();
