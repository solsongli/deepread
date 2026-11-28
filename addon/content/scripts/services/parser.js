/*
 * PDF structure parsing via MinerU.
 *  - provider "mineru":   official mineru.net precise-parsing API v4 (user's own token)
 *  - provider "selfhost": MinerU FastAPI `mineru-api` (POST /file_parse) or a compatible deployment
 * Result: { resultDir, contentList, markdown }.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Components, IOUtils, PathUtils, fetch, Blob, FormData, AbortController, atob, setTimeout, clearTimeout */

DeepRead.Parser = {
  POLL_INTERVAL_MS: 3000,
  TIMEOUT_MS: 30 * 60 * 1000,

  // Error codes documented at https://mineru.net/apiManage/docs
  MINERU_ERRORS: {
    A0202: ["Token 错误，请检查 MinerU Token", "MinerU token is invalid, please check it"],
    A0211: ["Token 已过期，请在 mineru.net 更换 Token", "MinerU token has expired, please create a new one at mineru.net"],
    "-60005": ["文件过大（上限 200 MB）", "File too large (limit 200 MB)"],
    "-60006": ["PDF 页数超过限制（上限 200 页），请拆分后重试", "Too many pages (limit 200); split the PDF and retry"],
    "-60004": ["文件为空", "The file is empty"],
    "-60003": ["文件读取失败，PDF 可能已损坏", "File could not be read; the PDF may be corrupted"],
    "-60009": ["解析队列已满，请稍后重试", "Task queue is full, retry later"],
    "-60018": ["今日解析任务数量已达上限（额度用尽）", "Daily parsing quota exhausted"],
    "-60007": ["模型服务暂时不可用，请稍后重试", "Model service temporarily unavailable, retry later"],
    "-60010": ["解析失败，请稍后重试", "Parsing failed, retry later"],
  },

  // ---- public API --------------------------------------------------------

  isConfigured(config) {
    const cfg = config || DeepRead.prefs.parserConfig();
    if (cfg.provider === "builtin") return true;
    if (cfg.provider === "grobid") return !!cfg.grobidURL;
    if (cfg.provider === "selfhost") return !!cfg.selfHostURL;
    return !!cfg.mineruToken;
  },

  /** Providers that build the content list in-process ("builtin") or from a local service ("grobid"). */
  async _parseToContentList(ctx, pdfApp) {
    const { cfg, filePath, resultDir, status, signal } = ctx;
    let result;
    if (cfg.provider === "builtin") {
      if (!pdfApp) throw new Error(DeepRead.bilingual("内置解析需要在阅读器中打开 PDF", "The built-in parser needs the PDF open in the reader"));
      result = await DeepRead.TextLayerParser.parse({ pdfApp, onStatus: (s) => status(s.phase || "running", s.message, s), signal });
    }
    else {
      result = await DeepRead.GrobidParser.parse({ filePath, config: cfg, onStatus: (s) => status(s.phase || "running", s.message, s), signal });
    }
    const contentList = Array.isArray(result?.contentList) ? result.contentList : [];
    if (!contentList.length) {
      throw new Error(DeepRead.bilingual("没有从 PDF 中解析出内容（扫描版 PDF 没有文字层）", "No content was extracted from the PDF (scanned PDFs have no text layer)"));
    }
    await IOUtils.writeUTF8(PathUtils.join(resultDir, "content_list.json"), JSON.stringify(contentList));
    await IOUtils.writeUTF8(PathUtils.join(resultDir, "full.md"), result.markdown || "");
    return {
      resultDir,
      contentList: contentList.map((item, index) => ({ id: index, ...item })),
      markdown: result.markdown || "",
    };
  },

  async parsePDF({ filePath, attachmentKey, onStatus, signal, pdfApp, resumeDownload } = {}) {
    const cfg = DeepRead.prefs.parserConfig();
    const status = (phase, message, extra) => {
      try {
        onStatus?.({ phase, message, ...extra });
      }
      catch (e) {
        DeepRead.log("onStatus failed", String(e));
      }
    };
    this._throwIfAborted(signal);
    if (!this.isConfigured(cfg)) {
      throw new Error(DeepRead.bilingual("PDF 解析服务未配置", "PDF parser is not configured"));
    }
    const resultDir = await DeepRead.Store.resultDirFor(attachmentKey);
    await this._emptyDir(resultDir);

    const ctx = { cfg, filePath, attachmentKey, resultDir, status, signal, resumeDownload,
      firstPage:pdfApp?.firstPhysicalPage || 0, pageCount:pdfApp?.pdfDocument?.numPages };
    if (cfg.provider === "builtin") return await this._parseToContentList(ctx, pdfApp);
    try {
      if (cfg.provider === "grobid") return await this._parseToContentList(ctx, pdfApp);
      let origin;
      if (cfg.provider === "selfhost") await this._selfhostParse(ctx);
      else origin = await this._mineruParse(ctx);
      status("extract", DeepRead.bilingual("读取解析结果…", "Reading parse results…"));
      return {...await this._loadResults(resultDir), origin};
    }
    catch (error) {
      // A service that is down or out of quota should not block reading: fall back to the PDF's
      // own text layer (needs the open reader's pdf.js; scanned PDFs still fail).
      if (signal?.aborted || error?.name === "AbortError" || !pdfApp) throw error;
      DeepRead.log("parser failed, falling back to the built-in text layer", String(error?.message || error));
      status("fallback", DeepRead.bilingual(`解析服务失败（${error?.message || error}），改用内置文字层…`,
        `Parser failed (${error?.message || error}); using the built-in text layer…`));
      await this._emptyDir(resultDir);
      try {
        const result = await this._parseToContentList({ ...ctx, cfg: { ...cfg, provider: "builtin" } }, pdfApp);
        return { ...result, fallback: true, downloadJob: error.downloadJob };
      } catch (fallbackError) {
        if (error.downloadJob && !signal?.aborted) throw Object.assign(new Error(DeepRead.bilingual(
          "MinerU 已完成解析，但下载失败，且这些页没有可用的文字层。可再次翻译以重试下载。",
          "MinerU finished, but its result could not be downloaded and these pages have no usable text layer. Translate again to retry the download."
        )), {downloadJob:error.downloadJob});
        throw fallbackError;
      }
    }
  },

  async testConnection(config) {
    try {
      const cfg = config || DeepRead.prefs.parserConfig();
      if (cfg.provider === "builtin") {
        return { ok: true, message: DeepRead.bilingual("内置解析无需联网或服务，可直接使用", "The built-in parser needs no service — ready to use") };
      }
      if (cfg.provider === "grobid") {
        if (!cfg.grobidURL) return { ok: false, message: DeepRead.bilingual("请填写 GROBID 服务地址", "Enter the GROBID service URL") };
        return await DeepRead.GrobidParser.testConnection(cfg);
      }
      if (!this.isConfigured(cfg)) {
        return {
          ok: false,
          message: cfg.provider === "selfhost"
            ? DeepRead.bilingual("请填写自建服务地址", "Enter the self-hosted service URL")
            : DeepRead.bilingual("请填写 MinerU Token", "Enter the MinerU token"),
        };
      }
      return cfg.provider === "selfhost" ? await this._selfhostTest(cfg) : await this._mineruTest(cfg);
    }
    catch (e) {
      return { ok: false, message: String(e?.message || e) };
    }
  },

  // ---- provider: official MinerU API v4 ----------------------------------

  _mineruBase() {
    const raw = String(DeepRead.prefs.get("parser.mineruBaseURL") || "https://mineru.net").trim();
    return raw.replace(/\/+$/, "");
  },

  _mineruHeaders(cfg, json) {
    const h = { Authorization: `Bearer ${cfg.mineruToken}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  },

  /** Map an API-level error code to a readable message. */
  _mineruApiError(step, body) {
    const code = String(body?.code ?? "");
    const known = this.MINERU_ERRORS[code];
    const msg = known ? DeepRead.bilingual(known[0], known[1]) : "";
    const detail = body?.msg ? ` ${body.msg}` : "";
    return Object.assign(new Error(`MinerU ${step} failed (code ${code}): ${msg}${msg && detail ? " /" : ""}${detail}`.trim()), {code});
  },

  async _mineruParse(ctx) {
    const { cfg, signal, status } = ctx;
    const base = this._mineruBase();
    const timeout = this._deadline(signal);
    try {
      const sig = timeout.signal;
      let job, result;
      // Persist a completed batch ID locally. A retry obtains a fresh signed
      // URL from the configured MinerU account without uploading the PDF again.
      if (ctx.resumeDownload?.base === base) {
        job = ctx.resumeDownload;
        try {
          result = await this._mineruPoll({base,cfg,batchID:job.batchID,status,signal:sig});
        } catch (error) {
          if (!["-60012","-60013"].includes(error.code) && error.status !== 404)
            throw Object.assign(error,{downloadJob:job});
          // The stored result expired or belongs to a different account.
        }
      }
      if (!result) {
        status("upload", DeepRead.bilingual("上传 PDF 至 MinerU…", "Uploading PDF to MinerU…"));
        const bytes = await IOUtils.read(ctx.filePath);
        const req = await this._mineruRequestUpload({base,cfg,bytes,ctx,signal:sig});
        await this._mineruPut({url:req.uploadURL,bytes,signal:sig});
        job = {base,batchID:req.batchID,first:ctx.firstPage,count:ctx.pageCount};
        status("queued", DeepRead.bilingual("MinerU 排队中…", "Queued at MinerU…"));
        result = await this._mineruPoll({base,cfg,batchID:job.batchID,status,signal:sig});
      }
      status("download", DeepRead.bilingual("下载解析结果…", "Downloading result…"));
      let zip;
      try {
        zip = await this._download(result.full_zip_url, null, sig, "download result zip");
      } catch (error) {
        throw Object.assign(error,{downloadJob:job});
      }
      status("extract", DeepRead.bilingual("解压解析结果…", "Extracting result…"));
      await this._extractZip(zip, ctx.resultDir);
      return {first:job.first,count:job.count};
    }
    catch (e) {
      throw this._normalizeAbort(e, signal, timeout);
    }
    finally {
      timeout.clear();
    }
  },

  /** Step 1: ask for a presigned upload URL. → { batchID, uploadURL } */
  async _mineruRequestUpload({ base, cfg, bytes, ctx, signal }) {
    let name = PathUtils.filename(ctx.filePath) || "document.pdf";
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    const payload = {
      files: [{
        name,
        data_id: String(ctx.attachmentKey || "").replace(/[^\w.\-]/g, "_").slice(0, 128) || undefined,
        is_ocr: !!cfg.mineruOCR,
      }],
      model_version: cfg.mineruModel,
      language: cfg.mineruLanguage,
      enable_formula: !!cfg.mineruFormula,
      enable_table: !!cfg.mineruTable,
    };
    const body = await this._jsonRequest("request upload URL", `${base}/api/v4/file-urls/batch`, {
      method: "POST",
      headers: this._mineruHeaders(cfg, true),
      body: JSON.stringify(payload),
      signal,
    });
    if (String(body?.code) !== "0") throw this._mineruApiError("request upload URL", body);
    const batchID = body?.data?.batch_id;
    const uploadURL = body?.data?.file_urls?.[0];
    if (!batchID || !uploadURL) {
      throw new Error("MinerU request upload URL failed: unexpected response (missing batch_id/file_urls)");
    }
    return { batchID, uploadURL };
  },

  /** Step 2: PUT bytes to the presigned URL. No Content-Type, no Authorization. */
  async _mineruPut({ url, bytes, signal }) {
    let resp;
    try {
      resp = await fetch(url, { method: "PUT", body: bytes, signal });
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(`MinerU upload PDF failed: network error: ${e?.message || e}`);
    }
    if (!resp.ok) {
      throw new Error(`MinerU upload PDF failed: HTTP ${resp.status} ${await this._excerpt(resp)}`);
    }
  },

  /** Step 3: poll batch status until done. → the extract_result entry (state done). */
  async _mineruPoll({ base, cfg, batchID, status, signal }) {
    const url = `${base}/api/v4/extract-results/batch/${encodeURIComponent(batchID)}`;
    for (;;) {
      this._throwIfAborted(signal);
      const body = await this._jsonRequest("poll status", url, {
        method: "GET",
        headers: this._mineruHeaders(cfg, false),
        signal,
      });
      if (String(body?.code) !== "0") throw this._mineruApiError("poll status", body);
      const r = body?.data?.extract_result?.[0];
      if (r) {
        const state = r.state;
        const prog = r.extract_progress || {};
        const extra = { extractedPages: prog.extracted_pages, totalPages: prog.total_pages };
        if (state === "done") {
          if (!r.full_zip_url) throw new Error("MinerU poll status failed: state done but no full_zip_url");
          return r;
        }
        if (state === "failed") {
          throw new Error(`MinerU parsing failed: ${r.err_msg || "unknown error"}`);
        }
        if (state === "running" || state === "converting") {
          status("running", DeepRead.bilingual(
            state === "converting" ? "MinerU 格式转换中…" : "MinerU 解析中…",
            state === "converting" ? "MinerU converting…" : "MinerU parsing…"
          ), extra);
        }
        else {
          status("queued", DeepRead.bilingual("MinerU 排队中…", "Queued at MinerU…"), extra);
        }
      }
      else {
        status("queued", DeepRead.bilingual("MinerU 排队中…", "Queued at MinerU…"), {});
      }
      await this._sleep(this.POLL_INTERVAL_MS, signal);
    }
  },

  /**
   * Connection test without uploading: query the batch-result endpoint with a dummy id. A bad/expired token is
   * rejected by the auth layer (code A0202/A0211 or HTTP 401/403) before the id is looked up; any other answer
   * (e.g. "task not found") means the token was accepted. Costs no quota.
   */
  async _mineruTest(cfg) {
    const base = this._mineruBase();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    try {
      const resp = await fetch(`${base}/api/v4/extract-results/batch/00000000-0000-0000-0000-000000000000`, {
        headers: this._mineruHeaders(cfg, false),
        signal: ac.signal,
      });
      const text = await resp.text();
      let body = null;
      try {
        body = JSON.parse(text);
      }
      catch (e) { /* not JSON */ }
      const code = String(body?.code ?? "");
      if (code === "A0202" || code === "A0211" || resp.status === 401 || resp.status === 403) {
        const known = this.MINERU_ERRORS[code];
        return {
          ok: false,
          message: known ? DeepRead.bilingual(known[0], known[1])
            : DeepRead.bilingual("Token 无效", "Token rejected") + ` (HTTP ${resp.status})`,
        };
      }
      if (!body || resp.status >= 500) {
        return { ok: false, message: `HTTP ${resp.status} ${text.slice(0, 200)}` };
      }
      return { ok: true, message: DeepRead.bilingual("MinerU Token 有效", "MinerU token accepted") };
    }
    finally {
      clearTimeout(t);
    }
  },

  // ---- provider: self-hosted mineru-api ----------------------------------

  async _selfhostParse(ctx) {
    const { cfg, signal, status } = ctx;
    const timeout = this._deadline(signal);
    try {
      status("upload", DeepRead.bilingual("上传 PDF 至自建 MinerU…", "Uploading PDF to self-hosted MinerU…"));
      const bytes = await IOUtils.read(ctx.filePath);
      let name = PathUtils.filename(ctx.filePath) || "document.pdf";
      if (!/\.pdf$/i.test(name)) name += ".pdf";
      const form = this._selfhostForm(cfg, bytes, name);
      const headers = {};
      if (cfg.selfHostToken) headers.Authorization = `Bearer ${cfg.selfHostToken}`;
      status("running", DeepRead.bilingual("自建 MinerU 解析中（可能需要几分钟）…", "Self-hosted MinerU is parsing (may take minutes)…"));
      let resp;
      try {
        resp = await fetch(`${cfg.selfHostURL}/file_parse`, { method: "POST", headers, body: form, signal: timeout.signal });
      }
      catch (e) {
        if (e?.name === "AbortError") throw e;
        throw new Error(`Self-hosted parse request failed: network error: ${e?.message || e}`);
      }
      if (!resp.ok) {
        throw new Error(`Self-hosted parse request failed: HTTP ${resp.status} ${await this._excerpt(resp)}`);
      }
      status("download", DeepRead.bilingual("接收解析结果…", "Receiving result…"));
      let buf;
      try {
        buf = new Uint8Array(await resp.arrayBuffer());
      }
      catch (e) {
        if (e?.name === "AbortError") throw e;
        throw new Error(`Self-hosted parse download failed: ${e?.message || e}`);
      }
      status("extract", DeepRead.bilingual("解压解析结果…", "Extracting result…"));
      if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b) {
        await this._extractZip(buf, ctx.resultDir);
      }
      else {
        await this._writeJsonResult(buf, ctx.resultDir);
      }
    }
    catch (e) {
      throw this._normalizeAbort(e, signal, timeout);
    }
    finally {
      timeout.clear();
    }
  },

  _selfhostForm(cfg, bytes, name) {
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: "application/pdf" }), name);
    const fields = {
      backend: cfg.selfHostBackend || "pipeline",
      parse_method: "auto",
      return_md: "true",
      return_content_list: "true",
      return_images: "true",
      return_middle_json: "true",
      return_model_output: "false",
      response_format_zip: "true",
      formula_enable: String(!!cfg.mineruFormula),
      table_enable: String(!!cfg.mineruTable),
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return form;
  },

  /** JSON response form: { results: { <name>: { md_content, content_list, images: {file: dataURI|base64} } } } */
  async _writeJsonResult(buf, resultDir) {
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(buf));
    }
    catch (e) {
      throw new Error("Self-hosted parse failed: response is neither a zip nor JSON");
    }
    const first = Object.values(body?.results || {})[0];
    if (!first) {
      throw new Error(`Self-hosted parse failed: no results in response ${JSON.stringify(body).slice(0, 300)}`);
    }
    if (first.content_list !== undefined && first.content_list !== null) {
      const cl = typeof first.content_list === "string" ? first.content_list : JSON.stringify(first.content_list);
      await IOUtils.writeUTF8(PathUtils.join(resultDir, "content_list.json"), cl);
    }
    if (first.middle_json) {
      const layout=typeof first.middle_json==="string" ? first.middle_json : JSON.stringify(first.middle_json);
      await IOUtils.writeUTF8(PathUtils.join(resultDir,"layout.json"),layout);
    }
    await IOUtils.writeUTF8(PathUtils.join(resultDir, "full.md"), first.md_content || "");
    const images = first.images || {};
    const imgDir = PathUtils.join(resultDir, "images");
    await IOUtils.makeDirectory(imgDir, { createAncestors: true, ignoreExisting: true });
    for (const [fname, data] of Object.entries(images)) {
      const safe = String(fname).split(/[\\/]/).pop();
      if (!safe || safe === "." || safe === "..") continue;
      const b64 = String(data).replace(/^data:[^,]*,/, "");
      try {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        await IOUtils.write(PathUtils.join(imgDir, safe), arr);
      }
      catch (e) {
        DeepRead.log("skipping undecodable image", safe);
      }
    }
  },

  /** Reachability only: /docs (FastAPI Swagger) or /openapi.json. Docs may be disabled, so any HTTP answer < 500
   *  from /openapi.json or /docs counts as reachable; 401/403 is reported as an auth problem. */
  async _selfhostTest(cfg) {
    const headers = {};
    if (cfg.selfHostToken) headers.Authorization = `Bearer ${cfg.selfHostToken}`;
    let lastErr = "";
    for (const path of ["/openapi.json", "/docs", "/health"]) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      try {
        const resp = await fetch(cfg.selfHostURL + path, { headers, signal: ac.signal });
        if (resp.status === 401 || resp.status === 403) {
          return { ok: false, message: DeepRead.bilingual("服务拒绝访问，请检查 Token", "Access denied, check the token") + ` (HTTP ${resp.status})` };
        }
        if (resp.ok) {
          return { ok: true, message: DeepRead.bilingual("自建 MinerU 服务可访问", "Self-hosted MinerU is reachable") };
        }
        lastErr = `HTTP ${resp.status}`;
      }
      catch (e) {
        lastErr = String(e?.message || e);
      }
      finally {
        clearTimeout(t);
      }
    }
    return { ok: false, message: DeepRead.bilingual("无法连接自建服务：", "Cannot reach service: ") + lastErr };
  },

  // ---- shared: zip handling and result loading ---------------------------

  async _download(url, headers, signal, step) {
    let resp;
    try {
      resp = await fetch(url, { headers: headers || {}, signal });
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      // Some result CDNs work in Gecko's privileged HTTP channel after fetch
      // fails. Retry the same signed URL without credentials or cookies.
      if (!headers && /^https:\/\//i.test(url)) {
        return new Promise((resolve, reject) => {
          const req = new (Zotero.getMainWindow().XMLHttpRequest)({ mozAnon:true });
          const abort = () => req.abort();
          req.open("GET",url,true);
          // Some DNS and proxy routes drop the TLS handshake with the official
          // result CDN. Use Gecko's secure DNS for this retry on that host.
          if (/^https:\/\/cdn-mineru\.openxlab\.org\.cn\//i.test(url)) {
            req.channel?.setTRRMode(Components.interfaces.nsIRequest.TRR_ONLY_MODE);
          }
          req.responseType="arraybuffer";
          req.onload = () => req.status>=200 && req.status<300 ? resolve(new Uint8Array(req.response))
            : reject(new Error(`MinerU ${step} failed: HTTP ${req.status}`));
          req.onerror = () => reject(new Error(`MinerU ${step} failed: network error`));
          req.onabort = () => reject(this._abortError());
          req.onloadend = () => signal?.removeEventListener("abort",abort);
          this._throwIfAborted(signal);
          signal?.addEventListener("abort",abort,{once:true});
          req.send();
        });
      }
      throw new Error(`MinerU ${step} failed: network error: ${e?.message || e}`);
    }
    if (!resp.ok) throw new Error(`MinerU ${step} failed: HTTP ${resp.status} ${await this._excerpt(resp)}`);
    try {
      return new Uint8Array(await resp.arrayBuffer());
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(`MinerU ${step} failed while reading body: ${e?.message || e}`);
    }
  },

  /** Write zip bytes, extract with nsIZipReader, delete the zip, flatten wrapping folders. */
  async _extractZip(bytes, resultDir) {
    const zipPath = PathUtils.join(resultDir, "result.zip");
    await IOUtils.write(zipPath, bytes);
    const ZipReader = Components.Constructor("@mozilla.org/libjar/zip-reader;1", "nsIZipReader", "open");
    const reader = new ZipReader(Zotero.File.pathToFile(zipPath));
    try {
      const entries = [];
      const en = reader.findEntries(null);
      while (en.hasMore()) entries.push(en.getNext());
      for (const entry of entries) {
        const rel = this._safeRelPath(entry);
        if (rel === null) {
          throw new Error(`Extract result zip failed: unsafe path in archive: ${entry}`);
        }
        if (entry.endsWith("/") || !rel.length) continue; // directories are created implicitly
        const target = PathUtils.join(resultDir, ...rel);
        await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true, ignoreExisting: true });
        reader.extract(entry, Zotero.File.pathToFile(target));
      }
    }
    catch (e) {
      if (String(e?.message || e).startsWith("Extract result zip failed")) throw e;
      throw new Error(`Extract result zip failed: ${e?.message || e}`);
    }
    finally {
      try {
        reader.close();
      }
      catch (e) { /* ignore */ }
      try {
        await IOUtils.remove(zipPath, { ignoreAbsent: true });
      }
      catch (e) { /* ignore */ }
    }
    await this._flatten(resultDir);
  },

  /** → array of path segments, [] for empty, or null when unsafe (zip-slip, absolute, drive letters). */
  _safeRelPath(entry) {
    const s = String(entry);
    if (s.includes("\0") || s.includes("\\") || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
    const parts = s.split("/").filter(p => p && p !== ".");
    if (parts.includes("..")) return null;
    return parts;
  },

  async _flatten(dir) {
    for (let guard = 0; guard < 10; guard++) {
      const children = await IOUtils.getChildren(dir);
      if (children.length !== 1) return;
      const only = children[0];
      const st = await IOUtils.stat(only);
      if (st.type !== "directory") return;
      const tmp = PathUtils.join(dir, "__deepread_flat__");
      await IOUtils.move(only, tmp);
      for (const c of await IOUtils.getChildren(tmp)) {
        await IOUtils.move(c, PathUtils.join(dir, PathUtils.filename(c)));
      }
      await IOUtils.remove(tmp, { recursive: true });
    }
  },

  async _emptyDir(dir) {
    for (const c of await IOUtils.getChildren(dir)) {
      await IOUtils.remove(c, { recursive: true, ignoreAbsent: true });
    }
  },

  /** Recursively list files under dir (absolute paths). */
  async _listFiles(dir) {
    const out = [];
    for (const c of await IOUtils.getChildren(dir)) {
      const st = await IOUtils.stat(c);
      if (st.type === "directory") out.push(...await this._listFiles(c));
      else out.push(c);
    }
    return out;
  },

  /** Pick the content list file among paths: *_content_list.json (not _v2), else content_list.json. */
  _findContentList(files) {
    const base = p => PathUtils.filename(p);
    return files.find(p => base(p).endsWith("_content_list.json") && !base(p).endsWith("_v2.json"))
      || files.find(p => base(p) === "content_list.json")
      || null;
  },

  _findMarkdown(files) {
    const base = p => PathUtils.filename(p);
    return files.find(p => base(p) === "full.md") || files.find(p => /\.md$/i.test(base(p))) || null;
  },

  async _loadResults(resultDir) {
    const files = (await this._listFiles(resultDir)).sort((a, b) => a.length - b.length);
    const clPath = this._findContentList(files);
    if (!clPath) throw new Error("MinerU result has no content_list.json (parse produced no structured content)");
    let raw;
    try {
      raw = JSON.parse(await IOUtils.readUTF8(clPath));
      if (typeof raw === "string") raw = JSON.parse(raw);
    }
    catch (e) {
      throw new Error(`MinerU content list is not valid JSON: ${e?.message || e}`);
    }
    if (!Array.isArray(raw)) throw new Error("MinerU content list is not an array");
    const contentList = raw.map((item, index) => ({ id: index, ...item }));
    await this.enrichLayout(resultDir,contentList,files);
    const mdPath = this._findMarkdown(files);
    const markdown = mdPath ? await IOUtils.readUTF8(mdPath) : "";
    return { resultDir, contentList, markdown };
  },

  async enrichLayout(resultDir,contentList,files) {
    if (!resultDir || !contentList?.length) return;
    try {
      if (!files && !await IOUtils.exists(resultDir)) return;
      const paths=files || await this._listFiles(resultDir);
      const layout=paths.find(p=>/^(?:layout|.+_middle)\.json$/i.test(PathUtils.filename(p)));
      if (layout) DeepRead.ParallelVisual.attachLayout(contentList,JSON.parse(await IOUtils.readUTF8(layout)));
    } catch (error) { DeepRead.log("MinerU physical layout unavailable",String(error)); }
  },

  // ---- helpers -----------------------------------------------------------

  async _jsonRequest(step, url, init) {
    let resp;
    try {
      resp = await fetch(url, init);
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(`MinerU ${step} failed: network error: ${e?.message || e}`);
    }
    const text = await resp.text();
    let body = null;
    try {
      body = JSON.parse(text);
    }
    catch (e) { /* handled below */ }
    if (!resp.ok) {
      // API-level error codes sometimes come with a non-2xx status
      if (body && body.code !== undefined && String(body.code) !== "0") {
        const err = this._mineruApiError(step, body);
        err.status = resp.status;
        throw err;
      }
      const err = new Error(`MinerU ${step} failed: HTTP ${resp.status} ${text.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }
    if (!body) throw new Error(`MinerU ${step} failed: response is not JSON: ${text.slice(0, 200)}`);
    return body;
  },

  async _excerpt(resp) {
    try {
      return (await resp.text()).slice(0, 300);
    }
    catch (e) {
      return "";
    }
  },

  _abortError() {
    const e = new Error(DeepRead.bilingual("已取消", "Cancelled"));
    e.name = "AbortError";
    return e;
  },

  _throwIfAborted(signal) {
    if (signal?.aborted) throw this._abortError();
  },

  /** Combined signal: user's signal + overall timeout. */
  _deadline(signal) {
    const ac = new AbortController();
    const state = { timedOut: false };
    const t = setTimeout(() => {
      state.timedOut = true;
      ac.abort();
    }, this.TIMEOUT_MS);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ac.signal,
      get timedOut() {
        return state.timedOut;
      },
      clear() {
        clearTimeout(t);
        signal?.removeEventListener?.("abort", onAbort);
      },
    };
  },

  _normalizeAbort(e, userSignal, deadline) {
    if (e?.name === "AbortError" || deadline.signal.aborted) {
      if (deadline.timedOut && !userSignal?.aborted) {
        return new Error(DeepRead.bilingual("MinerU 解析超时（30 分钟）", "MinerU parsing timed out (30 min)"));
      }
      return this._abortError();
    }
    return e;
  },

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(this._abortError());
      const onAbort = () => {
        clearTimeout(t);
        reject(this._abortError());
      };
      const t = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  },
};
