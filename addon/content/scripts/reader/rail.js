/*
 * Margin rail: persistent paragraph summary cards beside the PDF.
 *
 * Vibero widened every PDF page inside a modified pdf.js to make room for its margin cards.
 * A plugin cannot do that, so the PDF iframe is narrowed instead and a rail is placed next to
 * it in the reader document. Each card is anchored at the vertical position of its paragraph,
 * pushed down to avoid overlaps (with a connector back to the anchor), and kept in sync with
 * scrolling and zooming.
 *
 * License: AGPL-3.0-or-later. Card design follows Vibero (AGPL-3.0, a Zotero fork).
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const GAP = 6;
  const OVERSCAN = 400;

  const CSS = `
#primary-view.deepread-has-rail > iframe { flex: 1 1 auto; width: auto !important; min-width: 0; }
.deepread-rail { position: relative; flex: 0 0 var(--dr-rail-width, 300px); overflow: hidden;
  border-inline-start: 1px solid var(--color-panedivider, rgba(0,0,0,0.12));
  background: var(--material-sidepane, #f6f7f8); color: var(--fill-primary, #1f2328);
  font: var(--dr-card-font, 12px)/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.deepread-rail .dr-resize { position: absolute; top: 0; bottom: 0; width: 6px; z-index: 8; cursor: col-resize; }
.deepread-rail.dr-right .dr-resize { left: 0; }
.deepread-rail.dr-left .dr-resize { right: 0; }
.deepread-rail .dr-resize:hover, .deepread-rail .dr-resize.dr-dragging { background: rgba(59,130,246,0.35); }
.deepread-rail.dr-left { border-inline-start: none; border-inline-end: 1px solid var(--color-panedivider, rgba(0,0,0,0.12)); }
.deepread-rail.dr-left .dr-rcard { left: 8px; right: 12px; }
/* Collapse: the rail folds to a thin strip (e.g. to make room for the AI chat pane). */
.deepread-rail .dr-collapse { position: absolute; top: 6px; z-index: 9; width: 18px; height: 22px; padding: 0; border: 1px solid rgba(0,0,0,0.12);
  border-radius: 5px; background: var(--material-background, #fff); color: var(--fill-secondary, #57606a); font: 12px/1 sans-serif; cursor: pointer; opacity: 0.55; }
.deepread-rail:hover .dr-collapse { opacity: 1; }
.deepread-rail .dr-collapse:hover { background: #eef2fb; color: #2b59c3; }
.deepread-rail.dr-right .dr-collapse { left: 2px; }
.deepread-rail.dr-left .dr-collapse { right: 2px; }
.deepread-rail.dr-collapsed { flex: 0 0 24px; cursor: pointer; }
.deepread-rail.dr-collapsed .dr-rcard, .deepread-rail.dr-collapsed svg.dr-links, .deepread-rail.dr-collapsed .dr-resize { display: none; }
.deepread-rail.dr-collapsed .dr-collapse { inset-inline: 2px; width: auto; height: auto; padding: 6px 0; opacity: 1;
  writing-mode: vertical-rl; letter-spacing: 0.1em; line-height: 1.2; }
:root[data-color-scheme="dark"] .deepread-rail .dr-collapse { background: #2a2d32; color: #c5c9cf; border-color: rgba(255,255,255,0.15); }
.deepread-rail svg.dr-links { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.deepread-rail .dr-rcard { position: absolute; left: 12px; right: 8px; box-sizing: border-box; padding: 6px 8px 5px;
  border-radius: 8px; background: var(--material-background, #fff); border: 1px solid rgba(0,0,0,0.08);
  box-shadow: 0 1px 3px rgba(0,0,0,0.06); transition: box-shadow .15s; }
.deepread-rail .dr-rcard:hover, .deepread-rail .dr-rcard.dr-linked { box-shadow: 0 0 0 1.5px rgba(251,191,36,0.9), 0 4px 14px rgba(0,0,0,0.10); }
.deepread-rail .dr-rhead { display: flex; gap: 4px; align-items: flex-start; }
.deepread-rail .dr-rsummary { flex: 1; font-weight: 600; cursor: pointer; outline: none; }
.deepread-rail .dr-rsummary[contenteditable="true"] { cursor: text; background: rgba(59,130,246,0.08); border-radius: 4px; }
.deepread-rail .dr-ractions { display: none; gap: 1px; flex-shrink: 0; }
.deepread-rail .dr-rcard:hover .dr-ractions { display: flex; }
.deepread-rail .dr-ractions button { border: none; background: transparent; color: var(--fill-secondary, #57606a); cursor: pointer;
  font-size: 0.92em; padding: 0 4px; border-radius: 4px; line-height: 1.5; }
.deepread-rail .dr-ractions button:hover { background: rgba(0,0,0,0.07); color: inherit; }
.deepread-rail ul { margin: 3px 0 0; padding: 0; list-style: none; }
.deepread-rail li { position: relative; padding: 1px 4px 1px 11px; border-radius: 4px; cursor: pointer; color: var(--fill-secondary, #424a53); }
.deepread-rail li::before { content: ""; position: absolute; left: 3px; top: 7px; width: 4px; height: 4px; border-radius: 50%; background: #8c959f; }
.deepread-rail li.dr-hl::before { background: var(--dr-hl); }
.deepread-rail li.dr-hl { color: inherit; background: color-mix(in srgb, var(--dr-hl) 18%, transparent); }
.deepread-rail li:hover { background: rgba(251,191,36,0.16); }
.deepread-rail li.dr-hl:hover { background: color-mix(in srgb, var(--dr-hl) 28%, transparent); }
.deepread-rail .dr-explain { margin-top: 3px; color: var(--fill-primary, #1f2328); overflow-wrap: anywhere; }
.deepread-rail .dr-explain p { margin: 0.25em 0; }
.deepread-rail .dr-explain ul, .deepread-rail .dr-explain ol { margin: 0.2em 0; padding-inline-start: 1.3em; list-style: revert; }
.deepread-rail .dr-explain li { padding: 0; cursor: auto; color: inherit; }
.deepread-rail .dr-explain li::before { display: none; }
.deepread-rail .dr-explain-pending, .deepread-rail .dr-explain-missing { color: var(--fill-secondary, #6b7280); font-style: italic; }
.deepread-rail .dr-explain-missing a { cursor: pointer; color: #2563eb; font-style: normal; }
.deepread-rail .dr-points { font-size: 0.95em; }
.deepread-rail .dr-trwrap { margin-top: 4px; }
.deepread-rail .dr-trtoggle { display: inline-block; font-size: 0.9em; color: var(--fill-secondary, #6b7280); cursor: pointer; user-select: none; }
.deepread-rail .dr-trtoggle:hover { color: var(--fill-primary, #1f2328); }
.deepread-rail .dr-trbody { margin-top: 2px; padding: 3px 7px; border-inline-start: 3px solid #93c5fd; border-radius: 4px;
  background: rgba(59,130,246,0.06); font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif; }
.deepread-rail .dr-rcard.dr-flash { background: #fffbea; border-color: rgba(234,179,8,0.45); cursor: pointer; }
.deepread-rail .dr-fc-label { font-size: 0.875em; font-weight: 700; color: #a16207; letter-spacing: .02em; }
.deepread-rail .dr-fc-q { font-weight: 600; }
.deepread-rail .dr-fc-a { margin-top: 3px; padding-top: 3px; border-top: 1px dashed rgba(161,98,7,0.35); }
.deepread-rail .dr-fc-a p { margin: 0.2em 0; }
.deepread-rail .dr-muted { color: var(--fill-secondary, #6b7280); }
.deepread-rail .dr-rcard:hover { z-index: 5; }
.deepread-rail .dr-rcard.dr-open { z-index: 6; border-color: #c9d6f3; box-shadow: 0 0 0 3px rgba(43,89,195,0.14), 0 8px 24px rgba(20,30,60,0.12); }
/* Figure cards */
.deepread-rail .dr-rcard.dr-figure { padding: 0 0 8px; overflow: hidden; border-radius: 10px; cursor: pointer; }
.deepread-rail .dr-fhead { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #f4f4f1; border-bottom: 1px solid rgba(0,0,0,0.05); }
.deepread-rail .dr-flabel { flex-shrink: 0; padding: 0 6px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12); background: #fff; font-size: 0.8em; font-weight: 600; line-height: 1.6; }
.deepread-rail .dr-ftitle { flex: 1; min-width: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.deepread-rail .dr-fcount { flex-shrink: 0; font-size: 0.8em; color: var(--fill-secondary, #4a4a46); }
.deepread-rail .dr-fthumb { display: block; margin: 8px 10px 0; border-radius: 4px; background: #ededea; }
.deepread-rail .dr-fbody { margin: 6px 10px 0; }
.deepread-rail .dr-fsteps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.deepread-rail .dr-fsteps li { display: flex; gap: 7px; padding: 2px 4px; margin: 0 -4px; border-radius: 6px; cursor: inherit; color: inherit; }
.deepread-rail .dr-fsteps li::before { display: none; }
.deepread-rail .dr-fsteps li.dr-on { background: rgba(43,89,195,0.10); }
.deepread-rail .dr-fnum { flex-shrink: 0; width: 1.35em; height: 1.35em; margin-top: 0.15em; border-radius: 50%; background: #1d1d1b; color: #fff;
  display: grid; place-items: center; font-size: 0.75em; font-weight: 700; }
.deepread-rail .dr-fsteps li.dr-on .dr-fnum { background: #2b59c3; }
.deepread-rail .dr-ftext { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; line-height: 1.6; }
.deepread-rail .dr-fcaption { font-size: 0.9em; line-height: 1.5; color: var(--fill-secondary, #4a4a46); }
.deepread-rail .dr-evidence { margin: 8px 10px 0; padding-top: 6px; border-top: 1px solid rgba(0,0,0,0.1); cursor: default; }
.deepread-rail .dr-evidence label { display: grid; gap: 3px; margin: 6px 0; font-size: 0.9em; }
.deepread-rail .dr-evidence textarea { box-sizing: border-box; width: 100%; padding: 4px 6px; resize: vertical; font: inherit; line-height: 1.45; color: inherit; background: var(--material-background, #fff); border: 1px solid var(--color-panedivider, #bbb); border-radius: 4px; }
.deepread-rail .dr-evidence p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 3px 0 8px; }
.deepread-rail .dr-evidence button { font: inherit; padding: 2px 6px; cursor: pointer; }
/* Figures amber, tables teal: told apart from paragraph cards at a glance. */
.deepread-rail .dr-rcard.dr-figure { background: #fffdf8; border: 1px solid #efd9ac; border-inline-start: 3px solid #d97706; }
.deepread-rail .dr-figure .dr-fhead { background: #fcf1dc; border-bottom-color: #f1e0bb; }
.deepread-rail .dr-figure .dr-flabel { background: #d97706; border-color: #d97706; color: #fff; }
.deepread-rail .dr-figure .dr-fnum { background: #92400e; }
.deepread-rail .dr-figure .dr-fsteps li.dr-on { background: rgba(217,119,6,0.13); }
.deepread-rail .dr-figure .dr-fsteps li.dr-on .dr-fnum { background: #d97706; }
.deepread-rail .dr-rcard.dr-figure[data-kind="table"] { background: #fbfefd; border-color: #bfe3dd; border-inline-start-color: #0d9488; }
.deepread-rail .dr-figure[data-kind="table"] .dr-fhead { background: #e4f4f1; border-bottom-color: #cbe9e3; }
.deepread-rail .dr-figure[data-kind="table"] .dr-flabel { background: #0d9488; border-color: #0d9488; }
.deepread-rail .dr-figure[data-kind="table"] .dr-fnum { background: #115e59; }
.deepread-rail .dr-figure[data-kind="table"] .dr-fsteps li.dr-on { background: rgba(13,148,136,0.12); }
.deepread-rail .dr-figure[data-kind="table"] .dr-fsteps li.dr-on .dr-fnum { background: #0d9488; }
:root[data-color-scheme="dark"] .deepread-rail .dr-rcard.dr-figure { background: #2d2a24; border-color: rgba(217,119,6,0.45); border-inline-start-color: #d97706; }
:root[data-color-scheme="dark"] .deepread-rail .dr-rcard.dr-figure[data-kind="table"] { background: #232b2a; border-color: rgba(13,148,136,0.45); border-inline-start-color: #14b8a6; }
:root[data-color-scheme="dark"] .deepread-rail .dr-figure[data-kind="table"] .dr-fhead { background: rgba(13,148,136,0.12); }
.deepread-rail .dr-rcard.dr-figure.dr-compact .dr-fbody { display: none; }
.deepread-rail .dr-rcard.dr-figure.dr-compact:hover .dr-fbody { display: block; }
:root[data-color-scheme="dark"] .deepread-rail .dr-fhead { background: rgba(255,255,255,0.05); }
/* Paragraph cards: tinted header by the paragraph's role, white body. Colour only in labels and fine edges. */
.deepread-rail .dr-rcard.dr-para { padding: 0 0 9px; overflow: hidden; border-radius: 10px; }
.deepread-rail .dr-para > *:not(.dr-phead) { margin-left: 10px; margin-right: 10px; }
.deepread-rail .dr-phead { padding: 7px 8px 6px 10px; background: #fafaf8; border-bottom: 1px solid rgba(0,0,0,0.05); margin-bottom: 2px; }
.deepread-rail .dr-para[data-role="background"] .dr-phead { background: #f5f6f8; }
.deepread-rail .dr-para[data-role="gap"] .dr-phead { background: #fdf6f1; }
.deepread-rail .dr-para[data-role="prior"] .dr-phead { background: #faf7f2; }
.deepread-rail .dr-para[data-role="contribution"] .dr-phead, .deepread-rail .dr-para[data-role="method"] .dr-phead { background: #f3f6fd; }
.deepread-rail .dr-para[data-role="result"] .dr-phead { background: #f1f8f7; }
.deepread-rail .dr-para[data-role="limitation"] .dr-phead { background: #fcf3f3; }
.deepread-rail .dr-para .dr-rhead { align-items: center; gap: 6px; }
.deepread-rail .dr-role { flex-shrink: 0; align-self: flex-start; margin-top: 0.12em; padding: 0 5px; border-radius: 4px; font-size: 0.78em; font-weight: 700; line-height: 1.6; }
.deepread-rail .dr-role-background { background: #eef0f4; color: #3a3f4c; }
.deepread-rail .dr-role-gap { background: #fce9dd; color: #9a3412; }
.deepread-rail .dr-role-prior { background: #f3eee6; color: #6b4e1e; }
.deepread-rail .dr-role-contribution { background: #2b59c3; color: #fff; }
.deepread-rail .dr-role-method { background: #e3eafa; color: #1e428f; }
.deepread-rail .dr-role-result { background: #e0f1ee; color: #0b5550; }
.deepread-rail .dr-role-limitation { background: #f8e6e6; color: #8a1c1c; }
.deepread-rail .dr-imp { flex-shrink: 0; align-self: flex-start; margin-top: 0.5em; width: 7px; height: 7px; border-radius: 50%; }
.deepread-rail .dr-q { flex-shrink: 0; align-self: flex-start; margin-top: 0.12em; padding: 0 5px; border-radius: 4px; font-size: 0.75em;
  font-weight: 700; line-height: 1.6; background: #ede9fe; color: #5b21b6; cursor: pointer; }
.deepread-rail .dr-q:hover { background: #ddd6fe; }
:root[data-color-scheme="dark"] .deepread-rail .dr-q { background: rgba(139,92,246,0.25); color: #ddd6fe; }
.deepread-rail .dr-guide-notes { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; cursor: pointer; }
.deepread-rail .dr-guide-note { display: flex; gap: 6px; align-items: baseline; font-size: 0.88em; line-height: 1.45; }
.deepread-rail .dr-gn-label { flex-shrink: 0; padding: 0 5px; border-radius: 4px; font-weight: 700; font-size: 0.9em; background: #e6f4f1; color: #0f5f58; }
.deepread-rail .dr-gn-hedge .dr-gn-label { background: #fdf2e3; color: #92400e; }
.deepread-rail .dr-gn-claim .dr-gn-label { background: #ede9fe; color: #5b21b6; }
.deepread-rail .dr-gn-text { color: var(--fill-secondary, #57606a); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.deepread-rail .dr-rcard.dr-compact .dr-guide-notes { display: none; }
.deepread-rail .dr-rcard.dr-compact:hover .dr-guide-notes { display: flex; }
:root[data-color-scheme="dark"] .deepread-rail .dr-gn-label { background: rgba(20,184,166,0.18); color: #99f6e4; }
.deepread-rail .dr-range { flex-shrink: 0; align-self: flex-start; margin-top: 0.15em; padding: 0 5px; border-radius: 8px;
  font-size: 0.75em; line-height: 1.6; color: var(--fill-secondary, #57606a); border: 1px solid rgba(0,0,0,0.12); }
.deepread-rail .dr-trbody > .dr-trpart + .dr-trpart { margin-top: 0.45em; }
.deepread-rail .dr-badges { display: none; flex-shrink: 0; gap: 3px; }
.deepread-rail .dr-rcard.dr-compact .dr-badges { display: flex; }
.deepread-rail .dr-badge { padding: 0 5px; border-radius: 8px; font-size: 0.78em; line-height: 1.55; font-weight: 600; }
.deepread-rail .dr-badge-fc { background: #fbf4e4; color: #7a5300; }
.deepread-rail .dr-badge-note { background: #eaf5ee; color: #1f6b3a; }
.deepread-rail .dr-para .dr-explain { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; line-height: 1.75; margin-top: 6px; }
.deepread-rail .dr-para .dr-points { margin-top: 7px; padding-top: 6px; border-top: 1px solid rgba(0,0,0,0.06); }
.deepread-rail .dr-para .dr-trtoggle { padding: 1px 8px; border: 1px solid rgba(0,0,0,0.1); border-radius: 10px; background: #fafaf8; }
.deepread-rail .dr-rcard.dr-para.dr-compact { padding-bottom: 0; }
.deepread-rail .dr-rcard.dr-para.dr-compact .dr-phead { padding: 5px 8px; border-bottom: none; margin-bottom: 0; }
.deepread-rail .dr-rcard.dr-para.dr-compact:hover .dr-phead { border-bottom: 1px solid rgba(0,0,0,0.05); }
.deepread-rail .dr-rcard.dr-para.dr-compact:hover { padding-bottom: 8px; }
:root[data-color-scheme="dark"] .deepread-rail .dr-phead { background: rgba(255,255,255,0.04) !important; border-color: rgba(255,255,255,0.08); }
.deepread-rail .dr-rcard.dr-compact { padding-block: 3px; }
.deepread-rail .dr-rcard.dr-compact .dr-rsummary { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.deepread-rail .dr-rcard.dr-compact .dr-points, .deepread-rail .dr-rcard.dr-compact .dr-explain,
.deepread-rail .dr-rcard.dr-compact .dr-trwrap { display: none; }
.deepread-rail .dr-rcard.dr-compact:hover .dr-rsummary { white-space: normal; font-weight: 600; }
.deepread-rail .dr-rcard.dr-compact:hover .dr-points, .deepread-rail .dr-rcard.dr-compact:hover .dr-explain,
.deepread-rail .dr-rcard.dr-compact:hover .dr-trwrap { display: block; }
.deepread-rail .dr-note { margin-top: 5px; padding: 4px 7px; border-radius: 6px; border-inline-start: 3px solid #10b981;
  background: rgba(16,185,129,0.08); color: var(--fill-primary, #1f2328); cursor: text; }
.deepread-rail .dr-note-label { font-size: 0.875em; font-weight: 700; color: #047857; }
.deepread-rail .dr-note-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.deepread-rail .dr-note-editing textarea { margin-top: 2px; }
.deepread-rail .dr-attached { margin-top: 5px; display: flex; flex-direction: column; gap: 4px; }
.deepread-rail .dr-fc-attached { padding: 4px 7px; border-radius: 6px; background: #fffbea; border: 1px solid rgba(234,179,8,0.4); cursor: pointer; }
.deepread-rail .dr-fc-attached:hover .dr-ractions { display: flex; }
.deepread-rail .dr-fc-reveal { font-size: 0.92em; }
.deepread-rail .dr-fc .dr-note { cursor: default; }
:root[data-color-scheme="dark"] .deepread-rail .dr-note { background: rgba(16,185,129,0.14); color: #e6e6e6; }
:root[data-color-scheme="dark"] .deepread-rail .dr-note-label { color: #34d399; }
:root[data-color-scheme="dark"] .deepread-rail .dr-fc-attached { background: #3a3320; border-color: rgba(234,179,8,0.35); }
.deepread-rail textarea { width: 100%; box-sizing: border-box; font: inherit; resize: vertical; margin: 2px 0;
  border: 1px solid rgba(0,0,0,0.15); border-radius: 5px; padding: 3px 5px; background: var(--material-background, #fff); color: inherit; }
.deepread-rail .dr-fc-buttons { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.deepread-rail .dr-fc-buttons button { font: inherit; font-size: 0.92em; padding: 1px 7px; border-radius: 4px; cursor: pointer;
  border: 1px solid rgba(0,0,0,0.15); background: transparent; color: inherit; }
.deepread-rail .dr-fc-buttons button.dr-primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
:root[data-color-scheme="dark"] .deepread-rail { background: #1f2124; color: #e6e6e6; }
:root[data-color-scheme="dark"] .deepread-rail .dr-rcard { background: #2a2d32; border-color: rgba(255,255,255,0.1); }
:root[data-color-scheme="dark"] .deepread-rail li { color: #c5c9cf; }
:root[data-color-scheme="dark"] .deepread-rail .dr-trbody { background: rgba(59,130,246,0.12); }
:root[data-color-scheme="dark"] .deepread-rail .dr-explain { color: #e6e6e6; }
:root[data-color-scheme="dark"] .deepread-rail .dr-rcard.dr-flash { background: #3a3320; border-color: rgba(234,179,8,0.35); }
`;

  /** Which 带读 step a card note belongs to. */
  function note0Step(note) {
    return { component: 3, hedge: 4, claim: 4, move: 2 }[note?.kind] || 1;
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.Rail = class Rail {
    constructor(session) {
      this.session = session;
      this.cards = new Map(); // key → { el, height, width, anchor, kind, data, sig }
      this.expanded = new Set();
      this.focusKey = null; // card opened by clicking its paragraph in the PDF
      this.drafts = new Map(); // unsaved editor text, kept when a card re-renders (e.g. it is closed)
      this.trToggled = new Set(); // cards whose translation fold differs from the default (pref cards.translationOpen)
      this.attached = false;
      this._cleanup = [];
      this._raf = null;
    }

    get enabled() {
      return DeepRead.Modules.enabled(this.session, "cards");
    }

    /** "split": left-column paragraphs get cards on the left of the PDF; "right": one rail. */
    get layoutMode() {
      return DeepRead.prefs.get("view.railLayout") === "right" ? "right" : "split";
    }

    /** Which rail a paragraph belongs to, from its horizontal position on the page. */
    _sideFor(pageIndex, rect) {
      if (this.layoutMode !== "split" || !rect) return "right";
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return "right";
      const pct = this.overlay._toPercent(geom, rect);
      if (pct.width > 60) return "right"; // full-width (single-column) block
      if (!this._isTwoColumn(pageIndex, geom)) return "right"; // e.g. a short heading on a one-column page
      return pct.left + pct.width / 2 < 50 ? "left" : "right";
    }

    _isTwoColumn(pageIndex) {
      return this.overlay.isTwoColumn(pageIndex);
    }

    /** Expanded by the reader (summary click) or opened by clicking the paragraph. */
    isOpen(key) {
      return this.expanded.has(key) || this.focusKey === key;
    }

    /**
     * Open a paragraph's card (full card, next to its paragraph, scrolled into view); null closes it.
     * With "keep cards open" (pref cards.keepOpen) the previously opened card stays expanded.
     */
    openParagraph(paragraph, { toggle = false } = {}) {
      const raw = paragraph ? `p_${paragraph.pageIndex}_${paragraph.paragraphIndex}` : null;
      const key = raw ? this.session.groupLead(raw) : null;
      if (toggle && key && this.isOpen(key)) {
        this.expanded.delete(key);
        if (this.focusKey === key) this.focusKey = null;
        this._revealPending = false;
        this._invalidate(key);
        this.schedule(true);
        return;
      }
      this.focusParagraphKey = raw;
      if (key === this.focusKey) {
        if (key) this._revealPending = true;
        this.schedule();
        return;
      }
      const previous = this.focusKey;
      if (previous && DeepRead.prefs.get("cards.keepOpen") !== false) this.expanded.add(previous);
      this.focusKey = key;
      if (key && raw !== key) paragraph = this.session._paragraphByKey(key)?.paragraph || paragraph;
      if (key && this.session.isCardHidden?.(key)) this.session.setCardHidden(key, false);
      if (previous) this._invalidate(previous);
      if (key) {
        this._revealPending = true;
        this._invalidate(key);
        // An opened card should have its explanation: generate it now if it is missing.
        if (DeepRead.prefs.get("cards.autoExplain") !== false && paragraph && !this.session.explanation(key)
            && DeepRead.Explainer?.eligible(paragraph) && DeepRead.LLM.isConfigured()) {
          this.session.explainParagraph(key).catch((e) => DeepRead.log("explain on open failed", String(e)));
        }
      }
    }

    /** Fold every expanded card. */
    collapseAll() {
      const keys = [...this.expanded, this.focusKey].filter(Boolean);
      this.expanded.clear();
      this.focusKey = null;
      for (const key of keys) this._invalidate(key);
      this.schedule(true);
    }

    get openCount() {
      return new Set([...this.expanded, this.focusKey].filter(Boolean)).size;
    }

    /** "p. 3 ¶2" — how cards are referred to in the chat. */
    /** First figure/table mentioned in a paragraph: { id, panel } or null. */
    static figureMention(text, figures) {
      if (!text || !figures?.length) return null;
      const re = /(?<![A-Za-z])(Figs?|Figures?|Tables?|Tab)\.?\s*(\d+|[IVX]+)(?:\s*\(([a-z])\)|([a-z])(?![A-Za-z]))?/gi;
      for (const m of text.matchAll(re)) {
        const kind = /^t/i.test(m[1]) ? "table" : "figure";
        const figure = figures.find((f) => f.kind === kind && String(f.number).toUpperCase() === m[2].toUpperCase());
        if (figure) return { id: figure.id, panel: (m[3] || m[4] || "").toLowerCase() || null };
      }
      return null;
    }

    /** "图 3" / "Fig. 3", "表 I" / "Table I" in the interface language. */
    static figureLabel(figure) {
      const table = figure.kind === "table";
      return DeepRead.bilingual(`${table ? "表" : "图"} ${figure.number}`, `${table ? "Table" : "Fig."} ${figure.number}`);
    }

    static roleLabel(role) {
      const labels = {
        background: ["背景", "Background"], gap: ["空白", "Gap"], prior: ["已有方案", "Prior work"],
        contribution: ["贡献", "Contribution"], method: ["方法", "Method"], result: ["结果", "Result"], limitation: ["局限", "Limitation"],
      };
      const [zh, en] = labels[role] || [role, role];
      return DeepRead.bilingual(zh, en);
    }

    static blockLabel(paragraph) {
      return `p. ${paragraph.pageIndex + 1} ¶${paragraph.paragraphIndex + 1}`;
    }

    /** After layout: scroll the PDF so the opened card is fully visible (its paragraph stays on screen). */
    _revealFocus(railHeight) {
      this._revealPending = false;
      const card = this.cards.get(this.focusKey);
      if (!card || card.el.hidden) return;
      const top = card.el.offsetTop;
      const bottom = top + card.el.offsetHeight;
      let delta = 0;
      if (bottom > railHeight - 8) delta = Math.min(bottom - (railHeight - 8), top - 8);
      else if (top < 8) delta = top - 8;
      if (Math.abs(delta) < 2) return;
      const container = this.app?.pdfViewer?.container;
      if (container) container.scrollTop += delta;
    }

    _hasLeftItems() {
      if (this.layoutMode !== "split") return false;
      for (const [pageIndex, paragraphs] of this.overlay.pages) {
        for (const paragraph of paragraphs) {
          if (this._sideFor(pageIndex, paragraph.bbox) === "left") return true;
        }
      }
      return false;
    }

    get overlay() {
      return this.session.overlay;
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.pdfWin = view._iframeWindow;
      this.app = (this.pdfWin.wrappedJSObject || this.pdfWin).PDFViewerApplication;
      this.container = view._iframe?.parentElement;
      if (!this.container) return;
      this.attached = true;
      this.refresh();
    }

    detach() {
      this._teardownDOM();
      this.attached = false;
    }

    _teardownDOM() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      if (this._raf && this.readerWin) this.readerWin.cancelAnimationFrame(this._raf);
      this._raf = null;
      this.root?.remove();
      this.root = null;
      this.leftRoot?.remove();
      this.leftRoot = null;
      this.cards.clear();
      this.container?.classList.remove("deepread-has-rail");
      this.overlay.setRailActive?.(false);
    }

    /** Should the rail be shown right now? */
    _wanted() {
      if (!this.attached || !this.enabled) return false;
      return this.overlay.pages.size > 0;
    }

    /** Re-evaluate visibility and contents (call after data or settings change). */
    refresh() {
      if (!this.attached) return;
      if (!this._wanted()) {
        if (this.root) this._teardownDOM();
        return;
      }
      // Rebuild when the rail layout changed (e.g. a left rail is now needed or no longer needed).
      const wantLeft = this._hasLeftItems();
      if (this.root && !!this.leftRoot !== wantLeft) this._teardownDOM();
      if (!this.root) this._buildDOM(wantLeft);
      for (const card of this.cards.values()) card.sig = null; // force content refresh
      this.schedule(true);
    }

    _buildDOM(withLeft = false) {
      const doc = this.readerDoc;
      if (!doc.getElementById("deepread-rail-css")) {
        const style = doc.createElementNS(HTML_NS, "style");
        style.id = "deepread-rail-css";
        style.textContent = CSS;
        (doc.head || doc.documentElement).append(style);
      }
      if (!doc.getElementById("deepread-katex-css")) {
        const link = doc.createElementNS(HTML_NS, "link");
        link.id = "deepread-katex-css";
        link.rel = "stylesheet";
        link.href = "chrome://deepread/content/lib/katex/katex.min.css";
        (doc.head || doc.documentElement).append(link);
        this._cleanup.push(() => link.remove());
      }
      const makeRail = (cls, side) => {
        const rail = el(doc, "div", cls);
        const svg = doc.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "dr-links");
        const fold = el(doc, "button", "dr-collapse");
        fold.addEventListener("click", (e) => {
          e.stopPropagation();
          DeepRead.prefs.set(DeepRead.Rail.collapsePref(side), !this._collapsed(side));
        });
        // The folded strip is one big button.
        rail.addEventListener("click", () => {
          if (this._collapsed(side)) DeepRead.prefs.set(DeepRead.Rail.collapsePref(side), false);
        });
        rail.append(svg, this._resizeHandle(side), fold);
        rail._svg = svg;
        rail._fold = fold;
        rail._side = side;
        return rail;
      };
      this.root = makeRail("deepread-rail dr-right", "right");
      this.svg = this.root._svg;
      this.container.classList.add("deepread-has-rail");
      this.container.append(this.root);
      if (withLeft) {
        this.leftRoot = makeRail("deepread-rail dr-left", "left");
        this.container.prepend(this.leftRoot);
      }
      this._applySizing();
      this._applyCollapsed();
      // Card width / font size / translation fold follow the settings live.
      const observers = ["view.railWidth", "view.cardFontSize", "cards.translationOpen"].map((name) =>
        Zotero.Prefs.registerObserver(`deepread.${name}`, () => {
          this._applySizing();
          for (const card of this.cards.values()) card.sig = null;
          this.schedule(true);
        }));
      // Layout (split / right only) needs a rebuild, which unregisters this observer: do it after the callback.
      observers.push(Zotero.Prefs.registerObserver("deepread.view.railLayout", () => this.readerWin?.setTimeout(() => this.refresh(), 0)));
      for (const name of ["view.railCollapsedLeft", "view.railCollapsedRight"]) {
        observers.push(Zotero.Prefs.registerObserver(`deepread.${name}`, () => {
          this._applyCollapsed();
          this.schedule(true);
        }));
      }
      this._cleanup.push(() => observers.forEach((id) => Zotero.Prefs.unregisterObserver(id)));
      this.overlay.setRailActive?.(true);

      const schedule = () => this.schedule();
      const viewer = this.pdfWin.document.getElementById("viewerContainer");
      viewer?.addEventListener("scroll", schedule, { passive: true });
      this._cleanup.push(() => viewer?.removeEventListener("scroll", schedule));
      const onRendered = Components.utils.exportFunction((event) => {
        // Figure thumbnails are cut from the page canvas: redraw them once their page has rendered.
        const page = Number(event?.pageNumber) - 1;
        for (const [key, card] of this.cards) if (key.startsWith("g_") && card.page === page) card.sig = null;
        this.schedule(true);
      }, this.pdfWin);
      try {
        this.app.eventBus.on("pagerendered", onRendered);
        this.app.eventBus.on("scalechanging", onRendered);
        this.app.eventBus.on("rotationchanging", onRendered);
      }
      catch (e) {}
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagerendered", onRendered);
          this.app.eventBus.off("scalechanging", onRendered);
          this.app.eventBus.off("rotationchanging", onRendered);
        }
        catch (e) {}
      });
      const ro = new this.readerWin.ResizeObserver(() => this.schedule(true));
      ro.observe(this.root);
      if (this.leftRoot) ro.observe(this.leftRoot);
      this._cleanup.push(() => ro.disconnect());
      this._cleanup.push(() => this.readerDoc.getElementById("deepread-rail-css")?.remove());
    }

    static collapsePref(side) {
      return side === "left" ? "view.railCollapsedLeft" : "view.railCollapsedRight";
    }

    _collapsed(side) {
      return DeepRead.prefs.get(DeepRead.Rail.collapsePref(side)) === true;
    }

    _applyCollapsed() {
      for (const rail of [this.root, this.leftRoot]) {
        if (!rail) continue;
        const folded = this._collapsed(rail._side);
        rail.classList.toggle("dr-collapsed", folded);
        const away = rail._side === "left" ? "‹" : "›";
        const back = rail._side === "left" ? "›" : "‹";
        rail._fold.textContent = folded ? `${back} ${DeepRead.bilingual("卡片", "Cards")}` : away;
        rail._fold.title = folded ? DeepRead.bilingual("展开卡片栏", "Show the cards")
          : DeepRead.bilingual("收起卡片栏（给 AI 对话等腾出空间）", "Fold the cards away (e.g. to make room for the AI chat)");
      }
    }

    static clampWidth(value) {
      return Math.max(200, Math.min(520, Math.round(Number(value) || 280)));
    }

    static clampFont(value) {
      return Math.max(10, Math.min(18, Math.round(Number(value) || 12)));
    }

    _applySizing(width = DeepRead.Rail.clampWidth(DeepRead.prefs.number("view.railWidth", 280))) {
      const font = DeepRead.Rail.clampFont(DeepRead.prefs.number("view.cardFontSize", 12));
      for (const rail of [this.root, this.leftRoot]) {
        rail?.style.setProperty("--dr-rail-width", `${width}px`);
        rail?.style.setProperty("--dr-card-font", `${font}px`);
      }
    }

    /** Drag the rail's edge facing the PDF to resize the cards (saved as view.railWidth). */
    _resizeHandle(side) {
      const handle = el(this.readerDoc, "div", "dr-resize");
      handle.title = DeepRead.bilingual("拖动调整卡片宽度", "Drag to resize the cards");
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = handle.parentNode.clientWidth;
        const dir = side === "left" ? 1 : -1;
        let width = startWidth;
        handle.classList.add("dr-dragging");
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          width = DeepRead.Rail.clampWidth(startWidth + dir * (ev.clientX - startX));
          this._applySizing(width);
          this.schedule(true);
        };
        const up = () => {
          handle.classList.remove("dr-dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          if (width !== startWidth) DeepRead.prefs.set("view.railWidth", width);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
      return handle;
    }

    /** Translation fold of a card: default from the settings, flipped per card by the reader. */
    _translationOpen(key) {
      const byDefault = DeepRead.prefs.get("cards.translationOpen") === true;
      return this.trToggled.has(key) ? !byDefault : byDefault;
    }

    schedule(remeasure = false) {
      if (remeasure) this._remeasure = true;
      if (!this.root || this._raf) return;
      this._raf = this.readerWin.requestAnimationFrame(() => {
        this._raf = null;
        try {
          this._layout();
        }
        catch (e) {
          DeepRead.log("rail layout failed", e?.stack || String(e));
        }
      });
    }

    /* ---------- items ---------- */

    _items() {
      const items = [];
      const all = new Map([...this.overlay.pages].flatMap(([page, paras]) => paras.map((p) => [`p_${page}_${p.paragraphIndex}`, p])));
      for (const [pageIndex, paragraphs] of this.overlay.pages) {
        for (const paragraph of paragraphs) {
          const key = `p_${pageIndex}_${paragraph.paragraphIndex}`;
          // Paragraphs merged into one card are drawn inside their first paragraph's card.
          if (this.session.groupLead(key) !== key || this.session.isCardHidden?.(key)) continue;
          const keys = this.session.groupMembers(key).filter((k) => all.has(k));
          const members = keys.length > 1 ? keys.map((k) => all.get(k)) : null;

          const anchor = this.focusKey === key && keys.includes(this.focusParagraphKey) ? all.get(this.focusParagraphKey) : paragraph;
          items.push({ key, kind: "paragraph", pageIndex: anchor.pageIndex, rect: anchor.bbox, data: paragraph, members });
        }
      }
      if (DeepRead.Modules.enabled(this.session, "figureCards") && this.session.hasResults) {
        const figures = this.session.figures();
        for (const figure of figures) {
          const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
          if (rect) items.push({ key: `g_${figure.id}`, kind: "figure", pageIndex: figure.pageIndex, rect, data: figure });
        }
        // Papers read before figure guides existed: write them once, in the background.
        if (figures.length && !this.session._figuresRequested && DeepRead.prefs.get("cards.autoExplain") !== false) {
          this.session._figuresRequested = true;
          this.session.explainFigures().catch((e) => DeepRead.log("figure guides failed", String(e)));
        }
      }
      return items;
    }

    /** Anchor y (rail coordinates) of a PDF rect's top edge, or null if the page is not laid out. */
    _anchorY(pageIndex, rect) {
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return null;
      const pct = this.overlay._toPercent(geom, rect);
      const box = geom.div.getBoundingClientRect();
      const frame = this.view._iframe.getBoundingClientRect();
      const rail = this.root.getBoundingClientRect();
      return frame.top - rail.top + box.top + geom.div.clientTop + (pct.top / 100) * geom.div.clientHeight;
    }

    _visiblePages(railHeight) {
      const visible = new Set();
      const count = this.app?.pdfViewer?.pagesCount || 0;
      const frame = this.view._iframe.getBoundingClientRect();
      const rail = this.root.getBoundingClientRect();
      const offset = frame.top - rail.top;
      for (let i = 0; i < count; i++) {
        const div = this.app.pdfViewer.getPageView(i)?.div;
        if (!div) continue;
        const r = div.getBoundingClientRect();
        if (r.bottom + offset > -OVERSCAN && r.top + offset < railHeight + OVERSCAN) visible.add(i);
      }
      return visible;
    }

    /** Top/bottom (rail coordinates) of a page box. */
    _pageRange(pageIndex) {
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return null;
      const box = geom.div.getBoundingClientRect();
      const offset = this.view._iframe.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
      return { top: offset + box.top, bottom: offset + box.bottom };
    }

    _layout() {
      if (!this.root) return;
      const railHeight = this.root.clientHeight;
      const visible = this._visiblePages(railHeight);
      const items = this._items().filter((item) => visible.has(item.pageIndex));
      for (const item of items) item.anchor = this._anchorY(item.pageIndex, item.rect);
      const placed = items.filter((item) => item.anchor !== null).sort((a, b) => a.anchor - b.anchor);
      // Zoom/resize: re-decide which pages need compact cards.
      if (this._remeasure) this.compactPages = new Set();
      this.compactPages = this.compactPages || new Set();

      const width = this.root.clientWidth;
      const keep = new Set();
      const links = { left: [], right: [] };
      this._sideOfKey = new Map();
      for (const item of placed) {
        item.side = this.leftRoot ? this._sideFor(item.pageIndex, item.rect) : "right";
        this._sideOfKey.set(item.key, item.side);
      }
      // Pages laid out after the rail was built may reveal left-column paragraphs.
      if (!this.leftRoot && this.layoutMode === "split" && !this._leftCheckPending
          && placed.some((item) => this._sideFor(item.pageIndex, item.rect) === "left")) {
        this._leftCheckPending = true;
        setTimeout(() => {
          this._leftCheckPending = false;
          this.refresh();
        }, 0);
      }
      // Lay out each rail page by page so that a crowded page never pushes the next page's
      // cards away from their paragraphs: if a page's cards overflow its box, they switch to
      // compact mode (summary line only, expand on hover). The reader's own notes stay visible.
      for (const side of ["left", "right"]) {
        if (this._collapsed(side) && (side === "right" || this.leftRoot)) continue;
        const sideItems = placed.filter((item) => item.side === side);
        const pages = [];
        for (const item of sideItems) {
          let group = pages[pages.length - 1];
          if (!group || group.pageIndex !== item.pageIndex) pages.push(group = { pageIndex: item.pageIndex, items: [] });
          group.items.push(item);
        }
        let bottom = -Infinity;
        for (const group of pages) {
          const range = this._pageRange(group.pageIndex);
          const compactKey = `${side}:${group.pageIndex}`;
          const stack = () => {
            const heights = group.items.map((item) => this._ensureCard(item, width).height);
            const open = group.items.findIndex((item) => item.key === this.focusKey);
            let b = bottom;
            if (open < 0) {
              group.items.forEach((item, i) => {
                item.top = Math.max(item.anchor, b + GAP);
                b = item.top + heights[i];
              });
              return b;
            }
            // Keep the opened card beside its paragraph: cards above it stack upwards from it,
            // cards below it downwards; shift down only if the stack would hit the previous page.
            const items = group.items;
            items[open].top = Math.max(items[open].anchor, bottom + GAP);
            for (let i = open - 1; i >= 0; i--) items[i].top = Math.min(items[i].anchor, items[i + 1].top - GAP - heights[i]);
            const shift = Math.max(0, bottom + GAP - items[0].top);
            for (let i = 0; i <= open; i++) items[i].top += shift;
            b = items[open].top + heights[open];
            for (let i = open + 1; i < items.length; i++) {
              items[i].top = Math.max(items[i].anchor, b + GAP);
              b = items[i].top + heights[i];
            }
            return b;
          };
          let end = stack();
          if (range && end > range.bottom + 8 && !this.compactPages.has(compactKey)) {
            this.compactPages.add(compactKey);
            end = stack();
          }
          bottom = end;
          for (const item of group.items) {
            const card = this.cards.get(item.key);
            keep.add(item.key);
            const onScreen = item.top + card.height > -50 && item.top < railHeight + 50;
            card.el.hidden = !onScreen;
            if (onScreen) {
              card.el.style.top = `${Math.round(item.top)}px`;
              links[side].push({ anchor: item.anchor, top: item.top, kind: item.kind });
            }
          }
        }
      }
      for (const [key, card] of this.cards) {
        if (!keep.has(key)) {
          card.el.remove();
          this.cards.delete(key);
        }
      }
      this._remeasure = false;
      if (this._revealPending) this._revealFocus(railHeight);
      this._drawLinks(this.svg, links.right, "right");
      if (this.leftRoot) this._drawLinks(this.leftRoot._svg, links.left, "left");
    }

    _drawLinks(svg, links, side) {
      while (svg.firstChild) svg.firstChild.remove();
      const w = svg.parentNode?.clientWidth || 0;
      // The connector gutter faces the page: left edge of the right rail, right edge of the left rail.
      const x = side === "left" ? w - 3 : 3;
      const x2 = side === "left" ? w - 12 : 12;
      for (const { anchor, top, kind } of links) {
        const color = kind === "figure" ? "rgba(217,119,6,0.7)" : "rgba(107,114,128,0.55)";
        const dot = this.readerDoc.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(anchor + 4));
        dot.setAttribute("r", "2");
        dot.setAttribute("fill", color);
        svg.append(dot);
        if (Math.abs(top - anchor) > 3) {
          const path = this.readerDoc.createElementNS(SVG_NS, "path");
          path.setAttribute("d", `M${x} ${anchor + 4} L${x} ${top + 10} L${x2} ${top + 10}`);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", "1");
          svg.append(path);
        }
      }
    }

    /* ---------- cards ---------- */

    _signature(item) {
      if (item.kind === "figure") {
        const focus = this.figureFocus?.id === item.data.id ? this.figureFocus.panel || "*" : "";
        return `g|${JSON.stringify(this.session.figureGuide(item.data.id))}|${this.session.explainingFigures}|${focus}`
          + `|${JSON.stringify(this.session.figureNote(item.data.id))}|${this.figureEditing === item.data.id}`
          + `|${this.figureGuideOpen?.has(item.data.id)}`
          + `|${this.compactPages?.has(`${item.side || "right"}:${item.pageIndex}`) ? "c" : ""}`;
      }
      const paras = item.members || [item.data];
      const keys = paras.map((p) => `p_${p.pageIndex}_${p.paragraphIndex}`);
      const levels = paras.flatMap((p) => p.points || []).map((pt) => this.session.pointLevel(pt)).join("");
      const skim = this.session.skimDepth === "full" ? "" : `${this.session.skimDepth}:${this.session.skimTiers().tier.get(item.key) || ""}`;
      const questions = (this.session.questionsForKey?.(item.key) || []).map((q) => q.id).join(",");
      const guided = this.session.guide && DeepRead.Modules.enabled(this.session, "guided") ? this.session.guide.meta?.finishedAt || 1 : "";
      return `p|${keys.join(",")}|${this.session.groupTitle(item.key)}|${this.session.highlightColors().join("")}|${skim}|${questions}|${guided}`
        + `|${this.overlay.translationsFor(paras).join("\u001f")}`
        + `|${paras.map((p) => this.session.paragraphSummary(p)).join("|")}|${levels}|${this.isOpen(item.key)}|${this.focusKey === item.key}|${this._translationOpen(item.key)}`
        + `|${this.session.explanation(item.key)}|${this.session.isExplaining(item.key)}|${this.session.paragraphRole?.(item.key)}`
        + `|${this.compactPages?.has(`${item.side || "right"}:${item.pageIndex}`) ? "c" : ""}`
        + `|${keys.map((k) => this.session.paragraphNote(k)).join("|")}|${this.noteEditing === item.key}|`;
    }

    _invalidate(key) {
      const card = this.cards.get(key);
      if (card) card.sig = null;
      this.schedule(true);
    }

    _ensureCard(item, width) {
      let card = this.cards.get(item.key);
      const sig = this._signature(item);
      if (!card) {
        card = { el: el(this.readerDoc, "div", "dr-rcard"), height: 0, width: 0, sig: null, page: item.pageIndex };
        card.el.dataset.key = item.key;
        this.cards.set(item.key, card);
      }
      const parent = item.side === "left" && this.leftRoot ? this.leftRoot : this.root;
      if (card.el.parentNode !== parent) {
        parent.append(card.el);
        card.height = 0;
      }
      const editingFigure = item.kind === "figure" && this.figureEditing === item.data.id
        && card.el.contains(this.readerDoc.activeElement) && this.readerDoc.activeElement?.localName === "textarea";
      if (card.sig !== sig && !editingFigure) {
        card.el.replaceChildren();
        if (item.kind === "figure") this._fillFigure(card.el, item.data, item);
        else this._fillParagraph(card.el, item.key, item.data, item.members);
        card.sig = sig;
        card.height = 0;
      }
      if (!card.height || card.width !== width || this._remeasure) {
        card.el.hidden = false;
        card.height = card.el.offsetHeight;
        card.width = width;
      }
      return card;
    }

    _button(container, label, title, onClick) {
      const b = el(this.readerDoc, "button", "", label);
      b.title = title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(e);
      });
      container.append(b);
      return b;
    }

    /** A paragraph card; `members` (≥ 2 paragraphs, first = `paragraph`) when one card covers several paragraphs. */
    _fillParagraph(node, key, paragraph, members = null) {
      const doc = this.readerDoc;
      const session = this.session;
      const paras = members || [paragraph];
      const keys = paras.map((p) => `p_${p.pageIndex}_${p.paragraphIndex}`);
      node.classList.toggle("dr-group", !!members);
      node.classList.toggle("dr-expanded", this.isOpen(key));
      node.classList.toggle("dr-open", this.focusKey === key);
      const side = this._sideOfKey?.get(key) || "right";
      // Skim layers fold minor cards (every card in "margin only") to their one-line summary.
      const depth = session.skimDepth;
      const skimFold = depth === "margin" || (depth === "key" && session.skimTiers().tier.get(key) === "minor");
      node.classList.toggle("dr-compact", (skimFold || !!this.compactPages?.has(`${side}:${paragraph.pageIndex}`)) && !this.isOpen(key));
      node.classList.add("dr-para");
      const role = session.paragraphRole?.(key) || "";
      node.dataset.role = role;
      const head = el(doc, "div", "dr-rhead");
      if (role) head.append(el(doc, "span", `dr-role dr-role-${role}`, DeepRead.Rail.roleLabel(role)));
      const level = Math.max(1, ...paras.flatMap((p) => p.points || []).map((p) => session.pointLevel(p)));
      if (level >= 2) {
        const dot = el(doc, "span", "dr-imp");
        dot.style.background = session.levelColor(level);
        dot.title = DeepRead.bilingual("含荧光笔标记的要点", "Has highlighted key points");
        head.append(dot);
      }
      const title = members ? session.groupTitle(key) || session.paragraphSummary(paragraph) : session.paragraphSummary(paragraph);
      const summary = el(doc, "div", "dr-rsummary", title || "…");
      summary.title = members ? DeepRead.bilingual("单击展开 / 收起", "Click to open / close")
        : DeepRead.bilingual("单击展开 / 收起 · 双击编辑", "Click to open / close · double-click to edit");
      summary.addEventListener("click", () => {
        if (summary.isContentEditable) return;
        if (this.isOpen(key)) {
          this.expanded.delete(key);
          if (this.focusKey === key) this.focusKey = null;
        }
        else this.expanded.add(key);
        this.schedule();
        this.cards.get(key).sig = null;
      });
      summary.addEventListener("dblclick", (e) => {
        if (members) return; // a merged card's title is the AI's, not a paragraph summary
        e.preventDefault();
        summary.contentEditable = "true";
        summary.focus();
        const range = doc.createRange();
        range.selectNodeContents(summary);
        doc.defaultView.getSelection().removeAllRanges();
        doc.defaultView.getSelection().addRange(range);
      });
      const finish = (save) => {
        if (summary.contentEditable !== "true") return;
        summary.contentEditable = "false";
        if (save) session.setParagraphSummary(paragraph, summary.textContent.trim());
        else summary.textContent = session.paragraphSummary(paragraph);
        this.cards.get(key) && (this.cards.get(key).sig = null);
        this.schedule(true);
      };
      summary.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
        else if (e.key === "Escape") finish(false);
      });
      summary.addEventListener("blur", () => finish(true));
      head.append(summary);
      // Reading questions this card helps answer.
      for (const q of session.questionsForKey?.(key) || []) {
        const pill = el(doc, "span", "dr-q", session.questionLabel(q));
        pill.title = q.question;
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          DeepRead.Panes?.reveal(session.reader, "questions");
        });
        head.append(pill);
      }
      if (members) {
        const range = el(doc, "span", "dr-range", DeepRead.bilingual(`${paras.length} 段`, `${paras.length} ¶`));
        range.title = session.groupLabel(key);
        head.append(range);
      }
      // One-line (compact) cards keep a hint of what is folded inside.

      const badges = el(doc, "span", "dr-badges");

      if (session.paragraphNote(key)) badges.append(el(doc, "span", "dr-badge dr-badge-note", DeepRead.bilingual("理解", "Note")));
      if (badges.childNodes.length) head.append(badges);

      const actions = el(doc, "div", "dr-ractions");
      const translations = this.overlay.translationsFor(paras);
      this._button(actions, "⧉", DeepRead.t("card.copySummary"), () => {
        const lines = paras.flatMap((p) => [session.paragraphSummary(p), ...(p.points || []).map((pt) => `- ${pt.summary}`)]);
        DeepRead.util.copyToClipboard(lines.filter(Boolean).join("\n"));
      });
      if (translations.length) {
        this._button(actions, "译", DeepRead.t("card.copyTranslation"), () => {
          DeepRead.util.copyToClipboard(translations.join("\n\n"));
        });
      }
      this._button(actions, "✎", DeepRead.bilingual("写我的理解", "Add my understanding"), () => {
        this.noteEditing = key;
        this._invalidate(key);
      });
      const eligible = paras.some((p) => DeepRead.Explainer?.eligible(p));
      if (eligible) {
        this._button(actions, "讲", DeepRead.bilingual("重新生成 AI 讲解", "Regenerate the AI explanation"), () => {
          session.explainParagraph(key).catch((e) => session._notify(DeepRead.util.formatError(e), "error"));
        });
      }
      this._button(actions, "AI", DeepRead.t("card.askAI"), () => {
        session.askAI({ text: paras.map((p) => p.paragraphText || "").filter(Boolean).join("\n\n"), pageIndex: paragraph.pageIndex, block: session.groupLabel(key) });
      });
      if (session.previousCard(key)) this._button(actions, "合", DeepRead.bilingual("与上一张卡片合并", "Merge with previous card"), () => session.mergeCardWithPrevious(key));
      if (session.groupMembers(key).length > 1) this._button(actions, "拆", DeepRead.bilingual("拆开这张合并卡片", "Split this card"), () => session.splitCard(key));
      this._button(actions, "×", DeepRead.bilingual("隐藏此卡片", "Hide this card"), () => {
        session.setCardHidden(key, true);
      });
      head.append(actions);
      const headWrap = el(doc, "div", "dr-phead");
      headWrap.append(head);
      node.append(headWrap);

      // Body: the AI's explanation of the paragraph.
      const explanation = session.explanation(key);
      if (explanation) {
        const body = el(doc, "div", "dr-explain");
        body.append(DeepRead.Markdown.render(doc, explanation));
        node.append(body);
      }
      else if (session.isExplaining(key)) {
        node.append(el(doc, "div", "dr-explain dr-explain-pending", DeepRead.bilingual("AI 讲解生成中…", "Writing the explanation…")));
      }
      else if (eligible && session.hasResults) {
        const missing = el(doc, "div", "dr-explain dr-explain-missing");
        const link = el(doc, "a", "", DeepRead.bilingual("生成 AI 讲解", "Explain this paragraph"));
        link.addEventListener("click", (e) => {
          e.stopPropagation();
          session.explainParagraph(key).catch((err) => session._notify(DeepRead.util.formatError(err), "error"));
        });
        missing.append(link);
        node.append(missing);
      }

      // Guided reading's judgements on these paragraphs (load-bearing, hedging, claim status).
      const guideNotes = session.guideNotesForKey?.(key) || [];
      if (guideNotes.length) {
        const box = el(doc, "div", "dr-guide-notes");
        for (const note of guideNotes.slice(0, 4)) {
          const row = el(doc, "div", `dr-guide-note dr-gn-${note.kind}`);
          row.append(el(doc, "span", "dr-gn-label", note.label));
          if (note.text) row.append(el(doc, "span", "dr-gn-text", note.text));
          box.append(row);
        }
        box.title = DeepRead.bilingual("来自带读 · 点击打开带读", "From the guided reading · click to open it");
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          session.guidePanel?.open(note0Step(guideNotes[0]));
        });
        node.append(box);
      }

      const points = paras.flatMap((p) => (p.points || []).map((point) => ({ point, owner: p })));
      if (points.length) {
        const list = el(doc, "ul", "dr-points");
        for (const { point, owner } of points) {
          const li = el(doc, "li");
          const pointLevel = session.pointLevel(point);
          const color = session.levelColor(pointLevel);
          li.dataset.level = String(pointLevel);
          li.classList.toggle("dr-hl", !!color);
          if (color) li.style.setProperty("--dr-hl", color);
          li.title = DeepRead.bilingual("单击换荧光笔颜色（颜色和次数在设置或「功能」菜单里改）",
            "Click for the next highlighter colour (colours are set in the settings or the Features menu)");
          li.append(el(doc, "span", "", point.summary || ""));
          li.addEventListener("pointerenter", () => this.overlay._drawHover(owner, point.id));
          li.addEventListener("pointerleave", () => this.overlay._drawHover(owner));
          li.addEventListener("click", (e) => {
            e.stopPropagation();
            session.setPointImportance(point.id, session.nextPointLevel(point));
          });
          list.append(li);
        }
        node.append(list);
      }

      // The translation is one part of the card, folded by default.
      if (translations.length) {
        const open = this._translationOpen(key);
        const wrap = el(doc, "div", "dr-trwrap");
        const toggle = el(doc, "span", "dr-trtoggle", `${open ? "▾" : "▸"} ${DeepRead.bilingual("译文", "Translation")}`);
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.trToggled.has(key)) this.trToggled.delete(key);
          else this.trToggled.add(key);
          this._invalidate(key);
        });
        wrap.append(toggle);
        if (open) {
          const body = el(doc, "div", "dr-trbody");
          for (const text of translations) {
            const part = el(doc, "div", "dr-trpart");
            part.append(DeepRead.Overlay.inlineMarkdown(doc, text));
            body.append(part);
          }
          wrap.append(body);
        }
        node.append(wrap);
      }

      // The reader's own understanding: always expanded, never folded.
      const note = session.paragraphNote(key);
      if (this.noteEditing === key) {
        node.append(this._noteEditor(note, (value) => {
          this.noteEditing = null;
          this._clearDrafts(`note:${key}`);
          session.setParagraphNote(key, value);
          this._invalidate(key);
        }, () => {
          this.noteEditing = null;
          this._clearDrafts(`note:${key}`);
          this._invalidate(key);
        }, `note:${key}`));
      }
      else if (note) {
        const block = el(doc, "div", "dr-note");
        block.append(el(doc, "div", "dr-note-label", DeepRead.bilingual("我的理解", "My understanding")), el(doc, "div", "dr-note-text", note));
        block.title = DeepRead.bilingual("单击编辑", "Click to edit");
        block.addEventListener("click", (e) => {
          e.stopPropagation();
          this.noteEditing = key;
          this._invalidate(key);
        });
        node.append(block);
      }

      for (const member of paras.slice(1)) {
        const noteKey = `p_${member.pageIndex}_${member.paragraphIndex}`;
        const memberNote = session.paragraphNote(noteKey);
        if (memberNote) node.append(el(doc, "div", "dr-note", `${session.groupLabel(noteKey)} · ${memberNote}`));
      }
      node.onpointerenter = () => (members ? this.overlay.outlineParagraphs(paras) : this.overlay._drawHover(paragraph));
      node.onpointerleave = () => this.overlay._clearTransient();
    }

    /** Bind a textarea to a draft slot so typed text survives re-rendering the card. */
    _draft(field, id, initial) {
      field.value = this.drafts.has(id) ? this.drafts.get(id) : (initial || "");
      field.addEventListener("input", () => this.drafts.set(id, field.value));
    }

    _clearDrafts(prefix) {
      for (const id of [...this.drafts.keys()]) if (id.startsWith(prefix)) this.drafts.delete(id);
    }

    _noteEditor(value, onSave, onCancel, draftID) {
      const doc = this.readerDoc;
      const wrap = el(doc, "div", "dr-note dr-note-editing");
      wrap.append(el(doc, "div", "dr-note-label", DeepRead.bilingual("我的理解", "My understanding")));
      const area = el(doc, "textarea");
      area.rows = 3;
      area.placeholder = DeepRead.bilingual("写下你对这段的理解、疑问或联想…（Ctrl+Enter 保存）", "Your understanding, questions or connections… (Ctrl+Enter to save)");
      if (draftID) this._draft(area, draftID, value);
      else area.value = value || "";
      area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSave(area.value);
        }
        else if (e.key === "Escape") onCancel();
      });
      area.addEventListener("input", () => this.schedule(true));
      const buttons = el(doc, "div", "dr-fc-buttons");
      this._button(buttons, DeepRead.bilingual("保存", "Save"), "", () => onSave(area.value)).classList.add("dr-primary");
      this._button(buttons, DeepRead.bilingual("取消", "Cancel"), "", () => onCancel());
      wrap.append(area, buttons);
      wrap.addEventListener("click", (e) => e.stopPropagation());
      setTimeout(() => area.focus(), 0);
      return wrap;
    }

    /** Figure/table card: label, title, thumbnail cut from the rendered page, and reading steps. */
    _fillFigure(node, figure, item) {
      const doc = this.readerDoc;
      const session = this.session;
      node.classList.add("dr-figure");
      node.dataset.kind = figure.kind === "table" ? "table" : "figure";
      const focus = this.figureFocus?.id === figure.id ? this.figureFocus : null;
      node.classList.toggle("dr-linked", !!focus);
      const side = item?.side || this._sideOfKey?.get(`g_${figure.id}`) || "right";
      const compact = !!this.compactPages?.has(`${side}:${figure.pageIndex}`) && !focus && this.figureEditing !== figure.id;
      node.classList.toggle("dr-compact", compact);
      const guide = session.figureGuide(figure.id);
      const head = el(doc, "div", "dr-fhead");
      const label = DeepRead.Rail.figureLabel(figure);
      head.append(el(doc, "span", "dr-flabel", label));
      head.append(el(doc, "span", "dr-ftitle", guide?.title || figure.title || ""));
      const count = session.figureMentionCount(figure.id);
      if (count) head.append(el(doc, "span", "dr-fcount", DeepRead.bilingual(`提到 ${count} 次`, `${count} mentions`)));
      node.append(head);

      // Caption-only figures (no image region found) have nothing to show as a thumbnail.
      if (!figure.captionOnly) {
        const thumb = el(doc, "canvas", "dr-fthumb");
        thumb.setAttribute("role", "img");
        thumb.setAttribute("aria-label", `${label} ${figure.title || ""}`);
        node.append(thumb);
        this._drawThumb(thumb, figure);
      }

      const body = el(doc, "div", "dr-fbody");
      if (guide?.steps?.length) {
        const list = el(doc, "ol", "dr-fsteps");
        guide.steps.forEach((step, i) => {
          const li = el(doc, "li");
          const on = focus && (focus.panel ? step.panel === focus.panel : false);
          li.classList.toggle("dr-on", !!on);
          li.append(el(doc, "span", "dr-fnum", String(i + 1)));
          const text = el(doc, "span", "dr-ftext");
          text.append(DeepRead.Overlay.inlineMarkdown(doc, step.text || ""));
          li.append(text);
          list.append(li);
        });
        const details = el(doc, "details", "dr-figure-guide");
        details.open = this.figureGuideOpen?.has(figure.id) || false;
        details.append(el(doc, "summary", "", DeepRead.bilingual("查看 AI 读图步骤", "Show AI reading steps")), list);
        details.addEventListener("toggle", () => {
          this.figureGuideOpen = this.figureGuideOpen || new Set();
          if (details.open) this.figureGuideOpen.add(figure.id);
          else this.figureGuideOpen.delete(figure.id);
          this.schedule(true);
        });
        body.append(details);
      }
      else if (session.explainingFigures) {
        body.append(el(doc, "div", "dr-muted", DeepRead.bilingual("读图步骤生成中…", "Writing the reading guide…")));
      }
      else if (figure.caption) {
        body.append(el(doc, "div", "dr-fcaption", figure.caption.length > 160 ? `${figure.caption.slice(0, 160)}…` : figure.caption));
      }
      node.append(body);
      const evidence = el(doc, "div", "dr-evidence");
      const note = session.figureNote(figure.id);
      evidence.append(el(doc, "strong", "", DeepRead.bilingual("我的证据笔记", "My evidence notes")));
      if (this.figureEditing === figure.id) {
        const fields = {};
        for (const field of DeepRead.Reading.FIELDS) {
          const label = el(doc, "label", "", DeepRead.bilingual(field.zh, field.en));
          const input = el(doc, "textarea");
          input.rows = 2;
          input.maxLength = 6000;
          input.dataset.field = field.key;
          this._draft(input, `evidence:${figure.id}:${field.key}`, note?.[field.key]);
          input.addEventListener("input", () => this.schedule(true));
          input.addEventListener("keydown", (e) => e.stopPropagation());
          fields[field.key] = input;
          label.append(input);
          evidence.append(label);
        }
        this._button(evidence, DeepRead.bilingual("保存", "Save"), "", () => {
          this.figureEditing = null;
          this._clearDrafts(`evidence:${figure.id}:`);
          session.setFigureNote(figure, Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value])));
          this._invalidate(`g_${figure.id}`);
        }).classList.add("dr-evidence-save");
        this._button(evidence, DeepRead.bilingual("取消", "Cancel"), "", () => {
          this.figureEditing = null;
          this._clearDrafts(`evidence:${figure.id}:`);
          this._invalidate(`g_${figure.id}`);
        });
      }
      else {
        if (note) for (const field of DeepRead.Reading.FIELDS) if (note[field.key]) {
          evidence.append(el(doc, "div", "dr-muted", DeepRead.bilingual(field.zh, field.en)), el(doc, "p", "", note[field.key]));
        }
        this._button(evidence, DeepRead.bilingual(note ? "编辑笔记" : "先写我的判断", note ? "Edit notes" : "Write my interpretation"), "", () => {
          this.figureEditing = figure.id;
          this._invalidate(`g_${figure.id}`);
        }).classList.add("dr-evidence-edit");
      }
      evidence.addEventListener("click", (e) => e.stopPropagation());
      node.append(evidence);
      node.title = DeepRead.bilingual("单击跳到图表", "Click to go to the figure");
      node.onclick = (event) => {
        if (event.target?.closest("button, textarea, input, select, a, summary, details")) return;
        const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
        session.reader.navigate(rect ? { position: { pageIndex: figure.pageIndex, rects: [rect] } } : { pageIndex: figure.pageIndex });
      };
      node.onpointerenter = () => {
        const rect = this.overlay.permilleRect(figure.pageIndex, figure.bbox);
        if (rect) this.overlay._drawHover({ pageIndex: figure.pageIndex, bbox: rect, rects: [rect], points: [] });
      };
      node.onpointerleave = () => this.overlay._clearTransient();
    }

    /** Copy the figure's region from the page canvas pdf.js already rendered (blank until it has). */
    _drawThumb(canvas, figure) {
      const width = Math.max(120, (this.root?.clientWidth || 280) - 44);
      const [x1, y1, x2, y2] = figure.bbox || [0, 0, 1000, 1000];
      const aspect = Math.max(0.15, (y2 - y1) / Math.max(1, x2 - x1));
      const height = Math.min(180, Math.round(width * aspect));
      const ratio = this.readerWin?.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      try {
        const div = this.app?.pdfViewer?.getPageView(figure.pageIndex)?.div;
        const source = div?.querySelector("canvas");
        if (!source || !source.width) return;
        const src = Components.utils.unwaiveXrays ? Components.utils.unwaiveXrays(source) : source;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(src,
          (x1 / 1000) * source.width, (y1 / 1000) * source.height,
          ((x2 - x1) / 1000) * source.width, ((y2 - y1) / 1000) * source.height,
          0, 0, canvas.width, canvas.height);
        canvas.dataset.drawn = "1";
      }
      catch (e) {
        DeepRead.log("figure thumbnail failed", String(e));
      }
    }

    linkParagraph(paragraph) {
      if (!this.root) return;
      const key = paragraph ? this.session.groupLead(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`) : null;
      for (const [k, card] of this.cards) card.el.classList.toggle("dr-linked", k === key);
      // A paragraph that mentions a figure ("Fig. 3(b)") lights up that figure's card and step.
      const focus = paragraph ? DeepRead.Rail.figureMention(paragraph.paragraphText || "", this.session.figures()) : null;
      const before = this.figureFocus?.id;
      if (focus?.id !== before || focus?.panel !== this.figureFocus?.panel) {
        this.figureFocus = focus;
        for (const id of [before, focus?.id]) if (id && this.cards.get(`g_${id}`)) this.cards.get(`g_${id}`).sig = null;
        this.schedule();
      }
    }
  };
})();
