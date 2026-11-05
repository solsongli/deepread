/* Question-led reading and optional self-explanation practice.
 * License: AGPL-3.0-or-later */
/* global DeepRead */

(function () {
  const revealed = new WeakMap(); // session → Set(question id) answers shown early by the reader
  const drafts = new WeakMap(); // unsubmitted questions survive pane refreshes, scoped to the paper
  const views = new WeakMap(); // body → current session and pending IME-safe render

  function rememberFocus(body, doc) {
    const node = doc.activeElement;
    if (!body.contains(node) || !node?.dataset?.focusKey) return null;
    return { key: node.dataset.focusKey, start: node.selectionStart, end: node.selectionEnd,
      direction: node.selectionDirection, scrollTop: node.scrollTop };
  }

  function restoreFocus(root, focus) {
    if (!focus) return;
    const node = [...root.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === focus.key);
    if (!node) return;
    node.focus({ preventScroll: true });
    if (typeof focus.start === "number" && typeof node.setSelectionRange === "function") {
      node.setSelectionRange(focus.start, focus.end, focus.direction || "none");
      node.scrollTop = focus.scrollTop;
    }
  }

  function blockChip(h, session, key, questionID) {
    const m = /^p_(\d+)_(\d+)$/.exec(key || "");
    if (!m) return null;
    const page = Number(m[1]);
    const para = Number(m[2]);
    return h("button", {
      type: "button",
      class: "dr-q-chip dr-clickable",
      title: DeepRead.bilingual("跳到这一段并打开卡片", "Go to the paragraph and open its card"),
      "aria-label": DeepRead.bilingual(`核对原文：第 ${page + 1} 页，第 ${para + 1} 段`, `Check source: page ${page + 1}, paragraph ${para + 1}`),
      dataset: { focusKey: `source:${questionID}:${key}` },
      onclick: () => session.openBlock(page, para),
    }, `p. ${page + 1} ¶${para + 1}`);
  }

  function markdown(doc, text) {
    const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    box.append(DeepRead.Markdown.render(doc, text || ""));
    DeepRead.Markdown.wireLinks(box);
    return box;
  }

  function reviewSection(ctx, view) {
    const { session, h, body } = ctx;
    const issues = session.readingIssuesList?.() || [];
    const unmapped = session.userState.unmappedReadingIssues || [];
    const count = issues.length + unmapped.length;
    if (!session.hasResults && !count) return null;
    const section = h("details", { class: "dr-review-list", open: view.reviewsOpen ?? count > 0,
      ontoggle: (e) => { if (e.currentTarget.isConnected) view.reviewsOpen = e.currentTarget.open; } });
    section.append(h("summary", { dataset: { focusKey: "reviews-heading" } }, DeepRead.bilingual(`待弄懂 · ${count}`, `To revisit · ${count}`)));
    section.append(h("p", { class: "dr-muted dr-review-hint" }, count
      ? DeepRead.bilingual("回到原文核对；具体卡在哪里，可写在卡片的「我的理解」中。", "Revisit the source; use the card's personal note to record what is unclear.")
      : DeepRead.bilingual("在段落卡片的原文入口旁点「待弄懂」，之后在这里集中回看。", "Mark a paragraph beside its source link to revisit it here.")));
    const list = h("div", { class: "dr-review-items" });
    const remove = (action) => {
      action();
      // The removed row no longer has a focus target after the synchronous refresh.
      const target = body.querySelector('[data-focus-key="reviews-heading"]') || body.querySelector(".dr-questions-pane");
      if (target?.localName !== "summary") target?.setAttribute("tabindex", "-1");
      target?.focus({ preventScroll: true });
    };
    for (const issue of issues) {
      const row = h("div", { class: "dr-review-item", dataset: { reviewKey: issue.key } });
      const label = issue.summary || issue.quote || issue.originalKey;
      if (!issue.missing) row.append(h("button", {
        class: "dr-review-source", dataset: { focusKey: `review:${issue.key}` },
        title: issue.quote,
        onclick: () => session.openBlock(issue.pageIndex, issue.paragraphIndex).catch((error) => DeepRead.Panes.reportError(session, error)),
      }, h("span", { class: "dr-review-location" }, `p. ${issue.pageIndex + 1} ¶${issue.paragraphIndex + 1}`), label));
      else row.append(h("div", { class: "dr-review-missing" }, DeepRead.bilingual("原文待定位", "Source to relocate"), h("p", {}, label)));
      if (issue.note) row.append(h("p", { class: "dr-review-note" }, issue.note));
      row.append(h("button", { class: "dr-link-button dr-review-remove", dataset: { focusKey: `review-remove:${issue.key}` },
        onclick: () => remove(() => session.setNeedsReview(issue.key, false)),
      }, DeepRead.bilingual("取消标记", "Remove flag")));
      list.append(row);
    }
    for (const issue of unmapped) {
      list.append(h("div", { class: "dr-review-item dr-review-unmapped" },
        h("div", { class: "dr-muted" }, DeepRead.bilingual("重新解析后待定位", "Source changed after reparsing")),
        h("div", { class: "dr-review-quote" }, issue.quote || issue.summary || issue.originalKey),
        h("button", { class: "dr-link-button dr-review-remove", dataset: { focusKey: `unmapped-review:${issue.id}` },
          onclick: () => remove(() => session.removeUnmappedReview(issue.id)),
        }, DeepRead.bilingual("取消标记", "Remove flag"))));
    }
    section.append(list);
    return section;
  }

  DeepRead.Panes.renderers.questions = (ctx) => {
    const { body, doc, session, h, event } = ctx;
    if (event === "ask" || String(event).startsWith("chat")) return;
    if (!session) {
      views.delete(body);
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    let view = views.get(body);
    const sameSession = view?.session === session;
    if (!sameSession) {
      view = { session, composing: false, pending: null };
      views.set(body, view);
    }
    if (view.composing && DeepRead.Modules.enabled(session, "questions")) {
      view.pending = ctx;
      return;
    }
    const focus = sameSession ? rememberFocus(body, doc) : null;
    const reviewScrollTop = sameSession ? body.querySelector(".dr-review-items")?.scrollTop || 0 : 0;
    const root = h("div", { class: "dr-pane dr-questions-pane" });
    if (!DeepRead.Modules.enabled(session, "questions")) {
      view.composing = false;
      view.pending = null;
      const reviews = reviewSection(ctx, view);
      if (reviews) root.append(reviews);
      root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("问题导向已在「功能」菜单中关闭。", "Question-led reading is off in the Features menu.")));
      body.replaceChildren(root);
      const list = root.querySelector(".dr-review-items");
      if (list) list.scrollTop = reviewScrollTop;
      restoreFocus(root, focus);
      return;
    }
    root.addEventListener("compositionstart", () => { view.composing = true; });
    root.addEventListener("compositionend", () => {
      view.composing = false;
      // The final input event follows compositionend; let it save the committed text first.
      setTimeout(() => {
        if (views.get(body) !== view || !view.pending || !body.isConnected) return;
        const pending = view.pending;
        view.pending = null;
        DeepRead.Panes.renderers.questions(pending);
      }, 0);
    });
    const items = session.questions?.items || [];
    const hide = DeepRead.prefs.get("questions.hideAnswers") === true;
    const recall = session.userState.recallMode === true;
    const shown = revealed.get(session) || new Set();
    revealed.set(session, shown);

    const goal = session.userState.readingGoal || {};
    const goalBox = h("div", { class: "dr-reading-goal" },
      h("div", { class: "dr-q-section-label" }, DeepRead.bilingual("这次想读懂什么", "What I want to understand")));
    const select = h("select", { class: "dr-goal-kind", "aria-label": DeepRead.bilingual("阅读目标", "Reading goal"),
      dataset: { focusKey: "goal-kind" },
      onchange: (e) => session.setReadingGoal(e.target.value) });
    select.append(h("option", { value: "" }, DeepRead.bilingual("选择阅读目标（可选）", "Choose a reading goal (optional)")));
    for (const g of DeepRead.Reading.GOALS) select.append(h("option", { value: g.key }, DeepRead.bilingual(g.zh, g.en)));
    select.value = goal.kind || "";
    const goalText = h("input", { type: "text", class: "dr-goal-text", maxlength: 1000,
      dataset: { focusKey: "goal-text" },
      "aria-label": DeepRead.bilingual("这次想弄清的问题", "What I want to find out"),
      placeholder: DeepRead.bilingual("这次读完，我想弄清……", "By the end, I want to understand…"),
      oninput: (e) => session.setReadingGoal(session.userState.readingGoal?.kind, e.target.value, { notify: false }),
    });
    goalText.value = goal.text || "";
    goalBox.append(select, goalText);
    const selectedGoal = DeepRead.Reading.goal(goal.kind);
    if (selectedGoal) goalBox.append(h("div", { class: "dr-muted" }, DeepRead.bilingual(selectedGoal.hintZh, selectedGoal.hintEn)));
    const targets = session.readingTargets();
    if (targets.length) goalBox.append(h("div", { class: "dr-reading-links" }, targets.map((target) => h("button", {
      class: "dr-link-button", onclick: () => session.openReadingTarget(target),
    }, target.kind === "figure" ? DeepRead.bilingual("从图表开始", "Start with figures") : target.section.label))));
    root.append(goalBox);
    const reviews = reviewSection(ctx, view);
    if (reviews) root.append(reviews);

    const progress = session.questionProgress();
    const head = h("div", { class: "dr-q-head" },
      h("span", { class: "dr-muted" }, items.length
        ? DeepRead.bilingual(`已浏览到 ${progress.reached} / ${progress.total} 组答案出处`, `Source locations reached: ${progress.reached} / ${progress.total}`)
        : DeepRead.bilingual("带着问题读：精读后 AI 给出 5 个问题和答案出处", "Read with questions: after the deep read the AI answers five questions and points to the paragraphs")),
      h("label", { class: "dr-q-hide" },
        h("input", {
          type: "checkbox",
          dataset: { focusKey: "hide-answers" },
          checked: hide || null,
          onchange: (e) => {
            DeepRead.prefs.set("questions.hideAnswers", !!e.target.checked);
            session._emit("questions");
          },
        }),
        DeepRead.bilingual("到达出处后再显示答案", "Show answers when I reach their sources")));
    root.append(head);
    root.append(h("label", { class: "dr-q-hide" }, h("input", {
      type: "checkbox", checked: recall || null,
      dataset: { focusKey: "recall-mode" },
      onchange: (e) => {
        session.userState.recallMode = !!e.target.checked;
        shown.clear();
        session._saveUserStateSoon();
        session._emit("questions");
      },
    }), DeepRead.bilingual("自测：先自己解释，再看答案", "Self-check: explain first, then compare")));


    if (session.generatingQuestions) root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("正在生成阅读问题…", "Writing the reading questions…")));
    if (!items.length && !session.generatingQuestions) {
      root.append(h("div", { class: "dr-empty" },
        session.hasResults
          ? h("button", {
            class: "dr-primary-button",
            onclick: () => session.generateQuestions().catch((e) => DeepRead.Panes.reportError(session, e)),
          }, DeepRead.bilingual("生成阅读问题", "Write the reading questions"))
          : h("div", { class: "dr-muted" }, DeepRead.t("error.noParseData"))));
    }

    const list = h("div", { class: "dr-q-list" });
    for (const q of items) {
      const reached = session.questionReached(q);
      const item = h("div", { class: `dr-q-item${reached ? " dr-reached" : ""}${q.custom ? " dr-custom" : ""}` });
      item.append(h("div", { class: "dr-q-title" },
        h("span", { class: "dr-q-label" }, session.questionLabel(q)),
        h("span", { class: "dr-q-text" }, q.question),
        reached ? h("span", { class: "dr-q-state", title: DeepRead.bilingual("已浏览到答案出处；不代表已经理解", "Source location reached; this does not assess understanding") }, DeepRead.bilingual("已到达", "Reached")) : null,
        q.custom
          ? h("button", { class: "dr-q-remove", title: DeepRead.bilingual("删除这个问题", "Remove"), "aria-label": DeepRead.bilingual("删除这个问题", "Remove this question"), onclick: () => session.removeQuestion(q.id) }, "×")
          : null));
      if (recall && !q.pending) {
        const saved = session.userState.recallAnswers?.[q.id];
        const draft = saved?.question === q.question ? saved.text : "";
        const input = h("textarea", {
          class: "dr-q-recall", rows: 2,
          dataset: { focusKey: `recall:${q.id}:${q.question}` },
          placeholder: DeepRead.bilingual("用自己的话解释：为什么？依据在哪里？（可跳过）", "Explain in your own words: why, and what is the evidence? (optional)"),
          "aria-label": DeepRead.bilingual("我的回答", "My answer"),
          oninput: (e) => {
            session.userState.recallAnswers = { ...(session.userState.recallAnswers || {}), [q.id]: { question: q.question, text: e.target.value } };
            session._saveUserStateSoon();
          },
        });
        input.value = draft || "";
        item.append(h("label", { class: "dr-q-own" },
          h("span", { class: "dr-q-section-label" }, DeepRead.bilingual("我的解释", "My explanation")), input));
      }
      if (q.pending) {
        item.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("AI 正在全文中找答案…", "Looking for the answer…")));
      }
      else if ((recall || (hide && !reached)) && !shown.has(q.id) && q.answer) {
        const first = q.keys?.length ? session._paragraphByKey(q.keys[0]) : null;
        item.append(h("button", {
          class: "dr-q-reveal",
          dataset: { focusKey: `reveal:${q.id}` },
          onclick: () => {
            shown.add(q.id);
            session._emit("questions");
          },
        }, recall ? DeepRead.bilingual("查看 AI 答案并核对原文", "Compare with AI answer and source") : first
          ? DeepRead.bilingual(`到达第 ${first.page.pageIndex + 1} 页出处时显示 · 现在看`, `Revealed at the source on p. ${first.page.pageIndex + 1} · show now`)
          : DeepRead.bilingual("显示答案", "Show the answer")));
      }
      else if (q.answer) {
        item.append(h("div", { class: "dr-q-answer" },
          h("div", { class: "dr-q-section-label" }, DeepRead.bilingual("AI 参考答案", "AI reference answer")), markdown(doc, q.answer)));
        if (recall) item.append(h("button", { class: "dr-q-reveal", dataset: { focusKey: `reveal:${q.id}` }, onclick: () => { shown.delete(q.id); session._emit("questions"); } }, DeepRead.bilingual("收起答案，再回忆一次", "Hide answer and recall again")));
      }
      if (q.keys?.length) {
        item.append(h("div", { class: "dr-q-sources" },
          h("div", { class: "dr-q-section-label" }, DeepRead.bilingual("核对原文", "Check the source")),
          h("div", { class: "dr-q-chips" }, [...new Set(q.keys)].map((k) => blockChip(h, session, k, q.id)))));
      }
      list.append(item);
    }
    root.append(list);

    if (session.hasResults) {
      const input = h("input", {
        type: "text",
        class: "dr-q-input",
        dataset: { focusKey: "question-draft" },
        "aria-label": DeepRead.bilingual("添加我的阅读问题", "Add my reading question"),
        placeholder: DeepRead.bilingual("添加我的问题，AI 在全文中找答案…", "Add a question of your own…"),
        oninput: (e) => drafts.set(session, e.target.value),
      });
      input.value = drafts.get(session) || "";
      const submit = () => {
        const text = input.value.trim();
        if (!text || view.composing) return;
        input.value = "";
        drafts.set(session, "");
        session.askQuestion(text).catch((e) => {
          // Do not replace another question the reader has started while the request was pending.
          if (!drafts.get(session)) drafts.set(session, text);
          session._emit("questions");
          DeepRead.Panes.reportError(session, e);
        });
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      });
      root.append(h("div", { class: "dr-q-add" }, input, h("button", { class: "dr-primary-button", onclick: submit }, DeepRead.bilingual("提问", "Ask"))));
    }
    root.append(h("div", { class: "dr-reading-links" },
      h("button", { class: "dr-link-button dr-copy-record", onclick: () => DeepRead.util.copyToClipboard(session.readingRecord()) }, DeepRead.bilingual("复制阅读记录", "Copy reading record")),
      h("button", { class: "dr-link-button dr-save-record", onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try { await session.saveReadingNote(); button.textContent = DeepRead.bilingual("已存为 Zotero 笔记", "Saved as a Zotero note"); }
        catch (error) { button.disabled = false; DeepRead.Panes.reportError(session, error); }
      } }, DeepRead.bilingual("存为 Zotero 笔记", "Save as a Zotero note"))));
    if (session.userState.unmappedNotes?.length) root.append(h("details", { class: "dr-unmapped-notes" },
      h("summary", {}, DeepRead.bilingual("重新解析后待定位的笔记", "Notes to relocate after reparsing")),
      session.userState.unmappedNotes.map((note) => h("div", { class: "dr-note" }, h("blockquote", {}, note.quote || note.originalKey), h("p", {}, note.text)))));
    body.replaceChildren(root);
    const reviewList = root.querySelector(".dr-review-items");
    if (reviewList) reviewList.scrollTop = reviewScrollTop;
    restoreFocus(root, focus);
  };

})();
