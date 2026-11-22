/* UI smoke test: settings pane renders with localized labels and bound prefs; toolbar menu opens.
 * Run: scripts/e2e.sh test/e2e/ui.js */
/* global E2E, Zotero, IOUtils, PathUtils, setTimeout */

E2E.run = async function () {
  const steps = E2E.result.steps;
  const step = (name, data) => steps.push({ name, data });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000, label = "condition") => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  async function shot(win, name) {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const data = canvas.toDataURL("image/png").split(",")[1];
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const path = PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), `${name}.png`);
    await IOUtils.write(path, bytes);
    step("screenshot", path);
  }

  const DR = await waitFor(() => Zotero.DeepRead?.prefPaneID && Zotero.DeepRead, 15000, "plugin preferences");
  const main = Zotero.getMainWindow();
  main.resizeTo(1600, 1000);

  // --- Settings pane ---
  const prefsWin = Zotero.Utilities.Internal.openPreferences(DR.prefPaneID);
  const win = prefsWin || await waitFor(() => Services.wm.getMostRecentWindow("zotero:pref"), 10000, "prefs window");
  await waitFor(() => win.document.getElementById("deepread-pref-root"), 15000, "pref pane");
  win.resizeTo(1000, 1100);
  await sleep(1500);
  const doc = win.document;
  const root = doc.getElementById("deepread-pref-root");
  const unlocalized = [...root.querySelectorAll("[data-l10n-id]")]
    .filter((el) => !el.textContent.trim() && !el.getAttribute("label") && !el.getAttribute("value")
      && !el.getAttribute("placeholder") && !el.getAttribute("title") && !el.getAttribute("tooltiptext")
      && el.tagName !== "html:link")
    .map((el) => `${el.tagName}#${el.id}:${el.dataset.l10nId}`);
  const baseInput = root.querySelector('[preference="extensions.zotero.deepread.llm.baseURL"]');
  step("prefs", {
    l10nElements: root.querySelectorAll("[data-l10n-id]").length,
    unlocalized: unlocalized.slice(0, 20),
    baseURLValue: baseInput?.value,
    baseURLPref: Zotero.Prefs.get("deepread.llm.baseURL"),
    providerVisible: [...root.querySelectorAll("[id*='mineru'], [id*='selfhost']")].filter((e) => !e.hidden).map((e) => e.id).slice(0, 8),
  });
  await shot(win, "prefs-top");
  {
    const fs = doc.getElementById("deepread-pref-card-fontsize");
    const before = Zotero.Prefs.get("deepread.view.cardFontSize");
    fs.value = "15";
    fs.dispatchEvent(new win.Event("input", { bubbles: true }));
    const after = Zotero.Prefs.get("deepread.view.cardFontSize");
    const lbl = doc.getElementById("deepread-pref-card-fontsize-value")?.value;
    Zotero.Prefs.set("deepread.view.cardFontSize", 12);
    step("prefs-cardfontsize", { before, after, label: lbl, ok: after === 15 });
    if (after !== 15) throw new Error("cardFontSize pref not updated by slider: " + after);
  }
  {
    // Highlighter colours: swatches, + / - / reset, live save.
    const hlPref = () => JSON.parse(Zotero.Prefs.get("deepread.highlight.colors") || "[]");
    const swatches = () => doc.querySelectorAll("#deepread-pref-hl-colors .deepread-hl-swatch");
    const click = (id) => doc.getElementById(id).click();
    const initialCount = swatches().length;
    click("deepread-pref-hl-add");
    await sleep(200);
    const afterAdd = swatches().length;
    const addPrefLen = hlPref().length;
    const first = swatches()[0];
    first.value = "#112233";
    first.dispatchEvent(new win.Event("input", { bubbles: true }));
    first.dispatchEvent(new win.Event("change", { bubbles: true }));
    const edited = hlPref()[0];
    click("deepread-pref-hl-remove");
    await sleep(100);
    click("deepread-pref-hl-remove");
    await sleep(100);
    const afterRemove = swatches().length;
    click("deepread-pref-hl-reset");
    await sleep(200);
    const afterReset = hlPref();
    const ok = initialCount === 2 && afterAdd === 3 && addPrefLen === 3 && edited === "#112233"
      && afterRemove === 1 && JSON.stringify(afterReset) === JSON.stringify(["#3b82f6", "#ef4444"]) && swatches().length === 2;
    step("prefs-highlight", {
      initialCount, afterAdd, addPrefLen, edited, afterRemove, afterReset, ok,
      keepOpen: !!doc.getElementById("deepread-pref-cards-keepopen"),
      groupParagraphs: !!doc.getElementById("deepread-pref-cards-groupparagraphs"),
      keepOpenPref: Zotero.Prefs.get("deepread.cards.keepOpen"),
      groupPref: Zotero.Prefs.get("deepread.cards.groupParagraphs"),
    });
    if (!ok) throw new Error("highlight colour settings failed: " + JSON.stringify({ initialCount, afterAdd, addPrefLen, edited, afterRemove, afterReset }));
  }
  {
    // Profiles: migration, add (same path as the button), switch, switch back.
    const click = (id) => doc.getElementById(id).click();
    const profs = () => JSON.parse(Zotero.Prefs.get("deepread.llm.profiles") || "[]");
    const initial = profs();
    const firstId = Zotero.Prefs.get("deepread.llm.activeProfile");
    const firstModel = Zotero.Prefs.get("deepread.llm.model");
    if (initial.length !== 1 || initial[0].id !== firstId) throw new Error("profile migration failed: " + JSON.stringify(initial));
    click("deepread-pref-profile-add");
    await sleep(300);
    const secondId = Zotero.Prefs.get("deepread.llm.activeProfile");
    const modelInput = doc.getElementById("deepread-pref-llm-model");
    modelInput.value = "e2e-model-b";
    modelInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    modelInput.dispatchEvent(new win.Event("change", { bubbles: true }));
    await sleep(400);
    const afterAdd = profs();
    const cards = [...doc.querySelectorAll("#deepread-pref-profiles .deepread-card")];
    cards.find((c) => c.dataset.value === firstId).click();
    await sleep(300);
    const backModel = Zotero.Prefs.get("deepread.llm.model");
    cards.find((c) => c.dataset.value === secondId).click();
    await sleep(300);
    const bModel = Zotero.Prefs.get("deepread.llm.model");
    doc.querySelectorAll("#deepread-pref-profiles .deepread-card")[0].click();
    await sleep(300);
    const ok = initial.length === 1 && afterAdd.length === 2 && secondId !== firstId
      && backModel === firstModel && bModel === "e2e-model-b" && Zotero.Prefs.get("deepread.llm.model") === firstModel
      && afterAdd.find((p) => p.id === secondId).model === "e2e-model-b";
    step("prefs-profiles", { initial: initial.length, afterAdd: afterAdd.length, firstModel, backModel, bModel, ok });
    // Leave a single profile for later steps / reruns.
    doc.querySelectorAll("#deepread-pref-profiles .deepread-card")[1].click();
    await sleep(200);
    click("deepread-pref-profile-delete");
    await sleep(300);
    if (profs().length !== 1 || Zotero.Prefs.get("deepread.llm.model") !== firstModel) throw new Error("delete/restore failed");
    if (!ok) throw new Error("profile switching failed");
    // Parser cards and upgrade to the simplified settings pane
    doc.querySelector('#deepread-pref-parser-cards .deepread-card[data-value="selfhost"]').click();
    await sleep(200);
    const prov = Zotero.Prefs.get("deepread.parser.provider");
    doc.querySelector('#deepread-pref-parser-cards .deepread-card[data-value="builtin"]').click();
    const agentRemoved = !doc.getElementById("deepread-pref-agent-cards") && !doc.getElementById("deepread-pref-mod-guided");
    step("prefs-cards", { provider: prov, agentRemoved });
    if (!agentRemoved) throw new Error("obsolete agent controls are still present");
    if (prov !== "selfhost") throw new Error("parser card did not set provider");
    await sleep(200);
  }
  const llmTest = root.querySelector("[id*='llm'][id*='test']");
  if (llmTest) {
    llmTest.click();
    await sleep(2500);
    const status = root.querySelector("[id*='llm'][id*='status']");
    step("prefs-llm-test", { button: llmTest.id, status: status?.textContent, cls: status?.className });
  }
  const scroller = doc.querySelector("#prefs-content, .main-content, #content") || doc.documentElement;
  root.scrollIntoView?.({ block: "end" });
  await sleep(500);
  await shot(win, "prefs-bottom");
  win.close();

  // --- Toolbar menu ---
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) {
    item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  }
  await Zotero.Reader.open(item.id);
  const reader = Zotero.Reader._readers.find((r) => r.itemID === item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  await sleep(1500);
  const rdoc = reader._iframeWindow.document;
  const menuButton = await waitFor(() => rdoc.querySelector(".deepread-toolbar .dr-menu-button"), 10000, "toolbar");
  menuButton.click();
  await sleep(400);
  const menu = rdoc.querySelector(".deepread-menu");
  step("toolbar-menu", { open: !!menu, items: [...(menu?.querySelectorAll("button") || [])].map((b) => b.textContent) });
  await shot(main, "toolbar-menu");
  return { ok: true };
};
