/* Local English OCR for isolated plot labels. Apache-2.0 engine in lib/figure-ocr.
 * Adapter license: AGPL-3.0-or-later. */
"use strict";
const library = "chrome://deepread/content/lib/figure-ocr/";
importScripts(library + "tesseract-core-lstm.js");
let engine;
async function initialize() {
  const read = async (name) => {
    const response = await fetch(library + name);
    if (!response.ok) throw new Error("Cannot read packaged OCR resource: " + name);
    return response.arrayBuffer();
  };
  const [wasmBinary, language] = await Promise.all([read("tesseract-core-lstm.wasm"), read("eng.traineddata")]);
  const core = await TesseractCore({ wasmBinary, print() {}, printErr() {}, TesseractProgress() {} });
  core.FS.writeFile("/eng.traineddata", new Uint8Array(language));
  const api = new core.TessBaseAPI();
  if (api.Init(null, "eng", 1, null) !== 0) throw new Error("Could not initialize English OCR");
  api.SetVariable("tessedit_pageseg_mode", "11");
  api.SetVariable("user_defined_dpi", "300");
  return { core, api };
}
self.onmessage = async ({ data }) => {
  try {
    const { core, api } = await (engine ||= initialize());
    core.FS.writeFile("/input", new Uint8Array(data.bytes));
    api.SetVariable("tessedit_pageseg_mode", data.mode === "line" ? "7" : data.mode === "block" ? "6" : "11");
    if (api.SetImageFile(1, 0) !== 0 || api.Recognize(null) !== 0) throw new Error("Could not recognize the plot");
    self.postMessage({ tsv: api.GetTSVText() });
  } catch (error) {
    self.postMessage({ error: String(error?.message || error) });
  }
};
