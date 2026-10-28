/*
 * Manual update check from the settings pane. Uses Zotero's add-on manager with the
 * manifest's update_url (the same mechanism as the automatic daily check).
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, ChromeUtils, Zotero */

DeepRead.Updater = {
  RELEASES_URL: "https://github.com/solsongli/deepread/releases",

  async _addon() {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return { AddonManager, addon: await AddonManager.getAddonByID(DeepRead.id) };
  },

  /** → { available, version, install } or { available: false, error } */
  async check() {
    const { AddonManager, addon } = await this._addon();
    if (!addon) return { available: false, error: "add-on not found" };
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      addon.findUpdates({
        onUpdateAvailable: (_addon, install) => finish({ available: true, version: install.version, install }),
        onNoUpdateAvailable: () => finish({ available: false }),
        onUpdateFinished: (_addon, error) => finish({ available: false, error: error ? `update check failed (${error})` : null }),
      }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
      setTimeout(() => finish({ available: false, error: "update check timed out" }), 60000);
    });
  },

  /** On startup: if the version changed since last run (manual or automatic update), say so. */
  announceIfUpdated() {
    const last = DeepRead.prefs.get("lastVersion");
    DeepRead.prefs.set("lastVersion", DeepRead.version);
    if (!last || last === DeepRead.version) return false;
    try {
      const progress = new Zotero.ProgressWindow({ closeOnClick: true });
      progress.changeHeadline(DeepRead.bilingual(`DeepRead 已更新到 ${DeepRead.version}`, `DeepRead updated to ${DeepRead.version}`));
      progress.addDescription(DeepRead.bilingual(`原版本 ${last} · 更新内容见 GitHub Releases`, `Previously ${last} · see GitHub Releases for changes`));
      DeepRead.log(`announced update ${last} -> ${DeepRead.version}`);
      progress.show();
      progress.startCloseTimer(8000);
    }
    catch (e) {
      DeepRead.log("update notice failed", String(e));
    }
    return true;
  },

  /**
   * Check and, if a newer version exists, install it right away (bootstrapped plugins restart
   * in place, no Zotero restart). `onStatus(state, text)` with state ok | error | busy.
   */
  async checkAndInstall(onStatus = () => {}) {
    const current = DeepRead.version;
    onStatus("busy", DeepRead.bilingual("正在检查更新…", "Checking for updates…"));
    let result;
    try {
      result = await this.check();
    }
    catch (e) {
      result = { available: false, error: String(e?.message || e) };
    }
    if (result.error) {
      onStatus("error", DeepRead.bilingual(`检查失败：${result.error}（请检查网络能否访问 GitHub）`, `Check failed: ${result.error} (can Zotero reach GitHub?)`));
      return result;
    }
    if (!result.available) {
      onStatus("ok", DeepRead.bilingual(`已是最新版本（${current}）`, `Up to date (${current})`));
      return result;
    }
    // Installing restarts the plugin in place (this settings section is rebuilt), so the new
    // version announces itself on startup (see DeepRead.Updater.announceIfUpdated).
    onStatus("busy", DeepRead.bilingual(`发现新版本 ${result.version}，正在安装…完成后右下角会弹出提示`, `Installing ${result.version}… a notice appears when done`));
    try {
      await result.install.install();
      onStatus("ok", DeepRead.bilingual(`已更新到 ${result.version}。关闭并重新打开设置页即可看到新版本。`, `Updated to ${result.version}. Reopen the settings to see the new version.`));
      return { ...result, installed: true };
    }
    catch (e) {
      onStatus("error", DeepRead.bilingual(`安装失败：${e?.message || e}`, `Install failed: ${e?.message || e}`));
      return { ...result, error: String(e?.message || e) };
    }
  },
};
