/* Local typography functions available to the paper chat. License: AGPL-3.0-or-later */
(function () {
  const roles = ["documentTitle", "runningTitle", "heading", "subheading", "body", "figureCaption", "tableCaption", "figureLabel", "tableLabel"];
  const describe = (name, description, properties) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, additionalProperties: false } }
  });
  const fontTool = describe("pdf_fonts", "Read the local font stack, size and leading in points. Omit role for all roles.",
    { role: { type: "string", enum: roles } });
  const layoutTool = describe("pdf_layout", "Inspect the current translated page by default. Apply only on explicit user request. Reflows existing text locally without retranslating.",
    { mode: { type: "string", enum: ["inspect", "apply"] } });
  const checkTool = describe("pdf_check_translation",
    "Call with {} to check the current page for missing units, protected expressions, emphasis or short replies. Read-only. Counts describe local checks, not translation accuracy.", {});
  const unavailable = new Set();

  function select(question, comparisonOpen) {
    const explicit = /deepread|nature[- ]trans|pdf_fonts|pdf_layout|pdf_check_translation|对照|译[文页稿]|translated page|translation layout/iu.test(question);
    const context = explicit || (comparisonOpen && /当前页|本页|这[一]?页|重新排版|重排|\b(?:this|current) page\b|\breflow\b/iu.test(question));
    if (!context) return [];
    const tools = [];
    if (/pdf_fonts|字体|字号|字重|宋体|黑体|font|typography/iu.test(question)) tools.push(fontTool);
    if (/pdf_layout|排版|重排|对齐|行距|段距|行数|换行|断行|reflow|typeset|layout|line (?:spacing|break|count)/iu.test(question)) tools.push(layoutTool);
    if (/pdf_check_translation|漏译|缺译|待译|补页|译文完整|检查[^。！？]{0,9}译文|核对[^。！？]{0,9}译文|漏掉(?:了)?(?:公式|数字|引用)|占位符|missing translation|check (?:the )?translation/iu.test(question))
      tools.push(checkTool);
    return tools;
  }

  async function fonts(session, page, role) {
    const profile = page?.styleProfile || await DeepRead.PaperStyles.resolve(session);
    const language = page?.language || DeepRead.prefs.language();
    const simplified = /^(?:zh|zh-CN|zh-Hans)$/iu.test(language);
    const traditional = /^(?:zh-TW|zh-Hant)$/iu.test(language);
    const faces = {
      serif: simplified ? "Chinese Song typefaces + STIX Two Text" : traditional ? "STIX Two Text + Source Han Serif TC" : "STIX Two Text",
      sans: traditional ? "Noto Sans CJK TC" : "Noto Sans SC"
    };
    const styles = {};
    for (const key of role ? [role] : roles) {
      if (key === "figureLabel" || key === "tableLabel") {
        const kind = key === "figureLabel" ? "figure_label" : "table_label";
        const used = new Map();
        for (const unit of page?.units || []) {
          if (unit.role !== kind) continue;
          const {family,weight} = DeepRead.PaperStyles.labelFace(unit,language);
          const font = simplified && family === "serif" && weight === 500 ? "Noto Serif SC + STIX Two Text" : faces[family];
          used.set(font+"/"+weight,{font,weight});
        }
        const observed = [...used.values()];
        styles[key] = { font: [...new Set(observed.map(s=>s.font))].join(" / ") || "determined by the printed label",
          observed, size: "fits source frame",
          selection: "Source emphasis is retained. Simplified-Chinese table cells and native figure labels use the source family when identified. Unknown figure faces default to sans. Native figure labels below 6 pt and OCR labels use regular weight." };
        continue;
      }
      const sample = page?.units?.find(u => u.typeRole === key);
      const style = sample ? DeepRead.PaperStyles.styleFor(sample, profile) : profile.roles[key];
      styles[key] = { font: faces[style.family], pt: style.size, leading: style.step, weight: style.weight };
      if (simplified && style.family === "serif")
        styles[key].han = [500,550,700].includes(style.weight)
          ? { font: "Noto Serif SC", weight: style.weight === 700 ? 750 : style.weight }
          : { order: ["SimSun", "AR PL UMing CN", "STSong", "Noto Serif SC"], fallbackWeight: 500 };
    }
    return { styles, reference: "The nature-trans pages are raster images; exact font names are unknown." };
  }

  function activePageError(comparison, page) {
    if (!page || !comparison?.root)
      return DeepRead.bilingual("请先打开原版对照。", "Open original-layout comparison first.");
    if (comparison.page !== page)
      return DeepRead.bilingual("当前页已切换。", "The active page changed.");
    return "";
  }

  function layout(comparison, page, apply) {
    const error = activePageError(comparison, page);
    if (error) return { error };
    const translated = page.units.filter(unit => !!unit.translation).length;
    const ready = translated > 0 && comparison.surface?.page === page && !comparison.exportJob;
    if (apply && ready) comparison.paint();
    return {
      page: page.index + 1, translated, total: page.units.length, supplements: page.supplements?.length || 0,
      applied: apply && ready
    };
  }

  function checkTranslation(comparison, page) {
    const error = activePageError(comparison, page);
    if (error) return { error };
    const issues = [];
    let pending = 0, flagged = 0;
    for (const [i, unit] of page.units.entries()) {
      const code = DeepRead.ParallelPage.translationIssue(unit);
      if (!code) continue;
      if (code === "missing") pending++;
      else flagged++;
      if (issues.length < 8) issues.push({ unit: i + 1, code });
    }
    return {
      page: page.index + 1, total: page.units.length, pending, flagged, issues,
      supplements: page.supplements?.length || 0, originalBibliography: !!page.bibliographyOnly
    };
  }

  async function answer(session, question, tools, { config, signal, onDelta }) {
    const comparison = session.comparison, page = comparison?.root ? comparison.page : null;
    const allowApply = /重新排|重排|应用[^。！？]*排版|把[^。！？]*重新[^。！？]*对齐|\breflow\b|\bretypeset\b|\bapply\b[^.?]*\blayout\b/iu.test(question);
    const language = DeepRead.PARSE_LANGUAGES[DeepRead.prefs.language()] || DeepRead.PARSE_LANGUAGES.zh;
    const system = `Call the available PDF tools for current-page facts. Use mode=apply only on explicit request. Report local check results as rule checks. Reply briefly in ${language.instruction} unless the user writes in another language.`;
    const messages = [{ role: "user", content: question }];
    const model = config.baseURL + "\n" + config.model;
    let message;
    if (!unavailable.has(model)) {
      try {
        const response = await DeepRead.LLM.complete({ messages, system, config, signal, tools, reasoningEffort: "low" });
        message = response.raw?.choices?.[0]?.message;
      } catch (error) {
        if (![400, 422].includes(error.status) || !/tools?|function.call/i.test(error.body || "")) throw error;
        unavailable.add(model);
      }
    }
    if (signal?.aborted) return;
    const run = (name, args) => {
      if (name === "pdf_fonts" && (!args.role || roles.includes(args.role))) return fonts(session, page, args.role);
      if (name === "pdf_layout" && (!args.mode || ["inspect", "apply"].includes(args.mode)))
        return layout(comparison, page, allowApply && args.mode === "apply");
      if (name === "pdf_check_translation" && !Object.keys(args).length)
        return checkTranslation(comparison, page);
      return { error: "Invalid tool arguments." };
    };
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls.filter(call => call.type === "function" && typeof call.id === "string").slice(0, 8)
      : [];
    if (!calls.length) {
      // Some compatible endpoints ignore tools. The local result still comes
      // from the same renderer and avoids another model request.
      const lines = [];
      if (tools.includes(fontTool)) {
        const data = await fonts(session, page, "body");
        const { font, pt, leading } = data.styles.body;
        lines.push(DeepRead.bilingual(`正文使用 ${font}，字号 ${pt} pt，行距 ${leading} pt。`,
          `Body: ${font}, ${pt} pt, leading ${leading} pt.`));
      }
      if (tools.includes(layoutTool)) {
        const result = layout(comparison, page, allowApply);
        lines.push(result.error || DeepRead.bilingual(
          `第 ${result.page} 页${result.applied ? "已重排，" : "有 "}${result.translated}/${result.total} 处已译，${result.supplements} 处需查看完整译文。`,
          `Page ${result.page}${result.applied ? " reflowed" : ""}. ${result.translated}/${result.total} translated, ${result.supplements} full passages.`));
      }
      if (tools.includes(checkTool)) {
        const result = checkTranslation(comparison, page);
        lines.push(result.error || (result.originalBibliography
          ? DeepRead.bilingual("本页参考文献沿用原稿。", "This bibliography page is shown as in the original.")
          : DeepRead.bilingual(
              `第 ${result.page} 页共 ${result.total} 个译文单元，${result.pending} 个待译，${result.flagged} 个触发了校验规则。${result.supplements} 处可查看完整译文。`,
              `Page ${result.page} has ${result.total} units, ${result.pending} pending and ${result.flagged} flagged. ${result.supplements} full passages are available.`)));
      }
      const content = lines.join("\n\n");
      if (!signal?.aborted) onDelta(content, content);
      return;
    }
    const followUp = [...messages, {
      role: "assistant", content: message.content ?? null, tool_calls: calls,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {})
    }];
    for (const call of calls) {
      if (signal?.aborted) return;
      let args;
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* Return the argument error to the caller. */ }
      const result = args && typeof args === "object" && !Array.isArray(args) && tools.some(t => t.function.name === call.function?.name)
        ? await run(call.function.name, args)
        : { error: "Invalid tool call." };
      followUp.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (!signal?.aborted)
      await DeepRead.LLM.stream({ messages: followUp, system, config, signal, onDelta, reasoningEffort: "low" });
  }

  DeepRead.PaperTools = { select, answer };
})();
