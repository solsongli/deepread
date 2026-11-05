/* Shared theme and keyboard-accessible card action menus.
 * License: AGPL-3.0-or-later */
(function () {
  const activeMenus = new WeakMap();
  const mountedMenus = new Set();
  const NS = "http://www.w3.org/1999/xhtml";
  let menuID = 0;
  const currentMenu = (doc) => {
    const direct = doc && activeMenus.get(doc);
    if (direct) return direct;
    for (const entry of mountedMenus) {
      try { if (entry.doc.documentElement.isSameNode(doc?.documentElement)) return entry; }
      catch (_) {}
    }
    return null;
  };

  DeepRead.UI = {
    install(doc) {
      if (doc) DeepRead.util.injectStylesheet(doc, "chrome://deepread/content/styles/theme.css", "deepread-theme-css");
    },

    uninstall(doc) {
      if (!doc) return;
      currentMenu(doc)?.close(false);
      doc.getElementById("deepread-theme-css")?.remove();
    },

    closeMenu(doc, owner = null, restore = false) {
      const current = currentMenu(doc);
      if (current && (!owner || owner.contains(current.anchor))) current.close(restore && current.menu.contains(doc.activeElement));
    },

    closeAll() {
      for (const current of [...mountedMenus]) current.close(false);
    },

    openMenu(anchor, items, { label = "", relatedDocument = null, outsideDocument = null } = {}) {
      const doc = anchor.ownerDocument, win = doc.defaultView;
      const previous = currentMenu(doc);
      previous?.close(false);
      if (previous?.anchor?.isSameNode(anchor)) { anchor.focus({ preventScroll: true }); return; }
      this.install(doc);
      const menu = doc.createElementNS(NS, "div");
      menu.className = "deepread-card-menu";
      menu.id = `deepread-card-menu-${++menuID}`;
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", label);
      anchor.setAttribute("aria-expanded", "true");
      anchor.setAttribute("aria-controls", menu.id);
      const cleanup = [];
      const close = (restore = true) => {
        if (activeMenus.get(doc)?.menu !== menu) return;
        activeMenus.delete(doc);
        mountedMenus.delete(entry);
        for (const fn of cleanup) fn();
        menu.remove();
        anchor.setAttribute("aria-expanded", "false");
        anchor.removeAttribute("aria-controls");
        if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
      };
      const entry = { doc, menu, anchor, close };
      activeMenus.set(doc, entry);
      mountedMenus.add(entry);
      for (const item of items.filter(Boolean)) {
        if (item.separator) { const line = doc.createElementNS(NS, "hr"); line.setAttribute("role", "separator"); menu.append(line); continue; }
        const button = doc.createElementNS(NS, "button");
        button.textContent = item.label;
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.dataset.action = item.id;
        button.tabIndex = -1;
        if (item.danger) button.className = "dr-danger";
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          close(item.restoreFocus !== false);
          item.action();
        });
        menu.append(button);
      }
      (doc.body || doc.documentElement).append(menu);
      const r = anchor.getBoundingClientRect();
      const w = doc.documentElement.clientWidth || win.innerWidth, h = doc.documentElement.clientHeight || win.innerHeight;
      menu.style.maxWidth = `${Math.max(1, w - 16)}px`;
      menu.style.maxHeight = `${Math.max(1, h - 16)}px`;
      menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, w - menu.offsetWidth - 8))}px`;
      const below = h - r.bottom - 8, above = r.top - 8;
      const top = menu.offsetHeight > below && above > below ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
      menu.style.top = `${Math.max(8, Math.min(top, h - menu.offsetHeight - 8))}px`;
      const listen = (target, type, handler, capture = false) => {
        target?.addEventListener(type, handler, capture);
        cleanup.push(() => target?.removeEventListener(type, handler, capture));
      };
      listen(doc, "pointerdown", (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(false); }, true);
      listen(doc, "scroll", (e) => { if (!menu.contains(e.target)) close(false); }, true);
      listen(relatedDocument, "pointerdown", () => close(false), true);
      listen(relatedDocument, "scroll", () => close(false), true);
      listen(outsideDocument, "pointerdown", () => close(false), true);
      listen(outsideDocument?.defaultView, "blur", () => close(false));
      listen(win, "resize", () => close(false));
      listen(doc, "keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!menu.contains(event.target)) return;
        if (event.key === "Tab") { close(); return; }
        const buttons = [...menu.querySelectorAll("button")];
        const at = buttons.indexOf(doc.activeElement);
        let next;
        if (event.key === "ArrowDown") next = (at + 1) % buttons.length;
        if (event.key === "ArrowUp") next = (at + buttons.length - 1) % buttons.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = buttons.length - 1;
        if (next !== undefined) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
      }, true);
      const observer = new win.MutationObserver(() => { if (!anchor.isConnected) close(false); });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      cleanup.push(() => observer.disconnect());
      menu.querySelector("button")?.focus({ preventScroll: true });
    },
  };
})();
