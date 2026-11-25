/* File and Zotero library destinations for the native PDF exporter. AGPL-3.0-or-later */
(function () {
  const tr = (zh, en) => DeepRead.bilingual(zh, en);
  const imports = new Map();

  function description(reader, indices, layout, translationFirst) {
    const base = (reader.session.item.attachmentFilename || "paper").replace(/\.pdf$/iu, "");
    const range = DeepRead.PageRange.format(indices);
    const part =
      indices.length === reader.count
        ? ""
        : "-p" + (range.length <= 40 ? range : indices[0] + 1 + "-" + (indices.at(-1) + 1) + "-subset");
    const language = reader.page.language;
    const suffix = layout === "mono" ? "" : layout === "alternating" ? "-alternating" : "-dual";
    const name = base + "-" + language + suffix + (translationFirst ? "-first" : "") + part;
    const kind =
      layout === "mono"
        ? tr("译文", "Translation")
        : layout === "alternating"
          ? tr("双语交替页", "Alternating bilingual pages")
          : tr("双语并排", "Bilingual spread");
    const order =
      layout === "mono"
        ? ""
        : translationFirst
          ? tr(" · 译文在先", " · Translation first")
          : tr(" · 原文在先", " · Original first");
    const title =
      base +
      " · " +
      language +
      " · " +
      kind +
      order +
      (part ? tr(" · 第 ", " · pp. ") + range + tr(" 页", "") : "");
    return { name, title };
  }

  async function choose(reader, name) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(
      reader.session.reader._window || Zotero.getMainWindow(),
      tr("保存 PDF", "Save PDF"),
      picker.modeSave
    );
    picker.defaultString = name + ".pdf";
    picker.defaultExtension = "pdf";
    picker.appendFilter("PDF", "*.pdf");
    const result = await picker.show();
    return result === picker.returnOK || result === picker.returnReplace ? picker.file : null;
  }

  async function digest(value) {
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function attach(reader, path, output, fingerprint, signature) {
    const { session } = reader,
      source = session.item;
    const id = await digest([
      DeepRead.version,
      source.libraryID,
      source.key,
      source.parentItemID || null,
      fingerprint,
      signature
    ]);
    if (imports.has(id)) return imports.get(id);
    const task = (async () => {
      const slot = "export:attachment:" + id;
      const receipt = await DeepRead.Store.comparisonData(session.key, fingerprint, slot);
      if (receipt) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID, receipt);
        if (item && !item.deleted && item.parentItemID === source.parentItemID && (await item.fileExists()))
          return item;
      }
      const location = source.parentItemID
        ? { parentItemID: source.parentItemID }
        : { libraryID: source.libraryID, collections: source.getCollections() };
      const item = await Zotero.Attachments.importFromFile({
        ...location,
        file: Zotero.File.pathToFile(path),
        contentType: "application/pdf",
        fileBaseName: Zotero.File.getValidFileName(output.name),
        title: output.title
      });
      await DeepRead.Store.saveComparisonData(session.key, fingerprint, slot, item.key);
      return item;
    })();
    imports.set(id, task);
    try {
      return await task;
    } finally {
      imports.delete(id);
    }
  }

  DeepRead.ParallelExport = { description, choose, digest, attach };
})();
