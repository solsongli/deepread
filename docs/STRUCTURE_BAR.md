# Structure bar layout and navigation

`addon/content/scripts/reader/structureBar.js` owns the navigation strip in the
reader iframe. It continues to derive sections from the parser's content list;
the interface does not make model requests.

The strip has two flex groups: `.dr-map` contains the section map (or a native
section selector) and the furthest-position label; `.dr-controls` contains skim
depth, the approximate reading time, next-key navigation, figures, and question
sources. These groups wrap according to the available reader width, including
space occupied by Zotero's sidebar. When the section map has insufficient room,
the selector exposes the unabridged section titles and source page numbers.

A `ResizeObserver` watches the strip. `_layout()` writes its measured height to
`body`'s `--deepread-bar-height`; `#split-view` starts at `41px` plus that value.
Do not restore a fixed 30px height: the controls can occupy multiple rows. The
observer is disconnected and the body variable removed in `_remove()`, including
module disable and reader detach. Section progress uses a bottom line so a
partially reached section does not put one label across two contrasting fills.

`refresh()` compares a signature of sections, relevant modules, figures, and
question IDs/text/source keys before rebuilding. Position and skim-depth updates
reuse existing controls, preserving keyboard focus and an open native selector.
Required rebuilds restore focus by `data-focus-key`. The section selector is not
automatically changed while it has focus.

Question sources remain individually accessible in a native selector. Map
markers are native buttons; they are hidden when the map is unavailable or their
measured bounds overlap. Selecting either route opens the earliest valid source
paragraph and reveals the questions pane. A question with no valid source does
not invent a map location. The progress label describes the furthest position
reached, including skipped pages; it does not assess reading or understanding.

`_onKey()` owns the existing N / Shift+N navigation shortcut. Composition events,
key code 229, repeats, modifier chords, already handled events, and editable or
native selection controls do not trigger navigation.

Native regression coverage is in `test/e2e/structureBar.js`, using generated PDF
geometry and local question data, without a parser or model service:

```bash
env -u PYTHONHOME -u PYTHONPATH \
  E2E_BASE="$PWD/.test-profile/structure-ux" \
  E2E_SKIP_SERVICES=1 \
  E2E_PDF="$PWD/test/fixtures/reading/continuations.pdf" \
  scripts/e2e.sh test/e2e/structureBar.js
```

The regression covers full section names, dense and sparse source navigation,
focus retention, IME guards, responsive reader spacing, native sidebar resizing,
dark styling, and cleanup. Screenshots are constructed test cases, not evidence
of improved comprehension or measured reading speed.
