/* Small shared helpers. License: AGPL-3.0-or-later */
/* global DeepRead, Zotero */

DeepRead.log = function (...args) {
  Zotero.debug(`[DeepRead] ${args.map((a) => (typeof a === "string" ? a : DeepRead.util.safeStringify(a))).join(" ")}`);
};

DeepRead.util = {
  safeStringify(value) {
    try {
      return JSON.stringify(value);
    }
    catch (e) {
      return String(value);
    }
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  // Gecko can retain a loaded chrome stylesheet in an open reader across
  // an in-place add-on update. Each release needs its own stylesheet URI.
  styleURL(href) {
    return href + "?v=" + encodeURIComponent(DeepRead.version);
  },

  injectStylesheet(doc, href, id) {
    if (!doc) return;
    const url=this.styleURL(href);
    const existing=doc.getElementById(id);
    if (existing) {
      if (existing.getAttribute("href")!==url) existing.setAttribute("href",url);
      return existing;
    }
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = url;
    (doc.head || doc.documentElement).appendChild(link);
    return link;
  },

  readyStylesheet(doc,href,id) {
    const link=this.injectStylesheet(doc,href,id);
    if(link.sheet)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      link.addEventListener("load",resolve,{once:true});
      link.addEventListener("error",()=>reject(new Error("Could not load "+href)),{once:true});
    });
  },

  /** Create an HTML element in `doc` with attributes, properties and children. */
  h(doc, tag, props = {}, ...children) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "text") el.textContent = value;
      else if (key === "dataset") Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(typeof child === "string" ? doc.createTextNode(child) : child);
    }
    return el;
  },

  /** Stable per-attachment key that survives sync: "<libraryID>_<key>". */
  attachmentKey(item) {
    return `${item.libraryID}_${item.key}`;
  },

  async copyToClipboard(text) {
    Zotero.Utilities.Internal.copyTextToClipboard(String(text ?? ""));
  },

  formatError(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    return error.message || String(error);
  },
};
