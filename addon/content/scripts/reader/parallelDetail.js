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

  function refresh(surface, page) {
    if (!page?.dirtyRects || !(page.screenDensity > baseDensity(surface, page) * 1.1)) return;
    if (!surface.target.stage.querySelector("canvas[data-math-crop]")) return;
    if (
      page.sharpened === page.detailCanvas &&
      page.detailDensity >= Math.min(6, Math.ceil(page.screenDensity))
    )
      return;
    raster(surface, page, page.screenDensity, surface.controller.signal)
      .then((detail) => {
        if (
          !detail ||
          surface.page !== page ||
          surface.controller.signal.aborted ||
          page.sharpened === detail
        )
          return;
        DeepRead.ParallelInk.sharpen(surface.target.stage, detail, page);
        page.sharpened = detail;
      })
      .catch((error) => DeepRead.log("Could not sharpen inline formulas", String(error)));
  }

  function release(page) {
    if (!page?.detailCanvas) return;
    page.detailCanvas.width = page.detailCanvas.height = 0;
    page.detailCanvas = page.sharpened = null;
    page.detailDensity = 0;
  }
  DeepRead.ParallelDetail = { raster, refresh, release };
})();
