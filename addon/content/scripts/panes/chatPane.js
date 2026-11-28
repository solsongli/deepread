/* "AI 对话" section: per-paper chat grounded in the parsed full text, streamed from the user's
 * OpenAI-compatible model. Quotes come from "问 AI" in the selection popup / paragraph cards.
 * License: AGPL-3.0-or-later */
/* global DeepRead, Zotero */

(function () {
  const HISTORY_MESSAGES = 12;
  const HISTORY_CHARS = 20000;

  function paperMeta(session) {
    const item = session.parentItem;
    if (!item?.isRegularItem?.()) return "";
    const creators = item.getCreators().slice(0, 8)
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || "").filter(Boolean);
    const lines = [
      `Title: ${item.getField("title") || ""}`,
      creators.length ? `Authors: ${creators.join(", ")}` : "",
      item.getField("date") ? `Date: ${item.getField("date")}` : "",
      item.getField("publicationTitle") ? `Venue: ${item.getField("publicationTitle")}` : "",
      item.getField("abstractNote") ? `Abstract: ${String(item.getField("abstractNote")).slice(0, 4000)}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  function fullText(session, maxChars) {
    const pages = session.data?.hierarchicalData;
    let text = "";
    if (Array.isArray(pages) && pages.length) {
      text = pages.map((page) => {
        const body = (page.paragraphs || []).map((p) => p.paragraphText || "").filter(Boolean).join("\n\n");
        return `[p. ${page.pageIndex + 1}]\n${body}`;
      }).join("\n\n");
    }
    else if (session.data?.markdown) {
      text = session.data.markdown;
    }
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[…truncated…]`;
    return text;
  }

  /**
   * The margin cards ("blocks"): per paragraph, its summary and the AI explanation the reader sees,
   * labelled like the cards (p. 3 ¶2) so answers can build on and point to them.
   */
  function blockNotes(session, maxChars) {
    const lines = [];
    let used = 0;
    for (const page of session.data?.hierarchicalData || []) {
      for (const paragraph of page.paragraphs || []) {
        const key = `p_${page.pageIndex}_${paragraph.paragraphIndex}`;
        // A card that covers several paragraphs is listed once, under its first paragraph.
        if (session.groupLead && session.groupLead(key) !== key) continue;
        const explanation = session.explanation?.(key);
        const note = session.paragraphNote?.(key);
        if (!explanation && !note) continue;
        const label = session.groupLabel ? session.groupLabel(key) : `p. ${page.pageIndex + 1} ¶${paragraph.paragraphIndex + 1}`;
        const summary = session.groupTitle?.(key) || session.paragraphSummary?.({ ...paragraph, pageIndex: page.pageIndex }) || paragraph.paragraphSummary || "";
        const line = [`[${label}] ${summary}`, explanation ? `AI explanation: ${explanation}` : "", note ? `Reader's note: ${note}` : ""]
          .filter(Boolean).join("\n");
        if (used + line.length > maxChars) return lines.join("\n\n") + "\n\n[…more blocks truncated…]";
        used += line.length;
        lines.push(line);
      }
    }
    return lines.join("\n\n");
  }

  function systemPrompt(session) {
    const lang = DeepRead.PARSE_LANGUAGES[DeepRead.prefs.language()] || DeepRead.PARSE_LANGUAGES.zh;
    const maxChars = DeepRead.prefs.number("chat.maxContextChars", 120000);
    const blocks = blockNotes(session, Math.floor(maxChars * 0.3));
    const text = fullText(session, Math.max(4000, maxChars - blocks.length));
    return [
      "You are an expert research assistant helping the user read an academic paper.",
      `Answer in ${lang.instruction} unless the user writes in another language.`,
      "Ground every claim in the paper below. When you use the paper, cite pages like (p. 3).",
      "The reader studies the paper through paragraph blocks (cards) labelled like (p. 3 ¶2), each with an AI explanation "
        + "and sometimes the reader's own note. Build on those explanations, stay consistent with them or correct them "
        + "explicitly, and cite the blocks you rely on as (p. 3 ¶2).",
      "If the paper does not contain the answer, say so before giving general knowledge.",
      "Use Markdown. Write math with $...$ or $$...$$.",
      "",
      "# Paper metadata",
      paperMeta(session) || "(unknown)",
      "",
      ...(blocks ? ["# Paragraph blocks (AI explanations and the reader's notes)", blocks, ""] : []),
      "# Paper full text",
      text || "(Full text not available yet; the user has not run the deep-read parse. Rely on metadata and quotes.)",
    ].join("\n");
  }

  function userContent(message) {
    const quotes = (message.quotes || []).map((q) => {
      const page = q.block ? ` (${q.block})` : (Number.isInteger(q.pageIndex) ? ` (p. ${q.pageIndex + 1})` : "");
      return `> ${q.text.replace(/\n+/g, "\n> ")}${page}`;
    });
    return [...quotes, message.content].filter(Boolean).join("\n\n");
  }

  DeepRead.ChatPane = {
    systemPrompt,

    async ensureLoaded(session) {
      if (session.chat) return session.chat;
      if (!session._chatLoading) {
        session._chatLoading = DeepRead.Store.getChat(session.key).then((messages) => {
          session.chat = { messages, streaming: false, controller: null, error: null };
          session._emit("chat");
          return session.chat;
        });
      }
      return session._chatLoading;
    },

    async send(session, text) {
      const chat = await this.ensureLoaded(session);
      if (chat.streaming) return;
      const question = String(text || "").trim();
      const quotes = session.pendingQuotes.splice(0);
      if (!question && !quotes.length) return;
      if (!DeepRead.LLM.isConfigured()) {
        session.pendingQuotes.unshift(...quotes);
        DeepRead.Panes.reportError(session, Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true }));
        return;
      }
      const user = { role: "user", content: question || DeepRead.bilingual("请解释这段内容。", "Please explain this passage."), quotes, ts: Date.now() };
      chat.messages.push(user);
      const assistant = { role: "assistant", content: "", ts: Date.now() };
      chat.messages.push(assistant);
      chat.streaming = true;
      chat.error = null;
      chat.controller = new AbortController();
      session._emit("chat");

      const tools = quotes.length ? [] : DeepRead.PaperTools.select(question, !!session.comparison?.root);
      // History: recent turns within a character budget.
      const history = [];
      let budget = HISTORY_CHARS;
      for (const message of (tools.length ? [] : chat.messages.slice(0, -2).slice(-HISTORY_MESSAGES).reverse())) {
        const content = message.role === "user" ? userContent(message) : message.content;
        if (!content || budget - content.length < 0) break;
        budget -= content.length;
        history.unshift({ role: message.role, content });
      }

      try {
        const options = {
          config: DeepRead.prefs.llmConfig({ chat: true }),
          signal: chat.controller.signal,
          onDelta: (_delta, full) => {
            assistant.content = full;
            session._emit("chat-delta");
          },
        };
        if (tools.length) await DeepRead.PaperTools.answer(session, question, tools, options);
        else await DeepRead.LLM.stream({
          ...options, system: systemPrompt(session), messages: [...history, { role: "user", content: userContent(user) }]
        });
      }
      catch (error) {
        if (error?.name !== "AbortError") {
          chat.error = DeepRead.util.formatError(error);
          if (!assistant.content) chat.messages.pop();
        }
      }
      finally {
        chat.streaming = false;
        chat.controller = null;
        if (!assistant.content && chat.messages[chat.messages.length - 1] === assistant) chat.messages.pop();
        session._emit("chat");
        DeepRead.Store.saveChat(session.key, chat.messages).catch((e) => DeepRead.log("saveChat failed", String(e)));
      }
    },

    stop(session) {
      session.chat?.controller?.abort();
    },

    async clear(session) {
      if (!session) return;
      const chat = await this.ensureLoaded(session);
      chat.controller?.abort();
      chat.messages = [];
      chat.error = null;
      session.pendingQuotes = [];
      await DeepRead.Store.saveChat(session.key, []);
      session._emit("chat");
    },
  };

  /* ---------------- rendering ---------------- */

  function renderMessage(ctx, root, message, isStreaming) {
    const { h, doc, session } = ctx;
    const node = h("div", { class: `dr-msg dr-msg-${message.role}` });
    if (message.role === "user") {
      for (const q of message.quotes || []) {
        node.append(h("blockquote", { class: "dr-quote" }, q.text.length > 400 ? `${q.text.slice(0, 400)}…` : q.text));
      }
      node.append(h("div", { class: "dr-msg-text" }, message.content || ""));
    }
    else {
      const content = h("div", { class: "dr-msg-text dr-markdown" });
      content.append(DeepRead.Markdown.render(doc, message.content || (isStreaming ? "…" : ""), root));
      DeepRead.Markdown.linkPageRefs(content, (page, paragraph) => {
        if (paragraph) session.openBlock(page - 1, paragraph - 1);
        else session.reader.navigate({ pageIndex: page - 1 });
      });
      node.append(content);
    }
    return node;
  }

  function update(ctx, root) {
    const { session, h } = ctx;
    const chat = session.chat;
    const list = root.querySelector(".dr-chat-messages");
    const quotesBox = root.querySelector(".dr-chat-quotes");
    const sendButton = root.querySelector(".dr-chat-send");

    list.replaceChildren();
    if (!chat) {
      list.append(h("div", { class: "dr-muted" }, "…"));
    }
    else if (!chat.messages.length) {
      list.append(h("div", { class: "dr-muted" }, DeepRead.t("chat.empty")));
      if (!session.hasResults) list.append(h("div", { class: "dr-muted dr-small" }, DeepRead.t("chat.noContext")));
    }
    else {
      chat.messages.forEach((message, i) => {
        const streaming = chat.streaming && i === chat.messages.length - 1;
        list.append(renderMessage(ctx, root, message, streaming));
      });
    }
    if (chat?.error) list.append(h("div", { class: "dr-error" }, chat.error));
    list.scrollTop = list.scrollHeight;

    quotesBox.replaceChildren();
    session.pendingQuotes.forEach((quote, i) => {
      quotesBox.append(h("div", { class: "dr-chip", title: quote.text },
        h("span", {}, `${DeepRead.t("chat.quote")}${Number.isInteger(quote.pageIndex) ? ` p.${quote.pageIndex + 1}` : ""}: ${quote.text.slice(0, 60)}${quote.text.length > 60 ? "…" : ""}`),
        h("button", {
          class: "dr-chip-remove",
          onclick: () => {
            session.pendingQuotes.splice(i, 1);
            update(ctx, root);
          },
        }, "×")));
    });

    const streaming = !!chat?.streaming;
    sendButton.textContent = streaming ? DeepRead.t("chat.stop") : DeepRead.t("chat.send");
    sendButton.classList.toggle("dr-stop", streaming);
  }

  function updateStreaming(ctx, root) {
    const chat = ctx.session.chat;
    const list = root.querySelector(".dr-chat-messages");
    const last = list?.lastElementChild;
    const message = chat?.messages[chat.messages.length - 1];
    if (!last || !message || message.role !== "assistant" || !last.classList.contains("dr-msg-assistant")) {
      update(ctx, root);
      return;
    }
    const now = Date.now();
    if (root._lastStreamRender && now - root._lastStreamRender < 120) {
      clearTimeout(root._streamTimer);
      root._streamTimer = setTimeout(() => updateStreaming(ctx, root), 130);
      return;
    }
    root._lastStreamRender = now;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    last.replaceWith(renderMessage(ctx, root, message, true));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  DeepRead.Panes.renderers.chat = (ctx) => {
    const { body, session, h, event } = ctx;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    if (event === "progress") return;
    let root = body.querySelector(":scope > .dr-chat-pane");
    if (!root || root._session !== session) {
      const input = h("textarea", { class: "dr-chat-input", rows: "3", placeholder: DeepRead.t("chat.placeholder") });
      const sendButton = h("button", { class: "dr-primary-button dr-chat-send" }, DeepRead.t("chat.send"));
      const doSend = () => {
        if (session.chat?.streaming) {
          DeepRead.ChatPane.stop(session);
          return;
        }
        const text = input.value;
        input.value = "";
        DeepRead.ChatPane.send(session, text);
      };
      sendButton.addEventListener("click", doSend);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          doSend();
        }
      });
      root = h("div", { class: "dr-pane dr-chat-pane" },
        h("div", { class: "dr-chat-messages dr-markdown-host" }),
        h("div", { class: "dr-chat-quotes" }),
        h("div", { class: "dr-chat-compose" }, input, sendButton));
      root._session = session;
      DeepRead.Markdown.wireLinks(root.querySelector(".dr-chat-messages"));
      body.replaceChildren(root);
      DeepRead.ChatPane.ensureLoaded(session);
    }
    if (event === "chat-delta") {
      updateStreaming(ctx, root);
      return;
    }
    update(ctx, root);
    if (event === "ask") root.querySelector(".dr-chat-input")?.focus();
  };
})();
