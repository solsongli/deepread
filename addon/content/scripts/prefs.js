/* Preference access. License: AGPL-3.0-or-later */
/* global DeepRead, Zotero */

DeepRead.prefs = {
  PREFIX: "deepread.",

  get(key) {
    return Zotero.Prefs.get(this.PREFIX + key);
  },

  set(key, value) {
    return Zotero.Prefs.set(this.PREFIX + key, value);
  },

  number(key, fallback) {
    const n = Number(this.get(key));
    return Number.isFinite(n) ? n : fallback;
  },

  llmConfig({ chat = false } = {}) {
    const model = chat ? (this.get("llm.chatModel") || this.get("llm.model")) : this.get("llm.model");
    let extraHeaders = {};
    const rawHeaders = String(this.get("llm.extraHeaders") || "").trim();
    if (rawHeaders) {
      try {
        extraHeaders = JSON.parse(rawHeaders);
      }
      catch (e) {
        DeepRead.log("ignoring invalid llm.extraHeaders JSON");
      }
    }
    return {
      baseURL: String(this.get("llm.baseURL") || "").trim().replace(/\/+$/, ""),
      apiKey: String(this.get("llm.apiKey") || "").trim(),
      model: String(model || "").trim(),
      jsonMode: this.get("llm.jsonMode") || "json_object",
      temperature: this.number("llm.temperature", 0.6),
      concurrency: Math.max(1, Math.min(64, this.number("llm.concurrency", 8))),
      extraHeaders,
    };
  },

  /** Saved provider profiles (read-only; the runtime itself reads the flat llm.* prefs). */
  profiles() {
    try {
      const list = JSON.parse(String(this.get("llm.profiles") || "[]"));
      return Array.isArray(list) ? list.filter((p) => p && typeof p === "object" && p.id) : [];
    }
    catch (e) {
      return [];
    }
  },

  activeProfile() {
    const id = String(this.get("llm.activeProfile") || "");
    const list = this.profiles();
    return list.find((p) => p.id === id) || null;
  },

  parserConfig() {
    return {
      provider: this.get("parser.provider") || "builtin",
      mineruToken: String(this.get("parser.mineruToken") || "").trim(),
      mineruModel: this.get("parser.mineruModel") || "pipeline",
      mineruLanguage: this.get("parser.mineruLanguage") || "en",
      mineruOCR: !!this.get("parser.mineruOCR"),
      mineruFormula: this.get("parser.mineruFormula") !== false,
      mineruTable: this.get("parser.mineruTable") !== false,
      selfHostURL: String(this.get("parser.selfHostURL") || "").trim().replace(/\/+$/, ""),
      selfHostToken: String(this.get("parser.selfHostToken") || "").trim(),
      selfHostBackend: this.get("parser.selfHostBackend") || "pipeline",
      grobidURL: String(this.get("parser.grobidURL") || "http://127.0.0.1:8070").trim().replace(/\/+$/, ""),
    };
  },

  /** Highlighter colours (1-6 lowercase "#rrggbb"); falls back to the default pair. */
  normalizeColors(list) {
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
      let s = String(c || "").trim().toLowerCase();
      if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
      if (/^#[0-9a-f]{6}$/.test(s)) out.push(s);
      if (out.length >= 6) break;
    }
    return out;
  },

  highlightColors() {
    let list = [];
    try {
      list = this.normalizeColors(JSON.parse(String(this.get("highlight.colors") || "[]")));
    }
    catch (e) {
      list = [];
    }
    return list.length ? list : ["#3b82f6", "#ef4444"];
  },

  setHighlightColors(list) {
    const colors = this.normalizeColors(list);
    const final = colors.length ? colors : ["#3b82f6", "#ef4444"];
    this.set("highlight.colors", JSON.stringify(final));
    return final;
  },

  language() {
    const lang = this.get("language") || "zh";
    return DeepRead.PARSE_LANGUAGES?.[lang] ? lang : "zh";
  },
};
