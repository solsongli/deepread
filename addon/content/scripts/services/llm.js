/* OpenAI-compatible Chat Completions client. License: AGPL-3.0-or-later */
/* global DeepRead, fetch, AbortController, TextDecoder, setTimeout, clearTimeout */

DeepRead.LLM = (function () {
  const DEFAULT_TIMEOUT_MS = 240000;
  const MODES = ["json_schema", "json_object", "none"];
  // Session cache of downgraded json modes, keyed by "baseURL\nmodel".
  const modeCache = new Map();
  const unsupportedEffort = new Set();
  const unsupportedSubmission = new Set();

  function cfgOf(config) {
    return config || DeepRead.prefs.llmConfig();
  }

  function isConfigured(config) {
    const c = cfgOf(config) || {};
    return !!(String(c.baseURL || "").trim() && String(c.model || "").trim());
  }

  function abortError() {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return e;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      let onAbort;
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function effectiveMode(config) {
    const configured = MODES.includes(config.jsonMode) ? config.jsonMode : "json_object";
    const cached = modeCache.get(`${config.baseURL}\n${config.model}`);
    if (!cached) return configured;
    return MODES.indexOf(cached) > MODES.indexOf(configured) ? cached : configured;
  }

  function formatFor(mode, responseFormat) {
    if (!responseFormat || mode === "none") return undefined;
    if (mode === "json_object") return { type: "json_object" };
    return responseFormat;
  }

  function buildMessages(messages, system) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    if (system) list.unshift({ role: "system", content: system });
    return list;
  }

  function buildHeaders(config) {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    Object.assign(headers, config.extraHeaders || {});
    return headers;
  }

  function stripThink(text) {
    const s = String(text || "");
    const m = /^\s*<think>[\s\S]*?<\/think>\s*/.exec(s);
    return m ? s.slice(m[0].length) : s;
  }

  function contentToString(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => (typeof p === "string" ? p : (p && (p.type === "text" || p.text !== undefined) ? p.text || "" : "")))
        .join("");
    }
    return "";
  }

  async function makeError(response) {
    let body = "";
    try {
      body = await response.text();
    }
    catch (e) { /* ignore */ }
    const err = new Error(`LLM HTTP ${response.status} ${response.statusText || ""}: ${body.slice(0, 500)}`.replace(/ +:/, ":"));
    err.status = response.status;
    err.body = body;
    return err;
  }

  function retryAfterMs(response) {
    const raw = response.headers && response.headers.get && response.headers.get("retry-after");
    let ms = 1000;
    if (raw !== null && raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) ms = n * 1000;
      else {
        const d = Date.parse(raw);
        if (Number.isFinite(d)) ms = d - Date.now();
      }
    }
    return Math.max(0, Math.min(20000, ms));
  }

  /**
   * Core request with retry / downgrade handling.
   * `handle(response, ctx)` consumes a successful response and returns the result;
   * it runs while the timeout is still armed.
   */
  async function request({ body, config, signal, timeoutMs, responseFormat }, handle) {
    const url = `${config.baseURL}/chat/completions`;
    const headers = buildHeaders(config);
    const modelKey = `${config.baseURL}\n${config.model}`;
    const terminalTool = body.tool_choice?.type === "function" && !!responseFormat;
    let retryAsJSON = false;
    let mode = effectiveMode(config);
    let netRetries = 0;
    let rateRetries = 0;
    const netBackoff = [1000, 3000];

    for (;;) {
      if (signal && signal.aborted) throw abortError();
      const payload = Object.assign({}, body);
      if (terminalTool && (retryAsJSON || unsupportedSubmission.has(modelKey))) {
        delete payload.tools;
        delete payload.tool_choice;
      }
      // Named submission and JSON response formatting are alternative transports.
      const rf = terminalTool && payload.tool_choice ? undefined : formatFor(mode, responseFormat);
      if (unsupportedEffort.has(modelKey)) delete payload.reasoning_effort;
      if (rf) payload.response_format = rf;

      const controller = new AbortController();
      let timedOut = false;
      let timer = null;
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      let response;
      let failure = null;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (response.ok) {
          const result = await handle(response);
          cleanup();
          return result;
        }
        failure = await makeError(response);
      }
      catch (e) {
        cleanup();
        if (signal && signal.aborted) throw abortError();
        if (timedOut) {
          const te = new Error(`LLM request timeout after ${Math.round(timeoutMs / 1000)}s`);
          te.name = "TimeoutError";
          throw te;
        }
        if (e && e.status) throw e; // error raised by handler (e.g. in-stream error)
        failure = e instanceof Error ? e : new Error(String(e));
        failure.isNetwork = true;
      }
      cleanup();

      const status = failure.status;
      if ((status === 400 || status === 422) && payload.reasoning_effort &&
          /reasoning[ _-]?effort/i.test(failure.body || "")) {
        unsupportedEffort.add(modelKey);
        continue;
      }
      if (terminalTool && payload.tool_choice && (status === 400 || status === 422)) {
        retryAsJSON = true;
        if (/\btools?\b|tool[ _-]choice|function[ _-]call/i.test(failure.body || "")) {
          unsupportedSubmission.add(modelKey);
        }
        continue;
      }
      if ((status === 400 || status === 422) && rf
        && /response_format|json_schema|json_object/i.test(failure.body || "")) {
        const next = MODES[MODES.indexOf(mode) + 1];
        if (next) {
          mode = next;
          modeCache.set(`${config.baseURL}\n${config.model}`, mode);
          DeepRead.log(`LLM json mode downgraded to ${mode} for ${config.model}`);
          continue;
        }
      }
      if (status === 429 && rateRetries < 3) {
        rateRetries++;
        const wait = retryAfterMs(response);
        DeepRead.log(`LLM 429, retry ${rateRetries} in ${wait}ms`);
        await sleep(wait, signal);
        continue;
      }
      if ((failure.isNetwork || status >= 500) && netRetries < netBackoff.length) {
        const wait = netBackoff[netRetries++];
        DeepRead.log(`LLM ${status || "network error"}, retry ${netRetries} in ${wait}ms`);
        await sleep(wait, signal);
        continue;
      }
      if (failure.isNetwork) failure.message = `LLM network error: ${failure.message}`;
      throw failure;
    }
  }

  function baseBody(config, { messages, system, temperature, maxTokens, reasoningEffort, tools, toolChoice }, stream) {
    const body = {
      model: config.model,
      messages: buildMessages(messages, system),
      temperature: temperature !== undefined ? temperature : config.temperature,
      stream,
    };
    if (body.temperature === undefined) delete body.temperature;
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools?.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (reasoningEffort && /^(?:gpt-(?:5|6)(?:[-.]|$)|o[134](?:[-.]|$))/i.test(config.model)) {
      body.reasoning_effort = reasoningEffort;
      delete body.temperature;
    }
    return body;
  }

  async function complete(opts = {}) {
    const config = cfgOf(opts.config);
    const body = baseBody(config, opts, false);
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    return request({ body, config, signal: opts.signal, timeoutMs, responseFormat: opts.responseFormat }, async (response) => {
      const raw = await response.json();
      const message = raw && raw.choices && raw.choices[0] && raw.choices[0].message;
      const content = stripThink(contentToString(message && message.content));
      const result = { content, raw };
      if (raw && raw.usage) result.usage = raw.usage;
      return result;
    });
  }

  /** Visible text of a (possibly partial) stream, hiding a leading <think> block. */
  function visibleText(full) {
    const trimmed = full.replace(/^\s+/, "");
    const open = "<think>";
    if (trimmed.length < open.length) {
      if (open.startsWith(trimmed)) return { pending: true, text: "" };
      return { pending: false, text: full };
    }
    if (!trimmed.startsWith(open)) return { pending: false, text: full };
    const end = trimmed.indexOf("</think>");
    if (end < 0) return { pending: true, text: "" };
    return { pending: false, text: trimmed.slice(end + 8).replace(/^\s+/, "") };
  }

  async function stream(opts = {}) {
    const config = cfgOf(opts.config);
    const body = baseBody(config, opts, true);
    const onDelta = typeof opts.onDelta === "function" ? opts.onDelta : null;
    return request({ body, config, signal: opts.signal, timeoutMs: opts.timeoutMs || 0 }, async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let full = "";
      let emitted = "";
      let done = false;

      const emit = () => {
        const v = visibleText(full);
        if (v.pending) return;
        if (v.text.length > emitted.length && v.text.startsWith(emitted)) {
          const delta = v.text.slice(emitted.length);
          emitted = v.text;
          if (onDelta) onDelta(delta, emitted);
        }
      };

      const processEvent = (eventText) => {
        const dataLines = [];
        for (const line of eventText.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!dataLines.length) return;
        const data = dataLines.join("\n").trim();
        if (!data) return;
        if (data === "[DONE]") {
          done = true;
          return;
        }
        let json;
        try {
          json = JSON.parse(data);
        }
        catch (e) {
          return;
        }
        if (json && json.error) {
          const err = new Error(`LLM stream error: ${typeof json.error === "string" ? json.error : (json.error.message || JSON.stringify(json.error))}`);
          err.status = Number(json.error.code) || 500;
          throw err;
        }
        const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
        const piece = delta && contentToString(delta.content);
        if (piece) {
          full += piece;
          emit();
        }
      };

      const drain = (final) => {
        buffer = buffer.replace(/\r\n?/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const ev = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          processEvent(ev);
          if (done) return;
        }
        if (final && buffer.trim()) {
          processEvent(buffer);
          buffer = "";
        }
      };

      try {
        while (!done) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          drain(false);
        }
        if (!done) {
          buffer += decoder.decode();
          drain(true);
        }
      }
      finally {
        try {
          await reader.cancel();
        }
        catch (e) { /* ignore */ }
      }

      // Flush: if still pending (unclosed <think> or short prefix), expose the raw text.
      const v = visibleText(full);
      const finalText = v.pending ? full : v.text;
      if (finalText.length > emitted.length && finalText.startsWith(emitted)) {
        const delta = finalText.slice(emitted.length);
        emitted = finalText;
        if (onDelta) onDelta(delta, emitted);
      }
      return finalText;
    });
  }

  async function testConnection(config) {
    try {
      const c = cfgOf(config);
      if (!isConfigured(c)) return { ok: false, message: "Base URL and model are required" };
      const t0 = Date.now();
      const res = await complete({
        config: c,
        messages: [{ role: "user", content: "Reply with OK" }],
        maxTokens: 8,
        temperature: 0,
        timeoutMs: 30000,
      });
      const ms = Date.now() - t0;
      return { ok: true, message: `OK: ${c.model} (${ms} ms)${res.content ? ` - ${res.content.slice(0, 40)}` : ""}` };
    }
    catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  }

  return { complete, stream, testConnection, isConfigured, _modeCache: modeCache };
})();
