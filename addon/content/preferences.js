/*
 * DeepRead preferences pane script (runs in the preferences window scope).
 * License: AGPL-3.0-or-later
 */
(function () {
  var PREFIX = "extensions.zotero.deepread.";
  var PRESETS = {
    deepseek: ["https://api.deepseek.com/v1", "deepseek-chat"],
    dashscope: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
    zhipu: ["https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"],
    ark: ["https://ark.cn-beijing.volces.com/api/v3", ""],
    siliconflow: ["https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"],
    openrouter: ["https://openrouter.ai/api/v1", "deepseek/deepseek-chat"],
    openai: ["https://api.openai.com/v1", "gpt-4o-mini"],
    ollama: ["http://127.0.0.1:11434/v1", "qwen2.5:7b"],
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setField(id, prefKey, value) {
    var el = $(id);
    if (el) {
      el.value = value;
    }
    try {
      Zotero.Prefs.set(PREFIX + prefKey, value, true);
    } catch (e) {
      Zotero.debug("[DeepRead] pref set failed: " + e);
    }
  }


  var PRESET_NAMES = {
    deepseek: "DeepSeek",
    dashscope: "阿里云百炼 / 通义",
    zhipu: "智谱 GLM",
    ark: "火山方舟 / 豆包",
    siliconflow: "SiliconFlow",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    ollama: "Ollama",
  };
  // Flat pref key -> [profile field, control id, kind]
  var PROFILE_FIELDS = [
    ["baseURL", "llm.baseURL", "deepread-pref-llm-baseurl"],
    ["apiKey", "llm.apiKey", "deepread-pref-llm-apikey"],
    ["model", "llm.model", "deepread-pref-llm-model"],
    ["chatModel", "llm.chatModel", "deepread-pref-llm-chatmodel"],
    ["jsonMode", "llm.jsonMode", "deepread-pref-llm-jsonmode"],
    ["temperature", "llm.temperature", "deepread-pref-llm-temperature"],
    ["concurrency", "llm.concurrency", "deepread-pref-llm-concurrency"],
    ["extraHeaders", "llm.extraHeaders", "deepread-pref-llm-extraheaders"],
  ];
  var profiles = [];
  var activeId = "";

  function getPref(key, fallback) {
    try {
      var v = Zotero.Prefs.get(PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function setPref(key, value) {
    try {
      Zotero.Prefs.set(PREFIX + key, value, true);
    } catch (e) {
      Zotero.debug("[DeepRead] pref set failed: " + e);
    }
  }

  function newId() {
    return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function readFlatProfile() {
    var p = { preset: guessPreset() };
    PROFILE_FIELDS.forEach(function (f) {
      p[f[0]] = getPref(f[1], "");
    });
    p.concurrency = Number(p.concurrency) || 8;
    p.temperature = String(p.temperature);
    return p;
  }

  function loadProfiles() {
    try {
      var list = JSON.parse(String(getPref("llm.profiles", "[]")) || "[]");
      profiles = Array.isArray(list) ? list.filter(function (p) { return p && p.id; }) : [];
    } catch (e) {
      profiles = [];
    }
    activeId = String(getPref("llm.activeProfile", "") || "");
    if (!profiles.length) {
      // Migration: wrap the current flat llm.* prefs into the first profile.
      var p = readFlatProfile();
      p.id = newId();
      p.name = PRESET_NAMES[p.preset] || "默认";
      profiles = [p];
      activeId = p.id;
      saveProfiles();
    } else if (!profiles.some(function (p) { return p.id === activeId; })) {
      activeId = profiles[0].id;
      setPref("llm.activeProfile", activeId);
      applyProfileToFlat(profiles[0]);
    }
  }

  function saveProfiles() {
    setPref("llm.profiles", JSON.stringify(profiles));
    setPref("llm.activeProfile", activeId);
  }

  function activeProfile() {
    for (var i = 0; i < profiles.length; i++) if (profiles[i].id === activeId) return profiles[i];
    return null;
  }

  function applyProfileToFlat(p) {
    PROFILE_FIELDS.forEach(function (f) {
      var v = p[f[0]];
      if (v === undefined || v === null) v = f[0] === "concurrency" ? 8 : "";
      if (f[0] === "concurrency") v = Number(v) || 8;
      else v = String(v);
      setPref(f[1], v);
    });
  }

  function refreshControls() {
    var p = activeProfile();
    if (!p) return;
    PROFILE_FIELDS.forEach(function (f) {
      var el = $(f[2]);
      if (el) el.value = String(getPref(f[1], ""));
    });
    var preset = $("deepread-pref-llm-preset");
    if (preset) preset.value = p.preset || guessPreset();
    var name = $("deepread-pref-profile-name");
    if (name) name.value = p.name || "";
  }

  // Copy the flat prefs (just edited) into the active profile.
  function syncActiveFromFlat() {
    var p = activeProfile();
    if (!p) return;
    var preset = $("deepread-pref-llm-preset");
    var cur = readFlatProfile();
    cur.preset = (preset && preset.value) || cur.preset;
    PROFILE_FIELDS.forEach(function (f) {
      p[f[0]] = cur[f[0]];
    });
    p.preset = cur.preset;
    saveProfiles();
    renderProfiles();
  }

  function renderCards(container, items, activeValue, onPick) {
    container.textContent = "";
    items.forEach(function (it) {
      var card = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      card.className = "deepread-card";
      card.setAttribute("role", "radio");
      card.setAttribute("tabindex", "0");
      card.dataset.value = it.value;
      card.setAttribute("aria-checked", it.value === activeValue ? "true" : "false");
      var t = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      t.className = "deepread-card-title";
      t.textContent = it.title;
      var d = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      d.className = "deepread-card-desc";
      d.textContent = it.desc;
      var b = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      b.className = "deepread-card-badge";
      var tpl = $("deepread-pref-current-tpl");
      b.textContent = (tpl && tpl.textContent) || "当前";
      card.appendChild(t);
      card.appendChild(d);
      card.appendChild(b);
      card.addEventListener("click", function () { onPick(it.value); });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(it.value);
        }
      });
      container.appendChild(card);
    });
  }

  function renderProfiles() {
    var box = $("deepread-pref-profiles");
    if (!box) return;
    renderCards(box, profiles.map(function (p) {
      return { value: p.id, title: p.name || "—", desc: p.model || "—" };
    }), activeId, switchProfile);
    var del = $("deepread-pref-profile-delete");
    if (del) del.disabled = profiles.length <= 1;
  }

  function switchProfile(id) {
    var p = null;
    profiles.forEach(function (x) { if (x.id === id) p = x; });
    if (!p) return;
    activeId = id;
    applyProfileToFlat(p);
    saveProfiles();
    refreshControls();
    renderProfiles();
  }

  function addProfile(copyName) {
    var base = activeProfile() || readFlatProfile();
    var p = JSON.parse(JSON.stringify(base));
    p.id = newId();
    p.name = (base.name || "默认") + (copyName ? " 2" : " ＋");
    profiles.push(p);
    switchProfile(p.id);
    var nameEl = $("deepread-pref-profile-name");
    if (nameEl && nameEl.focus) nameEl.focus();
  }

  function deleteProfile() {
    if (profiles.length <= 1) return;
    profiles = profiles.filter(function (p) { return p.id !== activeId; });
    switchProfile(profiles[0].id);
  }

  function wireProfiles() {
    loadProfiles();
    refreshControls();
    renderProfiles();
    var add = $("deepread-pref-profile-add");
    if (add) add.addEventListener("command", function () { addProfile(false); });
    var copy = $("deepread-pref-profile-copy");
    if (copy) copy.addEventListener("command", function () { addProfile(true); });
    var del = $("deepread-pref-profile-delete");
    if (del) del.addEventListener("command", deleteProfile);
    var name = $("deepread-pref-profile-name");
    if (name) {
      name.addEventListener("input", function () {
        var p = activeProfile();
        if (!p) return;
        p.name = name.value;
        saveProfiles();
        renderProfiles();
      });
    }
    var schedule = function () { setTimeout(syncActiveFromFlat, 80); };
    PROFILE_FIELDS.forEach(function (f) {
      var el = $(f[2]);
      if (!el) return;
      ["input", "change", "command"].forEach(function (ev) { el.addEventListener(ev, schedule); });
    });
    var preset = $("deepread-pref-llm-preset");
    if (preset) preset.addEventListener("command", schedule);
  }

  // ---- channel 2: parser cards ----
  function wireParserCards() {
    var box = $("deepread-pref-parser-cards");
    if (!box) return;
    var select = function (v) {
      setPref("parser.provider", v);
      var menu = $("deepread-pref-parser-provider");
      if (menu) menu.value = v;
      markCards(box, v);
      updateProviderVisibility();
    };
    bindStaticCards(box, select);
    markCards(box, getPref("parser.provider", "builtin"));
  }

  function markCards(box, value) {
    box.querySelectorAll(".deepread-card").forEach(function (c) {
      c.setAttribute("aria-checked", c.dataset.value === value ? "true" : "false");
    });
  }

  function bindStaticCards(box, onPick) {
    box.querySelectorAll(".deepread-card").forEach(function (c) {
      c.addEventListener("click", function () { onPick(c.dataset.value); });
      c.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(c.dataset.value);
        }
      });
    });
  }

  // ---- channel 3: agent ----
  var AGENT_KINDS = ["none", "codex", "claude", "api", "import"];

  function agentKind() {
    var k = String(getPref("agent.kind", "none"));
    return AGENT_KINDS.indexOf(k) < 0 ? "none" : k;
  }

  function updateAgentVisibility() {
    var k = agentKind();
    var cli = k === "codex" || k === "claude";
    var show = function (id, on) { var el = $(id); if (el) el.hidden = !on; };
    show("deepread-pref-agent-command-block", cli);
    show("deepread-pref-agent-skills-block", cli || k === "api");
    show("deepread-pref-agent-api-block", k === "api");
    show("deepread-pref-agent-import-block", k === "import");
    show("deepread-pref-agent-detect-row", cli);
    var cmd = $("deepread-pref-agent-command");
    if (cmd) cmd.setAttribute("placeholder", k === "claude" ? "claude -p" : "codex exec");
    var st = $("deepread-pref-agent-status");
    if (st) {
      st.value = "";
      st.setAttribute("value", "");
      st.className = "deepread-pref-status";
    }
  }

  function agentSkillNames() {
    return String(getPref("agent.skills", "")).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function wireAgent() {
    var box = $("deepread-pref-agent-cards");
    if (!box) return;
    bindStaticCards(box, function (v) {
      setPref("agent.kind", v);
      markCards(box, v);
      updateAgentVisibility();
    });
    markCards(box, agentKind());
    updateAgentVisibility();

    var chosen = agentSkillNames();
    var boxes = document.querySelectorAll("#deepread-pref-agent-skills-block checkbox[data-skill]");
    boxes.forEach(function (cb) {
      cb.checked = chosen.indexOf(cb.dataset.skill) >= 0;
      cb.addEventListener("command", function () {
        var out = [];
        boxes.forEach(function (c) { if (c.checked) out.push(c.dataset.skill); });
        setPref("agent.skills", out.join(","));
      });
    });

    var detect = $("deepread-pref-agent-detect");
    if (detect) detect.addEventListener("command", runDetect);
  }

  async function findExecutable(name) {
    var sep = Zotero.isWin ? ";" : ":";
    var dirs = String(Services.env.get("PATH") || "").split(sep).filter(Boolean);
    var names = Zotero.isWin ? [name + ".exe", name + ".cmd", name + ".bat", name] : [name];
    for (var i = 0; i < dirs.length; i++) {
      for (var j = 0; j < names.length; j++) {
        try {
          var path = PathUtils.join(dirs[i], names[j]);
          if (await IOUtils.exists(path)) return path;
        } catch (e) {}
      }
    }
    return null;
  }

  async function countSkills() {
    var home = "";
    try {
      home = PathUtils.homeDir || "";
    } catch (e) {}
    if (!home) home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    var roots = [
      PathUtils.join(home, "agents", "codex", "skills"),
      PathUtils.join(home, ".codex", "skills"),
      PathUtils.join(home, ".claude", "skills"),
    ];
    var names = ["nature-paper-xray", "nature-paper-card"];
    var found = [];
    for (var i = 0; i < names.length; i++) {
      for (var j = 0; j < roots.length; j++) {
        try {
          if (await IOUtils.exists(PathUtils.join(roots[j], names[i], "SKILL.md"))) {
            found.push(names[i]);
            break;
          }
        } catch (e) {}
      }
    }
    return found;
  }

  async function L(id, args) {
    try {
      if (document.l10n && document.l10n.formatValue) {
        var v = await document.l10n.formatValue(id, args);
        if (v) return String(v).replace(/[\u2068\u2069]/g, "");
      }
    } catch (e) {}
    return id;
  }

  async function runDetect() {
    var status = $("deepread-pref-agent-status");
    var kind = agentKind();
    if (!status || (kind !== "codex" && kind !== "claude")) return;
    var set = function (cls, text) {
      status.className = "deepread-pref-status" + (cls ? " " + cls : "");
      status.value = text;
      status.setAttribute("value", text);
    };
    set("", "…");
    try {
      // Only looks for files; nothing is ever executed.
      var exe = await findExecutable(kind);
      var skills = await countSkills();
      var all = ["nature-paper-xray", "nature-paper-card"];
      var missing = all.filter(function (n) { return skills.indexOf(n) < 0; }).join(", ");
      var text = await L(exe ? "deepread-pref-agent-found" : "deepread-pref-agent-notfound", { kind: kind, n: skills.length });
      if (exe && missing) text += " " + (await L("deepread-pref-agent-skills-missing", { names: missing }));
      set(exe && skills.length ? "ok" : "error", text);
    } catch (e) {
      set("error", String((e && e.message) || e));
    }
  }

  function guessPreset() {
    var url = "";
    try {
      url = String(Zotero.Prefs.get(PREFIX + "llm.baseURL", true) || "").replace(/\/+$/, "");
    } catch (e) {}
    for (var k in PRESETS) {
      if (PRESETS[k][0] === url) return k;
    }
    return "custom";
  }

  function updateProviderVisibility() {
    var menu = $("deepread-pref-parser-provider");
    var provider = menu && menu.value;
    if (!provider) {
      try {
        provider = Zotero.Prefs.get(PREFIX + "parser.provider", true);
      } catch (e) {}
    }
    var known = ["builtin", "grobid", "mineru", "selfhost"];
    if (known.indexOf(provider) < 0) provider = "builtin";
    var cards = $("deepread-pref-parser-cards");
    if (cards) markCards(cards, provider);
    var blocks = {
      builtin: "deepread-pref-parser-builtin",
      grobid: "deepread-pref-parser-grobid",
      mineru: "deepread-pref-parser-mineru",
      selfhost: "deepread-pref-parser-selfhost",
    };
    for (var k in blocks) {
      var el = $(blocks[k]);
      if (el) el.hidden = k !== provider;
    }
  }

  function wireTest(btnId, statusId, getTarget) {
    var btn = $(btnId);
    var status = $(statusId);
    if (!btn || !status) return;
    btn.addEventListener("command", async function () {
      var target = getTarget();
      var setStatus = function (cls, text) {
        status.className = "deepread-pref-status" + (cls ? " " + cls : "");
        status.setAttribute("value", text);
        status.value = text;
      };
      if (!target || typeof target.testConnection !== "function") {
        setStatus("error", "DeepRead is not loaded");
        return;
      }
      btn.disabled = true;
      setStatus("", "…");
      try {
        // Make sure typed-but-unblurred values are committed to prefs.
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
        var res = await target.testConnection();
        setStatus(res && res.ok ? "ok" : "error", (res && res.message) || "");
      } catch (e) {
        setStatus("error", String((e && e.message) || e));
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireUpdate() {
    var versionLabel = $("deepread-pref-update-version");
    var button = $("deepread-pref-update-check");
    var status = $("deepread-pref-update-status");
    var releases = $("deepread-pref-update-releases");
    var deepread = Zotero.DeepRead;
    if (versionLabel) versionLabel.value = deepread ? deepread.version : "?";
    if (releases) {
      releases.addEventListener("click", function (event) {
        event.preventDefault();
        Zotero.launchURL((deepread && deepread.Updater && deepread.Updater.RELEASES_URL) || "https://github.com/solsongli/deepread/releases");
      });
    }
    if (!button || !status) return;
    button.addEventListener("command", async function () {
      var updater = Zotero.DeepRead && Zotero.DeepRead.Updater;
      if (!updater) {
        status.value = "DeepRead is not loaded";
        status.className = "deepread-pref-status error";
        return;
      }
      button.disabled = true;
      try {
        await updater.checkAndInstall(function (state, text) {
          status.value = text;
          status.setAttribute("value", text);
          status.className = "deepread-pref-status" + (state === "ok" ? " ok" : state === "error" ? " error" : "");
        });
      }
      finally {
        button.disabled = false;
      }
    });
  }

  function wireSlider(id, valueId, prefKey, min, max, unit) {
    var input = $(id);
    var label = $(valueId);
    if (!input) return;
    var clamp = function (v) {
      v = Math.round(Number(v));
      if (!isFinite(v)) v = min;
      return Math.min(max, Math.max(min, v));
    };
    var show = function (v) {
      if (label) {
        label.value = v + " " + unit;
        label.setAttribute("value", v + " " + unit);
      }
    };
    var current = min;
    try {
      current = clamp(Zotero.Prefs.get(PREFIX + prefKey, true));
    } catch (e) {}
    input.value = String(current);
    show(current);
    var onInput = function () {
      var v = clamp(input.value);
      show(v);
      try {
        Zotero.Prefs.set(PREFIX + prefKey, v, true);
      } catch (e) {
        Zotero.debug("[DeepRead] pref set failed: " + e);
      }
    };
    input.addEventListener("input", onInput);
    input.addEventListener("change", onInput);
  }

  var HL_DEFAULT = ["#3b82f6", "#ef4444"];
  var HL_PALETTE = ["#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#6366f1"];

  function normColors(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      var s = String(c || "").trim().toLowerCase();
      if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
      if (/^#[0-9a-f]{6}$/.test(s) && out.length < 6) out.push(s);
    });
    return out;
  }

  function readColors() {
    var list = [];
    try {
      list = normColors(JSON.parse(String(getPref("highlight.colors", "[]")) || "[]"));
    } catch (e) {}
    return list.length ? list : HL_DEFAULT.slice();
  }

  function writeColors(list) {
    var c = normColors(list);
    setPref("highlight.colors", JSON.stringify(c.length ? c : HL_DEFAULT));
  }

  function wireHighlight() {
    var box = $("deepread-pref-hl-colors");
    if (!box) return;
    function render() {
      var colors = readColors();
      while (box.firstChild) box.removeChild(box.firstChild);
      colors.forEach(function (c, i) {
        var inp = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
        inp.type = "color";
        inp.className = "deepread-hl-swatch";
        inp.value = c;
        var save = function () {
          var cur = readColors();
          cur[i] = inp.value;
          writeColors(cur);
        };
        inp.addEventListener("input", save);
        inp.addEventListener("change", save);
        box.appendChild(inp);
      });
      var add = $("deepread-pref-hl-add");
      var rem = $("deepread-pref-hl-remove");
      if (add) add.disabled = colors.length >= 6;
      if (rem) rem.disabled = colors.length <= 1;
    }
    var add = $("deepread-pref-hl-add");
    if (add) add.addEventListener("command", function () {
      var cur = readColors();
      if (cur.length >= 6) return;
      var next = HL_PALETTE.filter(function (c) { return cur.indexOf(c) < 0; })[0] || "#22c55e";
      cur.push(next);
      writeColors(cur);
      render();
    });
    var rem = $("deepread-pref-hl-remove");
    if (rem) rem.addEventListener("command", function () {
      var cur = readColors();
      if (cur.length <= 1) return;
      cur.pop();
      writeColors(cur);
      render();
    });
    var reset = $("deepread-pref-hl-reset");
    if (reset) reset.addEventListener("command", function () {
      writeColors(HL_DEFAULT);
      render();
    });
    render();
  }

  function init() {
    var root = $("deepread-pref-root");
    if (!root || root.dataset.deepreadInit === "1") return;
    root.dataset.deepreadInit = "1";

    var preset = $("deepread-pref-llm-preset");
    if (preset) {
      preset.value = guessPreset();
      preset.addEventListener("command", function () {
        var p = PRESETS[preset.value];
        if (!p) return; // custom: leave fields alone
        setField("deepread-pref-llm-baseurl", "llm.baseURL", p[0]);
        setField("deepread-pref-llm-model", "llm.model", p[1]);
      });
    }


    wireProfiles();
    wireParserCards();
    wireAgent();

    var provider = $("deepread-pref-parser-provider");
    if (provider) {
      provider.addEventListener("command", updateProviderVisibility);
      provider.addEventListener("change", updateProviderVisibility);
    }
    updateProviderVisibility();
    // Menulist value is synced from the pref slightly after load.
    setTimeout(updateProviderVisibility, 0);
    setTimeout(updateProviderVisibility, 300);

    wireUpdate();
    wireSlider("deepread-pref-card-width", "deepread-pref-card-width-value", "view.railWidth", 200, 520, "px");
    wireSlider("deepread-pref-card-fontsize", "deepread-pref-card-fontsize-value", "view.cardFontSize", 10, 18, "px");

    wireHighlight();

    wireTest("deepread-pref-llm-test", "deepread-pref-llm-status", function () {
      return Zotero.DeepRead && Zotero.DeepRead.LLM;
    });
    wireTest("deepread-pref-parser-test", "deepread-pref-parser-status", function () {
      return Zotero.DeepRead && Zotero.DeepRead.Parser;
    });
  }

  // Zotero loads this script before inserting the pane fragment, then dispatches a
  // (non-bubbling) "load" event on the pane root: catch it in the capture phase.
  document.addEventListener("load", function (event) {
    if (event.target && event.target.id === "deepread-pref-root") init();
  }, true);
  // Fallback: poll briefly in case the event was missed.
  var tries = 0;
  (function poll() {
    if ($("deepread-pref-root")) {
      init();
      return;
    }
    if (++tries < 50) setTimeout(poll, 100);
  })();
})();
