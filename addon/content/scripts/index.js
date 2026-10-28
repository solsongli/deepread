/*
 * DeepRead for Zotero — runtime entry.
 * Every module attaches itself to the shared `DeepRead` namespace; files are
 * loaded in dependency order into the bootstrap-provided scope object.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Services */

(function () {
  const MODULES = [
    "util.js",
    "prefs.js",
    "l10n.js",
    "services/store.js",
    "services/llm.js",
    "services/updater.js",
    "services/typography.js",
    "services/textLayerParser.js",
    "services/grobidParser.js",
    "services/parser.js",
    "services/explainer.js",
    "services/structure.js",
    "services/figures.js",
    "services/references.js",
    "services/questions.js",
    "services/skim.js",
    "services/highlights.js",
    "services/cardGroups.js",
    "services/guide.js",
    "services/agentRunner.js",
    "pipeline/languages.js",
    "pipeline/responseFormats.js",
    "pipeline/summaryManager.js",
    "pipeline/pipeline.js",
    "reader/modules.js",
    "reader/overlay.js",
    "reader/rail.js",
    "reader/structureBar.js",
    "reader/lookup.js",
    "reader/guideView.js",
    "reader/guidePanel.js",
    "reader/session.js",
    "reader/toolbar.js",
    "reader/selection.js",
    "panes/common.js",
    "panes/summaryPane.js",
    "panes/outlinePane.js",
    "panes/chatPane.js",
    "panes/questionsPane.js",
  ];

  // Core modules must load; optional feature modules only log on failure.
  const OPTIONAL = new Set();
  for (const file of MODULES) {
    try {
      Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/scripts/${file}`, this);
    }
    catch (e) {
      if (!OPTIONAL.has(file)) throw e;
      Zotero.logError(e);
      Zotero.debug(`[DeepRead] optional module ${file} failed to load: ${e}`);
    }
  }

  const PLUGIN_ID = DeepRead.id;
  const windows = new Set();

  DeepRead.startup = async function () {
    DeepRead.log(`starting ${DeepRead.version}`);
    await DeepRead.Store.init();

    DeepRead.prefPaneID = await Zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID,
      src: `${DeepRead.rootURI}content/preferences.xhtml`,
      scripts: [`${DeepRead.rootURI}content/preferences.js`],
      stylesheets: [`${DeepRead.rootURI}content/styles/preferences.css`],
      label: "DeepRead",
      image: `${DeepRead.rootURI}content/icons/deepread.svg`,
    });

    DeepRead.Toolbar.register(PLUGIN_ID);
    DeepRead.Selection.register(PLUGIN_ID);
    DeepRead.Panes.registerAll(PLUGIN_ID);

    for (const win of Zotero.getMainWindows()) {
      DeepRead.onMainWindowLoad(win);
    }
    // After a (silent) update, tell the user once. Wait for the UI on app startup.
    Zotero.uiReadyPromise.then(() => DeepRead.Updater.announceIfUpdated()).catch(() => {});
  };

  DeepRead.onMainWindowLoad = function (win) {
    if (windows.has(win)) return;
    windows.add(win);
    win.MozXULElement.insertFTLIfNeeded("deepread.ftl");
    DeepRead.util.injectStylesheet(win.document, "chrome://deepread/content/styles/panes.css", "deepread-panes-css");
    DeepRead.util.injectStylesheet(win.document, "chrome://deepread/content/lib/katex/katex.min.css", "deepread-katex-css");
  };

  DeepRead.onMainWindowUnload = function (win) {
    windows.delete(win);
  };

  DeepRead.shutdown = async function () {
    DeepRead.log("shutting down");
    DeepRead.Session.destroyAll();
    DeepRead.Toolbar.unregister();
    for (const win of windows) {
      win.document.getElementById("deepread-panes-css")?.remove();
      win.document.getElementById("deepread-katex-css")?.remove();
      win.document.querySelector('link[href="deepread.ftl"]')?.remove();
    }
    windows.clear();
    await DeepRead.Store.close();
  };
}).call(this);
