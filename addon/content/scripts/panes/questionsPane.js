/* Question-led reading and optional self-explanation practice.
 * License: AGPL-3.0-or-later */
/* global DeepRead */

(function () {
  const revealed = new WeakMap(); // session → Set(question id) answers shown early by the reader

  function blockChip(h, session, key) {
    const m = /^p_(\d+)_(\d+)$/.exec(key || "");
    if (!m) return null;
    const page = Number(m[1]);
    const para = Number(m[2]);
    return h("span", {
      class: "dr-q-chip dr-clickable",
      title: DeepRead.bilingual("跳到这一段并打开卡片", "Go to the paragraph and open its card"),
      onclick: () => session.openBlock(page, para),
    }, `p. ${page + 1} ¶${para + 1}`);
  }

  function markdown(doc, text) {
    const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    box.append(DeepRead.Markdown.render(doc, text || ""));
    return box;
  }

  DeepRead.Panes.renderers.questions = (ctx) => {
    const { body, doc, session, h, event } = ctx;
    if (event === "ask" || String(event).startsWith("chat")) return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    if (event !== "change" && event !== "modules" && body.contains(doc.activeElement)
        && doc.activeElement?.matches("textarea, input[type='text']")) return;
    const root = h("div", { class: "dr-pane dr-questions-pane" });
    if (!DeepRead.Modules.enabled(session, "questions")) {
      root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("问题导向已在「功能」菜单中关闭。", "Question-led reading is off in the Features menu.")));
      body.replaceChildren(root);
      return;
    }
    const items = session.questions?.items || [];
    const hide = DeepRead.prefs.get("questions.hideAnswers") === true;
    const recall = session.userState.recallMode === true;
    const shown = revealed.get(session) || new Set();
    revealed.set(session, shown);

    const goal = session.userState.readingGoal || {};
    const goalBox = h("div", { class: "dr-reading-goal" });
    const select = h("select", { class: "dr-goal-kind", "aria-label": DeepRead.bilingual("阅读目标", "Reading goal"),
      onchange: (e) => session.setReadingGoal(e.target.value) });
    select.append(h("option", { value: "" }, DeepRead.bilingual("选择阅读目标（可选）", "Choose a reading goal (optional)")));
    for (const g of DeepRead.Reading.GOALS) select.append(h("option", { value: g.key }, DeepRead.bilingual(g.zh, g.en)));
    select.value = goal.kind || "";
    const goalText = h("input", { type: "text", class: "dr-goal-text", maxlength: 1000,
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

    const progress = session.questionProgress();
    const head = h("div", { class: "dr-q-head" },
      h("span", { class: "dr-muted" }, items.length
        ? DeepRead.bilingual(`已读到 ${progress.reached} / ${progress.total} 个答案`, `Answers reached: ${progress.reached} / ${progress.total}`)
        : DeepRead.bilingual("带着问题读：精读后 AI 给出 5 个问题和答案出处", "Read with questions: after the deep read the AI answers five questions and points to the paragraphs")),
      h("label", { class: "dr-q-hide" },
        h("input", {
          type: "checkbox",
          checked: hide || null,
          onchange: (e) => {
            DeepRead.prefs.set("questions.hideAnswers", !!e.target.checked);
            session._emit("questions");
          },
        }),
        DeepRead.bilingual("先自己想，读到时再揭晓", "Hide answers until I get there")));
    root.append(head);
    root.append(h("label", { class: "dr-q-hide" }, h("input", {
      type: "checkbox", checked: recall || null,
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
        reached ? h("span", { class: "dr-q-state", title: DeepRead.bilingual("已读到答案所在的段落", "You have read the answer's paragraphs") }, "✓") : null,
        q.custom
          ? h("button", { class: "dr-q-remove", title: DeepRead.bilingual("删除这个问题", "Remove"), onclick: () => session.removeQuestion(q.id) }, "×")
          : null));
      if (recall && !q.pending) {
        const saved = session.userState.recallAnswers?.[q.id];
        const draft = saved?.question === q.question ? saved.text : "";
        const input = h("textarea", {
          class: "dr-q-recall", rows: 2,
          placeholder: DeepRead.bilingual("用自己的话解释：为什么？依据在哪里？（可跳过）", "Explain in your own words: why, and what is the evidence? (optional)"),
          "aria-label": DeepRead.bilingual("我的回答", "My answer"),
          oninput: (e) => {
            session.userState.recallAnswers = { ...(session.userState.recallAnswers || {}), [q.id]: { question: q.question, text: e.target.value } };
            session._saveUserStateSoon();
          },
        });
        input.value = draft || "";
        item.append(input);
      }
      if (q.pending) {
        item.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("AI 正在全文中找答案…", "Looking for the answer…")));
      }
      else if ((recall || (hide && !reached)) && !shown.has(q.id) && q.answer) {
        const first = q.keys?.length ? session._paragraphByKey(q.keys[0]) : null;
        item.append(h("button", {
          class: "dr-q-reveal",
          onclick: () => {
            shown.add(q.id);
            session._emit("questions");
          },
        }, recall ? DeepRead.bilingual("查看 AI 答案并核对原文", "Compare with AI answer and source") : first
          ? DeepRead.bilingual(`读到第 ${first.page.pageIndex + 1} 页时揭晓 · 现在看`, `Revealed at p. ${first.page.pageIndex + 1} · show now`)
          : DeepRead.bilingual("显示答案", "Show the answer")));
      }
      else if (q.answer) {
        item.append(h("div", { class: "dr-q-answer" }, markdown(doc, q.answer)));
        if (recall) item.append(h("button", { class: "dr-q-reveal", onclick: () => { shown.delete(q.id); session._emit("questions"); } }, DeepRead.bilingual("收起答案，再回忆一次", "Hide answer and recall again")));
      }
      if (q.keys?.length && (recall || !hide || reached || shown.has(q.id))) {
        item.append(h("div", { class: "dr-q-chips" }, q.keys.map((k) => blockChip(h, session, k))));
      }
      list.append(item);
    }
    root.append(list);

    if (session.hasResults) {
      const input = h("input", {
        type: "text",
        class: "dr-q-input",
        placeholder: DeepRead.bilingual("添加我的问题，AI 在全文中找答案…", "Add a question of your own…"),
      });
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        session.askQuestion(text).catch((e) => DeepRead.Panes.reportError(session, e));
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
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
  };

})();
