/* Parse selected pages in original page coordinates. AGPL-3.0-or-later */
(function () {
  const tr = (zh, en) => DeepRead.bilingual(zh, en);
  const prefix = (provider) => "range-parse:" + provider + ":";
  async function load(key, fingerprint, provider) {
    if (!fingerprint) return new Map();
    const start = prefix(provider);
    const rows = await DeepRead.Store.db.queryAsync(
      "SELECT slot, payload FROM comparison_cache WHERE attachment_key=? AND fingerprint=? AND slot LIKE ?",
      [key, fingerprint, start + "%"]
    );
    const pages = new Map();
    for (const row of rows) {
      const index = Number(row.slot.slice(start.length));
      const page = JSON.parse(row.payload);
      if (Number.isInteger(index) && Array.isArray(page?.items)) pages.set(index, page);
    }
    return pages;
  }

  // A scan can have no text-layer fallback. Keep the batch separately in
  // that case, so the next request for these pages can still resume it.
  async function parse(reader, page, options) {
    if (DeepRead.prefs.parserConfig().provider !== "mineru") return DeepRead.Parser.parsePDF(options);
    const { key } = reader.session,
      { fingerprint } = page;
    const first = options.pdfApp.firstPhysicalPage || 0,
      count = options.pdfApp.pdfDocument.numPages;
    const slot = "mineru-download:" + first + ":" + count;
    const pending = await DeepRead.Store.comparisonData(key, fingerprint, slot);
    try {
      const result = await DeepRead.Parser.parsePDF({
        ...options,
        resumeDownload: options.resumeDownload || pending
      });
      if (pending) await DeepRead.Store.saveComparisonData(key, fingerprint, slot, null);
      return result;
    } catch (error) {
      if (error.downloadJob && !options.signal.aborted)
        await DeepRead.Store.saveComparisonData(key, fingerprint, slot, error.downloadJob);
      throw error;
    }
  }

  async function fill(reader, page, indices, cache, signal, force = false) {
    const session = reader.session,
      cfg = DeepRead.prefs.parserConfig();
    const missing = indices.filter((i) => force || !cache.has(i));
    if (!missing.length) return;
    const adapter = session.pdfAdapter().pdfDocument;
    const source = await session.item.getFilePathAsync();
    let slice;
    try {
      slice = await DeepRead.ParallelPDF.sourceSlices(reader, source);
    } catch {
      /* Password-protected PDFs may still have an accessible reader text layer. */
    }
    for (const run of DeepRead.PageRange.runs(missing)) {
      if (signal.aborted) return;
      const id = session.key + "-range-" + crypto.randomUUID(),
        file = PathUtils.join(PathUtils.tempDir, id + ".pdf");
      const scratch = PathUtils.join(DeepRead.Store.resultRoot(), id);
      const local = {
        firstPhysicalPage: run[0],
        pdfDocument: {
          numPages: run.length,
          getPage: (n) => adapter.getPage(run[n - 1] + 1),
          getPageData: async ({ pageIndex }) => {
            const data = await adapter.getPageData({ pageIndex: run[pageIndex] });
            return { ...data, chars: (data.chars || []).map((c) => ({ ...c, pageIndex })) };
          }
        }
      };
      let parsed;
      try {
        reader.status.textContent =
          tr("正在解析所选页 ", "Parsing selected pages ") + DeepRead.PageRange.format(run);
        const resumeDownload = force && (cache.get(run[0])?.downloadJob || reader.parsed?.downloadJob);
        if (slice || resumeDownload) {
          if (slice) await IOUtils.write(file, await slice(run));
          if (signal.aborted) return;
          parsed = await parse(reader, page, {
            filePath: file,
            attachmentKey: id,
            pdfApp: local,
            signal,
            resumeDownload,
            onStatus: (e) => {
              if (!signal.aborted) reader.status.textContent = e.message;
            }
          });
        } else {
          parsed = { ...(await DeepRead.TextLayerParser.parse({ pdfApp: local, signal })), fallback: true };
          if (!parsed.contentList.length)
            throw new Error(
              tr(
                "无法从所选页面读取文字或提取可供解析的 PDF。",
                "Cannot read the selected text layer or extract these pages for parsing."
              )
            );
        }
        if (signal.aborted) return;
        const origin = parsed.origin;
        const physical =
          origin?.count && origin.first >= 0 && origin.first + origin.count <= reader.count
            ? Array.from({ length: origin.count }, (_, i) => origin.first + i)
            : run;
        const items = DeepRead.PageRange.remap(parsed.contentList, physical);
        for (const index of run) {
          if (signal.aborted) return;
          const result = {
            items: DeepRead.ParallelVisual.pageItems(items, index),
            fallback: !!parsed.fallback,
            downloadJob: parsed.downloadJob
          };
          await DeepRead.Store.saveComparisonData(
            session.key,
            page.fingerprint,
            prefix(cfg.provider) + index,
            result
          );
          cache.set(index, result);
        }
        session.hasComparisonCache = !!page.fingerprint;
      } finally {
        await IOUtils.remove(file, { ignoreAbsent: true });
        await IOUtils.remove(scratch, { recursive: true, ignoreAbsent: true });
      }
    }
  }
  DeepRead.RangeParser = { load, fill, parse };
})();
