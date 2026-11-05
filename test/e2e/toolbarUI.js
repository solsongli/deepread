/* Settings popup: viewport bounds, scrolling, keyboard focus and lifecycle cleanup.
 * E2E_SKIP_SERVICES=1 E2E_PDF=$PWD/test/fixtures/reading/lookup.pdf scripts/e2e.sh test/e2e/toolbarUI.js
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); if (!ok) throw new Error(name); };
  for (let i = 0; i < 100 && !Zotero.DeepRead?.Panes?.paneIDs?.chat; i++) await sleep(100);
  const D = Zotero.DeepRead;
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init();
  const doc = s.overlay.readerDoc, win = Zotero.getMainWindow();
  win.resizeTo(850, 580); await sleep(300);
  const anchor = doc.querySelector(".deepread-toolbar .dr-menu-button");
  check("toolbar remains within the host row", anchor.getBoundingClientRect().height <= 32 && doc.querySelector(".deepread-toolbar").getBoundingClientRect().height <= 41);
  anchor.click();
  let menu = doc.querySelector(".deepread-menu");
  check("features open as a nonmodal settings dialog", menu?.getAttribute("role") === "dialog" && anchor.getAttribute("aria-expanded") === "true");
  check("scope control receives keyboard focus", menu.querySelector(".dr-scope").contains(doc.activeElement));
  check("settings have three distinct groups", menu.querySelectorAll(".dr-menu-section").length === 3);
  const r = menu.getBoundingClientRect();
  check("short-window menu stays inside visible bounds", r.top >= 0 && r.bottom <= doc.documentElement.clientHeight && r.left >= 0 && r.right <= doc.documentElement.clientWidth);
  check("long settings remain scrollable", menu.scrollHeight > menu.clientHeight && doc.defaultView.getComputedStyle(menu).overflowY === "auto");
  menu.scrollTop = menu.scrollHeight;
  const end = menu.querySelector(".dr-menu-actions > button:last-child").getBoundingClientRect();
  check("last action can be reached without leaving the popup", end.top >= r.top && end.bottom <= r.bottom + 1);
  const head = menu.querySelector(".dr-menu-head").getBoundingClientRect();
  check("scope stays visible while scrolling", head.top >= r.top && head.bottom < r.bottom);
  menu.scrollTop = 0;
  const feature = menu.querySelector("[data-module='lookup']");
  feature.focus(); feature.click();
  check("changing a feature retains keyboard focus", doc.activeElement?.dataset.module === "lookup");
  const key = new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  doc.activeElement.dispatchEvent(key);
  check("Escape closes menu and returns focus", !doc.querySelector(".deepread-menu") && doc.activeElement === anchor && anchor.getAttribute("aria-expanded") === "false");
  for (let i = 0; i < 3; i++) { anchor.click(); anchor.click(); }
  anchor.click(); menu = doc.querySelector(".deepread-menu");
  menu.querySelector(".dr-scope button").click();
  check("reopening leaves no stale outside listener", !!doc.querySelector(".deepread-menu") && anchor.getAttribute("aria-expanded") === "true");
  const theme = doc.documentElement.getAttribute("data-color-scheme");
  doc.documentElement.setAttribute("data-color-scheme", "dark");
  const surface = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  surface.style.background = "var(--dr-surface)"; doc.body.append(surface);
  check("menu follows shared dark surface", !!doc.defaultView.getComputedStyle(surface).getPropertyValue("--dr-surface").trim() && doc.defaultView.getComputedStyle(menu).backgroundColor === doc.defaultView.getComputedStyle(surface).backgroundColor);
  surface.remove();
  async function shot(name) {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0);
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), name), Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
  }
  await shot("toolbar-dark.png");
  if (theme === null) doc.documentElement.removeAttribute("data-color-scheme"); else doc.documentElement.setAttribute("data-color-scheme", theme);
  await shot("toolbar-light.png");
  const pdfDoc = s.overlay.pdfDoc;
  pdfDoc.body.dispatchEvent(new pdfDoc.defaultView.Event("pointerdown", { bubbles: true }));
  check("clicking PDF closes the menu", !doc.querySelector(".deepread-menu"));
  anchor.click();
  win.document.documentElement.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  check("clicking main window closes the menu", !doc.querySelector(".deepread-menu"));
  anchor.click();
  win.resizeTo(800, 540); await sleep(150);
  check("resize closes and cleans up the old menu", !doc.querySelector(".deepread-menu") && anchor.getAttribute("aria-expanded") === "false");
  anchor.click();
  D.Toolbar.unregister();
  check("unregister removes menu and toolbar", !doc.querySelector(".deepread-menu") && !doc.querySelector(".deepread-toolbar"));
  const after = new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  doc.body.dispatchEvent(after);
  check("unregister removes the Escape listener", !after.defaultPrevented);
  return { checks: E2E.result.steps.length };
};
