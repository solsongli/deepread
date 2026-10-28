/*
 * Feature modules the reader can switch per paper (toolbar 「功能」 menu) or globally (settings).
 * Effective state = the paper's override (session.userState.modules[key]) if set, else the global pref.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

DeepRead.Modules = {
  LIST: [
    { key: "cards", pref: "view.marginCards", zh: "页边卡片", en: "Margin cards" },
    { key: "hoverTranslation", pref: "view.translationPopup", zh: "悬停翻译", en: "Hover translation", hintZh: "双栏放到另一栏，单栏放在段落下方，与原段同大小", hintEn: "In the other column (two-column pages) or below, same size as the paragraph" },
    { key: "highlights", pref: "view.highlights", zh: "要点高亮", en: "Key-point highlights", hintZh: "重要 / 关键要点在原文中着色", hintEn: "Colour important points in the PDF" },
    { key: "structureBar", pref: "view.structureBar", zh: "全文结构条", en: "Section bar", hintZh: "工具栏下的章节横条", hintEn: "Section strip under the toolbar" },
    { key: "figureCards", pref: "view.figureCards", zh: "图表卡片", en: "Figure cards", hintZh: "图表成卡，附读图步骤", hintEn: "Figures as cards with reading steps" },
    { key: "skim", pref: "view.skim", zh: "速读分层", en: "Skim layers", hintZh: "阅读深度：全文 / 重点 / 只看边注", hintEn: "Reading depth: full / key / margin only" },
    { key: "lookup", pref: "view.lookup", zh: "悬停查证", en: "Hover lookup", hintZh: "引用和图表引用", hintEn: "Citations and figure references" },
    { key: "guided", pref: "view.guided", zh: "带读", en: "Guided reading", hintZh: "Agent 带读：定位 → 骨架 → 方法 → 证据 → 带走", hintEn: "Agent-guided: position → skeleton → method → evidence → takeaway" },
    { key: "questions", pref: "view.questions", zh: "问题导向", en: "Question-led reading", hintZh: "5 个阅读问题，答案挂到卡片和结构条", hintEn: "Five reading questions, answers on cards and the section bar" },
  ],

  get(key) {
    return this.LIST.find((m) => m.key === key) || null;
  },

  /** Is the module on for this paper? */
  enabled(session, key) {
    const module = this.get(key);
    if (!module) return false;
    const override = session?.userState?.modules?.[key];
    if (typeof override === "boolean") return override;
    return DeepRead.prefs.get(module.pref) !== false;
  },

  /** Paper-level override (scope "paper") or new global default (scope "default", which drops the paper's override). */
  set(session, key, value, scope = "paper") {
    const module = this.get(key);
    if (!module) return;
    if (scope === "default") {
      DeepRead.prefs.set(module.pref, !!value);
      if (session?.userState?.modules) delete session.userState.modules[key];
    }
    else if (session) {
      session.userState.modules = { ...(session.userState.modules || {}), [key]: !!value };
    }
    session?._saveUserStateSoon?.();
    session?.applyModules?.();
  },

  count(session) {
    return { on: this.LIST.filter((m) => this.enabled(session, m.key)).length, total: this.LIST.length };
  },

  label(module) {
    return DeepRead.bilingual(module.zh, module.en);
  },

  hint(module) {
    return module.hintZh ? DeepRead.bilingual(module.hintZh, module.hintEn) : "";
  },
};
