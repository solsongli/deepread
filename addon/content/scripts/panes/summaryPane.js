/* "速读卡" section: run status and a five-part article summary with jump-to-source points.
 * License: AGPL-3.0-or-later */
/* global DeepRead */

(function () {
  function contentText(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === "string" ? c : c?.content || c?.text || "")).filter(Boolean).join("\n");
    }
    return String(content.content || content.text || "");
  }

  function renderStatus(ctx) {
    const { session, h } = ctx;
    if (session.status === "running") {
      return h("div", { class: "dr-status" },
        DeepRead.Panes.progressBar(h, session.progress.percent),
        h("div", { class: "dr-status-row" },
          h("span", { class: "dr-muted" }, `${Math.round(session.progress.percent || 0)}% · ${session.progress.message || ""}`),
          h("button", { class: "dr-link-button", onclick: () => session.cancel() }, DeepRead.bilingual("取消", "Cancel"))));
    }
    if (session.status === "error" || (session.error && !session.hasResults)) {
      return h("div", { class: "dr-status dr-error" }, session.progress.message || DeepRead.util.formatError(session.error));
    }
    return null;
  }

  function runButton(ctx, label) {
    const { session, h } = ctx;
    return h("button", {
      class: "dr-primary-button",
      onclick: () => session.run().catch((e) => DeepRead.Panes.reportError(session, e)),
    }, label);
  }

  DeepRead.Panes.renderers.summary = (ctx) => {
    const { body, session, h, event } = ctx;
    if (event === "ask" || String(event).startsWith("chat")) return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    const root = h("div", { class: "dr-pane dr-summary-pane" });
    const status = renderStatus(ctx);
    if (status) root.append(status);

    const items = session.data?.articleSummary;
    if (session.summaryStatus === "running") {
      root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("正在重新生成速读卡…", "Regenerating summary…")));
    }
    else if (session.summaryStatus === "error" && session.summaryError) {
      root.append(h("div", { class: "dr-error" }, session.summaryError));
    }

    if (!Array.isArray(items) || !items.length) {
      if (session.status !== "running") {
        root.append(h("div", { class: "dr-empty" },
          h("div", { class: "dr-muted" }, session.hasResults
            ? DeepRead.bilingual("速读卡生成失败，可点击右上角重新生成。", "Summary is missing; use the regenerate button.")
            : DeepRead.t("summary.empty")),
          session.hasResults ? null : runButton(ctx, DeepRead.t("toolbar.run"))));
      }
      body.replaceChildren(root);
      return;
    }

    for (const item of items) {
      const card = h("section", { class: "dr-summary-card" });
      card.append(h("h4", { class: "dr-summary-title" }, item.title || ""));
      const text = contentText(item.content);
      if (text) card.append(h("p", { class: "dr-summary-text" }, text));
      const points = Array.isArray(item.points) ? item.points : [];
      if (points.length) {
        const list = h("ul", { class: "dr-summary-points" });
        for (const point of points) {
          const blockIds = Array.isArray(point.block_ids) ? point.block_ids : [];
          const li = h("li", {
            class: blockIds.length ? "dr-clickable" : "",
            title: blockIds.length ? DeepRead.bilingual("跳转到原文", "Jump to source") : null,
            onclick: blockIds.length ? () => session.navigateToBlockIds(blockIds) : null,
          },
          point.point_title ? h("strong", {}, point.point_title) : null,
          point.point_title && point.content ? " " : null,
          point.content || "");
          list.append(li);
        }
        card.append(list);
      }
      root.append(card);
    }
    body.replaceChildren(root);
  };
})();
