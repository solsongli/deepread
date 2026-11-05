/* Question-pane interaction regressions in Zotero's real main-window DOM.
 * E2E_SKIP_SERVICES=1 E2E_BASE=$PWD/.test-profile/questions-ux scripts/e2e.sh test/e2e/questionsPane.js
 * No PDF upload or model request; session replies are local fixtures.
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, value) => { E2E.result.steps.push({ name, ok: !!value }); if (!value) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.questions; i++) await sleep(100);
  const D = Zotero.DeepRead, win = Zotero.getMainWindow(), doc = win.document;
  win.resizeTo(1100, 1000);
  const host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  host.style.cssText = "position:fixed;right:20px;top:20px;width:340px;max-height:930px;overflow:auto;padding:16px;background:var(--material-background,#fff);color:var(--fill-primary,#24292f);z-index:2147483646;box-sizing:border-box";
  doc.documentElement.append(host);
  let current, submitted = [], errors = [];
  const originalReport = D.Panes.reportError, previousHide = D.prefs.get("questions.hideAnswers");
  const hadThemePref = Services.prefs.prefHasUserValue("ui.systemUsesDarkTheme");
  const themePref = Services.prefs.getIntPref("ui.systemUsesDarkTheme", 0);
  const render = (event = "change") => D.Panes.renderers.questions({ body: host, doc, session: current, event, h: (...args) => D.util.h(doc, ...args) });
  const makeSession = () => ({
    userState: { modules: { questions: true }, recallMode: true, readingGoal: { kind: "evidence", text: "这张图支持了哪一步结论？" }, recallAnswers: {} },
    questions: { items: [{ id: "q1", question: "作者的实验是否真的支持方法有效？", answer: "平均准确率提高，但样本规模和测试分布限制了结论的适用范围。\n\n回到实验设置，核对对照组和误差范围。", keys: ["p_0_0", "p_0_0", "p_1_2"] }] },
    hasResults: true, reached: false, generatingQuestions: false,
    questionProgress() { return { total: 1, reached: this.reached ? 1 : 0 }; },
    questionReached() { return this.reached; }, questionLabel: (q) => q.id.toUpperCase(),
    readingTargets: () => [], _paragraphByKey: () => ({ page: { pageIndex: 0 } }),
    _saveUserStateSoon() {}, _emit(event) { if (current === this) render(event); },
    setReadingGoal(kind, text = this.userState.readingGoal.text, { notify = true } = {}) {
      this.userState.readingGoal = { kind, text }; if (notify) this._emit("questions");
    },
    openBlock(page, paragraph) { this.lastSource = { page, paragraph }; },
    readingRecord: () => "My notes", saveReadingNote: async () => {},
    askQuestion: async (text) => { submitted.push(text); },
  });
  const input = (node, value) => { node.value = value; node.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const screenshot = async (name) => {
    await sleep(150);
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), name), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  };
  try {
    D.Panes.reportError = (_session, error) => errors.push(error.message);
    D.prefs.set("questions.hideAnswers", true);
    current = makeSession();
    current.userState.recallMode = false;
    render();
    check("question stylesheet is loaded", !!doc.getElementById("deepread-questions-css"));
    check("hidden answer keeps source route available", !host.querySelector(".dr-q-answer") && host.querySelectorAll(".dr-q-chip").length === 2);
    const chip = host.querySelector(".dr-q-chip");
    check("source locations are native keyboard buttons", chip.localName === "button" && chip.tabIndex === 0 && chip.getAttribute("aria-label").includes("1"));
    chip.click();
    check("source button opens exact paragraph", current.lastSource.page === 0 && current.lastSource.paragraph === 0);
    current.userState.recallMode = true; render();

    let draft = host.querySelector(".dr-q-input");
    input(draft, "消融实验是否充分？"); draft.focus(); draft.setSelectionRange(2, 4);
    render("change"); draft = host.querySelector(".dr-q-input");
    check("background refresh keeps unsubmitted question", draft.value === "消融实验是否充分？");
    check("background refresh preserves focus and selection", doc.activeElement === draft && draft.selectionStart === 2 && draft.selectionEnd === 4);
    let recall = host.querySelector(".dr-q-recall");
    input(recall, "需要核对样本量和置信区间。"); recall.focus(); recall.setSelectionRange(3, 6);
    render("questions"); recall = host.querySelector(".dr-q-recall");
    check("personal explanation and caret survive new results", recall.value.includes("置信区间") && doc.activeElement === recall && recall.selectionStart === 3 && recall.selectionEnd === 6);

    draft = host.querySelector(".dr-q-input"); draft.focus();
    draft.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true, data: "zhong" }));
    render("change");
    check("composition is not interrupted by background refresh", host.querySelector(".dr-q-input") === draft);
    draft.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    check("IME Enter never submits question", submitted.length === 0);
    draft.dispatchEvent(new win.CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    input(draft, "中文输入完成的问题");
    await sleep(30);
    check("deferred render uses committed composition text", host.querySelector(".dr-q-input").value === "中文输入完成的问题");

    const firstSession = current;
    current = makeSession(); render();
    check("question drafts do not leak across papers", host.querySelector(".dr-q-input").value === "");
    current = firstSession; render();
    check("returning to paper restores its draft", host.querySelector(".dr-q-input").value === "中文输入完成的问题");
    current.askQuestion = async () => { throw new Error("offline fixture failure"); };
    host.querySelector(".dr-q-add button").click();
    await sleep(20);
    check("failed request restores submitted question", host.querySelector(".dr-q-input").value === "中文输入完成的问题" && errors.length === 1);
    let fail;
    current.askQuestion = () => new Promise((_resolve, reject) => { fail = reject; });
    host.querySelector(".dr-q-add button").click();
    input(host.querySelector(".dr-q-input"), "新的问题不应被覆盖");
    fail(new Error("delayed offline failure")); await sleep(20);
    check("late failure never overwrites newer draft", host.querySelector(".dr-q-input").value === "新的问题不应被覆盖");
    current.askQuestion = async (text) => { submitted.push(text); };
    host.querySelector(".dr-q-input").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    check("ordinary Enter submits once and clears draft", submitted.length === 1 && submitted[0] === "新的问题不应被覆盖" && host.querySelector(".dr-q-input").value === "");

    const reveal = host.querySelector(".dr-q-reveal"); reveal.focus(); reveal.click();
    check("personal explanation and AI reference have distinct labels", !!host.querySelector(".dr-q-own .dr-q-section-label") && !!host.querySelector(".dr-q-answer > .dr-q-section-label") && !!host.querySelector(".dr-q-sources .dr-q-section-label"));
    check("reveal keeps keyboard focus on comparison control", doc.activeElement === host.querySelector(".dr-q-reveal"));
    current.reached = true; render();
    check("progress describes source navigation rather than mastery", host.querySelector(".dr-q-state").title === D.bilingual("已浏览到答案出处；不代表已经理解", "Source location reached; this does not assess understanding"));
    check("narrow pane has no horizontal overflow", host.scrollWidth <= host.clientWidth + 1);
    await screenshot("questions-light.png");
    Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);
    await sleep(200);
    check("dark mode test exercises native Zotero theme", win.matchMedia("(prefers-color-scheme: dark)").matches);
    check("dark mode uses light answer reveal text", win.getComputedStyle(host.querySelector(".dr-q-reveal")).color === "rgb(213, 189, 255)");
    await screenshot("questions-dark.png");
    return { checks: E2E.result.steps.length };
  }
  finally {
    host.remove(); D.Panes.reportError = originalReport; D.prefs.set("questions.hideAnswers", previousHide);
    if (hadThemePref) Services.prefs.setIntPref("ui.systemUsesDarkTheme", themePref);
    else Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
  }
};
