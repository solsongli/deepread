/* Page selection and native PDF output in the Zotero reader. AGPL-3.0-or-later */
(function () {
  const tr = (zh, en) => DeepRead.bilingual(zh, en);

  function open(reader) {
    if (!reader.page?.units || reader.book || reader.exportJob || reader.optionsDialog) return;
    const doc = reader.doc,
      current = reader.pageIndex;
    const el = (tag, cls, value) => DeepRead.util.h(doc, tag, { class: cls }, value);
    const panel = (reader.optionsDialog = el("dialog", "dr-translation-options"));
    const heading = el("h2", "", tr("选页与导出", "Pages and export"));
    panel.setAttribute("aria-label", heading.textContent);
    const fields = el("fieldset", "");
    const row = (label, control) => {
      const wrap = el("label", "dr-export-field");
      wrap.append(el("span", "", label), control);
      fields.append(wrap);
      return wrap;
    };
    const select = (label, key, choices) => {
      const control = el("select", "");
      control.name = key;
      for (const [value, text] of choices) {
        const option = el("option", "", text);
        option.value = value;
        control.append(option);
      }
      row(label, control);
      return control;
    };
    const scope = select(tr("页码", "Pages"), "scope", [
      ["current", tr("当前页", "Current page") + " (" + (current + 1) + ")"],
      ["range", tr("自选页码", "Custom range")],
      ["all", tr("全文", "Entire paper") + " (" + reader.count + ")"]
    ]);
    const range = el("input", "");
    range.type = "text";
    range.name = "range";
    range.placeholder = "1,3-5,8-";
    const custom = row(tr("PDF 页码（从 1 开始）", "PDF page numbers (starting at 1)"), range);
    const layout = select(tr("PDF 版式", "PDF layout"), "layout", [
      ["parallel", tr("原译文左右并排", "Side by side")],
      ["alternating", tr("原译文逐页交替", "Alternating pages")],
      ["mono", tr("仅译文", "Translation only")]
    ]);
    const order = select(tr("阅读顺序", "Reading order"), "order", [
      ["original", tr("原文在先", "Original first")],
      ["translated", tr("译文在先", "Translation first")]
    ]);
    const destination = select(tr("导出到", "Destination"), "destination", [
      ["file", tr("保存文件", "Save to file")],
      ["library", tr("Zotero 文库并打开", "Zotero library and open")]
    ]);
    const redo = el("input", "");
    redo.type = "checkbox";
    redo.name = "retranslate";
    const redoLabel = el("label", "dr-options-check");
    redoLabel.append(redo, tr("用新版重译已完成的段落", "Retranslate completed passages"));
    fields.append(redoLabel);
    const status = el("p", "dr-options-status");
    status.setAttribute("role", "status");
    const actions = el("div", "dr-options-actions");
    const button = (key, label) => {
      const b = el("button", "", label);
      b.type = "button";
      b.name = key;
      actions.append(b);
      return b;
    };
    const close = button("close", tr("关闭", "Close")),
      translate = button("translate", tr("翻译所选页", "Translate selected pages")),
      save = button("save", tr("导出已有译文", "Export translated pages"));
    panel.append(heading, fields, status, actions);
    reader.root.append(panel);
    let busy = false,
      observer;
    const pages = () =>
      scope.value === "current"
        ? [current]
        : DeepRead.PageRange.parse(scope.value === "all" ? "1-" : range.value, reader.count);
    function refresh() {
      custom.hidden = scope.value !== "range";
      order.parentElement.hidden = layout.value === "mono";
      translate.textContent=redo.checked ? tr("重译所选页","Retranslate selected pages") : tr("翻译所选页","Translate selected pages");
      if (busy) return;
      try {
        const indices = pages();
        status.textContent = tr("已选 ", "Selected ") + indices.length + tr(" 页", " pages");
        range.removeAttribute("aria-invalid");
        translate.disabled = save.disabled = false;
      } catch (error) {
        status.textContent = error.message;
        range.setAttribute("aria-invalid", "true");
        translate.disabled = save.disabled = true;
      }
    }
    fields.addEventListener("input", refresh);
    fields.addEventListener("change", refresh);
    function dismiss() {
      if (busy) {
        reader.book?.abort();
        reader.exportJob?.abort();
      } else panel.close();
    }
    close.addEventListener("click", dismiss);
    panel.addEventListener("cancel", (event) => {
      event.stopPropagation();
      event.preventDefault();
      dismiss();
    });
    panel.addEventListener("close", () => {
      observer?.disconnect();
      panel.remove();
      if (reader.optionsDialog === panel) reader.optionsDialog = null;
      if (reader.root) reader.exportControl.focus({ preventScroll: true });
    });
    async function run(exporting) {
      if (busy || reader.book || reader.exportJob) return;
      const indices = pages();
      busy = fields.disabled = translate.disabled = save.disabled = true;
      close.textContent = tr("停止", "Stop");
      observer = new doc.defaultView.MutationObserver(() => {
        status.textContent = reader.status.textContent;
      });
      observer.observe(reader.status, { subtree: true, childList: true, characterData: true });
      let message;
      try {
        if (exporting) {
          const result = await reader.savePDF("selection", null, {
            indices,
            layout: layout.value,
            translationFirst: order.value === "translated",
            destination: destination.value
          });
          if (result && destination.value === "library" && panel.open && reader.root) {
            panel.close();
            await Zotero.Reader.open(result.id);
          }
        } else await reader.translateBook(indices,{revise:redo.checked});
      } catch (error) {
        message = DeepRead.util.formatError(error);
        if (reader.root) reader.status.textContent = message;
      } finally {
        observer.disconnect();
        busy = fields.disabled = false;
        if (panel.open) {
          close.textContent = tr("关闭", "Close");
          refresh();
          status.textContent = message || reader.status.textContent;
        }
      }
    }
    translate.addEventListener("click", () => run(false));
    save.addEventListener("click", () => run(true));
    refresh();
    panel.showModal();
    scope.focus();
  }
  DeepRead.TranslationOptions = { open };
})();
