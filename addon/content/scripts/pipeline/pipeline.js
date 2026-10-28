/* DeepRead — reader-side AI pipeline: MinerU blocks + PDF.js chars -> paragraphs/sentences -> per-page LLM
 * summaries, key points and translations -> article summary / outline -> hierarchical data for the overlays.
 * Ported from Vibero (AGPL-3.0, a Zotero fork). License: AGPL-3.0-or-later
 *
 * The method bodies below (from setParseResultInSummaryManager on) are Vibero's, kept as close to the original as
 * possible. UI / login / credits code was dropped; the class constructor, shims (_l10n, _call_llm_api, _parsePDF,
 * progress/notification hooks, ...) and the public API (run, generateOutline, regenerateArticleSummary, loadState,
 * getState) are DeepRead's. See docs/PIPELINE_PORT.md.
 */
/* global DeepRead, Zotero */

DeepRead.Pipeline = class Pipeline {
  /**
   * @param {Object} opts
   * @param {Function} opts.getPdfApp  () => PDFViewerApplication of the reader's primary view
   * @param {Function} opts.llm        async ({ messages, responseFormat, maxTokens, temperature, signal }) => ({ content })
   * @param {Function} opts.parsePDF   async ({ excludedPageIndices, onStatus }) => ({ resultDir, contentList, markdown })
   * @param {Function} [opts.onProgress] ({ percent?, message? }) => void
   * @param {Function} [opts.notify]   (message, type) => void
   * @param {string} [opts.language]   key of DeepRead.PARSE_LANGUAGES for summaries / translations
   */
  constructor({
    getPdfApp,
    llm,
    parsePDF,
    onProgress,
    notify,
    language = "zh",
    paperTitle = "",
    concurrency = 8,
    filterAuthors = true,
    signal,
  } = {}) {
    this._getPdfApp = typeof getPdfApp === "function" ? getPdfApp : () => null;
    this._llm = llm;
    this._parsePDFFn = parsePDF;
    this._onProgress = typeof onProgress === "function" ? onProgress : null;
    this._notify = typeof notify === "function" ? notify : null;
    this._paperTitle = paperTitle || "";
    this._concurrency = Math.max(1, Number(concurrency) || 8);
    this._filterAuthors = filterAuthors !== false;
    this._signal = signal || null;

    this._summaryManager = new DeepRead.SummaryManager();
    this._state = {};
    this._readerRef = { current: null };
    this._llmPromptLanguage = language || "zh";
    this._lastMarkdown = "";

    // Fields read by the ported code
    this._reparsePageLanguageSampleCache = new Map();
    this._oneTimeSourceLanguageLocaleOverride = undefined;
    this._lastLoggedSentenceSegmenterLocale = undefined;
    this._sourceTextSegmenterLocale = undefined;
    this._pageLLMThrottleTail = null;
    this._pageLLMNextRequestSlotAt = 0;
    this._pageLLMLastRequestFireAt = undefined;
    this._flowAborted = false;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Shims replacing Vibero's Reader environment
  // ---------------------------------------------------------------------------------------------------------

  /** The ported code reads the PDF viewer through `this._primaryView._iframeWindow.PDFViewerApplication`. */
  get _primaryView() {
    const app = this._getPdfApp();
    // `_pages[i].originalPage.viewport` mirrors the reader's Page objects that the ported
    // geometry helpers read (served from the adapter's synchronous geometry cache).
    return { _iframeWindow: { PDFViewerApplication: app }, _pages: app?.pdfViewer?._pages || [] };
  }

  _updateState(patch) {
    Object.assign(this._state, patch || {});
  }

  _getCurrentLlmPromptLanguage() {
    return this._llmPromptLanguage;
  }

  _bilingual(zh, en) {
    return DeepRead.bilingual(zh, en);
  }

  /** Messages for Vibero's getLocalizedString() keys used by run() and friends. */
  _l10n(key, args = {}) {
    const B = (zh, en) => DeepRead.bilingual(zh, en);
    const table = {
      "reader-error-pdf-reader-not-ready": B("PDF 阅读器尚未就绪", "The PDF reader is not ready"),
      "reader-error-no-full-parse-data": B("没有可用的全文解析数据，请先执行 AI 解析", "No full-text parse data available. Run AI deep read first"),
      "reader-flow-starting": B("开始解析…", "Starting..."),
      "reader-flow-parsing-pdf-structure": B("正在解析 PDF 结构…", "Parsing PDF structure..."),
      "reader-flow-parse-complete-init": B("PDF 结构解析完成，正在初始化…", "PDF structure parsed, initializing..."),
      "reader-flow-parse-failed": B("PDF 解析失败", "PDF parsing failed"),
      "reader-flow-extracting-text": B("正在提取文本…", "Extracting text..."),
      "reader-flow-extracting-text-progress": B("正在提取文本（{current}/{total}）…", "Extracting text ({current}/{total})..."),
      "reader-flow-organizing-paragraphs": B("正在整理段落…", "Organizing paragraphs..."),
      "reader-flow-extracting-main-content": B("正在提取正文内容…", "Extracting main content..."),
      "reader-flow-filtering-headers-footers": B("正在过滤作者名单等非正文内容…", "Filtering author lists and other non-body content..."),
      "reader-flow-generating-article-summary": B("正在生成全文总结…", "Generating article summary..."),
      "reader-flow-article-summary-failed": B("全文总结生成失败，其余内容不受影响", "Article summary failed; the rest is unaffected"),
      "reader-flow-llm-request-failed": B("AI 总结与翻译失败：{error}", "AI summary and translation failed: {error}"),
      "reader-flow-building-hierarchy": B("正在构建层级结构…", "Building hierarchy..."),
      "reader-general-complete": B("完成", "Done"),
    };
    const template = table[key] ?? key;
    return String(template).replace(/\{(\w+)\}/g, (_, name) => (args && args[name] !== undefined ? args[name] : `{${name}}`));
  }

  _setFlowProgress(progress = {}) {
    if (!this._onProgress) return;
    try {
      this._onProgress({ percent: progress.percent, message: progress.message });
    }
    catch (e) {
      DeepRead.log("onProgress failed", String(e));
    }
  }

  _setFlowProgressMessage(message) {
    this._setFlowProgress({ message });
  }

  _scheduleClearFlowProgress() {}

  _buildAndRenderMindMapView() {}

  _renderMindMapEmptyState() {}

  _showNotification(message, type = "info") {
    if (this._notify) {
      try {
        this._notify(message, type);
      }
      catch (e) {
        DeepRead.log("notify failed", String(e));
      }
    }
  }

  async _showAPIErrorDialog() {
    this._showNotification(
      this._bilingual(
        "请求过于频繁（HTTP 429），已达到 API 并发/速率限制。请稍后重试，或在设置中降低并发数。",
        "Too many requests (HTTP 429): the API rate/concurrency limit was reached. Retry later or lower the concurrency in settings."
      ),
      "error"
    );
  }

  _checkFlowAborted() {
    if (this._signal && this._signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
  }

  async _readMarkdownFile() {
    return this._lastMarkdown || "";
  }

  /**
   * Vibero's `_parsePDF(optionsJson, onPoll)` shape on top of the injected parsePDF.
   * @returns {Promise<{success: true, pdfProcessResult: {resultDir, contentList}}|{success: false, error, message}>}
   */
  async _parsePDF(optionsJson = "", onPoll = null) {
    let excludedPageIndices = [];
    if (optionsJson) {
      try {
        const opts = typeof optionsJson === "string" ? JSON.parse(optionsJson) : optionsJson;
        if (Array.isArray(opts?.excludedPageIndices)) excludedPageIndices = opts.excludedPageIndices;
      }
      catch (e) {
        // ignore malformed options
      }
    }
    if (typeof this._parsePDFFn !== "function") {
      return { success: false, error: "parsePDF is not available", message: "parsePDF is not available" };
    }
    try {
      const result = await this._parsePDFFn({
        excludedPageIndices,
        onStatus: (status) => {
          if (typeof onPoll === "function") onPoll(status);
        },
      });
      this._lastMarkdown = result?.markdown || "";
      return { success: true, pdfProcessResult: { resultDir: result?.resultDir, contentList: result?.contentList || [] } };
    }
    catch (error) {
      if (error && error.name === "AbortError") throw error;
      const message = error?.message || String(error);
      return { success: false, error: message, message };
    }
  }

  /**
   * Same contract as Vibero's Zotero.pdfParser.llmRequest(prompt, options): JSON array -> array; JSON object ->
   * the raw content string; unparseable -> raw content; empty -> "". Errors propagate unchanged.
   */
  async _call_llm_api(prompt, options = undefined) {
    this._checkFlowAborted();
    const opts = options || {};
    const messages = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });
    const response = await this._llm({
      messages,
      responseFormat: opts.response_format,
      maxTokens: opts.max_tokens,
      temperature: opts.temperature,
      signal: this._signal || undefined,
    });
    const content = response?.content;
    if (!content) {
      console.warn('[pdfParser] LLM 响应为空，返回空字符串');
      return '';
    }
    const parsedResult = this._parseLLMResponse(content);
    if (parsedResult !== null) {
      if (Array.isArray(parsedResult)) {
        return parsedResult;
      } else if (typeof parsedResult === 'object') {
        return content;
      }
    }
    console.warn('[pdfParser] 无法解析 LLM 响应，返回原始内容');
    return content;
  }

  /** JSONUtils.parseJSON replacement: JSON.parse or null (no eval fallback). */
  _jsonParseOrNull(jsonString) {
    try {
      return JSON.parse(jsonString);
    }
    catch (e) {
      return null;
    }
  }

  /**
   * 解析 LLM 返回的 JSON 内容（支持对象和数组）
   * @param {string} content - LLM 返回的文本内容
   * @returns {Object|Array|null} 解析后的结果或 null
   */
  _parseLLMResponse(content) {
    if (!content) {
      return null;
    }
    let trimmed = content.trim();

    // 1. 尝试直接解析整个内容
    try {
      const directParsed = this._jsonParseOrNull(trimmed);
      if (directParsed !== null && typeof directParsed === 'object') {
        // console.log('[pdfParser] 直接解析成功');
        return directParsed;
      }
    }
    catch (error) {
      console.warn('[pdfParser] 直接解析失败，尝试提取 JSON:', error);
    }

    // 2. 尝试提取 JSON 对象（优先）
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = this._jsonParseOrNull(objectMatch[0]);
        if (parsed !== null && typeof parsed === 'object') {
          // console.log('[pdfParser] 提取 JSON 对象成功');
          return parsed;
        }
      }
      catch (error) {
        console.warn('[pdfParser] 提取的 JSON 对象解析失败，尝试修复:', error);
        // 尝试修复被截断或格式错误的 JSON
        try {
          const fixed = this._fixMalformedJSON(objectMatch[0]);
          const parsed = this._jsonParseOrNull(fixed);
          if (parsed !== null && typeof parsed === 'object') {
            console.warn('[pdfParser] ⚠️ JSON 格式错误，已通过修复恢复');
            return parsed;
          }
        } catch (fixError) {
          console.warn('[pdfParser] JSON 修复失败:', fixError);
        }
      }
    }

    // 3. 尝试提取 JSON 数组（兼容旧逻辑）
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = this._jsonParseOrNull(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          // console.log('[pdfParser] 提取 JSON 数组成功');
          return parsed;
        }
      }
      catch (error) {
        console.warn('[pdfParser] 提取的 JSON 数组解析失败，尝试修复:', error);
        // 尝试修复被截断或格式错误的 JSON
        try {
          const fixed = this._fixMalformedJSON(arrayMatch[0]);
          const parsed = this._jsonParseOrNull(fixed);
          if (Array.isArray(parsed)) {
            console.warn('[pdfParser] ⚠️ JSON 格式错误，已通过修复恢复');
            return parsed;
          }
        } catch (fixError) {
          console.warn('[pdfParser] JSON 修复失败:', fixError);
        }
      }
    }

    return null;
  }

  /**
   * 修复格式错误的 JSON（处理未闭合的字符串、缺失的括号等）
   * @param {string} json - 格式错误的 JSON 字符串
   * @returns {string} 修复后的 JSON 字符串
   */
  _fixMalformedJSON(json) {
    let fixed = json;

    // 1. 修复未闭合的字符串
    // 通过扫描找到最后一个未闭合的字符串
    let inString = false;
    let escaped = false;
    let lastStringStart = -1;

    for (let i = 0; i < fixed.length; i++) {
      const char = fixed[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        if (inString) {
          inString = false;
        } else {
          inString = true;
          lastStringStart = i;
        }
      }
    }

    // 如果最后还有未闭合的字符串，添加闭合引号
    if (inString) {
      fixed += '"';
    }

    // 2. 补全缺失的闭合符号
    let openBraces = (fixed.match(/\{/g) || []).length;
    let closeBraces = (fixed.match(/\}/g) || []).length;
    let openBrackets = (fixed.match(/\[/g) || []).length;
    let closeBrackets = (fixed.match(/\]/g) || []).length;

    while (closeBraces < openBraces) {
      fixed += '}';
      closeBraces++;
    }
    while (closeBrackets < openBrackets) {
      fixed += ']';
      closeBrackets++;
    }

    // 3. 移除末尾可能的逗号（JSON 不允许）
    fixed = fixed.replace(/,\s*([}\]])/, '$1');

    return fixed;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Ported Vibero methods (reader.js / pdfParser helpers)
  // ---------------------------------------------------------------------------------------------------------

  async setParseResultInSummaryManager(pdfProcessResult) {
    // 1. 保存 MinerU 解析结果
    const resultDir = pdfProcessResult.resultDir;
    this._summaryManager.setResultDir(resultDir);

    // 2. 读取目录中的 .md 全文 markdown 文件
    const fullMarkdown = await this._readMarkdownFile(resultDir);
    // console.log("[reader/reader.js] fullMarkdown: ", fullMarkdown);
    const pdfContentList = pdfProcessResult.contentList;
    // console.log('[reader/reader.js] setParseResultInSummaryManager - pdfContentList:', pdfContentList);

    // 保存 pdfContentList和markdown 到 SummaryManager（用于段落索引跳转）
    this._summaryManager.setPdfContentList(pdfContentList);
    this._summaryManager.setMarkdownContent(fullMarkdown);

    // 2. 提取简略版段落（包括索引序号、type、page_idx、内容）
    const simplifiedContentList = this._extractSimplifiedContentList(pdfContentList);
  }

  /**
   * 从 pdfContentList 提取简略版段落列表
   * @param {Array} pdfContentList - MinerU 解析的完整内容列表
   * @returns {Array} simplifiedContentList
   */
  _extractSimplifiedContentList(pdfContentList) {
    if (!pdfContentList || !Array.isArray(pdfContentList)) {
      return [];
    }
    const simplifiedContentList = [];

    // 遍历 pdfContentList，提取简略版段落
    for (let i = 0; i < pdfContentList.length; i++) {
      const item = pdfContentList[i];
      const mineruIndex = i; // 在 contentList 中的索引

      if (item.type === 'text') {
        // 文本块：保留 id, page_idx, text, type, text_level
        simplifiedContentList.push({
          mineruIndex: mineruIndex,
          type: item.text_level === 1 ? 'title' : 'text',
          page_idx: item.page_idx,
          content: item.text || ''
        });
      } else if (item.type === 'image') {
        // 图片块：简略版只保留 caption
        const imageCaption = item.image_caption && item.image_caption[0] || '';
        simplifiedContentList.push({
          mineruIndex: mineruIndex,
          type: 'image',
          page_idx: item.page_idx,
          content: imageCaption
        });
      } else if (item.type === 'table') {
        // 表格块：简略版只保留 caption
        const tableCaption = item.table_caption && item.table_caption[0] || '';
        simplifiedContentList.push({
          mineruIndex: mineruIndex,
          type: 'table',
          page_idx: item.page_idx,
          content: tableCaption
        });
      }
    }
    return simplifiedContentList;
  }

  processParagraphData(charsDataList) {
    // 对全局charsDataList拼接字符串、分段
    // charsDataList是扁平数组，每个char有offset（全局索引）和pageIndex属性
    let processedParagraphDataList = [];

    // 按页分组处理
    const pageGroups = new Map();
    for (let char of charsDataList) {
      if (!pageGroups.has(char.pageIndex)) {
        pageGroups.set(char.pageIndex, []);
      }
      pageGroups.get(char.pageIndex).push(char);
    }
    for (let [pageIndex, pageChars] of pageGroups) {
      // 拼接字符串并维护 charMapping（全局索引）
      let text = [];
      let charMapping = []; // charMapping[stringIndex] = globalOffset

      for (let char of pageChars) {
        text.push(char.u);
        for (let k = 0; k < char.u.length; k++) {
          charMapping.push(char.offset); // 使用全局offset
        }
        if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
          text.push(' ');
          charMapping.push(char.offset);
        }
      }
      let fullText = text.join('');

      // 按 paragraphBreakAfter 分段
      let paragraphs = [];
      let paragraphStartOffset = 0;
      for (let i = 0; i < pageChars.length; i++) {
        let char = pageChars[i];
        if (char.paragraphBreakAfter) {
          // 检查下一个字符的baseline差异和水平位置，判断是否真的是段落分隔
          let isRealParagraphBreak = true;

          // // 如果有下一个字符，检查baseline差异和水平位置
          // if (i + 1 < pageChars.length) {
          // 	let nextChar = pageChars[i + 1];
          // 	let baselineDiff = char.baseline - nextChar.baseline;

          // 	// 计算水平距离：当前字符右边界到下一字符左边界的距离
          // 	let horizontalGap = Math.abs(nextChar.rect[0] - char.rect[2]);

          // 	// 条件1：如果baseline差异小于10（包括负数情况），则不是真正的段落分隔
          // 	// 正常换段的baseline差异约为12，小于10说明不是换段
          // 	if (baselineDiff < 10) {
          // 		isRealParagraphBreak = false;

          // 		// 获取接下来的50个字符用于调试
          // 		let next50Chars = '';
          // 		for (let j = i + 1; j < Math.min(i + 51, pageChars.length); j++) {
          // 			next50Chars += pageChars[j].u;
          // 		}

          // 		console.log(`[processParagraphData] 过滤假段落分隔(baseline<10): baseline差异=${baselineDiff.toFixed(2)}, 当前字符='${char.u}', 下一字符='${nextChar.u}', 接下来50个字符='${next50Chars}'`);
          // 	}
          // 	// 条件2：即使baseline差异>=10，如果水平距离小于1，说明字符几乎相邻，也不是换段
          // 	else if (horizontalGap < 0.5) {
          // 		isRealParagraphBreak = false;

          // 		// 获取接下来的50个字符用于调试
          // 		let next50Chars = '';
          // 		for (let j = i + 1; j < Math.min(i + 51, pageChars.length); j++) {
          // 			next50Chars += pageChars[j].u;
          // 		}

          // 		console.log(`[processParagraphData] 过滤假段落分隔(水平相邻): baseline差异=${baselineDiff.toFixed(2)}, 水平间距=${horizontalGap.toFixed(2)}, 当前字符='${char.u}'(rect[2]=${char.rect[2].toFixed(2)}), 下一字符='${nextChar.u}'(rect[0]=${nextChar.rect[0].toFixed(2)}), 接下来50个字符='${next50Chars}'`);
          // 	}
          // }
          // 只有真正的段落分隔才进行分段
          if (isRealParagraphBreak) {
            // 找到当前字符在 charMapping 中的最后一个位置
            let paragraphEndOffset = charMapping.lastIndexOf(char.offset) + 1;

            // 提取段落文本
            let paragraphText = fullText.substring(paragraphStartOffset, paragraphEndOffset).trim();
            if (paragraphText.length > 0) {
              // 为该段落创建独立的 charMapping（全局索引）
              let paragraphCharMapping = charMapping.slice(paragraphStartOffset, paragraphEndOffset);

              // 从全局charsDataList获取字符对象
              let startGlobalIdx = paragraphCharMapping[0];
              let endGlobalIdx = paragraphCharMapping[paragraphCharMapping.length - 1];
              paragraphs.push({
                text: paragraphText,
                charMapping: paragraphCharMapping,
                startCharIndex: charsDataList[startGlobalIdx],
                endCharIndex: charsDataList[endGlobalIdx]
              });
            }
            paragraphStartOffset = paragraphEndOffset;
          }
        }
      }

      // 处理最后一段（如果有剩余文本）
      if (paragraphStartOffset < fullText.length) {
        let paragraphText = fullText.substring(paragraphStartOffset).trim();
        if (paragraphText.length > 0) {
          let paragraphCharMapping = charMapping.slice(paragraphStartOffset);
          let startGlobalIdx = paragraphCharMapping[0];
          let endGlobalIdx = paragraphCharMapping[paragraphCharMapping.length - 1];
          paragraphs.push({
            text: paragraphText,
            charMapping: paragraphCharMapping,
            startCharIndex: charsDataList[startGlobalIdx],
            endCharIndex: charsDataList[endGlobalIdx]
          });
        }
      }
      processedParagraphDataList.push({
        page_idx: pageIndex,
        paragraphs: paragraphs
      });
    }

    // 按页码排序
    processedParagraphDataList.sort((a, b) => a.page_idx - b.page_idx);
    return processedParagraphDataList;
  }

  async articleSummaryRequest(mainBlocks, pdfContentList = null) {
    // 将发送给LLM，生成基于block分组的层级化全文总结（增量重试机制）
    try {
      // console.log('[reader/reader.js] 🚀 开始生成block分组总结...');
      this._setFlowProgress({
        percent: 68,
        message: this._bilingual('构建文章结构（Article Summary）…', 'Building article structure (Article Summary)...')
      });

      // 1. 创建block映射关系，分离title和content的ID系统
      const blockMapping = this._createBlockMapping(mainBlocks);
      // console.log('[reader/reader.js] 📝 Block映射创建完成:', blockMapping);
      this._setFlowProgress({
        percent: 70,
        message: this._bilingual('准备输入数据…', 'Preparing input data...')
      });

      // 2. 准备发送给LLM的数据，同时更新blockMapping中的关联关系
      const {
        sections: llmInputData,
        updatedBlockMapping
      } = this._prepareDataForLLM(blockMapping);
      // console.log('[reader/reader.js] 📄 LLM输入数据准备完成:', llmInputData);
      // console.log('[reader/reader.js] 🔗 更新后的blockMapping:', updatedBlockMapping);

      // 2.5 ⭐ 检测 Introduction 章节末尾是否存在 contribution list
      const contributionList = pdfContentList ? this._extractContributionList(pdfContentList) : null;
      // if (contributionList) {
      // 	console.log('[reader/reader.js] 📋 检测到 Introduction 章节的 contribution list:', contributionList);
      // } else {
      // 	console.log('[reader/reader.js] 📋 未检测到 contribution list，将由 LLM 自行总结核心创新点');
      // }

      // 3. 请求 LLM（耗时最长；与逐页总结并行，勿把进度写在 await 之后否则长时间停在「准备输入数据」）
      this._setFlowProgressMessage(this._bilingual('生成全文总结 Article Summary…', 'Generating full Article Summary...'));
      const finalResult = await this._llmArticleSummaryRequest(llmInputData, updatedBlockMapping, contributionList);
      // console.log('[_llmArticleSummaryRequest] finalResult:', finalResult)

      this._summaryManager.setArticleSummary(finalResult.article_summary);
      this._summaryManager.setBlockMapping(finalResult.blockMapping);
      // 仅用文案更新：若逐页侧仍慢，bump 高 percent 会挡住逐页侧 71–89 的前进
      this._setFlowProgressMessage(this._bilingual('全文总结 Article Summary 已生成…', 'Full Article Summary generated...'));
      // 返回最终结果
      return finalResult;
    } catch (error) {
      console.error('[reader/reader.js] ❌ articleSummaryRequest失败:', error);
      throw error;
    }
  }

  /**
   * 从outline结构中提取叶子节点，并映射到原始sections数据
   * @param {Object} outline - LLM返回的层级结构
   * @param {Array} originalSections - _prepareDataForLLM生成的原始sections数据
   * @returns {Array} 需要生成summary的叶子节点sections
   */
  _parseOutline(outline, originalSections) {
    const leafNodes = [];

    /**
     * 递归遍历outline结构，提取叶子节点
     * @param {Object} node - 当前节点
     * @param {number} currentLevel - 当前层级深度
     */
    const traverse = (node, currentLevel = 0) => {
      // 数据验证
      if (!node || typeof node !== 'object') {
        console.warn('[parseOutline] 遇到无效节点:', node);
        return;
      }

      // 判断是否为叶子节点（没有children或children为空数组）
      const isLeafNode = !node.children || node.children.length === 0;
      if (isLeafNode) {
        // 找到叶子节点，获取对应的原始section数据
        const originalSection = originalSections.find((section) => section.title_block_id === node.title_block_id);
        if (originalSection && originalSection.blocks && originalSection.blocks.length > 0) {
          // 简化数据结构：只保留必要字段
          const leafNode = {
            title: node.title || originalSection.title,
            title_block_id: node.title_block_id,
            level: node.level || currentLevel,
            blocks: originalSection.blocks // 保留叶子标题下的原文blocks
          };
          leafNodes.push(leafNode);
        } else {
          console.warn(`[parseOutline] 跳过无内容的叶子节点: title_block_id ${node.title_block_id}`);
        }
      } else {
        // 非叶子节点，递归处理子节点
        if (Array.isArray(node.children)) {
          node.children.forEach((child) => {
            traverse(child, currentLevel + 1);
          });
        }
      }
    };

    // 开始遍历outline结构
    if (outline && typeof outline === 'object') {
      // console.log('[parseOutline] 开始遍历outline结构提取叶子节点');
      traverse(outline);
    } else {
      console.error('[parseOutline] 无效的outline结构:', outline);
    }
    return leafNodes;
  }

  /**
   * 将 Zotero PDF 原生的大纲书签转换为供 Vibe 面板使用的大纲树节点格式
   */
  _convertNativeOutlineToNodes(nativeItems, level = 1, indexPrefix = "native") {
    if (!nativeItems || !Array.isArray(nativeItems)) return [];
    return nativeItems.map((item, index) => {
      const currentPrefix = `${indexPrefix}_${index}`;
      return {
        title: item.title,
        location: item.location || (item.dest ? {
          dest: item.dest
        } : null),
        dest: item.dest,
        title_block_id: currentPrefix,
        // 伪造 ID，避免 React key 报错
        level: level,
        summary: '',
        // 原生书签没有 summary
        children: this._convertNativeOutlineToNodes(item.items, level + 1, currentPrefix)
      };
    });
  }

  /**
   * 将 Zotero/PDF 原生 outline 转为侧边栏可直接消费的 sections 根节点
   * 这样在解析前、解析中都可以直接显示原生大纲，而不用等 LLM 结果
   * @param {Array} nativeOutline
   * @returns {Object|null}
   */
  _buildNativeOutlineSections(nativeOutline) {
    if (!Array.isArray(nativeOutline) || nativeOutline.length === 0) {
      return null;
    }
    const titleParam = this._paperTitle || "Document Outline";
    return {
      title: titleParam,
      title_block_id: "native_root",
      level: 0,
      summary: "提取自原文原生书签索引",
      children: this._convertNativeOutlineToNodes(nativeOutline, 1)
    };
  }

  _getCachedLLMOutlineSections() {
    const sections = this._summaryManager?.getSections?.();
    if (!sections || sections.title_block_id === 'native_root') {
      return null;
    }
    return sections;
  }

  _getCurrentPDFPagesCount() {
    const pdfApp = this._primaryView?._iframeWindow?.PDFViewerApplication;
    return pdfApp?.pdfViewer?.pagesCount || pdfApp?.pdfDocument?.numPages || 0;
  }

  _buildFallbackContentListForArticleSummary() {
    const pdfContentList = this._summaryManager.getPdfContentList();
    if (Array.isArray(pdfContentList) && pdfContentList.length > 0) {
      return pdfContentList;
    }
    const blockMapping = this._summaryManager.getBlockMapping();
    if (Array.isArray(blockMapping?.title_blocks) || Array.isArray(blockMapping?.content_blocks)) {
      const contentList = [];
      for (const title of blockMapping.title_blocks || []) {
        if (!String(title?.title || '').trim()) continue;
        contentList.push({
          id: title.minerUid ?? title.title_block_id ?? contentList.length,
          type: 'text',
          text: title.title,
          text_level: 1,
          page_idx: title.page_idx ?? 0,
          bbox: title.bbox
        });
      }
      for (const block of blockMapping.content_blocks || []) {
        const text = block?.text || block?.paragraphText || block?.content || '';
        if (!String(text).trim()) continue;
        contentList.push({
          id: block.minerUid ?? block.block_id ?? contentList.length,
          type: block.type || 'text',
          text,
          text_level: 0,
          page_idx: block.page_idx ?? 0,
          bbox: block.bbox
        });
      }
      contentList.sort((a, b) => Number(a.id) - Number(b.id));
      if (contentList.length > 0) {
        return contentList;
      }
    }
    if (Array.isArray(blockMapping) && blockMapping.length > 0) {
      const contentList = [];
      for (const section of blockMapping) {
        if (section?.title) {
          contentList.push({
            id: section.minerUid ?? section.title_block_id ?? contentList.length,
            type: 'text',
            text: section.title,
            text_level: 1,
            page_idx: section.page_idx ?? 0
          });
        }
        for (const block of section?.blocks || []) {
          const text = block?.text || block?.paragraphText || block?.content || '';
          if (!String(text).trim()) continue;
          contentList.push({
            ...block,
            id: block.minerUid ?? block.block_id ?? contentList.length,
            type: block.type || 'text',
            text,
            page_idx: block.page_idx ?? section.page_idx ?? 0,
            text_level: block.text_level ?? 0
          });
        }
      }
      contentList.sort((a, b) => Number(a.id) - Number(b.id));
      if (contentList.length > 0) {
        return contentList;
      }
    }
    const hierarchicalData = this._summaryManager.getHierarchicalData();
    if (Array.isArray(hierarchicalData) && hierarchicalData.length > 0) {
      return hierarchicalData.flatMap((page) => (page.paragraphs || []).filter((paragraph) => String(paragraph?.paragraphText || '').trim()).map((paragraph) => ({
        id: paragraph.minerUid ?? `${page.pageIndex}_${paragraph.paragraphIndex}`,
        type: 'text',
        text: paragraph.paragraphText,
        page_idx: page.pageIndex,
        text_level: paragraph.paragraphType === 'title' ? 1 : 0
      })));
    }
    const markdown = this._summaryManager.getMarkdownContent();
    if (typeof markdown === 'string' && markdown.trim()) {
      return markdown.split(/\n{2,}/).map((text) => text.trim()).filter(Boolean).map((text, index) => ({
        id: `markdown_${index}`,
        type: 'text',
        text,
        page_idx: 0,
        text_level: /^#{1,3}\s+/.test(text) ? 1 : 0
      }));
    }
    return [];
  }

  async ensureBlockMappingForOutline() {
    const currentBlockMapping = this._summaryManager?.getBlockMapping?.();
    if (Array.isArray(currentBlockMapping) && currentBlockMapping.length > 0) {
      return currentBlockMapping;
    }
    if (!this._parsePDF) {
      throw new Error(this._bilingual('解析服务不可用，无法生成大纲', 'Parsing service unavailable. Unable to generate outline'));
    }
    const parseResult = await this._parsePDF('');
    if (!parseResult?.success) {
      const errorMsg = parseResult?.error || parseResult?.message || 'PDF 解析失败';
      throw new Error(errorMsg);
    }
    const pdfProcessResult = parseResult.pdfProcessResult;
    const pdfContentList = pdfProcessResult?.contentList;
    if (!Array.isArray(pdfContentList) || pdfContentList.length === 0) {
      throw new Error(this._bilingual('解析结果为空，无法生成大纲', 'Parsing result is empty. Unable to generate outline'));
    }
    await this.setParseResultInSummaryManager(pdfProcessResult);

    // 侧栏「生成大纲」专用路径：不再调用 filterAuthorListByLLM，避免多一次 LLM；全文 onflow 仍会在 _onFlowReparse 里过滤
    const mainBlocks = this.selectMainBlocks(pdfContentList);
    const blockMapping = this._createBlockMapping(mainBlocks);
    this._summaryManager.setBlockMapping(blockMapping);
    return blockMapping;
  }

  /**
   * onflow/缓存里存的是 _buildHierarchicalBlockMapping 的数组；轻量解析路径是 { title_blocks, content_blocks }
   */
  _isHierarchicalBlockMappingArray(bm) {
    if (!Array.isArray(bm) || bm.length === 0) {
      return false;
    }
    const first = bm[0];
    return !!(first && typeof first === 'object' && Array.isArray(first.blocks) && Object.prototype.hasOwnProperty.call(first, 'title_block_id'));
  }

  /** 层级化 blockMapping → _getOutline / _buildOutlinePrompt 所需的 sections 结构 */
  _hierarchicalBlockMappingToLLMInputSections(hierarchical) {
    return hierarchical.map((section) => ({
      title: section.title,
      title_block_id: section.title_block_id,
      blocks: (section.blocks || []).map((b) => ({
        block_id: b.block_id,
        type: b.type,
        text: b.text != null ? String(b.text) : ''
      }))
    }));
  }

  async prepareOutlineInputData() {
    const blockMapping = await this.ensureBlockMappingForOutline();
    // 已有全文解析：SummaryManager 里是层级数组，不能交给 _prepareDataForLLM（它需要 title_blocks/content_blocks）
    if (this._isHierarchicalBlockMappingArray(blockMapping)) {
      const llmInputData = this._hierarchicalBlockMappingToLLMInputSections(blockMapping);
      this._summaryManager.setBlockMapping(blockMapping);
      return {
        llmInputData,
        updatedBlockMapping: blockMapping
      };
    }
    if (!blockMapping || !Array.isArray(blockMapping.title_blocks) || !Array.isArray(blockMapping.content_blocks)) {
      throw new Error(this._bilingual('blockMapping 格式异常，无法生成大纲', 'Invalid blockMapping format. Unable to generate outline'));
    }
    const {
      sections: llmInputData,
      updatedBlockMapping
    } = this._prepareDataForLLM(blockMapping);
    this._summaryManager.setBlockMapping(updatedBlockMapping);
    return {
      llmInputData,
      updatedBlockMapping
    };
  }

  /**
   * 将生成的summary数据合并回outline结构中
   * @param {Object} outline - 原始outline结构
   * @param {Array} sectionsSummary - 包含oneword_summary和points的sections数据
   * @returns {Object} 合并后的完整outline结构
   */
  _mergeSections(outline, sectionsSummary) {
    // 创建一个映射，便于快速查找summary数据
    const summaryMap = new Map();
    sectionsSummary.forEach((section) => {
      // 确保 title_block_id 为字符串类型，统一数据格式
      const titleBlockId = String(section.title_block_id);
      summaryMap.set(titleBlockId, {
        points: section.points
      });
    });

    /**
     * 递归合并summary数据到outline节点
     * @param {Object} node - 当前outline节点
     * @returns {Object} 合并后的节点
     */
    const mergeNode = (node) => {
      if (!node || typeof node !== 'object') {
        return node;
      }
      const mergedNode = {
        ...node
      };

      // 如果是叶子节点，添加summary数据
      // 确保 title_block_id 为字符串类型，统一数据格式
      const titleBlockId = String(node.title_block_id);
      const summaryData = summaryMap.get(titleBlockId);
      if (summaryData) {
        mergedNode.points = summaryData.points;
        // console.log(`[mergeSummaryToOutline] 为叶子节点添加points: ${node.title} (title_block_id: ${titleBlockId})`);
      } else {



        // 调试信息：输出未匹配的节点
        // console.log(`[mergeSummaryToOutline] 未找到匹配的summary数据: ${node.title} (title_block_id: ${titleBlockId})`);
        // console.log(`[mergeSummaryToOutline] 可用的title_block_ids:`, Array.from(summaryMap.keys()));
      } // 递归处理子节点
      if (Array.isArray(node.children)) {mergedNode.children = node.children.map((child) => mergeNode(child));
      }
      return mergedNode;
    };

    // 开始合并
    const finalSections = mergeNode(outline);
    // console.log(`[mergeSummaryToOutline] 合并完成，outline层级保持完整`);

    return finalSections;
  }

  /**
   * 简化的LLM请求与校验 - 一次性处理所有sections
   */
  async _llmArticleSummaryRequest(llmInputData, updatedBlockMapping, contributionList = null) {
    // console.log('[reader/reader.js] 📚 _llmArticleSummaryRequest 开始，仅请求 article_summary');
    const articleSummaryResult = await this._getArticleSummary(llmInputData, contributionList);

    // 返回 article_summary 和 blockMapping；outline 改为侧栏按需生成
    return {
      article_summary: articleSummaryResult.article_summary,
      blockMapping: updatedBlockMapping
    };
  }

  /**
   * 增强的JSON解析方法，包含多种修复策略
   * @param {string} response - LLM返回的原始响应
   * @param {string} context - 调用上下文（用于日志）
   * @returns {Object} 解析后的JSON对象
   */
  _parseJSONWithRetry(response, context = 'unknown') {
    // 策略1: 直接解析
    try {
      return JSON.parse(response);
    } catch (error) {
      console.warn(`[Reader/${context}] 直接JSON解析失败:`, error.message);
    }

    // 策略2: 移除可能的markdown代码块标记
    try {
      let cleaned = response.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }
      return JSON.parse(cleaned);
    } catch (error) {
      console.warn(`[Reader/${context}] 移除markdown标记后解析失败:`, error.message);
    }

    // 策略3: 修复常见的引号问题
    try {
      // 修复未转义的引号
      const fixedQuotes = response.replace(/(?<!\\)"([^"]*)"([^"]*)"(?!\\)/g, '"$1\\"$2"');
      return JSON.parse(fixedQuotes);
    } catch (error) {
      console.warn(`[Reader/${context}] 修复引号后解析失败:`, error.message);
    }

    // 策略4: 修复换行符问题
    try {
      const fixedNewlines = response.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
      return JSON.parse(fixedNewlines);
    } catch (error) {
      console.warn(`[Reader/${context}] 修复换行符后解析失败:`, error.message);
    }

    // 策略5: 激进修复 - 处理格式错误的JSON（未闭合字符串、缺失括号等）
    try {
      let fixed = response.trim();

      // 5a. 修复未闭合的字符串（通过扫描找到最后一个未闭合的字符串）
      let inString = false;
      let escaped = false;
      for (let i = 0; i < fixed.length; i++) {
        const char = fixed[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          if (inString) {
            inString = false;
          } else {
            inString = true;
          }
        }
      }

      // 如果最后还有未闭合的字符串，添加闭合引号
      if (inString) {
        fixed += '"';
      }

      // 5b. 补全缺失的闭合符号
      let openBraces = (fixed.match(/\{/g) || []).length;
      let closeBraces = (fixed.match(/\}/g) || []).length;
      let openBrackets = (fixed.match(/\[/g) || []).length;
      let closeBrackets = (fixed.match(/\]/g) || []).length;
      while (closeBraces < openBraces) {
        fixed += '}';
        closeBraces++;
      }
      while (closeBrackets < openBrackets) {
        fixed += ']';
        closeBrackets++;
      }

      // 5c. 移除末尾可能的逗号
      fixed = fixed.replace(/,\s*([}\]])/, '$1');
      const parsed = JSON.parse(fixed);
      console.warn(`[Reader/${context}] ⚠️ JSON格式错误，已通过激进修复恢复`);
      return parsed;
    } catch (error) {
      console.warn(`[Reader/${context}] 激进修复后解析失败:`, error.message);
    }

    // 策略6: 清空 block_ids 后重试（长文 block_ids 过多导致 JSON 截断时的兜底）
    // block_ids 缺失会被 _validateAndFixArticleSummary 降级为 []，不影响核心内容
    try {
      // 匹配完整或截断的 block_ids 整数数组，替换为空数组
      let stripped = response.replace(/"block_ids"\s*:\s*\[\s*(?:\d+\s*,?\s*)*\]?/g, '"block_ids":[]');
      // 补全可能因截断丢失的闭合符号
      let openBraces = (stripped.match(/\{/g) || []).length;
      let closeBraces = (stripped.match(/\}/g) || []).length;
      let openBrackets = (stripped.match(/\[/g) || []).length;
      let closeBrackets = (stripped.match(/\]/g) || []).length;
      while (closeBraces < openBraces) {
        stripped += '}';
        closeBraces++;
      }
      while (closeBrackets < openBrackets) {
        stripped += ']';
        closeBrackets++;
      }
      return JSON.parse(stripped);
    } catch (error) {
      console.warn(`[Reader/${context}] 清空block_ids后解析失败:`, error.message);
    }

    // 策略7: 尝试提取JSON对象（处理前后有额外文本的情况）
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.warn(`[Reader/${context}] 提取JSON对象后解析失败:`, error.message);
    }

    // 策略8: 清空 block_ids + 提取JSON对象组合
    try {
      let stripped = response.replace(/"block_ids"\s*:\s*\[\s*(?:\d+\s*,?\s*)*\]?/g, '"block_ids":[]');
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.warn(`[Reader/${context}] 清空block_ids+提取JSON对象后解析失败:`, error.message);
    }

    // 所有策略都失败，记录详细错误信息
    console.error(`[Reader/${context}] ❌ 所有JSON修复策略都失败`);
    console.error(`[Reader/${context}] 原始响应长度: ${response.length}`);
    console.error(`[Reader/${context}] 响应前500字符:`, response.substring(0, 500));
    console.error(`[Reader/${context}] 响应后500字符:`, response.substring(Math.max(0, response.length - 500)));

    // 尝试找到具体的错误位置
    try {
      JSON.parse(response);
    } catch (finalError) {
      console.error(`[Reader/${context}] 最终错误详情:`, finalError);
      throw new Error(this._bilingual(`JSON解析失败: ${finalError.message}`, `JSON parse failed: ${finalError.message}`));
    }
  }

  /**
   * 轻量校验：保证侧栏 OutlineView 能渲染不崩（可 JSON 化、children 须为数组）
   * 通过后才扣 credits
   * @param {*} outline - _getOutline 返回的 outline 根节点
   */
  _validateLLMOutlinePayload(outline) {
    if (!outline || typeof outline !== 'object' || Array.isArray(outline)) {
      throw new Error(this._bilingual('大纲根节点无效', 'Invalid outline root node'));
    }
    try {
      JSON.parse(JSON.stringify(outline));
    } catch (e) {
      throw new Error(this._bilingual(`大纲无法序列化为 JSON: ${e.message}`, `Outline cannot be serialized to JSON: ${e.message}`));
    }
    const walk = (node, depth) => {
      if (depth > 100) {
        throw new Error(this._bilingual('大纲层级过深', 'Outline hierarchy is too deep'));
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new Error(this._bilingual('大纲子节点无效', 'Invalid outline child nodes'));
      }
      if (node.children != null && !Array.isArray(node.children)) {
        throw new Error(this._bilingual('大纲 children 须为数组', 'Outline children must be an array'));
      }
      const kids = node.children || [];
      for (const c of kids) {
        walk(c, depth + 1);
      }
    };
    walk(outline, 0);
  }

  /**
   * LLM 获取 outline（简单任务）
   * 仅在 Zotero/PDF 原生 outline 缺失时调用，避免与 GitHub 查找耦合
   * @param {Array} sections - 论文sections数据
   * @param {number} retryCount - 重试次数
   */
  async _getOutline(sections, retryCount = 0) {
    const MAX_RETRIES = 4;
    try {
      // 构建 outline 专用 prompt
      const llmPrompt = this._buildOutlinePrompt(sections);
      const outlineSchema = DeepRead.ResponseFormats.outlineOnlyFormat();

      // 添加5分钟超时检查
      const TIMEOUT_MS = 5 * 60 * 1000;
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('LLM request timed out after 5 minutes')), TIMEOUT_MS));
      const response = await Promise.race([this._call_llm_api(llmPrompt, {
        ...outlineSchema,
        max_tokens: 24800,
        system: this._buildSystemPrompt()
      }), timeoutPromise]);

      // 尝试解析JSON
      const parsedResult = this._parseJSONWithRetry(response, '_getOutline');
      return {
        outline: parsedResult.outline
      };
    } catch (error) {
      console.error(`[Reader] _getOutline失败 (尝试 ${retryCount + 1}/${MAX_RETRIES + 1}):`, error);

      // 如果还有重试次数，则重试
      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return this._getOutline(sections, retryCount + 1);
      }

      // 重试次数用尽，抛出错误
      console.error('[Reader] ❌ _getOutline 已达到最大重试次数，放弃请求');
      throw error;
    }
  }

  /**
   * LLM获取 article_summary（复杂任务）
   * 独立调用，与 outline/github_url 分离，互不影响
   * @param {Array} sections - 论文sections数据
   * @param {Object|null} contributionList - 从 Introduction 提取的 contribution list（如果存在）
   * @param {number} retryCount - 重试次数
   */
  async _getArticleSummary(sections, contributionList = null, retryCount = 0) {
    const MAX_RETRIES = 4;
    try {
      // 构建 article_summary 专用的 prompt
      const llmPrompt = this._buildArticleSummaryPrompt(sections, contributionList);
      const lang = DeepRead.PARSE_LANGUAGES[this._llmPromptLanguage] || DeepRead.PARSE_LANGUAGES['en'];
      const t = lang.summaryTitles;
      const articleSummarySchema = DeepRead.ResponseFormats.articleSummaryOnlyFormat([t.paperTitle, t.background, t.innovations, t.experiments, t.conclusions]);

      // 添加5分钟超时检查
      const TIMEOUT_MS = 5 * 60 * 1000;
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('LLM request timed out after 5 minutes')), TIMEOUT_MS));

      // Article Summary 含大量 block_ids 时 JSON 极长；需要足够的 max_tokens 避免截断
      // 根据错误日志，7681列被截断，增加到24800以确保完整性
      const response = await Promise.race([this._call_llm_api(llmPrompt, {
        ...articleSummarySchema,
        max_tokens: 24800,
        system: this._buildSystemPrompt()
      }), timeoutPromise]);

      // 尝试解析JSON
      const parsedResult = this._parseJSONWithRetry(response, '_getArticleSummary');

      // 宽容校验并修复 article_summary 格式
      const validationResult = this._validateAndFixArticleSummary(parsedResult.article_summary);
      if (validationResult.warnings.length > 0) {
        console.warn('[Reader] ⚠️ ArticleSummary 校验警告 (已尽力修复):', validationResult.warnings.join('; '));
      }
      return {
        article_summary: validationResult.fixedData
      };
    } catch (error) {
      console.error(`[Reader] _getArticleSummary失败 (尝试 ${retryCount + 1}/${MAX_RETRIES + 1}):`, error);

      // 如果还有重试次数，则重试
      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return this._getArticleSummary(sections, contributionList, retryCount + 1);
      }

      // 重试次数用尽，抛出错误
      console.error('[Reader] ❌ _getArticleSummary 已达到最大重试次数，放弃请求');
      throw error;
    }
  }

  /**
   * @deprecated 已拆分为 _getOutline 和 _getArticleSummary
   * 保留此函数用于向后兼容，但不再使用
   */
  async _getOutlineAndArticleSummary(sections, contributionList = null, retryCount = 0) {
    console.warn('[Reader] ⚠️ _getOutlineAndArticleSummary 已弃用，请使用 _getOutline 和 _getArticleSummary');
    // 串行调用两个新函数以保持兼容
    const {
      outline
    } = await this._getOutline(sections, retryCount);
    const {
      article_summary
    } = await this._getArticleSummary(sections, contributionList, retryCount);
    return {
      outline,
      article_summary
    };
  }

  /**
  /**
   * 宽容校验并修复 ArticleSummary 格式和内容，尽最大可能保留解析出的数据
   * @param {Array} articleSummary - article_summary 数组
   * @returns {Object} {fixedData: Array, warnings: string[]}
   */
  _validateAndFixArticleSummary(articleSummary) {
    const warnings = [];
    let fixedData = [];

    // 1. 检查是否为数组，不报错直接返回空数组重头构造
    if (!Array.isArray(articleSummary)) {
      warnings.push(this._bilingual('article_summary 必须是数组，已重置为空数组修复异常数据', 'article_summary must be an array. Reset to [] to recover invalid data'));
      articleSummary = [];
    }

    // 2. 根据语言设置选择必需的标题
    const langConfig = DeepRead.PARSE_LANGUAGES[this._llmPromptLanguage] || DeepRead.PARSE_LANGUAGES['en'];
    const titles = langConfig.summaryTitles;
    const requiredTitles = [titles.paperTitle, titles.background, titles.innovations, titles.experiments, titles.conclusions];

    // 将原有解析出来的数据建立 Map 以便通过 title 查询
    const actualItemsMap = new Map();
    for (const item of articleSummary) {
      if (item && item.title && typeof item.title === 'string') {
        actualItemsMap.set(item.title, item);
      }
    }

    // 3. 逐个验证和修复必须的标题
    for (const requiredTitle of requiredTitles) {
      let originalItem = actualItemsMap.get(requiredTitle);
      let fixedItem = {
        title: requiredTitle,
        content: '',
        points: []
      };
      if (!originalItem) {
        warnings.push(this._bilingual(`缺少必需的标题: ${requiredTitle} (自动填充空结构)`, `Missing required title: ${requiredTitle} (auto-filled with empty structure)`));
        originalItem = {};
      }

      // 需要 content 字段的标题
      const contentTitles = [titles.paperTitle, titles.background, titles.conclusions];
      // 需要 points 字段的标题
      const pointsTitles = [titles.innovations, titles.experiments];
      if (contentTitles.includes(requiredTitle)) {
        // 处理 content 类型标题
        if (originalItem.content && typeof originalItem.content === 'string' && originalItem.content.trim() !== '') {
          fixedItem.content = originalItem.content;
        } else {
          warnings.push(this._bilingual(`${requiredTitle} 的 content 字段无效，已自动填充提示语`, `Invalid content for ${requiredTitle}. Auto-filled fallback text`));
          fixedItem.content = this._bilingual('未提取到相关有效内容', 'No relevant content extracted');
        }
        // 为了兼容性，保留为空数组的 points
        fixedItem.points = [];
      } else if (pointsTitles.includes(requiredTitle)) {
        // 处理 points 类型标题
        fixedItem.content = originalItem.content || ""; // 可选

        if (Array.isArray(originalItem.points) && originalItem.points.length > 0) {
          for (let i = 0; i < originalItem.points.length; i++) {
            const point = originalItem.points[i];
            if (!point || typeof point !== 'object') continue;
            let fixedPoint = {
              point_title: this._bilingual('未提取标题', 'Untitled point'),
              content: this._bilingual('未提取内容', 'No content extracted'),
              block_ids: []
            };

            // 修复标题和内容
            if (point.point_title && typeof point.point_title === 'string' && point.point_title.trim() !== '') {
              fixedPoint.point_title = point.point_title;
            } else {
              warnings.push(this._bilingual(`${requiredTitle} 第 ${i + 1} 个 point 缺少 point_title，自动降级`, `${requiredTitle} point #${i + 1} is missing point_title; auto-degraded`));
            }
            if (point.content && typeof point.content === 'string' && point.content.trim() !== '') {
              fixedPoint.content = point.content;
            } else {
              warnings.push(this._bilingual(`${requiredTitle} 第 ${i + 1} 个 point 缺少 content，自动降级`, `${requiredTitle} point #${i + 1} is missing content; auto-degraded`));
            }

            // 修复和过滤 block_ids（去重后每点最多保留 20 个，与 schema / prompt 一致）
            const BLOCK_IDS_CAP = 20;
            if (Array.isArray(point.block_ids)) {
              const validBlockIds = [];
              for (const blockId of point.block_ids) {
                if (typeof blockId === 'number' || typeof blockId === 'string') {
                  const parsedId = parseInt(blockId, 10);
                  if (!isNaN(parsedId) && parsedId >= 0) {
                    validBlockIds.push(parsedId);
                  } else {
                    warnings.push(this._bilingual(`${requiredTitle} 第 ${i + 1} 个 point 移除无效 blockId: ${blockId}`, `${requiredTitle} point #${i + 1} removed invalid blockId: ${blockId}`));
                  }
                } else {
                  warnings.push(this._bilingual(`${requiredTitle} 第 ${i + 1} 个 point 移除无效 blockId 类型: ${typeof blockId}`, `${requiredTitle} point #${i + 1} removed invalid blockId type: ${typeof blockId}`));
                }
              }
              const seen = new Set();
              const uniqueIds = [];
              for (const id of validBlockIds) {
                if (!seen.has(id)) {
                  seen.add(id);
                  uniqueIds.push(id);
                }
              }
              if (uniqueIds.length > BLOCK_IDS_CAP) {
                warnings.push(this._bilingual(`${requiredTitle} 第 ${i + 1} 个 point 的 block_ids 共 ${uniqueIds.length} 个，已截断为前 ${BLOCK_IDS_CAP} 个`, `${requiredTitle} point #${i + 1} has ${uniqueIds.length} block_ids, truncated to ${BLOCK_IDS_CAP}`));
              }
              fixedPoint.block_ids = uniqueIds.slice(0, BLOCK_IDS_CAP);
            } else if (point.block_ids !== undefined && point.block_ids !== null) {
              warnings.push(this._bilingual(`${requiredTitle} 第 ${i + 1} 个 point 的 block_ids 必须为数组 (实际为 ${typeof point.block_ids})，忽略`, `${requiredTitle} point #${i + 1} block_ids must be an array (got ${typeof point.block_ids}); ignored`));
            }
            fixedItem.points.push(fixedPoint);
          }
        }

        // 防止 points 数组修出来为空
        if (fixedItem.points.length === 0) {
          warnings.push(this._bilingual(`${requiredTitle} points 无效，自动填充提示结构`, `${requiredTitle} points are invalid; auto-filled fallback structure`));
          fixedItem.points = [{
            point_title: this._bilingual('核心点解析失败', 'Failed to parse key points'),
            content: this._bilingual('未能从本文中提取有效的细节分层', 'Unable to extract valid hierarchical details from this paper'),
            block_ids: []
          }];
        }
      }
      fixedData.push(fixedItem);
    }
    return {
      fixedData: fixedData,
      warnings: warnings
    };
  }

  /**
   * 从 Introduction 章节末尾检测并提取 contribution list
   * 论文的 Introduction 最后一段通常会有分点总结 contribution
   * @param {Array} pdfContentList - MinerU 原始解析结果
   * @returns {Object|null} { list_items: [...], minerUid: xxx, page_idx: xxx } 或 null
   */
  _extractContributionList(pdfContentList) {
    if (!pdfContentList || !Array.isArray(pdfContentList)) {
      console.warn('[_extractContributionList] pdfContentList 无效');
      return null;
    }

    // 1. 找到 Introduction 章节的起止位置
    let introStartIndex = -1;
    let introEndIndex = -1;
    const introPattern = /^(\d+\.?\s*)?(introduction)\b/i;
    for (let i = 0; i < pdfContentList.length; i++) {
      const item = pdfContentList[i];

      // 检测是否为标题（text_level === 1）
      if (item.type === 'text' && item.text_level === 1) {
        const titleText = (item.text || '').trim();
        if (introStartIndex === -1 && introPattern.test(titleText)) {
          // 找到 Introduction 章节开始
          introStartIndex = i;
          // console.log(`[_extractContributionList] 找到 Introduction 章节开始: "${titleText}" at index ${i}`);
        } else if (introStartIndex !== -1 && introEndIndex === -1) {
          // 找到 Introduction 之后的下一个一级标题，即 Introduction 结束
          introEndIndex = i;
          // console.log(`[_extractContributionList] 找到 Introduction 章节结束: "${titleText}" at index ${i}`);
          break;
        }
      }
    }

    // 如果没找到 Introduction 章节
    if (introStartIndex === -1) {
      // console.log('[_extractContributionList] 未找到 Introduction 章节');
      return null;
    }

    // 如果没找到结束位置，使用整个文档剩余部分（但这种情况不太可能）
    if (introEndIndex === -1) {
      introEndIndex = pdfContentList.length;
    }

    // 2. 在 Introduction 范围内，从后往前找第一个 type === 'list' 且 sub_type === 'text' 的 block
    for (let i = introEndIndex - 1; i > introStartIndex; i--) {
      const item = pdfContentList[i];
      if (item.type === 'list' && item.sub_type === 'text') {
        // 找到了 list 类型的 block
        const listItems = item.list_items || [];

        // 3. 验证该 list 是否像 contribution（检查关键词）
        // 常见的 contribution 关键词
        const contributionKeywords = ['contribution', 'contributions', 'contribute', 'we propose', 'we present', 'we introduce', 'we develop', 'our main', 'our key', 'our primary', 'this paper', 'this work', 'in this paper', 'in this work', 'novel', 'new', 'first'];

        // 检查 list_items 中是否包含 contribution 相关关键词
        const listText = listItems.join(' ').toLowerCase();
        const hasContributionKeyword = contributionKeywords.some((keyword) => listText.includes(keyword.toLowerCase()));

        // 也检查 list 前面的段落是否提到 contribution
        let precedingTextHasContribution = false;
        if (i > introStartIndex) {
          // 检查前一个 block
          const prevItem = pdfContentList[i - 1];
          if (prevItem && prevItem.type === 'text' && prevItem.text) {
            const prevText = prevItem.text.toLowerCase();
            precedingTextHasContribution = contributionKeywords.some((keyword) => prevText.includes(keyword.toLowerCase()));
          }
        }

        // 如果 list 本身或前面的段落包含 contribution 关键词，认为这是 contribution list
        if (hasContributionKeyword || precedingTextHasContribution) {
          // console.log(`[_extractContributionList] ✅ 找到 contribution list，包含 ${listItems.length} 个点`);
          // console.log(`[_extractContributionList] list_items:`, listItems);

          return {
            list_items: listItems,
            minerUid: item.id,
            page_idx: item.page_idx,
            bbox: item.bbox
          };
        } else {

          // console.log(`[_extractContributionList] 找到 list 但不像 contribution list，继续向前搜索`);
        }}
    }

    // console.log('[_extractContributionList] Introduction 章节中未找到 contribution list');
    return null;
  }

  /**
   * 创建block映射关系，分离title和content的ID系统
   * @param {Array} mainBlocks - selectMainBlocks返回的结果
   * @returns {Object} { title_blocks, content_blocks }
   */
  _createBlockMapping(mainBlocks) {
    const title_blocks = [];
    const content_blocks = [];
    let title_block_id = 0;
    let block_id = 0;

    // 按顺序处理每个页面的blocks
    for (const pageData of mainBlocks) {
      for (const block of pageData.blocks) {
        if (block.type === 'title') {
          // 标题块：记录标题信息
          title_blocks.push({
            title_block_id: title_block_id++,
            minerUid: block.minerUid,
            title: block.text,
            page_idx: block.page_idx
          });
        } else {
          // 内容块：需要关联到最近的标题
          content_blocks.push({
            block_id: block_id++,
            minerUid: block.minerUid,
            text: block.text,
            type: block.type,
            page_idx: block.page_idx
          });
        }
      }
    }
    return {
      title_blocks,
      content_blocks
    };
  }

  /**
   * 准备发送给LLM的数据结构，同时更新blockMapping中的关联关系
   * @param {Object} blockMapping - _createBlockMapping返回的映射
   * @returns {Object} { sections: 发送给LLM的数据, updatedBlockMapping: 更新后的blockMapping }
   */
  _prepareDataForLLM(blockMapping) {
    const sections = [];
    const {
      title_blocks,
      content_blocks
    } = blockMapping;

    // 基于位置的智能分配：根据 minerUid 的原始顺序将 content_blocks 分配给对应的 title
    // 需要重建原始顺序，因为 _createBlockMapping 已经分离了 title 和 content

    // 1. 创建一个包含所有块的有序列表（按 minerUid 排序，保持原始文档顺序）
    const allBlocksOrdered = [];

    // 合并 title_blocks 和 content_blocks，标记类型
    title_blocks.forEach((tb) => {
      allBlocksOrdered.push({
        ...tb,
        blockType: 'title'
      });
    });
    content_blocks.forEach((cb) => {
      allBlocksOrdered.push({
        ...cb,
        blockType: 'content'
      });
    });

    // 按 minerUid 排序（minerUid 是 MinerU 的原始顺序 ID）
    allBlocksOrdered.sort((a, b) => a.minerUid - b.minerUid);

    // 2. 按顺序遍历，将 content blocks 分配给最近的前一个 title
    let currentSection = null;
    let beforeFirstTitle = []; // 第一个标题之前的内容（如 Abstract 正文）
    let currentTitleBlockId = null; // 当前标题的 title_block_id

    // 为blockMapping中的content_blocks添加title_block_id字段
    const updatedContentBlocks = content_blocks.map((cb) => ({
      ...cb,
      title_block_id: null // 初始化为null，将在遍历过程中分配
    }));

    // 创建一个映射，用于快速查找和更新content_blocks
    const contentBlockMap = new Map();
    updatedContentBlocks.forEach((cb) => {
      contentBlockMap.set(cb.block_id, cb);
    });
    for (const block of allBlocksOrdered) {
      if (block.blockType === 'title') {
        // 遇到新标题：保存当前 section（如果有），创建新 section
        if (currentSection) {
          sections.push(currentSection);
        }
        currentTitleBlockId = block.title_block_id;
        currentSection = {
          title: block.title,
          title_block_id: block.title_block_id,
          blocks: []
        };
      } else if (block.blockType === 'content') {
        // 内容块：分配给当前section，并更新blockMapping中的title_block_id
        if (currentSection) {
          // 添加到section
          currentSection.blocks.push({
            block_id: block.block_id,
            text: block.text,
            type: block.type
          });

          // 更新content_blocks中的title_block_id
          const contentBlockToUpdate = contentBlockMap.get(block.block_id);
          if (contentBlockToUpdate) {
            contentBlockToUpdate.title_block_id = currentTitleBlockId;
          }
        } else {
          // 第一个标题之前的内容
          beforeFirstTitle.push({
            block_id: block.block_id,
            text: block.text,
            type: block.type
          });

          // 第一个标题之前的内容没有关联的标题
          const contentBlockToUpdate = contentBlockMap.get(block.block_id);
          if (contentBlockToUpdate) {
            contentBlockToUpdate.title_block_id = null; // 标记为无标题
          }
        }
      }
    }

    // 3. 添加最后一个 section
    if (currentSection) {
      sections.push(currentSection);
    }

    // 4. 处理第一个标题之前的内容（如果有）
    if (beforeFirstTitle.length > 0) {
      console.warn('[_prepareDataForLLM] 发现第一个标题之前的内容，将其添加到第一个section:', beforeFirstTitle);
      if (sections.length > 0) {
        // 将这些内容添加到第一个 section 的开头
        sections[0].blocks = [...beforeFirstTitle, ...sections[0].blocks];
      } else {
        // 没有任何标题，创建一个默认 section
        sections.push({
          title: this._bilingual('文档内容', 'Document Content'),
          title_block_id: -1,
          blocks: beforeFirstTitle
        });
      }
    }

    // 5. 构建更新后的blockMapping - 使用类似llmInputData的嵌套结构，但保留所有原始数据
    const hierarchicalBlockMapping = this._buildHierarchicalBlockMapping(title_blocks, updatedContentBlocks);
    return {
      sections,
      updatedBlockMapping: hierarchicalBlockMapping
    };
  }

  /**
   * 构建层级化的blockMapping结构 - 类似llmInputData的嵌套结构，但保留所有原始数据
   * @param {Array} title_blocks - 标题块数组
   * @param {Array} content_blocks - 包含title_block_id关联的内容块数组
   * @returns {Array} 层级化的blockMapping数组
   */
  _buildHierarchicalBlockMapping(title_blocks, content_blocks) {
    // console.log('[_buildHierarchicalBlockMapping] 开始构建层级化blockMapping...');

    // 1. 创建title_block的映射，便于快速查找
    const titleBlockMap = new Map();
    title_blocks.forEach((tb) => {
      titleBlockMap.set(tb.title_block_id, {
        title_block_id: tb.title_block_id,
        minerUid: tb.minerUid,
        title: tb.title,
        page_idx: tb.page_idx,
        blocks: [] // 将在这里填充关联的内容块
      });
    });

    // 2. 将content_blocks分配到对应的title下
    const beforeFirstTitleContentBlocks = []; // 第一个标题之前的内容块

    content_blocks.forEach((cb) => {
      const contentBlockData = {
        block_id: cb.block_id,
        minerUid: cb.minerUid,
        text: cb.text,
        type: cb.type,
        page_idx: cb.page_idx,
        title_block_id: cb.title_block_id // 保留关联信息
      };
      if (cb.title_block_id !== null && cb.title_block_id !== undefined) {
        // 关联到对应的标题
        const titleBlock = titleBlockMap.get(cb.title_block_id);
        if (titleBlock) {
          titleBlock.blocks.push(contentBlockData);
        } else {
          console.warn(`[_buildHierarchicalBlockMapping] 找不到title_block_id ${cb.title_block_id}对应的标题块`);
        }
      } else {
        // 第一个标题之前的内容块
        beforeFirstTitleContentBlocks.push(contentBlockData);
      }
    });

    // 3. 构建最终的层级化数组
    let hierarchicalMapping = [];

    // 4. 处理第一个标题之前的内容（如果有）
    if (beforeFirstTitleContentBlocks.length > 0) {
      // console.log(`[_buildHierarchicalBlockMapping] 发现${beforeFirstTitleContentBlocks.length}个第一个标题之前的内容块`);
      hierarchicalMapping.push({
        title_block_id: -1,
        // 特殊ID表示第一个标题之前的内容
        title: this._bilingual('文档起始内容', 'Document Start Content'),
        page_idx: beforeFirstTitleContentBlocks[0]?.page_idx || 0,
        minerUid: beforeFirstTitleContentBlocks[0]?.minerUid || 0,
        blocks: beforeFirstTitleContentBlocks
      });
    }

    // 5. 按title_block_id排序添加标题块
    const sortedTitleBlocks = Array.from(titleBlockMap.values()).sort((a, b) => a.minerUid - b.minerUid);
    sortedTitleBlocks.forEach((titleBlock) => {
      // 对blocks按minerUid排序，保持原始顺序
      titleBlock.blocks.sort((a, b) => a.minerUid - b.minerUid);
      hierarchicalMapping.push(titleBlock);
    });
    return hierarchicalMapping;
  }

  _useChinesePrompt() {
    return this._llmPromptLanguage === 'zh' || this._llmPromptLanguage === 'zh-TW';
  }

  _buildSystemPrompt() {
    const lang = DeepRead.PARSE_LANGUAGES[this._llmPromptLanguage] || DeepRead.PARSE_LANGUAGES['en'];
    const base = this._useChinesePrompt() ? `你是一名专业的学术论文分析助手。请全程使用 ${lang.instruction} 回答。专有名词和通用缩写（例如 Transformer、BERT）可以保留英文。` : `You are a professional academic paper analysis assistant. Respond entirely in ${lang.instruction}. Proper nouns and widely-used abbreviations (e.g., Transformer, BERT) may remain in English.`;
    return lang.nativeInstruction ? `${base}\n${lang.nativeInstruction}` : base;
  }

  _buildOutlinePrompt(sections) {
    const lang = DeepRead.PARSE_LANGUAGES[this._llmPromptLanguage] || DeepRead.PARSE_LANGUAGES['en'];
    const taskDescription = this._useChinesePrompt() ? `请基于给定论文生成大纲结构。

### 大纲识别
从输入数据中提取标题。每个标题必须包含：title、title_block_id、level、children、summary：
- title 和 title_block_id 必须严格匹配输入数据，不能为空
- 准确判断层级关系，不要只依赖编号格式
- 子标题必须只出现在父标题的 children 数组中（例如 “3.1 xxx” 是 “3 xxx” 的子节点）
- 层级规则：论文主标题 = level 0；一级章节（Introduction、Abstract 等）= level 1；二级章节（3.1 xxx）= level 2；以此类推
- summary：用 ${lang.instruction} 写一句简洁章节摘要（20词或等量字数以内），不能为空

输出格式：
“outline”:
{
	“title”: “论文标题”,
	“title_block_id”: 0,
	“level”: 0,
	“summary”: “...”,
	“children”: [
	{
		“title”: “1 Introduction”,
		“title_block_id”: 2,
		“level”: 1,
		“summary”: “...”,
		“children”: [
		{
			“title”: “1.1 xxx”,
			“title_block_id”: 3,
			“level”: 2,
			“summary”: “...”,
			“children”: []
		}
		]
	}
	]
}

## 输入数据
论文 sections JSON 数据：` : `Based on the provided paper, generate the outline structure.

### Outline Recognition
Extract titles from input data. Each title must have: title, title_block_id, level, children, summary:
- title and title_block_id must strictly match input data, must not be empty
- Accurately determine hierarchy levels regardless of numbering
- Subtitles must only appear in parent's children array (e.g., “3.1 xxx” is a child of “3 xxx”)
- Level rules: paper main title = level 0; first-level sections (Introduction, Abstract, etc.) = level 1 inside main title's children; second-level (3.1 xxx) = level 2; and so on
- summary: one concise sentence in ${lang.instruction} summarizing the section (20 words or equivalent or less), must not be empty

Output format:
“outline”:
{
	“title”: “Paper Title”,
	“title_block_id”: 0,
	“level”: 0,
	“summary”: “...”,
	“children”: [
	{
		“title”: “1 Introduction”,
		“title_block_id”: 2,
		“level”: 1,
		“summary”: “...”,
		“children”: [
		{
			“title”: “1.1 xxx”,
			“title_block_id”: 3,
			“level”: 2,
			“summary”: “...”,
			“children”: []
		}
		]
	}
	]
	}

## Input Data
Paper sections JSON data:`;
    const sectionsData = sections.map((section) => ({
      title: section.title,
      title_block_id: section.title_block_id,
      blocks: section.blocks.map((block) => ({
        block_id: block.block_id,
        type: block.type,
        text: block.text
      }))
    }));
    const jsonData = JSON.stringify(sectionsData, null, 2);
    const jsonOutputInstructions = this._useChinesePrompt() ? `只返回包含 outline 字段的 JSON 对象。key 和字符串值必须使用英文双引号。不要返回解释、Markdown 代码块或其他文本。` : `Return only a JSON object with the outline field. Use double quotes for keys and values.`;
    return taskDescription + '\n\n' + jsonData + '\n\n' + jsonOutputInstructions;
  }

  _buildArticleSummaryPrompt(sections, contributionList = null) {
    const lang = DeepRead.PARSE_LANGUAGES[this._llmPromptLanguage] || DeepRead.PARSE_LANGUAGES['en'];
    const t = lang.summaryTitles;
    const useChinesePrompt = this._useChinesePrompt();
    const conciseRules = !useChinesePrompt ? `### Brevity rules for fast reading
- Write for fast scanning, not paragraph-style explanation.
- For “${t.background}” and “${t.conclusions}”: prefer 1-2 sentences, maximum 3 sentences.
- For each point under “${t.innovations}” and “${t.experiments}”: prefer 1-2 sentences, maximum 3 sentences.
- point_title should be compact: ideally 2-6 English words.
- Keep only the most decision-useful information: problem, method, result, value.
- Make each sentence focused. Avoid long chained clauses, repeated qualifiers, and unnecessary setup.` : `### 精炼规则（适合快速扫读）
- 以“卡片速读”风格写，不要写成长段解释。
- “${t.background}”和“${t.conclusions}”的content优先写1-2句，最多3句。
- “${t.innovations}”和“${t.experiments}”下每个点的content优先写1-2句，最多3句。
- point_title尽量短，优先控制在4-12字。
- 只保留最有判断价值的信息：问题、方法、结果、价值。
- 每句话尽量只表达一个核心信息，避免过长并列句、重复修饰和铺垫。
- 自然语言字段必须使用 ${lang.instruction}：content、points[].point_title、points[].content。专有名词、模型名、数据集名、指标名可以保留英文，但不能输出完整英文解释句。`;
    let coreInnovationInstruction;
    if (contributionList && contributionList.list_items && contributionList.list_items.length > 0) {
      const contributionItemsText = contributionList.list_items.map((item, idx) => `  ${idx + 1}. ${item}`).join('\n');
      coreInnovationInstruction = useChinesePrompt ? `- 在 **“${t.innovations}”** 下总结论文的核心贡献。
	**重要：Introduction 章节已经列出作者贡献。输出必须严格基于以下内容：**
${contributionItemsText}

	每个 point 包含 point_title、content、block_ids：
	**point_title**：创新点的短标题（使用 ${lang.instruction}）
	**content**：优先 1-2 句，最多 3 句（使用 ${lang.instruction}）。保持精炼、可读，并严格遵循上方贡献列表。
	**block_ids**：必须**全面收集**全文中与该创新相关的所有 block_ids。
		⚠️ **block_ids 要求（关键）**：
		- 一个创新通常会在**多个章节**出现，请遍历全文
		- Introduction：问题动机；Related Work：已有局限；Method：实现细节；Experiments：验证；Conclusion：总结；Figures/Tables：架构图或结果
		- 每个创新通常应有 **10+ 个 blocks**；若少于 5 个，请重新检查
		- block_ids 必须严格来自输入数据，禁止编造` : `- Under **”${t.innovations}”**, summarize the paper's key contributions.
	**Important: The Introduction section already lists the authors' contributions. Strictly base your output on:**
${contributionItemsText}

	Each point includes point_title, content, block_ids:
	**point_title**: A short name for the innovation (in ${lang.instruction})
	**content**: Prefer 1-2 sentences, maximum 3 sentences (in ${lang.instruction}). Keep it concise, readable, and strictly follow the contribution text above.
	**block_ids**: Must **comprehensively collect** all block_ids related to this innovation throughout the paper.
		⚠️ **block_ids requirements (critical)**:
		- An innovation is typically mentioned in **multiple sections** — traverse the full paper
		- Introduction: problem motivation; Related Work: prior limitations; Method: implementation; Experiments: validation; Conclusion: summary; Figures/Tables: architecture diagrams
		- Each innovation should typically have **10+ blocks**; recheck if fewer than 5
		- block_ids must strictly exist in the input data, never fabricate`;
    } else {
      coreInnovationInstruction = useChinesePrompt ? `- 在 **“${t.innovations}”** 下总结论文的核心贡献。每个 point 包含 point_title、content、block_ids：
	**point_title**：创新点的短标题（使用 ${lang.instruction}）
	**content**：优先 1-2 句，最多 3 句。保持精炼、可读。如果 Introduction 列出了贡献，请严格遵循；否则从全文总结
	**block_ids**：必须**全面收集**与该创新相关的所有 block_ids。
		⚠️ **block_ids 要求（关键）**：
		- 一个创新通常会在**多个章节**出现，请遍历全文
		- Introduction：问题动机；Related Work：已有局限；Method：实现细节；Experiments：验证；Conclusion：总结；Figures/Tables：架构图或结果
		- 每个创新通常应有 **10+ 个 blocks**；若少于 5 个，请重新检查
		- block_ids 必须严格来自输入数据，禁止编造` : `- Under **”${t.innovations}”**, summarize the paper's key contributions. Each point includes point_title, content, block_ids:
	**point_title**: A short name for the innovation (in ${lang.instruction})
	**content**: Prefer 1-2 sentences, maximum 3 sentences. Keep it concise and readable. If Introduction lists contributions, follow them strictly; otherwise summarize from full text
	**block_ids**: Must **comprehensively collect** all block_ids related to this innovation.
		⚠️ **block_ids requirements (critical)**:
		- An innovation is typically mentioned in **multiple sections** — traverse the full paper
		- Introduction: problem motivation; Related Work: prior limitations; Method: implementation; Experiments: validation; Conclusion: summary; Figures/Tables: architecture diagrams
		- Each innovation should typically have **10+ blocks**; recheck if fewer than 5
		- block_ids must strictly exist in the input data, never fabricate`;
    }
    const langRequirement = this._llmPromptLanguage === 'en' ? '' : useChinesePrompt ? `\n⚠️ 重要：所有自然语言字段必须使用 ${lang.instruction}，包括 content、points[].point_title、points[].content。不要用英文撰写摘要句子；英文只能用于必要的专有名词、模型名、数据集名和指标名。\n` : `\n⚠️ IMPORTANT: All content fields (background, innovations, experiments, conclusions) MUST be written in ${lang.instruction}. Do not write any summary content in English.\n`;
    const bgContentHint = !useChinesePrompt ? '(prefer 1-2 concise sentences on key problem and background; maximum 3 sentences)' : `（用 ${lang.instruction} 写 1-2 句精炼内容，说明核心问题和研究背景；最多 3 句）`;
    const pointContentHint = !useChinesePrompt ? '(prefer 1-2 concise sentences; maximum 3 sentences)' : `（用 ${lang.instruction} 写 1-2 句精炼内容；最多 3 句）`;
    const conclusionContentHint = !useChinesePrompt ? '(prefer 1-2 concise sentences on theoretical/practical value; maximum 3 sentences)' : `（用 ${lang.instruction} 写 1-2 句精炼内容，说明理论或实践价值；最多 3 句）`;
    const bgContentInstruction = useChinesePrompt ? `- 在 **“${t.background}”** 下：在 “content” 中写精炼背景（1-2 句，最多 3 句；使用 ${lang.instruction}）；“points” 设为 []。` : `- Under **”${t.background}”**: write a concise background in “content” (1-2 sentences, max 3; in ${lang.instruction}); set “points” to [].`;
    const conclusionContentInstruction = useChinesePrompt ? `- 在 **“${t.conclusions}”** 下：在 “content” 中写结论（1-2 句，最多 3 句；使用 ${lang.instruction}）；“points” 设为 []。` : `- Under **”${t.conclusions}”**: write the conclusion in “content” (1-2 sentences, max 3; in ${lang.instruction}); set “points” to [].`;
    const taskDescription = useChinesePrompt ? `请基于给定论文生成清晰、结构化的学术论文总结。不要返回 outline 或 github_url。
总结章节：${t.paperTitle}、${t.background}、${t.innovations}、${t.experiments}、${t.conclusions}
${langRequirement}
${conciseRules}

### block_ids 硬性上限
- **每个 point** 的 block_ids 最多包含 **20 个整数**。优先选择 **5-15** 个代表性 blocks。
- 如果覆盖范围很广，请拆成多个 points（每个 point 仍然 <= 20）。

${coreInnovationInstruction}
- 在 **“${t.experiments}”** 下总结所有实验（定量、定性、消融等；可按数据集拆分）。每个 point 包含 point_title、content、block_ids：
	**point_title**：简短实验名称（使用 ${lang.instruction}）
	**content**：优先 1-2 句，最多 3 句，只覆盖关键设置和核心结果（使用 ${lang.instruction}）
	**block_ids**：必须全面收集所有相关 block_ids（实验设置、baseline、结果表格/图、分析、消融）
		⚠️ 每个实验通常应有 **5+ 个 blocks**；若少于 3 个，请重新检查。block_ids 必须来自输入数据，禁止编造。

## 输出格式
JSON schema 要求每个 item 同时包含 “content”（字符串）和 “points”（数组）。请遵循：
- 对于 “${t.paperTitle}”：把真实论文标题放入 “content”；“points” 设为 []。
${bgContentInstruction}
${conclusionContentInstruction}
- 对于 “${t.innovations}”、“${t.experiments}”：把内容放入 “points”；“content” 设为 “”。

严格返回 JSON 格式：
{
	“article_summary”: [
		{
			“title”: “${t.paperTitle}”,
			“content”: “（真实论文标题）”,
			“points”: []
		},
		{
			“title”: “${t.background}”,
			“content”: “${bgContentHint}”,
			“points”: []
		},
		{
			“title”: “${t.innovations}”,
			“content”: “”,
			“points”: [{
				“point_title”: “...”,
				“content”: “${pointContentHint}”,
				“block_ids”: []
			},...]
		},
		{
			“title”: “${t.experiments}”,
			“content”: “”,
			“points”: [{
				“point_title”: “...”,
				“content”: “${pointContentHint}”,
				“block_ids”: []
			},...]
		},
		{
			“title”: “${t.conclusions}”,
			“content”: “${conclusionContentHint}”,
			“points”: []
		}
	]
}

## 输入数据
论文 sections JSON 数据：` : `Based on the provided paper, generate a clear and structured academic paper summary. Do not return outline or github_url.
Summary sections: ${t.paperTitle}, ${t.background}, ${t.innovations}, ${t.experiments}, ${t.conclusions}
${langRequirement}
${conciseRules}

### block_ids hard limit
- **Per point**, block_ids must contain **at most 20 integers**. Prefer **5–15** representative blocks.
- If coverage is broad, split into multiple points (each still ≤ 20).

${coreInnovationInstruction}
- Under **”${t.experiments}”**, summarize all experiments (quantitative, qualitative, ablation, etc.; split by dataset). Each point includes point_title, content, block_ids:
	**point_title**: Short experiment name (in ${lang.instruction})
	**content**: Prefer 1-2 sentences, maximum 3 sentences, covering only the key setup + result (in ${lang.instruction})
	**block_ids**: Must comprehensively collect all related block_ids (experiment setup, baselines, result tables/figures, analysis, ablation)
		⚠️ Each experiment should typically have **5+ blocks**; recheck if fewer than 3. block_ids must exist in input data, never fabricate.

## Output Format
The JSON schema requires every item to have both “content” (string) and “points” (array). Follow these rules:
- For “${t.paperTitle}”: put the actual paper title in “content”; set “points” to [].
${bgContentInstruction}
${conclusionContentInstruction}
- For “${t.innovations}”, “${t.experiments}”: put data in “points”; set “content” to “”.

Return strictly in JSON format:
{
	“article_summary”: [
		{
			“title”: “${t.paperTitle}”,
			“content”: “(the actual paper title text)”,
			“points”: []
		},
		{
			“title”: “${t.background}”,
			“content”: “${bgContentHint}”,
			“points”: []
		},
		{
			“title”: “${t.innovations}”,
			“content”: “”,
			“points”: [{
				“point_title”: “...”,
				“content”: “${pointContentHint}”,
				“block_ids”: []
			},...]
		},
		{
			“title”: “${t.experiments}”,
			“content”: “”,
			“points”: [{
				“point_title”: “...”,
				“content”: “${pointContentHint}”,
				“block_ids”: []
			},...]
		},
		{
			“title”: “${t.conclusions}”,
			“content”: “${conclusionContentHint}”,
			“points”: []
		}
	]
}

## Input Data
Paper sections JSON data:`;
    const sectionsData = sections.map((section) => ({
      title: section.title,
      title_block_id: section.title_block_id,
      blocks: section.blocks.map((block) => ({
        block_id: block.block_id,
        type: block.type,
        text: block.text
      }))
    }));
    const jsonData = JSON.stringify(sectionsData, null, 2);
    const jsonOutputInstructions = useChinesePrompt ? `只返回包含 article_summary 字段的 JSON 对象。key 和字符串值必须使用英文双引号。不要返回解释、Markdown 代码块或其他文本。` : `Return only a JSON object with article_summary field. Use double quotes for keys and values.`;
    return taskDescription + '\n\n' + jsonData + '\n\n' + jsonOutputInstructions;
  }

  /**
   * 构建英文版 sections points 的 prompt（用于 Gemini API）
   * @param {Array} sections - 论文章节数据
   * @returns {string} 英文版 prompt
   */
  _buildSectionsPointsPromptEN(sections) {
    const taskDescription = `You are a professional academic paper analysis assistant. Generate bullet points for each section:
- points: 1-4 key points, concise and clear, may use markdown for formulas

## Output Format
Return strictly in JSON format:
{
  "sections_points": [
    {
      "title_block_id": "xxx",
      "points": [
        "Point 1",
        "Point 2",
        "Point 3"
      ]
    }
  ]
}

## Input Data
Paper sections JSON data:`;
    const sectionsData = sections.map((section) => ({
      title: section.title,
      title_block_id: section.title_block_id,
      blocks: section.blocks.map((block) => ({
        block_id: block.block_id,
        type: block.type,
        text: block.text
      }))
    }));
    const jsonData = JSON.stringify(sectionsData, null, 2);
    const jsonOutputInstructions = `Return only a JSON object with sections_points field. Use double quotes for keys and values.`;
    return taskDescription + '\n\n' + jsonData + '\n\n' + jsonOutputInstructions;
  }

  /**
   * 构建新的articleSummary结构
   * @param {Object} llmResult - LLM返回的结果
   * @param {Object} blockMapping - block映射关系
   * @returns {Object} 新的articleSummary结构
   */
  _buildNewArticleSummary(llmResult, blockMapping) {
    // 处理新的树形sections结构
    const processSectionsTree = (sections) => {
      return sections.map((section) => {
        const titleBlock = blockMapping.title_blocks.find((t) => t.title_block_id === section.title_block_id);
        const result = {
          title: section.title,
          title_block_id: section.title_block_id,
          level: section.level,
          minerUid: titleBlock?.minerUid,
          children: []
        };

        // 只有叶子节点（无children）才有oneword_summary和points
        if (!section.children || section.children.length === 0) {
          if (section.oneword_summary && section.points) {
            const pointsText = section.points.filter((point) => point && typeof point === 'string').map((point) => point.trim()).filter((point) => point.length > 0).join('\n• ');
            result.summary = `##### ${section.oneword_summary}\n\n• ${pointsText}`;
          } else {
            result.summary = this._bilingual('摘要内容暂时不可用', 'Summary is temporarily unavailable');
          }
        } else {
          // 递归处理子sections
          result.children = processSectionsTree(section.children);
        }
        return result;
      });
    };
    const sections = processSectionsTree(llmResult.sections || []);

    // 兼容新格式：保持结构化数据格式
    let processedArticleSummary;
    if (Array.isArray(llmResult.article_summary)) {
      // 新格式：保持原始结构化数组，不转换为markdown
      processedArticleSummary = llmResult.article_summary;
    } else {
      // 旧格式：直接使用字符串
      processedArticleSummary = llmResult.article_summary;
    }
    return {
      articleSummary: processedArticleSummary,
      // 保持结构化数据
      sections: sections,
      // 保持向后兼容
      blockMapping: blockMapping
    };
  }

  /**
   * 更新传统数据结构以保持兼容性
   * @param {Object} llmResult - LLM返回的结果
   * @param {Object} blockMapping - block映射关系
   */
  _updateLegacyDataStructures(llmResult, blockMapping) {
    // 如果需要，可以在这里更新一些现有的数据结构以保持向后兼容
    // 目前主要数据都通过SummaryManager管理，这里暂时留空
    // console.log('[reader/reader.js] 📝 更新传统数据结构以保持兼容性');
    // 标记参数为有意不使用
    void llmResult;
    void blockMapping;
  }

  selectMainBlocks(pdfContentList) {
    // 从MinerU返回结果中抽取正文段落
    // 规则：type === 'text' && text_level !== 1 && 在第一个章节标题之后

    if (!pdfContentList || !Array.isArray(pdfContentList)) {
      console.warn('[selectMainBlocks] ❌ pdfContentList无效，返回空数组');
      return [];
    }
    let firstSectionTitleIndex = -1; // 第一个章节标题的索引（跳过论文标题）
    let titleCount = 0; // 遇到的标题数量计数器
    let referencesStartIndex = -1;
    let referencesEndIndex = pdfContentList.length;
    const referencesPattern = /^(\d+\.?\s*)?(references?|reference[s]?)\b[:\s\-]*/i;

    // 第一步：识别关键section位置
    for (let i = 0; i < pdfContentList.length; i++) {
      let item = pdfContentList[i];

      // 遇到标题时计数（text_level === 1 表示这是一个标题）
      if (item.type === 'text' && item.text_level === 1) {
        titleCount++;
        // 第2个标题（跳过论文标题）作为正文开始的分界点
        if (firstSectionTitleIndex === -1 && titleCount === 2) {
          firstSectionTitleIndex = i;
          // console.log(`[selectMainBlocks] 找到第一个章节标题: "${item.text}" at index ${i}`);
        }
      }

      // References 识别逻辑
      if (referencesStartIndex === -1) {
        if (item.text && typeof item.text === 'string' && item.text_level === 1 && referencesPattern.test(item.text.trim())) {
          referencesStartIndex = i;
          // console.log(`[selectMainBlocks] 🔍 找到 References 开始: index=${i}, page=${item.page_idx}, text="${item.text}"`);
        }
      } else if (referencesEndIndex === pdfContentList.length && i > referencesStartIndex && item.text_level === 1) {
        // 关键：添加 referencesEndIndex === pdfContentList.length 条件，确保只在第一次遇到标题时更新
        referencesEndIndex = i;
        // console.log(`[selectMainBlocks] 🔍 References 结束于: index=${i}, page=${item.page_idx}, text="${item.text}", text_level=${item.text_level}`);
      }
    }

    // 输出 References 识别结果
    // console.log(`[selectMainBlocks] References 识别完成: startIndex=${referencesStartIndex}, endIndex=${referencesEndIndex}, 总长度=${pdfContentList.length}`);

    // 如果没找到第一个章节标题，从头开始处理
    if (firstSectionTitleIndex === -1) {
      console.warn('[selectMainBlocks] 未找到第一个章节标题，从索引0开始处理');
      firstSectionTitleIndex = 0;
    }

    // 1. 筛选正文文本块
    let mainTextBlocks = [];
    let beforeFirstSectionStats = {
      processed: 0,
      included: 0,
      excluded: 0
    };
    let afterFirstSectionStats = {
      processed: 0,
      included: 0,
      excluded: 0
    };

    // 从索引0开始处理
    let startIndex = 0;
    for (let i = startIndex; i < pdfContentList.length; i++) {
      let item = pdfContentList[i];

      // 统计处理情况
      const isBeforeFirstSection = i < firstSectionTitleIndex;
      let stats = isBeforeFirstSection ? beforeFirstSectionStats : afterFirstSectionStats;
      stats.processed++;

      // 在第一个章节标题之前，只包含：text且text_level=1（论文标题）、image、table
      // ⚠️ 已注释：不再过滤第一个章节标题之前的普通文本段落
      // if (i < firstSectionTitleIndex) {
      // 	if (!((item.type === 'text' && item.text_level === 1) ||
      // 		  item.type === 'image' ||
      // 		  item.type === 'table')) {
      // 		stats.excluded++;
      // 		continue;
      // 	}
      // 	stats.included++;
      // } else {
      // 	// 第一个章节标题之后的处理
      // 	if (referencesStartIndex !== -1 && i >= referencesStartIndex && i < referencesEndIndex) {
      // 		stats.excluded++;
      // 		continue;
      // 	}
      // 	stats.included++;
      // }

      // 只排除 References 章节，保留所有其他内容（包括第一个章节标题之前的普通文本）
      if (referencesStartIndex !== -1 && i >= referencesStartIndex && i < referencesEndIndex) {
        stats.excluded++;
        continue;
      }
      stats.included++;

      // 根据规则选择文本、标题、图片与表格
      if (item.type === 'text') {
        if (item.text_level === 1) {
          mainTextBlocks.push({
            minerUid: item.id,
            page_idx: item.page_idx,
            text: item.text,
            type: 'title',
            bbox: item.bbox // 保留 bbox 信息
          });
        } else if (item.text_level !== 1) {
          mainTextBlocks.push({
            minerUid: item.id,
            page_idx: item.page_idx,
            text: item.text,
            type: 'text',
            bbox: item.bbox // 保留 bbox 信息
          });
        }
      } else if (item.type === 'equation') {
        mainTextBlocks.push({
          minerUid: item.id,
          page_idx: item.page_idx,
          text: item.text || '',
          type: 'equation',
          specialType: 'equation',
          // 标记为特殊类型，用于后处理
          bbox: item.bbox // 保留 bbox 信息
        });
      } else if (item.type === 'list' && item.sub_type === 'text') {
        // list且非ref_list
        const listText = item.list_items && Array.isArray(item.list_items) ? item.list_items.join('\n') // 将列表的分点合成一条字符串
        : item.text || '';
        mainTextBlocks.push({
          minerUid: item.id,
          page_idx: item.page_idx,
          text: listText,
          type: 'list',
          bbox: item.bbox // 保留 bbox 信息
        });
      } else if (['image', 'chart', 'figure'].includes(item.type)) {
        item = { ...item, image_caption: item.image_caption || item.chart_caption || item.caption || [] };
        if (typeof item.image_caption === 'string') item.image_caption = [item.image_caption];
        // 选择文本长度最长的 image_caption
        let longestCaption = '';
        if (item.image_caption && Array.isArray(item.image_caption)) {
          longestCaption = item.image_caption.reduce((longest, current) => {
            return current && current.length > longest.length ? current : longest;
          }, '');
        }
        mainTextBlocks.push({
          minerUid: item.id,
          page_idx: item.page_idx,
          text: longestCaption,
          type: 'image',
          bbox: item.bbox,
          // 保留 bbox 信息
          img_path: item.img_path || '',
          img_caption: longestCaption
        });
      } else if (item.type === 'table') {
        // 从 table_caption 和 table_footnote 中选择最长的文本
        let longestCaption = '';
        let longestFootnote = '';

        // 处理 table_caption（可能是数组）
        if (item.table_caption && Array.isArray(item.table_caption)) {
          longestCaption = item.table_caption.reduce((longest, current) => {
            return current && current.length > longest.length ? current : longest;
          }, '');
        } else if (item.table_caption && typeof item.table_caption === 'string') {
          longestCaption = item.table_caption;
        }

        // 处理 table_footnote（可能是数组）
        if (item.table_footnote && Array.isArray(item.table_footnote)) {
          longestFootnote = item.table_footnote.reduce((longest, current) => {
            return current && current.length > longest.length ? current : longest;
          }, '');
        } else if (item.table_footnote && typeof item.table_footnote === 'string') {
          longestFootnote = item.table_footnote;
        }

        // 选择 caption 和 footnote 中最长的作为 text
        const selectedText = longestCaption.length >= longestFootnote.length ? longestCaption : longestFootnote;
        mainTextBlocks.push({
          minerUid: item.id,
          page_idx: item.page_idx,
          text: selectedText,
          type: 'table',
          bbox: item.bbox,
          // 保留 bbox 信息
          table_body: item.table_body || '',
          table_caption: longestCaption,
          table_footnote: longestFootnote,
          img_path: item.img_path || ''
        });
      } else if (item.type === 'code') {
        mainTextBlocks.push({
          minerUid: item.id,
          page_idx: item.page_idx,
          text: item.code_body || '',
          type: 'code',
          bbox: item.bbox // 保留 bbox 信息
        });
      } else {

        // console.warn(`[selectMainBlocks] ⚠️ [${i}] 未知类型block，跳过: ${item.type}`);
      }}

    // 2. 处理 list/equation 与前一个 text 的合并（在MinerU层级，无需依赖原文匹配）
    const finalBlocks = this._mergeListBlocks(mainTextBlocks);

    // 按页面组织
    let pageMap = new Map();
    for (let block of finalBlocks) {
      if (!pageMap.has(block.page_idx)) {
        pageMap.set(block.page_idx, []);
      }
      pageMap.get(block.page_idx).push(block);
    }

    // 转换为数组格式
    let result = [];
    for (let [page_idx, blocks] of pageMap) {
      result.push({
        page_idx: page_idx,
        blocks: blocks
      });
    }

    // 按页码排序
    result.sort((a, b) => a.page_idx - b.page_idx);
    return result;
  }

  /**
   * 🎯 使用 LLM 智能过滤前2页的作者名单
   * @param {Array} mainBlocks - selectMainBlocks 返回的结果（按页分组）
   * @returns {Array} 过滤后的 mainBlocks
   */
  async filterAuthorListByLLM(mainBlocks) {
    // console.log('[filterAuthorListByLLM] 开始智能过滤，原始数量:', mainBlocks.length);

    if (mainBlocks.length === 0) return mainBlocks;

    // 只处理前2页的数据
    const firstTwoPages = mainBlocks.filter((pageData) => pageData.page_idx <= 1);
    if (firstTwoPages.length === 0) {
      // console.log('[filterAuthorListByLLM] 前2页没有数据，跳过过滤');
      return mainBlocks;
    }

    // 展开所有 blocks，并记录它们的来源
    const allBlocks = [];
    const blockToPageMap = new Map(); // block -> pageData 的映射

    for (const pageData of firstTwoPages) {
      if (pageData.blocks && Array.isArray(pageData.blocks)) {
        for (const block of pageData.blocks) {
          allBlocks.push(block);
          blockToPageMap.set(block, pageData);
        }
      }
    }
    if (allBlocks.length === 0) {
      // console.log('[filterAuthorListByLLM] 前2页没有 blocks，跳过过滤');
      return mainBlocks;
    }

    // console.log(`[filterAuthorListByLLM] 前2页共有 ${allBlocks.length} 个 blocks`);

    // 构建段落摘要（只取前150字符）
    const blockSummaries = allBlocks.map((block, idx) => {
      const preview = block.text ? block.text.substring(0, 150).replace(/\n/g, ' ') : '';
      return {
        index: idx,
        page: block.page_idx,
        type: block.type,
        preview: preview
      };
    });
    // 构建 prompt
    const prompt = this._buildAuthorFilterPrompt(blockSummaries);
    try {
      // 作者过滤仅用 json_object：百炼 qwen-plus-latest 等对 strict json_schema（含 uniqueItems）易报 STOP_WITH_INVALID_PARAMS
      // Prompt 已要求返回 JSON 数组；_parseFilterResponse 支持数组 / { indices } / 字符串
      const response = await this._call_llm_api(prompt, {
        response_format: {
          type: 'json_object'
        }
      });

      // 解析需要过滤的索引
      const indicesToFilter = this._parseFilterResponse(response);
      // console.log('[filterAuthorListByLLM] 解析后需要过滤的索引:', indicesToFilter);

      if (indicesToFilter.length === 0) {
        return mainBlocks;
      }

      // 构建需要过滤的 block 的 Set（用于快速查找）
      const blocksToFilter = new Set();
      indicesToFilter.forEach((idx) => {
        if (idx >= 0 && idx < allBlocks.length) {
          blocksToFilter.add(allBlocks[idx]);
        }
      });

      // 过滤 mainBlocks：遍历每个页面，过滤其中的 blocks
      const filtered = mainBlocks.map((pageData) => {
        if (pageData.page_idx > 1) {
          // 第3页及以后，不过滤
          return pageData;
        }

        // 前2页，过滤 blocks
        const filteredBlocks = pageData.blocks.filter((block) => {
          if (blocksToFilter.has(block)) {
            // console.log(`[filterAuthorListByLLM] 过滤元数据: 页${block.page_idx} "${block.text?.substring(0, 50)}..."`);
            return false;
          }
          return true;
        });
        return {
          ...pageData,
          blocks: filteredBlocks
        };
      }).filter((pageData) => pageData.blocks.length > 0); // 移除空页面

      const totalBlocksBefore = mainBlocks.reduce((sum, p) => sum + p.blocks.length, 0);
      const totalBlocksAfter = filtered.reduce((sum, p) => sum + p.blocks.length, 0);
      // console.log(`[filterAuthorListByLLM] 过滤完成，原始: ${totalBlocksBefore} blocks, 剩余: ${totalBlocksAfter} blocks, 过滤: ${totalBlocksBefore - totalBlocksAfter} blocks`);
      return filtered;
    } catch (error) {
      console.error('[filterAuthorListByLLM] LLM 调用失败，跳过过滤:', error);
      // 降级策略：LLM 失败时返回原始数据
      return mainBlocks;
    }
  }

  /**
   * 构建作者名单过滤 Prompt
   */
  _buildAuthorFilterPrompt(blockSummaries) {
    const language = this._llmPromptLanguage || 'zh';
    if (language === 'zh') {
      return `你是一个学术论文内容清洗助手。请分析以下段落列表（来自论文前2页），识别出需要**过滤的非正文元数据段落**。

需要过滤的内容特征（Metadata to Filter）：
1. **作者信息**：作者姓名、所属机构、地址、邮箱、上标标记等。
2. **分类与索引**：JEL Classification codes, PACS codes, MSC codes, Keywords（关键词列表）。
3. **出版信息**：期刊名称、卷号、年份、DOI、页码、出版社名称（如 Elsevier, Springer）。
4. **版权声明**：Copyright © statements, "All rights reserved"。
5. **文章历史**：Received date, Revised date, Accepted date, Available online date。
6. **页眉页脚**：包含期刊名、会议名、网址的页眉或页脚内容。
7. **其他标识**：Check for updates, Open Access 标识等。

**请务必保留：**
- **论文主标题** (Title)
- **摘要正文** (Abstract content)
- **正文第一章标题及内容** (如 "1. Introduction" ...)

段落列表：
${JSON.stringify(blockSummaries, null, 2)}

请返回需要**过滤**（即删除）的段落索引（index）列表，格式为 JSON 数组：
[0, 1, 3, 5]

只返回 JSON 数组，不要其他解释。如果没有需要过滤的段落，返回空数组 []`;
    } else {
      return `You are an academic paper content cleaning assistant. Analyze the following paragraph list (from the first 2 pages) and identify **non-content metadata paragraphs** that should be filtered out.

Metadata to Filter (Filter these out):
1. **Author Information**: Author names, affiliations, addresses, emails, superscript markers.
2. **Classification & Indexing**: JEL Classification codes, PACS codes, MSC codes, Keywords lists.
3. **Publication Info**: Journal names, volume/issue, year, DOI, page numbers, publisher names (e.g., Elsevier, Springer).
4. **Copyright**: Copyright © statements, "All rights reserved".
5. **Article History**: Received date, Revised date, Accepted date, Available online date.
6. **Headers/Footers**: Journal/Conference names, URLs in headers or footers.
7. **Other Identifiers**: Check for updates, Open Access badges, etc.

**Existing Content to KEEP (Do NOT filter):**
- **Paper Main Title**
- **Abstract Content**
- **Main Section Titles & Content** (e.g., "1. Introduction" ...)

Paragraph list:
${JSON.stringify(blockSummaries, null, 2)}

Return the indices (index) of paragraphs to **filter out** (delete) as a JSON array:
[0, 1, 3, 5]

Return only the JSON array, no other explanation. If nothing to filter, return empty array []`;
    }
  }

  /**
   * 解析 LLM 返回的过滤索引
   */
  _parseFilterResponse(response) {
    try {
      // 如果已经是数组，直接返回
      if (Array.isArray(response)) {
        return response.filter((idx) => typeof idx === 'number');
      }

      // 如果是带 indices 字段的对象，优先使用该字段
      if (response && typeof response === 'object' && Array.isArray(response.indices)) {
        return response.indices.filter((idx) => typeof idx === 'number');
      }

      // 如果是字符串，提取 JSON 数组
      if (typeof response === 'string') {
        // 移除可能的 markdown 代码块标记
        let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // 优先尝试解析 json_schema 形式的对象响应
        try {
          const parsedObject = JSON.parse(cleaned);
          if (parsedObject && typeof parsedObject === 'object' && Array.isArray(parsedObject.indices)) {
            return parsedObject.indices.filter((idx) => typeof idx === 'number');
          }
        } catch (e) {

          // 继续尝试兼容旧的纯数组格式
        }
        // 提取第一个 JSON 数组
        const match = cleaned.match(/\[[\d,\s]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          return Array.isArray(parsed) ? parsed.filter((idx) => typeof idx === 'number') : [];
        }

        // 尝试直接解析
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed.filter((idx) => typeof idx === 'number') : [];
      }
      console.warn('[parseFilterResponse] 无法解析响应，返回空数组');
      return [];
    } catch (error) {
      console.error('[parseFilterResponse] 解析失败:', error);
      return [];
    }
  }

  /**
   * 将MinerU的bbox坐标（千分比‰，左上右下）转换为PDF坐标（左下右上）
   * @param {Array} mineruBbox - MinerU bbox [x0, y0, x1, y1] (千分比‰，左上右下)
   * @param {number} pageIndex - 页面索引
   * @returns {Array} PDF坐标 [x1, y1, x2, y2] (左下右上)
   */
  _convertMinerUBboxToPdfCoords(mineruBbox, pageIndex) {
    const [x0_permille, y0_permille, x1_permille, y1_permille] = mineruBbox;
    let originalViewBox = null;
    let viewBox = null;
    let extendedWidth, extendedHeight, originalPDFWidth, originalPDFHeight;
    try {
      const pdfViewer = this._primaryView._iframeWindow.PDFViewerApplication.pdfViewer;
      const pageView = pdfViewer.getPageView(pageIndex);
      originalViewBox = pageView.viewport.originalViewBox;
      viewBox = pageView.viewport.viewBox;
    } catch (error) {
      console.warn(`[_convertMinerUBboxToPdfCoords] 无法从PDF文档获取页面${pageIndex}的viewport:`, error);
    }

    // 计算扩展后的viewBox尺寸
    extendedWidth = viewBox[2] - viewBox[0];
    extendedHeight = viewBox[3] - viewBox[1];

    // MinerU bbox基于原始PDF尺寸
    originalPDFWidth = originalViewBox[2] - originalViewBox[0];
    originalPDFHeight = originalViewBox[3] - originalViewBox[1];

    // 将千分比转换为原始PDF坐标系
    // DeepRead: include the view box origin (cropped pages do not start at 0,0).
    const originX = originalViewBox[0] || 0;
    const originY = originalViewBox[1] || 0;
    const x0_original = originX + x0_permille / 1000 * originalPDFWidth;
    const x1_original = originX + x1_permille / 1000 * originalPDFWidth;
    const y0_original = originY + (1 - y0_permille / 1000) * originalPDFHeight;
    const y1_original = originY + (1 - y1_permille / 1000) * originalPDFHeight;

    // 🔄 坐标系转换：MinerU(左上右下) → PDF(左下右上)
    // MinerU: y0在上边界, y1在下边界
    // PDF: y1在下边界, y2在上边界 (Y轴向上)
    // ✅ 正确的Y轴翻转：基于原始PDF高度
    const pdfBbox = [x0_original,
    // 左边界不变
    y1_original,
    // MinerU下边界 → PDF下边界（Y轴向上）
    x1_original,
    // 右边界不变
    y0_original // MinerU上边界 → PDF上边界
    ];
    return pdfBbox;
  }

  /**
   * 检查字符中心点是否在目标bbox内
   * @param {Array} charRect - 字符矩形 [x1, y1, x2, y2] (PDF坐标，左下右上)
   * @param {Array} targetBbox - 目标bbox [x1, y1, x2, y2] (PDF坐标，左下右上)
   * @returns {boolean} 字符中心点是否在bbox内
   */
  _isCharInBbox(charRect, targetBbox) {
    const [charX1, charY1, charX2, charY2] = charRect;
    const [bboxX1, bboxY1, bboxX2, bboxY2] = targetBbox;

    // 计算字符中心点
    const centerX = (charX1 + charX2) / 2;
    const centerY = (charY1 + charY2) / 2;

    // 中心点必须在 bbox 内
    return centerX >= bboxX1 && centerX <= bboxX2 && centerY >= bboxY1 && centerY <= bboxY2;
  }

  /**
   * 从字符数组提取格式化文本（保持段落、行、词结构）
   * 同时构建与 processParagraphData 一致的 charMapping
   * @param {Array} chars - 字符数组
   * @returns {Object} { text: string, charMapping: Array }
   */
  _extractFormattedText(chars) {
    if (!chars || chars.length === 0) {
      return {
        text: '',
        charMapping: []
      };
    }
    let text = [];
    let charMapping = []; // 与 processParagraphData 一致的映射方式

    for (let char of chars) {
      // 跳过忽略的字符
      if (char.ignorable) {
        continue;
      }

      // 添加字符内容（char.c 可能是多字符字符串，如 "ab"）
      const charContent = char.c || char.u || ''; // 兼容不同的字符内容字段
      text.push(charContent);

      // ✅ 关键修复：为字符串的每个字符都创建映射条目
      for (let k = 0; k < charContent.length; k++) {
        charMapping.push(char.offset);
      }

      // 根据字符标记添加分隔符
      if (char.spaceAfter || char.lineBreakAfter && !char.paragraphBreakAfter) {
        text.push(' ');
        charMapping.push(char.offset); // 空格也映射到当前字符的 offset
      }
      if (char.paragraphBreakAfter) {
        text.push('\n\n');
        charMapping.push(char.offset); // 段落分隔符也映射
        charMapping.push(char.offset);
      }
    }
    const finalText = text.join('').trim();
    // trim 后需要调整 charMapping 长度
    const trimmedCharMapping = charMapping.slice(0, finalText.length);
    return {
      text: finalText,
      charMapping: trimmedCharMapping
    };
  }

  /**
   * 对文本和 charMapping 同步做规范化处理（\n\n→空格、\n→空格、多空格合并、trim）。
   * 保证规范化后 text.length === mapping.length，索引完全对齐。
   * @param {string} text
   * @param {Array} mapping
   * @returns {{ text: string, mapping: Array }}
   */
  _normalizeTextAndMapping(text, mapping) {
    let midText = '';
    let midMap = [];
    let i = 0;

    // Pass 1: \n\n → ' ' (2 chars → 1), \n → ' ' (1 char → 1)
    while (i < text.length) {
      if (text[i] === '\n' && i + 1 < text.length && text[i + 1] === '\n') {
        midText += ' ';
        midMap.push(mapping[i] !== undefined ? mapping[i] : mapping.length > 0 ? mapping[mapping.length - 1] : 0);
        i += 2;
      } else if (text[i] === '\n') {
        midText += ' ';
        midMap.push(mapping[i] !== undefined ? mapping[i] : mapping.length > 0 ? mapping[mapping.length - 1] : 0);
        i++;
      } else {
        midText += text[i];
        midMap.push(mapping[i] !== undefined ? mapping[i] : mapping.length > 0 ? mapping[mapping.length - 1] : 0);
        i++;
      }
    }

    // Pass 2: collapse consecutive spaces
    let outText = '';
    let outMap = [];
    let inSpace = false;
    for (let j = 0; j < midText.length; j++) {
      if (midText[j] === ' ') {
        if (!inSpace) {
          outText += ' ';
          outMap.push(midMap[j]);
          inSpace = true;
        }
        // else: extra space — skip char and its mapping entry
      } else {
        outText += midText[j];
        outMap.push(midMap[j]);
        inSpace = false;
      }
    }

    // Pass 3: trim leading/trailing spaces
    let start = 0;
    let end = outText.length - 1;
    while (start <= end && outText[start] === ' ') start++;
    while (end >= start && outText[end] === ' ') end--;
    return {
      text: outText.slice(start, end + 1),
      mapping: outMap.slice(start, end + 1)
    };
  }

  /**
   * 根据MinerU bbox从charsDataList中提取对应的文字字符
   * @param {Array} charsDataList - 全局字符数据列表
   * @param {Object} mineruBlock - MinerU块数据
   * @returns {Object} { text: String, chars: Array, charCount: number, charMapping: Array }
   */
  _extractTextByBbox(charsDataList, mineruBlock, visualBlocks = []) {
    const {
      bbox,
      page_idx
    } = mineruBlock;
    if (!bbox || bbox.length < 4) {
      console.warn('[_extractTextByBbox] MinerU block缺少bbox信息:', mineruBlock);
      return {
        text: '',
        chars: [],
        charCount: 0,
        charMapping: []
      };
    }

    // 1. 坐标转换：MinerU bbox → PDF坐标
    const pdfBbox = this._convertMinerUBboxToPdfCoords(bbox, page_idx);
    if (!pdfBbox) {
      return {
        text: '',
        chars: [],
        charCount: 0,
        charMapping: []
      };
    }

    // 🔍 详细调试：检查目标页面的字符范围
    const pageChars = charsDataList.filter((char) => char.pageIndex === page_idx);
    if (pageChars.length === 0) {
      console.warn(`🔍 [调试] 页面${page_idx}没有找到任何字符!`);
      return {
        text: '',
        chars: [],
        charCount: 0,
        charMapping: []
      };
    }

    // 2. 过滤目标页面且在bbox内的字符
    let charsInBbox = [];
    let charsOutOfRange = 0;
    let charsWrongPage = 0;
    for (let char of charsDataList) {
      // 统计页面筛选
      if (char.pageIndex !== page_idx) {
        charsWrongPage++;
        continue;
      }

      // 检查字符是否在bbox内
      const isInBbox = this._isCharInBbox(char.rect, pdfBbox);
      if (isInBbox) {
        charsInBbox.push(char);
      } else {
        charsOutOfRange++;
      }
    }

    // 3. 按offset排序保持阅读顺序
    charsInBbox.sort((a, b) => a.offset - b.offset);

    // Keep neighboring figure labels / columns out of an oversized parser box.
    let aligned = DeepRead.Typography?.match(charsInBbox, mineruBlock.text);
    if (!aligned && visualBlocks.length && mineruBlock.type === "text") {
      const regions = visualBlocks.map((b) => this._convertMinerUBboxToPdfCoords(b.bbox, page_idx)).filter(Boolean);
      const outside = charsInBbox.filter((c) => !regions.some((r) => this._isCharInBbox(c.rect, r)));
      // Only discard figure text when the remaining characters match the complete
      // source paragraph. Overlapping/incorrect figure boxes must not delete prose.
      aligned = DeepRead.Typography?.match(outside, mineruBlock.text);
    }
    if (aligned) charsInBbox = aligned;

    // 4. 提取格式化文本和字符映射
    const {
      text,
      charMapping
    } = this._extractFormattedText(charsInBbox);
    return {
      text,
      chars: charsInBbox,
      charCount: charsInBbox.length,
      charMapping,
      // ✅ 新增：返回与 text 长度一致的 charMapping
      pdfBbox // 返回转换后的PDF坐标供调试
    };
  }

  /**
   * 基于bbox坐标进行精确匹配（替换原有的模糊匹配）
   * 使用MinerU提供的bbox坐标直接从原文中提取对应的段落
   * @param {Array} mainBlocks - selectMainBlocks返回的结果
   * @param {Array} paragraphs - processParagraphData返回的结果（保持接口兼容性，用于image/table的caption匹配）
   * @param {Array} charsDataList - 全局字符数据列表
   * @returns {Array} matchedResults - 匹配结果，保持与原fuzzMatch相同的数据结构
   */
  bboxMatch(mainBlocks, paragraphs, charsDataList) {
    let matchedResults = [];

    // 1. 确保charsDataList可用
    if (!charsDataList || charsDataList.length === 0) {
      console.warn('[bboxMatch] charsDataList为空，无法进行bbox匹配');
      return matchedResults;
    }

    // 2. 按页面处理MinerU块
    for (let pageData of mainBlocks) {
      let page_idx = pageData.page_idx;
      let mineruBlocks = pageData.blocks;
      let matchedParagraphs = [];

      // 3. 对每个MinerU块进行匹配
      for (let block of mineruBlocks) {
        try {
          const hasText = typeof block.text === 'string' && block.text.trim().length > 0;
          const hasBbox = Array.isArray(block.bbox) && block.bbox.length >= 4;
          const canExtractByBbox = block.type !== 'image' && block.type !== 'table' && hasBbox;

          // MinerU may emit continuation blocks with an empty text field but a valid bbox
          // for cross-page/cross-column fragments. Keep those so pdf.js chars can fill them.
          if (!hasText && !canExtractByBbox) {
            if (block.type !== 'image' && block.type !== 'table') {
              continue;
            }
          }

          // 4. 对image和table类型特殊处理：直接使用MinerU数据，不做字符匹配
          let extractionResult;
          if (block.type === 'image' || block.type === 'table') {
            // Captions can lie outside the image bbox. Match on this page, uniquely;
            // keep the caption itself if OCR/text-layer disagreement prevents alignment.
            const captionChars = DeepRead.Typography?.match(
              charsDataList.filter((c) => c.pageIndex === page_idx), block.text
            );
            extractionResult = captionChars ? {
              ...this._extractFormattedText(captionChars), chars: captionChars,
              charCount: captionChars.length, skipCharMatching: false,
            } : {
              text: block.text || "", chars: [], charCount: (block.text || "").length,
              skipCharMatching: true,
            };
          } else {
            // 对于其他类型，使用bbox直接提取对应的原文段落
            extractionResult = this._extractTextByBbox(charsDataList, block,
              mineruBlocks.filter((b) => b !== block && ["image", "table"].includes(b.type) && b.bbox));
            if (extractionResult.charCount === 0) {
              console.warn(`[bboxMatch] ⚠️ 未在bbox内找到字符: ${block.type}块，文本="${block.text?.substring(0, 30)}..."`);
              // 对于空结果，可以选择跳过或创建空条目，这里选择跳过
              continue;
            }
          }

          // 5. 构建匹配结果，保持与原fuzzMatch相同的数据结构
          const matchedParagraph = {
            paragraph_idx: matchedParagraphs.length,
            // 在页面中的顺序索引
            text: extractionResult.text,
            typography: DeepRead.Typography?.metrics(extractionResult.chars || []),
            // MinerU的caption文本或bbox提取的原文
            charMapping: extractionResult.skipCharMatching ? [] // image/table类型跳过字符匹配，使用空数组
            : extractionResult.charMapping,
            // ✅ 修复：使用与 text 长度一致的 charMapping
            startCharIndex: extractionResult.skipCharMatching ? null // image/table类型跳过字符匹配，使用null
            : extractionResult.chars[0],
            // 第一个字符对象
            endCharIndex: extractionResult.skipCharMatching ? null // image/table类型跳过字符匹配，使用null
            : extractionResult.chars[extractionResult.chars.length - 1],
            // 最后一个字符对象
            mineruText: block.text,
            // MinerU提供的原文
            type: block.type,
            bbox: block.bbox,
            // MinerU的bbox（千分比格式）
            // 保留 MinerU 原始 ID
            minerUid: block.minerUid,
            // ✅ 传递特殊类型标记，确保equation等特殊类型能被正确识别
            specialType: block.specialType,
            // 保留 image/table 特有字段
            img_path: block.img_path,
            image_caption: block.img_caption || block.image_caption,
            table_body: block.table_body,
            table_caption: block.table_caption,
            similarityScore: 1.0 // bbox匹配被认为是完美的位置匹配，相似度为1
          };
          matchedParagraphs.push(matchedParagraph);
        } catch (error) {
          console.error(`[bboxMatch] ❌ 处理${block.type}块时出错:`, error);
          continue;
        }
      }

      // 6. 添加页面结果
      if (matchedParagraphs.length > 0) {
        matchedResults.push({
          page_idx: page_idx,
          paragraphs: matchedParagraphs
        });
      } else {
        console.warn(`[bboxMatch] 页面${page_idx}无匹配结果`);
      }
    }
    return matchedResults;
  }

  fuzzMatch(mainBlocks, processedParagraphData) {
    // 正文段落和原文段落进行模糊匹配
    // 使用 Fuse.js 进行高效模糊搜索

    let matchedResults = [];
    for (let pageData of mainBlocks) {
      let page_idx = pageData.page_idx;
      let mineruBlocks = pageData.blocks;

      // 找到对应页面的原文段落数据
      let originalPageData = processedParagraphData.find((p) => p.page_idx === page_idx);
      if (!originalPageData) {
        continue;
      }
      let originalParagraphs = originalPageData.paragraphs;
      let matchedParagraphs = [];
      let usedIndices = new Set(); // 记录已使用的段落索引

      // 为当前页面的原文段落创建 Fuse.js 实例
      // 配置选项：忽略位置、大小写不敏感、包含分数
      const fuseOptions = {
        keys: ['text'],
        // 搜索 text 字段
        includeScore: true,
        // 包含分数用于排序和阈值过滤
        includeMatches: true,
        // 包含匹配的子字符串
        threshold: 1.0,
        // 匹配阈值（0.0 完全匹配，1.0 匹配任何内容）
        ignoreLocation: true,
        // 忽略位置，在整个字符串中搜索
        isCaseSensitive: false,
        // 大小写不敏感
        ignoreDiacritics: true,
        // 忽略音调符号
        minMatchCharLength: 5,
        // 最小匹配字符长度
        shouldSort: true,
        // 按分数排序
        findAllMatches: false
      };

      // 为原文段落添加索引，便于后续关联
      const indexedParagraphs = originalParagraphs.map((para, idx) => ({
        ...para,
        originalIndex: idx
      }));
      const fuse = new Fuse(indexedParagraphs, fuseOptions);
      // 对每个 MinerU 文本块，使用 Fuse.js 找到最匹配的原文段落
      for (let block of mineruBlocks) {
        try {
          if (!block.text || block.text.trim().length === 0) {
            continue;
          }
        } catch (e) {
          console.error("[reader/reader.js] Error matching block:", block);
          continue;
        }

        // 使用 Fuse.js 搜索
        const results = fuse.search(block.text);
        // console.log("搜索匹配项,", block.text, "testResults,", results)
        if (block.type === 'equation') {

          // console.log("testEquation:results", results)
        }if (block.type === 'list') {

          // console.log("testList:results", results)
        } // 取最佳匹配结果（分数最低的）
        if (results.length > 0) {
          const bestResult = results[0];
          const matchedPara = bestResult.item;
          const score = bestResult.score; // Fuse.js 分数：0 是完美匹配，1 是完全不匹配

          // 直接取分数最低的匹配结果，保留 block 的所有字段
          // paragraph_idx 使用匹配后的索引（在 matchedParagraphs 中的位置）
          matchedParagraphs.push({
            paragraph_idx: matchedParagraphs.length,
            // 匹配后在页面中的顺序索引
            text: matchedPara.text,
            charMapping: matchedPara.charMapping,
            startCharIndex: matchedPara.startCharIndex,
            endCharIndex: matchedPara.endCharIndex,
            mineruText: block.text,
            type: block.type,
            bbox: block.bbox,
            // 保留 MinerU 原始 ID
            minerUid: block.minerUid,
            // 保留 image/table 特有字段
            img_path: block.img_path,
            image_caption: block.img_caption || block.image_caption,
            table_body: block.table_body,
            table_caption: block.table_caption,
            similarityScore: 1 - score // 转换为相似度（0-1，越高越好）
          });
        }
      }
      matchedResults.push({
        page_idx: page_idx,
        paragraphs: matchedParagraphs
        // paragraphs: finalMatchedParagraphs
      });
    }
    return matchedResults;
    // 迭代合并检查
    // 		if (results.length === 0) {
    // 			console.warn(`[fuzzMatch] 未找到匹配段落: ${block.text.substring(0, 50)}...`);
    // 			continue;
    // 		}

    // 		const bestResult = results[0];
    // 		const matchedPara = bestResult.item;
    // 		let mergedParagraphs = [matchedPara]; // 用于合并的段落列表
    // 		usedIndices.add(matchedPara.originalIndex);

    // 		// 迭代合并：基于bbox检查
    // 		const finalPara = this._iterativeMergeParagraphs(
    // 			mergedParagraphs,
    // 			block,
    // 			originalParagraphs,
    // 			usedIndices,
    // 			page_idx
    // 		);

    // 		matchedParagraphs.push(finalPara);
    // 	}

    // 	matchedResults.push({
    // 		page_idx: page_idx,
    // 		paragraphs: matchedParagraphs
    // 	});
    // }

    // return matchedResults;
  }

  /**
   * 迭代合并段落，基于bbox位置检查
   * @param {Array} mergedParagraphs - 当前已合并的段落列表
   * @param {Object} block - MinerU块
   * @param {Array} allParagraphs - 当前页面所有段落
   * @param {Set} usedIndices - 已使用的段落索引
   * @param {number} pageIndex - 页面索引
   * @returns {Object} 最终合并的段落
   */
  _iterativeMergeParagraphs(mergedParagraphs, block, allParagraphs, usedIndices, pageIndex) {
    const MAX_ITERATIONS = 5; // 最大迭代次数
    const HEIGHT_THRESHOLD_PERMILLE = 6; // 高度差异阈值（千分比‰）
    const Y_THRESHOLD_PERMILLE = 6; // Y坐标差异阈值（千分比‰）
    let iteration = 0;
    while (iteration < MAX_ITERATIONS) {
      iteration++;

      // 1. 计算当前合并段落的bbox（千分比‰格式，左上右下）
      const mergedBbox = this._calculateMergedParagraphBbox(mergedParagraphs, pageIndex);
      // console.log("testMergedBox:", mergedBbox);
      if (!mergedBbox) {
        console.warn('[_iterativeMergeParagraphs] 无法计算合并段落的bbox');
        break;
      }

      // 2. 获取MinerU块的bbox（千分比‰格式，左上右下）
      const mineruBbox = block.bbox;
      // console.log("testmineruBbox:", mineruBbox);
      if (!mineruBbox || mineruBbox.length < 4) {
        console.warn('[_iterativeMergeParagraphs] MinerU块缺少bbox信息');
        break;
      }

      // 3. 计算高度
      const mergedHeight = mergedBbox.bottomY - mergedBbox.topY;
      const mineruHeight = mineruBbox[3] - mineruBbox[1]; // bbox格式：[左, 上, 右, 下]
      const heightDiff = Math.abs(mergedHeight - mineruHeight);

      // 4. 比较bbox的Y坐标（上边和下边）
      const bboxDiff = this._compareBbox(mergedBbox, mineruBbox);

      // 打印MinerU块和段落原文的text
      // console.log(`  MinerU块原文: "${block.text}"`);
      // console.log(`  MinerU块bbox: [${mineruBbox.map(v => v.toFixed(1)).join(', ')}]`);
      const mergedText = mergedParagraphs.map((p) => p.text).join(' ');
      // console.log(`  段落原文: "${mergedText}"`);
      // console.log(`  合并段落Y坐标: topY=${mergedBbox.topY.toFixed(1)}‰, bottomY=${mergedBbox.bottomY.toFixed(1)}‰`);
      // console.log(`  合并段落高度=${mergedHeight.toFixed(1)}‰, MinerU块高度=${mineruHeight.toFixed(1)}‰`);
      // console.log(`  高度差异=${heightDiff.toFixed(2)}‰`);
      // console.log(`  上边差异=${bboxDiff.topDiff.toFixed(2)}‰, 下边差异=${bboxDiff.bottomDiff.toFixed(2)}‰`);

      // 5. 先判断高度差异：如果高度接近，说明内容已匹配（即使位置偏移）
      if (heightDiff <= HEIGHT_THRESHOLD_PERMILLE) {
        // console.log('[_iterativeMergeParagraphs] ✅ 高度匹配，内容正确，停止迭代：', heightDiff);
        break;
      }

      // console.log("test: 高度不匹配，需要合并")

      // 6. 高度不匹配时，确定合并方向（向上或向下）
      // 比较上下边的绝对差异，哪边差异大就向哪边合并
      let needMergeAbove = false;
      let needMergeBelow = false;
      const topAbsDiff = Math.abs(bboxDiff.topDiff);
      const bottomAbsDiff = Math.abs(bboxDiff.bottomDiff);
      if (topAbsDiff > Y_THRESHOLD_PERMILLE || bottomAbsDiff > Y_THRESHOLD_PERMILLE) {
        // 哪边差异更大，就向哪边合并
        if (topAbsDiff > bottomAbsDiff) {
          // 上边差异大：如果合并段落上边低于MinerU块，需要向上合并
          needMergeAbove = bboxDiff.topDiff > Y_THRESHOLD_PERMILLE;
        } else {
          // 下边差异大：如果合并段落下边高于MinerU块，需要向下合并
          needMergeBelow = bboxDiff.bottomDiff < -Y_THRESHOLD_PERMILLE;
        }
      }
      if (!needMergeAbove && !needMergeBelow) {
        // console.log('[_iterativeMergeParagraphs] ⚠️ 边界差异在阈值内但高度不匹配，停止迭代');
        break;
      }

      // 7. 查找相邻段落
      let adjacentPara = null;
      if (needMergeAbove) {
        // 向上查找：找到第一个段落的前一个段落
        const firstIndex = mergedParagraphs[0].originalIndex;
        adjacentPara = allParagraphs.find((p) => p.originalIndex === firstIndex - 1 && !usedIndices.has(p.originalIndex));
        if (adjacentPara) {
          // console.log(`[_iterativeMergeParagraphs] ⬆️ 向上合并段落 ${adjacentPara.originalIndex}（上边差异更大）`);
          mergedParagraphs.unshift(adjacentPara); // 添加到开头
          usedIndices.add(adjacentPara.originalIndex);
        }
      } else if (needMergeBelow) {
        // 向下查找：找到最后一个段落的后一个段落
        const lastIndex = mergedParagraphs[mergedParagraphs.length - 1].originalIndex;
        adjacentPara = allParagraphs.find((p) => p.originalIndex === lastIndex + 1 && !usedIndices.has(p.originalIndex));
        if (adjacentPara) {
          // console.log(`[_iterativeMergeParagraphs] ⬇️ 向下合并段落 ${adjacentPara.originalIndex}（下边差异更大）`);
          mergedParagraphs.push(adjacentPara); // 添加到末尾
          usedIndices.add(adjacentPara.originalIndex);
        }
      }

      // 8. 如果找不到相邻段落，停止迭代
      if (!adjacentPara) {
        console.warn('[_iterativeMergeParagraphs] ⚠️ 无相邻段落可合并，停止迭代');
        break;
      }
    }

    // 8. 构建最终结果
    return this._buildMergedParagraph(mergedParagraphs, block);
  }

  /**
   * 计算合并段落的bbox（千分比‰格式，左上右下）
   * 只需要第一个字和最后一个字的rect
   * @param {Array} paragraphs - 段落列表
   * @param {number} pageIndex - 页面索引
   * @returns {Array} [x0, y0, x1, y1] 千分比‰格式，左上右下 或 null
   */
  _calculateMergedParagraphBbox(paragraphs, pageIndex) {
    if (!paragraphs || paragraphs.length === 0) {
      return null;
    }

    // 获取第一个段落的第一个字符和最后一个段落的最后一个字符
    const firstPara = paragraphs[0];
    const lastPara = paragraphs[paragraphs.length - 1];
    const firstChar = firstPara.startCharIndex;
    const lastChar = lastPara.endCharIndex;
    if (!firstChar || !lastChar || !firstChar.rect || !lastChar.rect) {
      console.warn('[_calculateMergedParagraphBbox] 字符缺少rect信息');
      return null;
    }

    // firstChar.rect 和 lastChar.rect 格式：[x1, y1, x2, y2]（PDF坐标，左下右上）
    const firstRect = firstChar.rect;
    const lastRect = lastChar.rect;

    // 计算Y坐标边界（PDF坐标，左下右上）
    let bottomY = lastRect[1]; // 最后一个字符的下边界（Y最小值）
    let topY = firstRect[3]; // 第一个字符的上边界（Y最大值）

    // 转换为千分比‰格式
    ({
      topY,
      bottomY
    } = this._convertYCoordsToBbox(bottomY, topY, pageIndex));
    return {
      topY,
      bottomY
    };
  }

  /**
   * 将Y坐标（PDF坐标，左下右上）转换为bbox的Y坐标（千分比‰，左上右下）
   * @param {number} bottomY - 下边界（PDF坐标，Y最小值）
   * @param {number} topY - 上边界（PDF坐标，Y最大值）
   * @param {number} pageIndex - 页面索引
   * @returns {Object} { topY, bottomY } 千分比‰格式
   */
  _convertYCoordsToBbox(bottomY, topY, pageIndex) {
    // 获取页面尺寸
    const page = this._primaryView._pages[pageIndex];
    if (!page) {
      console.warn(`[_convertYCoordsToBbox] 页面${pageIndex}不存在`);
      return {
        topY: 0,
        bottomY: 0
      };
    }

    // 从 viewport.originalViewBox 获取原始页面尺寸（PDF坐标系）
    const viewport = page.originalPage.viewport;
    const originalViewBox = viewport.originalViewBox;
    if (!originalViewBox || originalViewBox.length < 4) {
      console.warn(`[_convertYCoordsToBbox] 页面${pageIndex}缺少originalViewBox`);
      return {
        topY: 0,
        bottomY: 0
      };
    }

    // originalViewBox格式：[x0, y0, x1, y1] - 这是原始PDF的尺寸
    const originalHeight = originalViewBox[3] - originalViewBox[1];
    const originalWidth = originalViewBox[2] - originalViewBox[0];

    // 		console.log(`[_convertYCoordsToBbox] 页面${pageIndex}:`, {
    // 			originalViewBox,
    // 			originalWidth,
    // 			originalHeight,
    // 			说明: "使用originalViewBox计算千分比坐标"
    // 		});

    // Y坐标转换：PDF坐标系（左下原点，Y向上）→ bbox坐标系（左上原点，Y向下）
    // rect坐标系（PDF坐标）：bottomY是下边界（y1），topY是上边界（y2）
    // bbox坐标系（千分比‰，左上右下）：y0是上边界，y1是下边界
    // 需要翻转Y坐标：bbox_Y = (originalHeight - rect_Y) / originalHeight * 1000
    topY = (originalHeight - topY) / originalHeight * 1000; // 上边界（rect的topY翻转）
    bottomY = (originalHeight - bottomY) / originalHeight * 1000; // 下边界（rect的bottomY翻转）

    return {
      topY,
      bottomY
    };
  }

  /**
   * 比较两个bbox的Y坐标差异（千分比‰格式，左上右下）
   * @param {Object} mergedBbox - 合并段落的Y坐标 { topY, bottomY }
   * @param {Array} mineruBbox - MinerU块的bbox [x0, y0, x1, y1]
   * @returns {Object} { topDiff, bottomDiff }
   */
  _compareBbox(mergedBbox, mineruBbox) {
    // mergedBbox格式：{ topY, bottomY }（千分比‰）
    // mineruBbox格式：[x0, y0, x1, y1]（千分比‰，左上右下）
    // y0是上边，y1是下边

    const {
      topY: y0_merged,
      bottomY: y1_merged
    } = mergedBbox;
    const [, y0_mineru,, y1_mineru] = mineruBbox;

    // 计算差异（正值表示merged低于mineru，负值表示merged高于mineru）
    const topDiff = y0_merged - y0_mineru; // 上边差异
    const bottomDiff = y1_merged - y1_mineru; // 下边差异

    return {
      topDiff,
      bottomDiff
    };
  }

  /**
   * 构建最终合并的段落
   */
  _buildMergedParagraph(paragraphs, block) {
    if (paragraphs.length === 1) {
      return {
        paragraph_idx: paragraphs[0].originalIndex,
        text: paragraphs[0].text,
        charMapping: paragraphs[0].charMapping,
        startCharIndex: paragraphs[0].startCharIndex,
        endCharIndex: paragraphs[0].endCharIndex,
        mineruText: block.text,
        type: block.type,
        bbox: block.bbox,
        minerUid: block.minerUid,
        img_path: block.img_path,
        image_caption: block.img_caption || block.image_caption,
        table_body: block.table_body,
        table_caption: block.table_caption,
        similarityScore: 1
      };
    }

    // 合并多个段落。注意：插入分隔符时也要同步补一位 mapping，
    // 否则 mergedText.length 会大于 mergedCharMapping.length，
    // 后续按 sentenceStart/sentenceEnd 切片时，段尾句子会被静默丢掉。
    const {
      text: mergedText,
      mapping: mergedCharMapping
    } = this._concatenateTextAndMappings(paragraphs);
    return {
      paragraph_idx: paragraphs[0].originalIndex,
      text: mergedText,
      charMapping: mergedCharMapping,
      startCharIndex: paragraphs[0].startCharIndex,
      endCharIndex: paragraphs[paragraphs.length - 1].endCharIndex,
      mineruText: block.text,
      type: block.type,
      bbox: block.bbox,
      minerUid: block.minerUid,
      img_path: block.img_path,
      image_caption: block.img_caption || block.image_caption,
      table_body: block.table_body,
      table_caption: block.table_caption,
      similarityScore: 1,
      mergedFrom: paragraphs.map((p) => p.originalIndex)
    };
  }

  _concatenateTextAndMappings(paragraphs, separator = ' ') {
    let mergedText = '';
    let mergedMapping = [];
    for (let paragraph of paragraphs) {
      const partText = typeof paragraph?.text === 'string' ? paragraph.text : '';
      const partMapping = Array.isArray(paragraph?.charMapping) ? paragraph.charMapping : [];
      if (!partText) {
        continue;
      }
      if (mergedText.length > 0) {
        mergedText += separator;
        mergedMapping.push(partMapping[0] !== undefined ? partMapping[0] : mergedMapping.length > 0 ? mergedMapping[mergedMapping.length - 1] : 0);
      }
      mergedText += partText;
      if (partMapping.length === partText.length) {
        mergedMapping.push(...partMapping);
        continue;
      }
      if (partMapping.length > 0) {
        mergedMapping.push(...partMapping);
        const filler = partMapping[partMapping.length - 1];
        for (let i = partMapping.length; i < partText.length; i++) {
          mergedMapping.push(filler);
        }
        continue;
      }
      const fallback = mergedMapping.length > 0 ? mergedMapping[mergedMapping.length - 1] : 0;
      for (let i = 0; i < partText.length; i++) {
        mergedMapping.push(fallback);
      }
    }
    return {
      text: mergedText,
      mapping: mergedMapping
    };
  }

  _normalizeSourceLanguageLocale(locale) {
    if (!locale || typeof locale !== 'string') {
      return undefined;
    }
    const normalized = locale.trim().replace('_', '-');
    if (!normalized || normalized.toLowerCase() === 'und' || normalized.toLowerCase() === 'unknown') {
      return undefined;
    }
    const lower = normalized.toLowerCase();
    const localeMap = {
      zh: 'zh-CN',
      cmn: 'zh-CN',
      'zh-cn': 'zh-CN',
      'zh-hans': 'zh-CN',
      'zh-tw': 'zh-TW',
      'zh-hant': 'zh-TW',
      en: 'en-US',
      'en-us': 'en-US',
      'en-gb': 'en-GB',
      ja: 'ja-JP',
      jp: 'ja-JP',
      'ja-jp': 'ja-JP',
      ko: 'ko-KR',
      kr: 'ko-KR',
      'ko-kr': 'ko-KR',
      th: 'th-TH',
      'th-th': 'th-TH',
      fr: 'fr-FR',
      'fr-fr': 'fr-FR',
      es: 'es-ES',
      'es-es': 'es-ES',
      de: 'de-DE',
      'de-de': 'de-DE',
      ru: 'ru-RU',
      'ru-ru': 'ru-RU',
      ar: 'ar',
      vi: 'vi-VN',
      'vi-vn': 'vi-VN',
      pt: 'pt-PT',
      'pt-pt': 'pt-PT',
      it: 'it-IT',
      'it-it': 'it-IT',
      nl: 'nl-NL',
      'nl-nl': 'nl-NL',
      tr: 'tr-TR',
      'tr-tr': 'tr-TR'
    };
    return localeMap[lower] || normalized;
  }

  _detectSourceLanguageLocaleFromText(text) {
    const value = typeof text === 'string' ? text : '';
    if (!value.trim()) {
      return undefined;
    }
    try {
      const langCode = DeepRead.detectLanguage(value);
      const locale = this._normalizeSourceLanguageLocale(DeepRead.FRANC_TO_SOURCE_LOCALE[langCode] || langCode);
      if (locale) {
        return locale;
      }
    } catch (error) {
      console.warn('[Reader][SourceLanguageDetection] franc-min detection failed:', error);
    }
    return undefined;
  }

  _collectSourceLanguageSample(mainBlocks) {
    const samples = [];
    for (const pageData of mainBlocks || []) {
      for (const block of pageData.blocks || []) {
        if (block?.type !== 'text') {
          continue;
        }
        const text = typeof block.text === 'string' ? block.text.replace(/\s+/g, ' ').trim() : '';
        if (text.length < 40) {
          continue;
        }
        samples.push(text.slice(0, 500));
        if (samples.length >= 3) {
          return samples.join('\n\n').slice(0, 3000);
        }
      }
    }
    return samples.join('\n\n').slice(0, 3000);
  }

  _extractPageTextSampleForLanguageDetection(pageData, maxChars = 100) {
    if (!pageData?.chars?.length) {
      return '';
    }
    const text = pageData.chars.map((char) => char?.u || '').join('').replace(/\s+/g, ' ').trim();
    return text.slice(0, maxChars);
  }

  async _collectSourceLanguageSampleFromIncludedPages(totalPages, excludedSet = new Set()) {
    const pdfApp = this._primaryView?._iframeWindow?.PDFViewerApplication;
    const pdfDocument = pdfApp?.pdfDocument;
    if (!pdfDocument || totalPages < 1) {
      return '';
    }
    const samples = [];
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      if (excludedSet.has(pageIndex)) {
        continue;
      }
      let sample = this._reparsePageLanguageSampleCache.get(pageIndex);
      if (sample === undefined) {
        try {
          const pageData = await pdfDocument.getPageData({
            pageIndex
          });
          sample = this._extractPageTextSampleForLanguageDetection(pageData);
        } catch (error) {
          console.warn('[Reader][SourceLanguageDetection] Failed to extract page text for language detection:', {
            pageIndex,
            error
          });
          sample = '';
        }
        this._reparsePageLanguageSampleCache.set(pageIndex, sample);
      }
      if (sample && sample.length >= 20) {
        samples.push(sample);
      }
      if (samples.length >= 3) {
        break;
      }
    }
    return samples.join(' ');
  }

  async _detectSourceLanguageFromPdfSelection(totalPages, excludedSet = new Set()) {
    const sample = await this._collectSourceLanguageSampleFromIncludedPages(totalPages, excludedSet);
    return this._detectSourceLanguageLocaleFromText(sample);
  }

  async _detectSourceTextLanguageForSegmentation(mainBlocks) {
    if (this._oneTimeSourceLanguageLocaleOverride) {
      this._lastLoggedSentenceSegmenterLocale = undefined;
      this._sourceTextSegmenterLocale = this._normalizeSourceLanguageLocale(this._oneTimeSourceLanguageLocaleOverride);
      return this._sourceTextSegmenterLocale;
    }
    const sample = this._collectSourceLanguageSample(mainBlocks);
    const detectedLocale = this._detectSourceLanguageLocaleFromText(sample);
    this._lastLoggedSentenceSegmenterLocale = undefined;
    if (!sample) {
      this._sourceTextSegmenterLocale = undefined;
      console.log('[Reader][SourceLanguageDetection] No source text sample; using default Intl.Segmenter locale.');
      return undefined;
    }
    this._sourceTextSegmenterLocale = detectedLocale;
    console.log('[Reader][SourceLanguageDetection] Local language detection result:', {
      detectedLocale,
      sampleLength: sample.length,
      effectiveLocale: this._sourceTextSegmenterLocale || null
    });
    return this._sourceTextSegmenterLocale;
  }

  _getSentenceSegmenterLocale() {
    const locale = this._normalizeSourceLanguageLocale(this._sourceTextSegmenterLocale);
    return locale || undefined;
  }

  _splitSentencesWithIntl(paraText) {
    const text = typeof paraText === 'string' ? paraText : '';
    if (!text.trim()) {
      return [];
    }
    const locale = this._getSentenceSegmenterLocale();
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try {
        if (this._lastLoggedSentenceSegmenterLocale !== locale) {
          // console.log('[Reader][SentenceSegmenter] Using Intl.Segmenter locale:', {
          // 	locale: locale || 'default',
          // 	sourceTextSegmenterLocale: this._sourceTextSegmenterLocale || null
          // });
          this._lastLoggedSentenceSegmenterLocale = locale;
        }
        const segmenter = new Intl.Segmenter(locale, {
          granularity: 'sentence'
        });
        const sentences = Array.from(segmenter.segment(text)).map((segment) => this._cleanSegmentedSentenceText(segment.segment)).filter(Boolean);
        if (sentences.length > 0) {
          return sentences;
        }
      } catch (error) {
        console.warn('[Reader] Intl.Segmenter sentence split failed, fallback to regex splitter.', error);
      }
    } else {
      console.warn('[Reader] Intl.Segmenter is unavailable, fallback to regex splitter.');
    }
    const fallbackSentences = text.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/gu) || [];
    return fallbackSentences.map((segment) => this._cleanSegmentedSentenceText(segment)).filter(Boolean);
  }

  _cleanSegmentedSentenceText(sentenceText) {
    let text = typeof sentenceText === 'string' ? sentenceText.trim() : '';
    if (!text) {
      return '';
    }
    if (/^(?:[\d\s]+|[①-⑳\s]+)$/u.test(text)) {
      return '';
    }
    text = text.replace(/^\s*(?:[①-⑳]|\d{1,2})\s*(?=[\p{Script=Han}A-Za-z“"‘'（(])/gu, '').trim();
    text = text.replace(/(?:\s+[①-⑳]|\s+\d{1,2})+\s*$/gu, '').trim();
    return text;
  }

  _getSentenceCharMapping(paraCharMapping, sentenceStartInPara, sentenceEndInPara) {
    if (!Array.isArray(paraCharMapping) || paraCharMapping.length === 0) {
      return [];
    }
    const sentenceLength = Math.max(0, sentenceEndInPara - sentenceStartInPara);
    const start = Math.max(0, Math.min(sentenceStartInPara, paraCharMapping.length));
    const end = Math.max(start, Math.min(sentenceEndInPara, paraCharMapping.length));
    const sentenceCharMapping = paraCharMapping.slice(start, end);
    if (sentenceCharMapping.length >= sentenceLength) {
      return sentenceCharMapping;
    }
    const fallbackIndex = sentenceCharMapping.length > 0 ? sentenceCharMapping[sentenceCharMapping.length - 1] : paraCharMapping[Math.min(start, paraCharMapping.length - 1)];
    while (sentenceCharMapping.length < sentenceLength && fallbackIndex !== undefined) {
      sentenceCharMapping.push(fallbackIndex);
    }
    return sentenceCharMapping;
  }

  processSentenceData(matchedResults) {
    // 对匹配后的段落进行分句，返回按段落组织的数据结构
    let paragraphData = [];
    for (let pageData of matchedResults) {
      let page_idx = pageData.page_idx;
      let paragraphs = pageData.paragraphs;
      for (let para of paragraphs) {
        let paragraph_idx = para.paragraph_idx;
        let paraText = para.text;
        let paraType = para.type;
        let processedSentences = [];

        // 使用wiki-nlp分句
        if (!paraText) continue;

        // text/title 类型：MinerU 同一 block 内的 \n\n 是行尾软换行被误标为段落断开的产物，
        // 对已识别为单个段落的 block 而言不应作为句子边界，统一替换为空格。
        // 同时对 charMapping 做同步规范化（_normalizeTextAndMapping），确保 text 与 charMapping
        // 始终等长对齐——否则 \n\n→' '（2 chars→1）会使后续句子的 charMapping 切片偏移。
        // list 类型保留 \n\n，因为它是真实的列表项分隔符（如 "(1) ...\n\n(2) ..."）。
        let paraCharMapping = para.charMapping ? para.charMapping.slice() : [];
        const translationLayout = DeepRead.TranslationLayout?.analyze(paraText, paraCharMapping,
          this._summaryManager.charsDataList || [], { type: paraType }) || null;
        if (paraType === 'text' || paraType === 'title') {
          const normalized = this._normalizeTextAndMapping(paraText, paraCharMapping);
          paraText = normalized.text;
          paraCharMapping = normalized.mapping;
        }
        processedSentences = this._splitSentencesWithIntl(paraText);
        let sentencesInParagraph = [];
        // 特殊处理：对于image、table和equation类型，如果没有charMapping，直接作为单个句子处理
        if ((paraType === 'image' || paraType === 'table') && (!paraCharMapping || paraCharMapping.length === 0)) {
          // console.log(`[Reader] 特殊处理${paraType}类型段落，直接生成单个句子: ${paraText.substring(0, 30)}...`);

          // 将整个caption作为单个句子
          sentencesInParagraph.push({
            sentence_idx: 0,
            text: paraText,
            charMapping: [],
            // 空的charMapping，表示无法进行字符级定位
            startCharIndex: null,
            // 无法进行字符级定位
            endCharIndex: null // 无法进行字符级定位
          });
        } else if (paraType === 'equation') {
          // 对于equation类型，无论是否有charMapping，都直接作为单个句子处理
          // 将整个equation作为单个句子，如果存在charMapping则使用
          sentencesInParagraph.push({
            sentence_idx: 0,
            text: paraText,
            charMapping: paraCharMapping,
            // 使用现有的charMapping，如果有的话
            startCharIndex: paraCharMapping.length > 0 ? this._summaryManager.charsDataList[paraCharMapping[0]] : null,
            // 使用第一个字符作为起始，如果没有charMapping则为null
            endCharIndex: paraCharMapping.length > 0 ? this._summaryManager.charsDataList[paraCharMapping[paraCharMapping.length - 1]] : null // 使用最后一个字符作为结束，如果没有charMapping则为null
          });
        } else {
          // 正常处理：为每个句子计算独立的charMapping
          let searchOffset = 0;
          for (let sentence_idx = 0; sentence_idx < processedSentences.length; sentence_idx++) {
            const sentenceText = processedSentences[sentence_idx];
            const sentenceStartInPara = paraText.indexOf(sentenceText, searchOffset);
            if (sentenceStartInPara === -1) {
              console.warn('[Reader] Could not find sentence in paragraph:', sentenceText);
              continue;
            }
            const sentenceEndInPara = sentenceStartInPara + sentenceText.length;
            searchOffset = sentenceEndInPara;
            const sentenceCharMapping = this._getSentenceCharMapping(paraCharMapping, sentenceStartInPara, sentenceEndInPara);
            if (sentenceCharMapping.length === 0) {
              console.warn('[Reader] Empty charMapping for sentence, keeping text without rects:', sentenceText);
            }
            const startGlobalIdx = sentenceCharMapping[0];
            const endGlobalIdx = sentenceCharMapping[sentenceCharMapping.length - 1];
            const startChar = startGlobalIdx !== undefined ? this._summaryManager.charsDataList[startGlobalIdx] : null;
            const endChar = endGlobalIdx !== undefined ? this._summaryManager.charsDataList[endGlobalIdx] : null;
            if (!startChar || !endChar) {
              console.warn('[Reader] Could not find chars for sentence, keeping text without precise rects:', {
                startGlobalIdx,
                endGlobalIdx,
                charsDataListLength: this._summaryManager.charsDataList.length
              });
            }
            sentencesInParagraph.push({
              sentence_idx,
              text: sentenceText,
              charMapping: sentenceCharMapping,
              startCharIndex: startChar,
              endCharIndex: endChar
            });
          }
        }

        // 将段落及其句子添加到结果中
        if (sentencesInParagraph.length > 0) {
          paragraphData.push({
            page_idx: page_idx,
            paragraph_idx: paragraph_idx,
            paragraph_type: paraType,
            paragraph_text: paraText,
            typography: para.typography,
            translationLayout,
            bbox: para.bbox,
            // 保留 MinerU 原始 ID 和 image/table 特有字段
            minerUid: para.minerUid,
            // ✅ 传递特殊类型标记，确保equation等特殊类型能被正确识别
            specialType: para.specialType,
            // ✅ 传递 MinerU 识别的原文（用于 equation 的翻译）
            mineruText: para.mineruText,
            sentences: sentencesInParagraph
          });
        }
      }
    }
    return paragraphData;
  }

  /**
   * 预处理：识别equation并建立映射关系
   * @param {Array} processedParagraphData - 原始段落数据
   * @returns {Object} { cleanParagraphData, equationMapping }
   */
  _preprocessEquationMapping(processedParagraphData) {
    // 		console.log('[_preprocessEquationMapping] 输入数据详情:', processedParagraphData.map((p, i) => ({
    // 			index: i,
    // 			type: p.paragraph_type || 'undefined',
    // 			specialType: p.specialType || 'undefined',
    // 			textLength: p.paragraph_text?.length || 0,
    // 			textPreview: p.paragraph_text ? (p.paragraph_text.length > 50 ? p.paragraph_text.substring(0, 50) + '...' : p.paragraph_text) : ''
    // 		})));

    const cleanParagraphData = [];
    const equationMapping = []; // 保存equation的映射关系

    for (let i = 0; i < processedParagraphData.length; i++) {
      const paragraph = processedParagraphData[i];
      // 检查是否为equation类型（通过之前添加的specialType标记）
      if (paragraph.specialType === 'equation') {
        // 保存equation映射关系
        equationMapping.push({
          cleanIndex: cleanParagraphData.length,
          // 在clean数据中的索引
          originalIndex: i,
          // 在原始数据中的索引
          originalParagraph: paragraph // 保存原始equation数据
        });

        // 添加到clean数据（equation正常处理，无需过滤特殊标记）
        cleanParagraphData.push({
          ...paragraph,
          // 统一字段名称，确保后续处理一致
          type: paragraph.paragraph_type,
          text: paragraph.paragraph_text
        });
      } else {
        // 普通段落直接添加
        cleanParagraphData.push({
          ...paragraph,
          // 统一字段名称，确保后续处理一致
          type: paragraph.paragraph_type,
          text: paragraph.paragraph_text
        });
      }
    }

    // console.log(`[_preprocessEquationMapping] 处理完成: 总段落数=${processedParagraphData.length}, equation数量=${equationMapping.length}`);

    return {
      cleanParagraphData,
      equationMapping
    };
  }

  /**
   * 使用映射关系处理equation的智能合并
   * 合并规则：
   * 1. text + equation → 合并
   * 2. text + equation + equation + ... → 递归合并所有连续equation
   * 3. text + equation + where/which/here开头的text（且后面不是equation）→ 合并
   * @param {Array} llmResults - LLM处理结果
   * @param {Array} equationMapping - equation映射关系
   * @returns {Array} 处理后的结果
   */
  _postProcessLLMResult(llmResults, equationMapping) {
    // console.log('[_postProcessLLMResult] 开始处理equation合并，总段落:', llmResults);

    // 构建equation索引集合
    const equationIndices = new Set(equationMapping.map((m) => m.cleanIndex));
    // console.log('[_postProcessLLMResult] equation索引:', Array.from(equationIndices));

    const finalResults = [];
    let i = 0;
    while (i < llmResults.length) {
      const current = llmResults[i];

      // 情况1：当前是equation（独立存在，前面没有text）
      if (equationIndices.has(i)) {
        // console.log(`[_postProcessLLMResult] equation段落${i}作为独立段落`);
        finalResults.push({
          ...current,
          type: 'equation_standalone',
          // 使用 MinerU 原始 LaTeX 作为公式翻译，替代空占位符
          point_translations: [current.mineruText || current.text || ''],
          points: [{
            content: current.paragraph_summary || this._bilingual('公式', 'Equation'),
            type: 'equation_point',
            sentence_indices: [0]
          }]
        });
        i++;
        continue;
      }

      // 情况2：当前是普通text，检查后续是否需要合并
      const nextIdx = i + 1;
      if (nextIdx < llmResults.length && equationIndices.has(nextIdx)) {
        // 后面是equation，收集所有需要合并的段落
        const toMerge = [current];
        let j = nextIdx;

        // 向后扫描：收集连续的equation和符合条件的解释文本
        while (j < llmResults.length) {
          const next = llmResults[j];
          const afterNext = j + 1 < llmResults.length ? llmResults[j + 1] : null;
          if (equationIndices.has(j)) {
            // 是equation，继续合并
            toMerge.push(next);
            j++;
          } else if (this._isEquationExplanationText(next.text)) {
            // 是where/which/here开头的text
            // 只有当后面不是equation时才合并
            const afterNextIsEquation = afterNext && equationIndices.has(j + 1);
            if (!afterNextIsEquation) {
              toMerge.push(next);
              j++;
            }
            // 无论是否合并，都停止扫描
            break;
          } else {
            // 普通text，停止合并
            break;
          }
        }

        // 执行合并
        // console.log(`[_postProcessLLMResult] 合并段落 ${i} 到 ${j - 1}，共 ${toMerge.length} 个`);
        const merged = this._mergeMultipleParagraphs(toMerge);
        // 使用 JSON.stringify 打印快照，避免控制台延迟展开导致的值不一致
        // console.log(`[_postProcessLLMResult] 合并段落结果 bbox:`, JSON.stringify(merged.bbox));
        finalResults.push(merged);
        i = j;
      } else {
        // 后面不是equation，直接保存
        finalResults.push(current);
        i++;
      }
    }

    // console.log('[_postProcessLLMResult] 处理完成，最终段落:', finalResults);
    return finalResults;
  }

  /**
   * 合并多个段落（支持text + 多个equation + 解释text）
   * 所有段落的bbox会合并成一个最大边界的bbox
   * @param {Array} paragraphs - 要合并的段落数组
   * @returns {Object} 合并后的段落
   */
  _mergeMultipleParagraphs(paragraphs) {
    if (paragraphs.length === 0) return null;
    if (paragraphs.length === 1) return paragraphs[0];

    // 基础段落（第一个text）
    const base = paragraphs[0];
    let mergedText = base.text || '';
    let mergedSentences = [...(base.sentences || [])];
    let mergedPointSplit = [...(base.point_split || [])];
    let mergedPointSummaries = [...(base.point_summaries || [])];
    let mergedPointTranslations = [...(base.point_translations || [])];
    const mergedLevels = (base.point_split || []).map((_, i) => base.point_importance_levels?.[i] || 1);
    let maxImportance = base.importance_level || 1;

    // 收集所有bbox用于合并（使用副本避免引用问题）
    const allBboxes = base.bbox ? [[...base.bbox]] : [];
    // console.log(`[_mergeMultipleParagraphs] 基础段落bbox:`, JSON.stringify(base.bbox));

    // 逐个合并后续段落
    for (let k = 1; k < paragraphs.length; k++) {
      const para = paragraphs[k];
      const currentSentenceOffset = mergedSentences.length;
      const isEquation = para.specialType === 'equation' || para.paragraph_type === 'equation';
      const isExplanation = this._isEquationExplanationText(para.text);

      // console.log(`[_mergeMultipleParagraphs] 合并段落${k}: type=${para.paragraph_type}, isEquation=${isEquation}, bbox=`, para.bbox);

      // 合并文本
      mergedText += '\n' + (para.text || '');

      // 合并句子（重新编号）
      const paraSentences = (para.sentences || []).map((s, idx) => ({
        ...s,
        sentence_idx: currentSentenceOffset + idx,
        specialType: isEquation ? 'equation' : isExplanation ? 'equation_explanation' : s.specialType
      }));
      mergedSentences.push(...paraSentences);

      // 合并point信息
      const newPointIndices = paraSentences.map((_, idx) => currentSentenceOffset + idx);
      mergedPointSplit.push(newPointIndices);
      mergedLevels.push(isEquation ? 1 : Math.max(1, ...(para.point_importance_levels || [])));
      mergedPointSummaries.push(para.paragraph_summary || '');

      // ✅ 修复：根据段落类型处理翻译合并
      if (isEquation) {
        // 使用 MinerU 原始 LaTeX 作为公式翻译，方便用户查看公式原文
        mergedPointTranslations.push(para.mineruText || para.text || '');
        // console.log(`[_mergeMultipleParagraphs] equation段落${k}使用MinerU LaTeX作为翻译`);
      } else {
        // 普通段落（包括 isExplanation 文本块）：合并所有 point 的翻译
        // 因为一个段落可能有多个 points，需要将所有翻译合并为一个完整的翻译
        const translations = para.point_translations || [];
        if (Array.isArray(translations) && translations.length > 0) {
          // 将所有 point 翻译合并，用换行符分隔
          // console.log("[mergeMultipleParagraphs] 合并point翻译时的translations：", translations);
          const mergedTranslation = translations.filter((t) => t && t.trim()).join('\n');
          mergedPointTranslations.push(mergedTranslation);
          // console.log(`[_mergeMultipleParagraphs] 段落${k}合并${translations.length}个point翻译: "${mergedTranslation.substring(0, 50)}..."`);
        } else {
          mergedPointTranslations.push('');
          // console.log(`[_mergeMultipleParagraphs] 段落${k}没有翻译内容`);
        }
      }

      // 更新重要性
      maxImportance = Math.max(maxImportance, para.importance_level || 1);

      // 收集bbox（使用副本避免引用问题）
      if (para.bbox) {
        allBboxes.push([...para.bbox]);
        // console.log(`[_mergeMultipleParagraphs] 添加bbox到allBboxes，当前数量: ${allBboxes.length}`);
      } else {

        // console.log(`[_mergeMultipleParagraphs] 段落${k}没有bbox`);
      }}

    // console.log(`[_mergeMultipleParagraphs] 收集完成，总共${allBboxes.length}个bbox:`, allBboxes);
    // 合并所有bbox为一个最大边界
    const mergedBbox = this._mergeBboxArray(allBboxes);
    // console.log("[_mergeMultipleParagraphs] 最终合并bbox:", mergedBbox);
    return {
      page_idx: base.page_idx,
      paragraph_idx: base.paragraph_idx,
      paragraph_type: 'text_with_equation',
      type: 'text_with_equation',
      text: mergedText,
      paragraph_text: mergedText,
      typography: base.typography,
      sentences: mergedSentences,
      importance_level: maxImportance,
      paragraph_summary: base.paragraph_summary,
      point_split: mergedPointSplit,
      point_summaries: mergedPointSummaries,
      point_translations: mergedPointTranslations,
      point_importance_levels: mergedLevels,
      bbox: mergedBbox,
      minerUid: base.minerUid,
      _mergedCount: paragraphs.length
    };
  }

  /**
   * 合并多个bbox为一个最大边界的bbox
   * bbox格式：[x0, y0, x1, y1] (千分比，左上右下)
   * @param {Array} bboxes - bbox数组
   * @returns {Array|null} 合并后的bbox
   */
  _mergeBboxArray(bboxes) {
    const validBboxes = bboxes.filter((b) => b && Array.isArray(b) && b.length === 4);
    if (validBboxes.length === 0) {
      return null;
    }
    if (validBboxes.length === 1) {
      // 返回新数组，避免引用问题
      const result = [...validBboxes[0]];
      return result;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x0, y0, x1, y1] of validBboxes) {
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0); // y0是上边界（值越小越靠上）
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1); // y1是下边界（值越大越靠下）
    }
    const result = [minX, minY, maxX, maxY];
    return result;
  }

  /**
   * 合并text和equation段落
   * @param {Object} textParagraph - 文本段落
   * @param {Object} equationParagraph - equation段落
   * @returns {Object} 合并后的段落
   */
  _mergeTextWithEquation(textParagraph, equationParagraph) {
    // console.log("[Reader] _mergeTextWithEquation textParagraph:", textParagraph);
    // console.log("[Reader] _mergeTextWithEquation equationParagraph:", equationParagraph);

    const textSentences = textParagraph.sentences || [];
    const equationSentences = equationParagraph.sentences || [];
    const textSentenceCount = textSentences.length;

    // equation句子在合并后的正确索引
    const equationSentenceIndices = equationSentences.map((_, idx) => textSentenceCount + idx);
    return {
      page_idx: Math.min(textParagraph.page_idx, equationParagraph.page_idx),
      paragraph_idx: textParagraph.paragraph_idx,
      paragraph_type: 'text_with_equation',
      text: `${textParagraph.text}\n${equationParagraph.text}`,
      paragraph_text: `${textParagraph.text}\n${equationParagraph.text}`,
      typography: textParagraph.typography,
      type: 'text_with_equation',
      sentences: [...textSentences, ...equationSentences.map((sentence, idx) => ({
        ...sentence,
        sentence_idx: textSentenceCount + idx,
        specialType: 'equation'
      }))],
      importance_level: Math.max(textParagraph.importance_level || 1, equationParagraph.importance_level || 1),
      paragraph_summary: textParagraph.paragraph_summary,
      // 修复：point_split 使用正确的句子索引
      point_split: [...(textParagraph.point_split || []), equationSentenceIndices],
      point_summaries: [...(textParagraph.point_summaries || []), equationParagraph.paragraph_summary],
      point_translations: [...(textParagraph.point_translations || []), equationParagraph.point_translations || []],
      point_importance_levels: [...(textParagraph.point_split || []).map((_, i) => textParagraph.point_importance_levels?.[i] || 1), 1],
      // 保留bbox用于fallback
      bbox: textParagraph.bbox,
      equationBbox: equationParagraph.bbox,
      minerUid: textParagraph.minerUid
    };
  }

  async llmRequest(processedParagraphData) {
    // 预处理：识别equation并建立映射关系
    const {
      cleanParagraphData,
      equationMapping
    } = this._preprocessEquationMapping(processedParagraphData);
    // console.log('[Reader] 预处理完成, cleanParagraphData:', cleanParagraphData, 'equationMapping:', equationMapping);

    // 🚀 优化：按页并发请求，一次性生成 summary + 翻译
    let llmResults = await this._generateSummaryAndTranslationByPage(cleanParagraphData);
    // console.log('[Reader] LLM处理完成，最终结果段落:', llmResults);

    // 后处理：使用映射关系处理equation的智能合并，确保equation作为独立point
    let finalResults = this._postProcessLLMResult(llmResults, equationMapping);
    if (DeepRead.TranslationLayout) finalResults = await DeepRead.TranslationLayout.complete(finalResults, {
      request: (options) => this._llm(options), targetLang: this._llmPromptLanguage, signal: this._signal,
    });
    if (DeepRead.Continuations) {
      const prepared = finalResults.map((p) => ({ ...p, sourceStyledText: (p.sentences || []).map((s) =>
        DeepRead.Typography?.styledSentence(s, this._summaryManager.charsDataList || []) ?? s.text).join(" ") }));
      const joined = await DeepRead.Continuations.reconcile(prepared, {
        complete: (options) => this._llm(options), targetLang: this._llmPromptLanguage, signal: this._signal,
        visuals: this._summaryManager.getPdfContentList(),
      });
      finalResults = joined.paragraphs;
    }

    // console.log('[Reader] 后处理完成，bbox检查:', finalResults);

    // 逐页侧已结束；若界面仍停很久，多半是 Promise.allSettled 还在等并行的 articleSummaryRequest
    this._setFlowProgressMessage(this._bilingual('等待全文 Article Summary 生成', 'Waiting for full Article Summary generation'));
    return finalResults;
  }

  /**
   * � 并发控制器：限制同时执行的 Promise 数量
   * @param {number} concurrency - 最大并发数
   * @returns {Function} 限流执行函数
   */
  _createConcurrencyLimiter(concurrency) {
    const queue = [];
    let activeCount = 0;
    const next = () => {
      activeCount--;
      if (queue.length > 0) {
        queue.shift()();
      }
    };
    const run = async (fn) => {
      activeCount++;
      try {
        return await fn();
      } finally {
        next();
      }
    };
    const enqueue = (fn) => {
      return new Promise((resolve, reject) => {
        const task = () => run(fn).then(resolve, reject);
        if (activeCount < concurrency) {
          task();
        } else {
          queue.push(task);
        }
      });
    };
    return enqueue;
  }

  /**
   * 限制「页级 LLM 请求」的启动时刻：任意两次请求开始之间至少间隔 GAP_MS，避免瞬时打满连接/服务端。
   * 用 Promise 链串行化调度计算，多路 await 仍安全。
   * @param {number} pageIdx - 用于日志对照
   */
  async _throttlePageLLMRequestStart(pageIdx) {
    const GAP_MS = 100;
    if (!this._pageLLMThrottleTail) {
      this._pageLLMThrottleTail = Promise.resolve();
    }
    const scheduled = this._pageLLMThrottleTail.then(async () => {
      const now = Date.now();
      const next = this._pageLLMNextRequestSlotAt || 0;
      const wait = Math.max(0, next - now);
      this._pageLLMNextRequestSlotAt = Math.max(now, next) + GAP_MS;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      const firedAt = Date.now();
      const prevFired = this._pageLLMLastRequestFireAt;
      this._pageLLMLastRequestFireAt = firedAt;
      // const gapSincePrev = prevFired != null ? firedAt - prevFired : null;
      // console.log(
      // 	`[Reader][页LLM节流] page=${pageIdx} 排队等待=${wait}ms 距上一请求发出=${gapSincePrev != null ? `${gapSincePrev}ms` : '首包'} 放行时刻=${firedAt}`
      // );
    });
    this._pageLLMThrottleTail = scheduled.catch(() => {});
    await scheduled;
  }

  /**
   * 🚀 优化版：按页并发请求，每页独立完成 请求→校验→重试 流程
   * 支持最大并发数限制，避免 API 限流
   * @param {Array} cleanParagraphData - 预处理后的段落数据
   * @returns {Array} 包含 summary 和翻译的完整结果
   */
  async _generateSummaryAndTranslationByPage(cleanParagraphData) {
    // console.log('[Reader] 🚀 开始按页并发处理...');
    const startTime = Date.now();

    // 🔧 最大并发数配置（可根据 API 限制调整）
    const MAX_CONCURRENCY = this._concurrency;

    // 1. 按页分组
    const pageGroups = new Map();
    for (const para of cleanParagraphData) {
      const pageIdx = para.page_idx;
      if (!pageGroups.has(pageIdx)) {
        pageGroups.set(pageIdx, []);
      }
      pageGroups.get(pageIdx).push(para);
    }
    const pageIndices = Array.from(pageGroups.keys()).sort((a, b) => a - b);
    // console.log(`[Reader] 共 ${pageIndices.length} 页需要处理，最大并发数: ${MAX_CONCURRENCY}`);
    const totalPages = pageIndices.length;
    let completedPages = 0;

    // Flow进度：逐页 LLM（并发执行，按完成页数推进）
    if (totalPages > 0) {
      this._setFlowProgress({
        percent: 71,
        message: this._bilingual(`逐页总结准备中（0/${totalPages}）…`, `Preparing per-page summary (0/${totalPages})...`)
      });
    }

    // 2. 创建并发限制器
    const limit = this._createConcurrencyLimiter(MAX_CONCURRENCY);

    // 3. 使用并发限制器处理所有页面
    const pagePromises = pageIndices.map((pageIdx) => {
      const pageParagraphs = pageGroups.get(pageIdx);
      // 通过限制器包装每个页面的处理任务
      // DeepRead: stop scheduling new page work once the flow was aborted
      return limit(() => {
        this._checkFlowAborted();
        return this._processPageWithValidation(pageIdx, pageParagraphs);
      }).then((res) => {
        completedPages++;
        if (totalPages > 0) {
          const percent = 71 + Math.floor(completedPages / totalPages * 18); // 71-89（为 MinerU 让出 18–38 后压缩本段）
          // 最后一页：仅更新进度数字；「合并」指 Promise.all 拼数组 + 后续公式合并，极快，真正耗时常在等并行全文总结
          this._setFlowProgress({
            percent,
            message: this._bilingual(`逐页总结（${completedPages}/${totalPages}）…`, `Per-page summary (${completedPages}/${totalPages})...`)
          });
        }
        return res;
      });
    });
    try {
      const pageResults = await Promise.all(pagePromises);

      // 4. 按页码顺序合并所有结果
      const allResults = [];
      for (const {
        pageIdx,
        results
      } of pageResults.sort((a, b) => a.pageIdx - b.pageIdx)) {
        allResults.push(...results);
      }
      const endTime = Date.now();
      // console.log(`[Reader] 🚀 按页并发处理完成，共 ${allResults.length} 个段落，耗时: ${((endTime - startTime) / 1000).toFixed(2)}秒`);

      return allResults;
    } catch (error) {
      // console.log()
      // 捕获 429 错误并显示用户提示对话框
      if (error.message && error.message.includes('429')) {
        console.error('[Reader] ❌ 达到 API 并发限制 (429 错误)');
        // 显示中文错误对话框（黑白 Notion 风格）
        await this._showAPIErrorDialog();
      }
      throw error;
    }
  }

  /**
   * 处理单页：请求 → 校验 → 重试，独立完成整个流程
   * @param {number} pageIdx - 页面索引
   * @param {Array} paragraphs - 该页的段落数据
   * @returns {Object} { pageIdx, results }
   */
  async _processPageWithValidation(pageIdx, paragraphs) {
    // 🌟 新增限制：如果当前页段落数超过 50，则判定为异常页面（如目录、参考文献集），直接跳过大模型解析
    if (paragraphs && paragraphs.length > 50) {
      console.warn(`[Reader] ⚠️ 页面 ${pageIdx} 段落数异常 (${paragraphs.length} > 50)，跳过解析`);
      return {
        pageIdx,
        results: []
      };
    }

    // console.log(`[Reader] 页面 ${pageIdx} 开始处理，共 ${paragraphs.length} 个段落`);
    const MAX_RETRIES = 4;

    // 构建该页的预期ID集合
    const expectedIds = new Set(paragraphs.map((p) => `${p.page_idx}_${p.paragraph_idx}`));
    let currentParagraphs = paragraphs;
    let validResults = new Map(); // paraId -> validated result
    let retryCount = 0;
    try {
      while (currentParagraphs.length > 0 && retryCount <= MAX_RETRIES) {
        // 1. 请求 LLM
        let apiResults;
        try {
          await this._throttlePageLLMRequestStart(pageIdx);
          apiResults = await this._requestPageSummaryAndTranslation(pageIdx, currentParagraphs);
        } catch (requestError) {
          // DeepRead: abort must not be swallowed by the retry loop
          if (requestError && requestError.name === 'AbortError') {
            throw requestError;
          }
          // 🔴 关键：检查是否是 429 错误（并发限制）
          if (requestError.message && requestError.message.includes('429')) {
            throw requestError;
          }
          console.warn(`[Reader] 页面 ${pageIdx} API请求出错 (重试 ${retryCount}/${MAX_RETRIES}): ${requestError.message}`);
          retryCount++;
          continue;
        }

        // 2. 校验每个段落
        const validBatch = [];
        const invalidBatch = [];
        for (const para of apiResults) {
          const paraId = `${para.page_idx}_${para.paragraph_idx}`;
          const sentenceCount = Array.isArray(para.sentences) ? para.sentences.length : 0;

          // 校验 ID
          if (!expectedIds.has(paraId)) {
            invalidBatch.push(para);
            continue;
          }

          // 校验 paragraph_summary 与 point_split / summaries / translations
          const requireTranslation = true;
          const isValid = this._isPointSplitValidWithTranslation(para.point_split, sentenceCount, para.point_summaries || [], para.point_translations || [], requireTranslation);
          if (isValid) {
            validBatch.push(para);
          } else {
            // console.warn(`[Reader] 段落 ${paraId} 验证失败:`, {
            // 	sentenceCount,
            // 	point_split: para.point_split,
            // 	point_summaries_len: (para.point_summaries || []).length,
            // 	point_translations_len: (para.point_translations || []).length,
            // 	sentences_preview: (para.sentences || []).slice(-3).map(s => s.text?.substring(0, 40))
            // });
            invalidBatch.push(para);
          }
        }

        // 3. 保存有效结果
        for (const para of validBatch) {
          const paraId = `${para.page_idx}_${para.paragraph_idx}`;
          validResults.set(paraId, para);
        }
        console.log(`[Reader] 页面 ${pageIdx} 第 ${retryCount + 1} 轮: 有效 ${validBatch.length}, 无效 ${invalidBatch.length}`);

        // 4. 准备重试
        if (invalidBatch.length === 0) {
          // console.log("全部校验通过")
          break; //全部校验通过
        }
        retryCount++;
        if (retryCount <= MAX_RETRIES) {
          // 从原始数据中获取需要重试的段落
          currentParagraphs = invalidBatch.map((invalid) => {
            const paraId = `${invalid.page_idx}_${invalid.paragraph_idx}`;
            return paragraphs.find((p) => `${p.page_idx}_${p.paragraph_idx}` === paraId) || invalid;
          });
        } else {
          // 达到最大重试次数，使用空结果
          for (const para of invalidBatch) {
            const paraId = `${para.page_idx}_${para.paragraph_idx}`;
            if (!validResults.has(paraId)) {
              validResults.set(paraId, {
                ...para,
                paragraph_summary: '',
                importance_level: 1,
                point_split: [],
                point_summaries: [],
                point_translations: []
              });
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Reader] 页面 ${pageIdx} 请求失败:`, error);
      // DeepRead: propagate abort instead of falling back to empty results
      if (error && error.name === 'AbortError') {
        throw error;
      }

      // 🔴 关键：检查是否是 429 错误（并发限制）
      // 如果是 429，直接抛出原始错误，不要包装，让上层处理
      if (error.message && error.message.includes('429')) {
        console.error('[Reader] ❌ 检测到 API 并发限制 (429 错误)，停止重试并向上层抛出');
        throw error; // 直接抛出原始 429 错误
      }

      // 其他错误：所有重试失败，使用空结果
      for (const para of currentParagraphs) {
        const paraId = `${para.page_idx}_${para.paragraph_idx}`;
        if (!validResults.has(paraId)) {
          validResults.set(paraId, {
            ...para,
            paragraph_summary: '',
            importance_level: 1,
            point_split: [],
            point_summaries: [],
            point_translations: []
          });
        }
      }
    }

    // 5. 按原始顺序返回结果
    const finalResults = paragraphs.map((para) => {
      const paraId = `${para.page_idx}_${para.paragraph_idx}`;
      return validResults.get(paraId) || {
        ...para,
        paragraph_summary: '',
        importance_level: 1,
        point_split: [],
        point_summaries: [],
        point_translations: []
      };
    });
    console.log(`[Reader] 页面 ${pageIdx} 处理完成，共 ${finalResults.length} 个段落，重试 ${retryCount} 次`);
    return {
      pageIdx,
      results: finalResults
    };
  }

  /**
   * 校验 point_split 是否有效（包含翻译数量校验）
   * @param {boolean} requireTranslation - 是否要求翻译（英文模式下为 false）
   */
  _isPointSplitValidWithTranslation(point_split, sentenceCount, point_summaries, point_translations, requireTranslation = true) {
    if (!Array.isArray(point_split) || point_split.length === 0) {
      return false;
    }
    const pointCount = point_split.length;

    // 检查 point_summaries 长度是否一致
    if (point_summaries.length !== pointCount) {
      return false;
    }

    // 仅在需要翻译时检查 point_translations
    if (requireTranslation && (!Array.isArray(point_translations) || point_translations.length !== pointCount)) {
      return false;
    }

    // 检查句子索引覆盖
    const coveredIndices = new Set();
    for (const point of point_split) {
      if (!Array.isArray(point)) return false;
      for (const idx of point) {
        if (typeof idx !== 'number' || idx < 0 || idx >= sentenceCount) return false;
        if (coveredIndices.has(idx)) return false;
        coveredIndices.add(idx);
      }
    }
    if (coveredIndices.size !== sentenceCount) return false;

    // 检查每个 point 的 summary 有效性
    for (let i = 0; i < pointCount; i++) {
      const summary = point_summaries[i];
      if (typeof summary !== 'string' || summary.trim().length < 2) return false;

      // 仅在需要翻译时检查 translation 有效性
      if (requireTranslation) {
        const translation = point_translations[i];
        if (typeof translation !== 'string' || translation.trim().length < 1) return false;
      }
    }
    return true;
  }

  /**
   * 请求单页的 summary + 翻译
   * @param {number} pageIdx - 页面索引
   * @param {Array} paragraphs - 该页的段落数据
   * @returns {Array} 处理后的段落数据（包含 summary 和翻译）
   */
  async _requestPageSummaryAndTranslation(pageIdx, paragraphs) {
    // console.log(`[Reader] 处理第 ${pageIdx} 页，共 ${paragraphs.length} 个段落`);

    // 单个页面 LLM 请求超时时间：4 分钟（240000 毫秒）
    const PAGE_LLM_TIMEOUT_MS = 4 * 60 * 1000;
    const PAGE_SUMMARY_MAX_TOKENS = 8192;

    // ------------------------------------------
    // ------------------------------------------
    const prompt = this._buildPagePrompt(paragraphs);
    let apiResponse;
    try {
      const pageSummarySchema = DeepRead.ResponseFormats.pageSummaryFormat();
      // console.log('[_requestPageSummaryAndTranslation] 📋 发送的 response_format:', JSON.stringify(pageSummarySchema.response_format, null, 2));

      // 使用 Promise.race 实现超时机制
      // console.warn(`[Reader/Page_${pageIdx}_Summary] 请求 page summary: paragraphs=${paragraphs.length}, promptChars=${prompt.length}, max_tokens=${PAGE_SUMMARY_MAX_TOKENS}`);
      const llmPromise = this._call_llm_api(prompt, {
        ...pageSummarySchema,
        max_tokens: PAGE_SUMMARY_MAX_TOKENS,
        system: this._buildSystemPrompt()
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`页面 ${pageIdx} LLM 请求超时（超过 ${PAGE_LLM_TIMEOUT_MS / 1000 / 60} 分钟）`));
        }, PAGE_LLM_TIMEOUT_MS);
      });
      apiResponse = await Promise.race([llmPromise, timeoutPromise]);
    } catch (error) {
      // console.log("[_requestPageSummaryAndTranslation],报错：", error);
      // 🔴 检查是否是超时错误
      if (error.message && error.message.includes('超时')) {
        console.error(`[Reader] ⏱️ 页面 ${pageIdx} LLM 请求超时:`, error.message);
        throw error; // 直接抛出超时错误
      }

      // 🔴 关键：先检查是否是 429 错误，如果是则直接抛出（不包装）
      if (error.message && error.message.includes('429')) {
        console.error(`[Reader] 页面 ${pageIdx} 遇到 429 错误:`, error.message);
        throw error; // 直接抛出原始 429 错误，让上层处理
      }

      // 其他 API 调用错误也直接抛出
      console.error(`[Reader] 页面 ${pageIdx} API 调用失败:`, error.message);
      throw error;
    }
    // console.log("apiResponse (raw): ", apiResponse);
    //-------------------------------------------
    // ------------------------------------------

    // 1. 尝试解析 JSON 字符串
    let parsedResponse;
    if (typeof apiResponse === 'string') {
      // console.warn(`[Reader/Page_${pageIdx}_Summary] 原始响应长度: ${apiResponse.length}`);
      parsedResponse = this._parseJSONWithRetry(apiResponse, `Page_${pageIdx}_Summary`);
    } else {
      // console.warn(`[Reader/Page_${pageIdx}_Summary] 收到对象响应，paragraphs=${apiResponse?.paragraphs?.length ?? 'unknown'}`);
      parsedResponse = apiResponse;
    }

    // console.log("parsedResponse: ", parsedResponse);

    // 2. 适配 Object/Array 两种返回格式
    let processResult = parsedResponse;
    if (processResult && !Array.isArray(processResult) && processResult.paragraphs && Array.isArray(processResult.paragraphs)) {
      processResult = processResult.paragraphs;
    }
    // console.log("[Reader], processResult:", processResult);

    // 检查 API 响应格式
    if (!processResult || !Array.isArray(processResult)) {
      throw new Error(this._bilingual(`页面 ${pageIdx} API 返回格式错误`, `API response format error on page ${pageIdx}`));
    }

    // 合并API结果与原始数据
    const results = [];
    for (const para of paragraphs) {
      const paraId = `${para.page_idx}_${para.paragraph_idx}`;
      const matched = processResult.find((r) => r.id === paraId);
      if (matched) {
        // 处理翻译：将 point_translations 数组与 point_split 对齐
        let pointTranslations = [];
        if (matched.point_translations && Array.isArray(matched.point_translations)) {
          pointTranslations = matched.point_translations;
        }
        results.push({
          ...para,
          paragraph_summary: matched.paragraph_summary || '',
          importance_level: 1,
          // paragraph的importance_level暂时没用到，全设置为1
          point_split: matched.point_split || [],
          point_summaries: matched.point_summaries || [],
          point_translations: pointTranslations,
          translationLayout: DeepRead.TranslationLayout?.accept(para.translationLayout, matched.layout_translations) || para.translationLayout,
          point_importance_levels: Array.isArray(matched.point_importance_levels)
            && matched.point_importance_levels.length === (matched.point_split || []).length
            && matched.point_importance_levels.every((v) => Number.isInteger(v) && v >= 1 && v <= 3)
            ? matched.point_importance_levels : undefined
        });
      } else {
        // 未找到匹配，保留原数据
        results.push({
          ...para,
          paragraph_summary: '',
          importance_level: 1,
          point_split: [],
          point_summaries: [],
          point_translations: []
        });
      }
    }
    return results;
  }

  /**
   * 构建单页的 prompt（同时请求 summary + 翻译）
   * @param {Array} paragraphs - 该页的段落数据
   * @returns {string} prompt 字符串
   */
  _buildPagePrompt(paragraphs) {
    const lang = DeepRead.PARSE_LANGUAGES[this._llmPromptLanguage] || DeepRead.PARSE_LANGUAGES['en'];
    const taskDescription = this._useChinesePrompt() ? `你将收到一个段落列表，每个段落包含多个句子。请为每个段落生成：

1. paragraph_summary：使用 ${lang.instruction} 写一句精炼摘要（10词或等量字数以内）。必须具体。
2. point_split：将段落句子划分为若干逻辑要点，格式为 [[0,1],[2,3]]。每个 point 表示介于单句和段落之间的“句子组”。
   - 划分原则：积极合并语义相近、同一子主题、因果关系或递进关系的相邻句子。只有相邻句子讨论明显不同子主题时才拆分。
   - 数量：通常灵活控制在 2-4 个 points。语义统一时可以只有 1 个，复杂段落可以更多。不要强行合并无关句子。
   - 格式：索引从 0 开始。points 必须覆盖所有句子，不能遗漏。单句段落使用 [[0]]。
3. point_summaries：数组，与 point_split 对齐。每个元素是使用 ${lang.instruction} 写的精炼摘要（10词或等量字数以内）。
4. point_translations：数组，与 point_split 对齐。每个元素是将该 point 中所有句子完整、流畅翻译成 ${lang.instruction} 的结果。
   - 原文句子中的 **粗体**、*斜体* 是真实排版标记：仅将对应译文用同样标记包裹，普通文字保持普通，不要自行强调或把整段加粗。保留列表项与段落边界。
   - 尽量保持与原文相近的显示篇幅：用紧凑自然的中文，避免解释性扩写；数字、限定条件、因果和技术含义不能删减，也不能为了凑长度添加内容。
   - 翻译必须准确完整，每项必须是非空字符串
   - 如果一个 point 包含多个句子，请把它们作为一个连贯语义单元翻译
   - 为保证准确性，成熟技术术语可以保留英文
   - paragraph_summary、point_summaries、point_translations 必须使用 ${lang.instruction}；英文只能用于必要的专有名词、模型名、数据集名和指标名，不能输出完整英文解释句

5. point_importance_levels：与 point_split 对齐的整数数组，1=普通，2=重要，3=核心贡献或关键证据。只突出少数真正承载主张的要点，多数为 1；不要整页都设为 2 或 3。

**示例**：
输入段落（4 个句子）：
“The goal of reducing sequential computation also forms the foundation of the Extended Neural GPU [16], ByteNet [18] and ConvS2S [9]...”

输出（目标语言为简体中文时）：
{
“paragraphs”: [
  {
    “id”: “0_0”,
    “paragraph_summary”: “Transformer相对于卷积神经网络的优势”,
    “point_split”: [[0], [1, 2], [3]],
    “point_importance_levels”: [1, 2, 3],
    “point_summaries”: [“卷积神经网络能减少顺序计算”, “但难以学习远程依赖关系”, “Transformer将操作数降为常数”],
    “point_translations”: [“减少顺序计算的目标也构成了...”, “在这些模型中，关联任意位置信号所需的操作数随距离增长...”, “在Transformer中，这被减少到恒定数量的操作...”]
  }
]
}` : `You will receive a list of paragraphs, each containing multiple sentences. For each paragraph, generate:

1. paragraph_summary: A concise summary in ${lang.instruction} (10 words or equivalent or less). Be specific.
2. point_split: Divide paragraph sentences into logical points, formatted as [[0,1],[2,3]]. Each point represents a “sentence group” between a sentence and a paragraph.
   - Division Principle: Aggressively merge adjacent sentences with similar semantics, same sub-topics, cause-effect, or progressive relationships. Only split when adjacent sentences discuss distinctly different sub-topics.
   - Quantity: Flexibly 2-4 points ideally. Can be 1 for unified meaning, or more for complex paragraphs. Don't force unrelated sentences together.
   - Format: Indices start from 0. Points must cover all sentences without omission. Single-sentence paragraph: [[0]].
3. point_summaries: Array aligned with point_split. Each element: concise summary in ${lang.instruction} (10 words or equivalent or less).
4. point_translations: Array aligned with point_split. Each element: complete, fluent translation of all sentences in that point into ${lang.instruction}.
   - Source **bold** and *italic* mark actual typography: preserve emphasis on the corresponding translated words only. Keep unmarked text plain; never bold the whole paragraph or invent emphasis. Preserve list and paragraph boundaries.
   - Prefer concise, natural wording close to the source visual length. Do not expand into explanations, omit qualifications/numbers/causality, or add filler to force equal lengths.
   - Translations must be accurate and complete; each must be a non-empty string
   - If a point has multiple sentences, translate them as a cohesive unit
   - Established technical terms may remain in English for accuracy

5. point_importance_levels: Integers aligned with point_split: 1=ordinary, 2=important, 3=central contribution or evidence. Highlight sparsely; most points should be 1. Do not mark the whole page important.

**Example**:
Input paragraph (4 sentences):
“The goal of reducing sequential computation also forms the foundation of the Extended Neural GPU [16], ByteNet [18] and ConvS2S [9]...”

Output (if target language is English):
{
“paragraphs”: [
  {
    “id”: “0_0”,
    “paragraph_summary”: “Transformer advantages over convolution”,
    “point_split”: [[0], [1, 2], [3]],
    “point_importance_levels”: [1, 2, 3],
    “point_summaries”: [“Convolution reduces sequential computation”, “But long-range dependencies remain hard”, “Transformer makes operations constant”],
    “point_translations”: [“The goal of reducing sequential computation also forms the foundation of...”, “In these models, the number of operations required to relate signals at arbitrary positions grows with distance...”, “In the Transformer, this is reduced to a constant number of operations...”]
		  }
		]
}`;
    const formattedParagraphs = paragraphs.map((para) => {
      const paraId = `${para.page_idx}_${para.paragraph_idx}`;
      const sentences = para.sentences.map((s, idx) => `[${idx}] ${JSON.stringify(DeepRead.Typography?.styledSentence(s, this._summaryManager.charsDataList || []) ?? s.text)}`).join('\n  ');
      const layout = para.translationLayout?.units || [];
      const structure = layout.length > 1 ? `\nSource layout units for ${paraId}: ${JSON.stringify(layout.map((u) => ({ unit_id: u.id, kind: u.kind, source_text: u.styledText || u.sourceText })))}` : "";
      return `{ id: “${paraId}”, sentences: [\n  ${sentences}\n] }${structure}`;
    }).join('\n\n');
    const jsonInstructions = this._useChinesePrompt() ? `只返回一个 JSON 对象，其中包含 'paragraphs' 数组。每个 item 必须包含：id、paragraph_summary、point_split、point_summaries、point_translations、point_importance_levels、layout_translations。key 和字符串值必须使用英文双引号。不要返回解释、Markdown 代码块或其他文本。` : `Return only a JSON object containing a 'paragraphs' array. Each item must contain: id, paragraph_summary, point_split, point_summaries, point_translations, point_importance_levels, layout_translations. Use double quotes for keys and values.`;
    const paragraphListLabel = this._useChinesePrompt() ? '段落列表' : 'Paragraph list';
    const layoutInstruction = this._useChinesePrompt()
      ? "6. layout_translations：若附有 Source layout units，按每个原始段落／列表项返回 [{unit_id, translation}]，所有 unit_id 必须完整且唯一。各项独立翻译，不能合并、换序或省略；只返回正文，列表标记由排版器恢复；保留粗体和斜体。没有提供 units 时返回 []。"
      : "6. layout_translations: When Source layout units are supplied, return [{unit_id, translation}] covering each original paragraph/list item exactly once. Translate independently without merging, reordering or omission; omit list markers (the renderer owns them). Preserve emphasis. Return [] when no units are supplied.";
    return `${taskDescription}\n${layoutInstruction}\n\n${paragraphListLabel}:\n${formattedParagraphs}\n\n${jsonInstructions}`;
  }

  _calculatePageLeftmostX(contentList) {
    const pageLeftmostX = {};
    for (const item of contentList) {
      if (item.bbox && Array.isArray(item.bbox) && item.bbox.length === 4) {
        const pageIdx = item.page_idx;
        const x1 = item.bbox[0];
        if (pageLeftmostX[pageIdx] === undefined || x1 < pageLeftmostX[pageIdx]) {
          pageLeftmostX[pageIdx] = x1;
        }
      }
    }
    return pageLeftmostX;
  }

  /**
   * 转换bbox坐标：从左上角原点(MinerU)转换为左下角原点(PDF标准)
   * 同时适配ViewBox扩展，并实现右对齐布局
   * @param {Array} bbox - [x1, y1, x2, y2] 左上角坐标系
   * @param {number} originalWidth - PDF页面原始宽度
   * @param {number} originalHeight - PDF页面原始高度
   * @param {number} expandedWidth - 扩展后的页面宽度
   * @param {number} expandedHeight - 扩展后的页面高度
   * @param {number} pageLeftmostX - 当前页面最左边bbox的x坐标
   * @returns {Array} [x1, y1, x2, y2] 左下角坐标系，已适配ViewBox扩展
   */
  _convertBboxToPDFCoords(bbox, originalWidth, originalHeight, expandedWidth, expandedHeight, pageLeftmostX) {
    const maxWidth = 200; // vibecard最大宽度
    const leftOffset = 100; // vibecard右边距离最左bbox的间距
    const topOffset = 50; // vibecard在y轴方向的上移距离
    const leftMargin = -(expandedWidth - originalWidth) / 2;
    const [x1_top, y1_top, x2_top, y2_top] = bbox;

    // 步骤1: 坐标系转换（左上角→左下角）
    // PDF坐标系：Y轴向上，原点在左下角
    const y1_pdf = expandedHeight - y2_top; // 注意：bbox的y2是底部，对应PDF的y1
    const y2_pdf = expandedHeight - y1_top; // bbox的y1是顶部，对应PDF的y2
    // console.log("stage 1:", [x1_pdf, y1_pdf, x2_pdf, y2_pdf]);

    // 步骤2: 适配ViewBox扩展
    // 原始坐标系：[0, originalWidth] → 扩展后：[-originalWidth/2, 3*originalWidth/2]
    // 原始内容在新坐标系中的偏移量为 originalWidth/2
    const viewBoxOffset = (expandedWidth - originalWidth) / 2;
    // console.log("stage 2:", [x1_adjusted, y1_pdf, x2_adjusted, y2_pdf]);

    // 步骤3: 计算vibecard位置（右对齐）
    // vibecard右边界 = 页面最左bbox - leftOffset
    const vibeRightX = pageLeftmostX - leftOffset;
    // vibecard左边界 = 右边界 - 最大宽度
    const vibeLeftX = vibeRightX - maxWidth < leftMargin ? leftMargin : vibeRightX - maxWidth;

    // 应用ViewBox偏移
    const vibeX1 = vibeLeftX;
    const vibeX2 = vibeRightX;
    const vibeY1 = y1_pdf + topOffset;
    const vibeY2 = y2_pdf + topOffset;
    return [vibeX1, vibeY1, vibeX2, vibeY2];
  }

  /**
   * 获取页面尺寸信息
   * @param {number} pageIndex - 页面索引
   * @returns {Promise<{originalWidth: number, originalHeight: number, expandedWidth: number, expandedHeight: number}>} 页面尺寸
   */
  async _getPageDimensions(pageIndex) {
    try {
      // 通过PDFView获取页面信息
      if (this._primaryView && this._primaryView._iframeWindow) {
        const pdfDocument = this._primaryView._iframeWindow.PDFViewerApplication?.pdfDocument;
        if (pdfDocument) {
          const page = await pdfDocument.getPage(pageIndex + 1); // PDF页码从1开始
          const viewport = page.getViewport({
            scale: 1.0
          });
          let originalWidth = null;
          let originalHeight = null;
          if (viewport.originalViewBox) {
            const [originX1, originY1, originX2, originY2] = viewport.originalViewBox;
            originalWidth = originX2 - originX1;
            originalHeight = originY2 - originY1;
          }
          let expandedWidth = null;
          let expandedHeight = null;
          if (viewport.viewBox) {
            const [expandedX1, expandedY1, expandedX2, expandedY2] = viewport.viewBox;
            expandedWidth = expandedX2 - expandedX1;
            expandedHeight = expandedY2 - expandedY1;
          }
          const result = {
            originalWidth: originalWidth ?? expandedWidth ?? 612,
            originalHeight: originalHeight ?? expandedHeight ?? 792,
            expandedWidth: expandedWidth ?? originalWidth ?? 612,
            expandedHeight: expandedHeight ?? originalHeight ?? 792
          };
          return result;
        }
      }
      // 如果无法获取，使用默认A4尺寸
      console.warn(`[Reader] 无法获取页面${pageIndex}的尺寸，使用默认值`);
      return {
        originalWidth: 612,
        originalHeight: 792,
        expandedWidth: 612,
        expandedHeight: 792
      }; // A4纸张的PDF点数
    } catch (error) {
      console.error(`[Reader] 获取页面${pageIndex}尺寸失败:`, error);
      return {
        originalWidth: 612,
        originalHeight: 792,
        expandedWidth: 612,
        expandedHeight: 792
      };
    }
  }

  async _convertMinerUBboxToPdfRect(bbox, pageIndex) {
    if (!bbox || bbox.length !== 4) {
      console.warn('[Reader] 无效的 bbox:', bbox);
      return null;
    }

    // 获取页面尺寸信息
    const pageDimensions = await this._getPageDimensions(pageIndex);
    const {
      originalWidth,
      originalHeight
    } = pageDimensions;

    // bbox 是千分比坐标（0-1000），左上右下
    const [x0_permille, y0_permille, x1_permille, y1_permille] = bbox;

    // 转换为 PDF 坐标系
    const x0 = x0_permille / 1000 * originalWidth;
    const x1 = x1_permille / 1000 * originalWidth;

    // Y 坐标需要翻转：PDF 左下原点 vs bbox 左上原点
    const y0_top = y0_permille / 1000 * originalHeight; // bbox 顶部
    const y1_top = y1_permille / 1000 * originalHeight; // bbox 底部

    const y0 = originalHeight - y0_top; // PDF 底部坐标
    const y1 = originalHeight - y1_top; // PDF 顶部坐标

    return [x0, y1, x1, y0]; // 返回 [左, 下, 右, 上] 格式
  }

  /**
   * 从 PDF rect 计算边界（简化版，用于兼容现有代码）
   * @param {Array} pdfRect - [x1, y1, x2, y2] (PDF坐标，左下右上)
   * @returns {Object} - {minX, minY, maxX, maxY}
   */
  _calculateBoundsFromPdfRect(pdfRect) {
    if (!pdfRect || pdfRect.length < 4) {
      return {
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0
      };
    }
    const [x1, y1, x2, y2] = pdfRect;
    return {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2)
    };
  }

  _mergeBboxes(bbox1, bbox2) {
    if (!bbox1 || bbox1.length !== 4) return bbox2;
    if (!bbox2 || bbox2.length !== 4) return bbox1;

    // bbox 格式：[x0, y0, x1, y1]
    // x0: 左边界, y0: 上边界, x1: 右边界, y1: 下边界 (千分比坐标系，左上角原点)

    // 分别取四条边更靠外的值
    const mergedX0 = Math.min(bbox1[0], bbox2[0]); // 最左边界
    const mergedY0 = Math.min(bbox1[1], bbox2[1]); // 最上边界 (Y值越小越靠上)
    const mergedX1 = Math.max(bbox1[2], bbox2[2]); // 最右边界
    const mergedY1 = Math.max(bbox1[3], bbox2[3]); // 最下边界 (Y值越大越靠下)

    return [mergedX0, mergedY0, mergedX1, mergedY1];
  }

  /**
   * 从字符 rects 计算 caption 的 bbox (千分比坐标系，左上角原点)
   * @param {Array} charMapping - 字符映射数组
   * @param {Array} charsDataList - 全局字符数据
   * @returns {Array} caption bbox [x0, y0, x1, y1] (千分比坐标系，左上角原点)
   */
  _calculateCaptionBbox(charMapping, charsDataList) {
    if (!charMapping || charMapping.length === 0) {
      console.warn('[CaptionBbox] 字符映射为空或不存在');
      return null;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let pageIdx = null;
    let originalWidth = null;
    let originalHeight = null;
    let validCharCount = 0;
    let invalidCharCount = 0;
    for (let i = 0; i < charMapping.length; i++) {
      const charGlobalIdx = charMapping[i];
      const char = charsDataList[charGlobalIdx];
      if (!char) {
        invalidCharCount++;
        console.warn(`[CaptionBbox] 字符 ${i}: 索引 ${charGlobalIdx} 在 charsDataList 中不存在`);
        continue;
      }
      if (!char.rect || char.rect.length < 4) {
        invalidCharCount++;
        console.warn(`[CaptionBbox] 字符 ${i}: 缺少 rect 数据或 rect 长度不足`);
        continue;
      }

      // 获取页面信息（只需获取一次）
      if (pageIdx === null) {
        pageIdx = char.pageIndex;

        // 🔧 修复：使用安全页面获取逻辑，处理懒加载情况
        let page = this._primaryView?._pages?.[pageIdx];
        let pageSource = '_primaryView._pages';

        // 如果页面未加载，尝试从PDFViewerApplication获取
        if (!page) {
          const pdfViewer = this._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
          if (pdfViewer && pdfViewer._pages && pdfViewer._pages[pageIdx]) {
            const pageFromViewer = pdfViewer._pages[pageIdx];
            if (pageFromViewer && pageFromViewer.viewport) {
              page = {
                originalPage: {
                  viewport: pageFromViewer.viewport,
                  div: pageFromViewer.div
                }
              };
              pageSource = 'PDFViewerApplication.pdfViewer._pages';
            }
          }
        }
        if (!page || !page.originalPage) {
          console.error(`[CaptionBbox] 页面 ${pageIdx} 不存在或无法访问`, {
            hasPrimaryView: !!this._primaryView,
            pagesLength: this._primaryView?._pages?.length,
            hasPdfViewer: !!this._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer,
            pdfViewerPagesLength: this._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages?.length,
            pdfViewerPagesCount: this._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?.pagesCount,
            pageIdx: pageIdx,
            pageSource: pageSource,
            charInfo: {
              hasRect: !!char.rect,
              pageIndex: char.pageIndex,
              text: char.text
            }
          });
          return null;
        }

        // 尝试多种方式获取viewport
        let viewport = null;
        if (page.originalPage?.viewport) {
          viewport = page.originalPage.viewport;
        } else if (page.viewport) {
          viewport = page.viewport;
        } else {
          console.error(`[CaptionBbox] 页面 ${pageIdx} 缺少viewport信息`, {
            hasOriginalPage: !!page.originalPage,
            hasViewport: !!page.viewport
          });
          return null;
        }
        if (!viewport) {
          console.error(`[CaptionBbox] 页面 ${pageIdx} viewport为null`);
          return null;
        }

        // 优先使用originalViewBox，否则回退到viewBox
        const viewBox = viewport.originalViewBox || viewport.viewBox;
        if (!viewBox || viewBox.length < 4) {
          console.error(`[CaptionBbox] 页面 ${pageIdx} 缺少有效的viewBox信息`);
          return null;
        }
        originalWidth = viewBox[2] - viewBox[0];
        originalHeight = viewBox[3] - viewBox[1];
      }
      const [x1, y1, x2, y2] = char.rect; // PDF 坐标系（左下右上）

      // 转换为千分比坐标系（左上角原点）
      // X坐标：PDF坐标 → 千分比
      const x0_permille = x1 / originalWidth * 1000; // 左边界
      const x1_permille = x2 / originalWidth * 1000; // 右边界

      // Y坐标：PDF坐标（左下原点） → 千分比坐标（左上原点）
      const y0_permille = (originalHeight - y2) / originalHeight * 1000; // 上边界
      const y1_permille = (originalHeight - y1) / originalHeight * 1000; // 下边界

      minX = Math.min(minX, x0_permille);
      maxX = Math.max(maxX, x1_permille);
      minY = Math.min(minY, y0_permille); // Y值越小越靠上
      maxY = Math.max(maxY, y1_permille); // Y值越大越靠下

      validCharCount++;
    }
    if (minX === Infinity) {
      console.warn('[CaptionBbox] 没有找到任何有效字符，无法计算bbox');
      return null;
    }

    // 返回千分比坐标系的bbox: [x0, y0, x1, y1] (左上角��点)
    const result = [minX, minY, maxX, maxY];
    return result;
  }

  /**
   * 合并 list/equation 与前一个 text 块
   * @param {Array} blocks - MinerU 块列表
   * @returns {Array} 合并后的块列表
   */
  _mergeListBlocks(blocks) {
    const mergedBlocks = [];
    let pendingTextBlock = null; // 缓存上一个 text/title 块
    let pendingIndex = -1; // 缓存块的索引
    let mergeCount = 0;
    for (let i = 0; i < blocks.length; i++) {
      const currentBlock = blocks[i];
      const isListOnly = currentBlock.type === 'list' && currentBlock.specialType !== 'equation';
      const isEquation = currentBlock.specialType === 'equation';
      if (!isListOnly) {
        // 当前不是list块：先处理之前缓存的 text 块
        if (pendingTextBlock) {
          mergedBlocks.push(pendingTextBlock);
        }

        // 缓存当前 text/title 块
        pendingTextBlock = currentBlock;
        pendingIndex = i;
      } else {
        // 当前是 list 块
        if (pendingTextBlock) {
          const canMerge = pendingTextBlock.page_idx === currentBlock.page_idx;
          if (canMerge) {
            // 开始合并：将 text 块与第一个 list 合并
            let mergedBlock = this._createMergedBlock(pendingTextBlock, currentBlock, pendingIndex, i);
            const mergedIndices = [pendingIndex, i];

            // 检查后续连续的 list 块并一起合并
            let j = i + 1;
            while (j < blocks.length) {
              const nextBlock = blocks[j];
              const isNextListOnly = nextBlock.type === 'list' && nextBlock.specialType !== 'equation';
              if (isNextListOnly && mergedBlock.page_idx === nextBlock.page_idx) {
                mergedBlock = this._createMergedBlock(mergedBlock, nextBlock, -1, j);
                mergedIndices.push(j);
                j++;
              } else {
                break;
              }
            }
            mergedBlock.mergedItems = mergedIndices;
            mergedBlocks.push(mergedBlock);
            pendingTextBlock = null;
            pendingIndex = -1;
            mergeCount++;
            i = j - 1;
          } else {
            mergedBlocks.push(pendingTextBlock);
            mergedBlocks.push(currentBlock);
            pendingTextBlock = null;
            pendingIndex = -1;
          }
        } else {
          mergedBlocks.push(currentBlock);
        }
      }
    }

    // 处理最后剩余的缓存 text 块
    if (pendingTextBlock) {
      mergedBlocks.push(pendingTextBlock);
    }
    return mergedBlocks;
  }

  /**
   * 检查文本是否以 where/which/here 开头（大小写不敏感）
   * @param {string} text - 文本内容
   * @returns {boolean} 是否匹配
   */
  _isEquationExplanationText(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmedText = text.trim().toLowerCase();
    // 匹配以 where/which/here 开头的文本
    return /^(where|which|here)\b/.test(trimmedText);
  }

  /**
   * 创建合并后的块
   * @param {Object} prevBlock - 前一个 text 块
   * @param {Object} currentBlock - 当前 list/equation 块
   * @param {number} prevIndex - 前一个块的索引
   * @param {number} currentIndex - 当前块的索引
   * @returns {Object} 合并后的块
   */
  _createMergedBlock(prevBlock, currentBlock, prevIndex, currentIndex) {
    // 合并文本（添加换行符分隔）
    const mergedText = `${prevBlock.text}\n${currentBlock.text}`;

    // 合并 bbox 坐标
    const mergedBbox = this._mergeBboxes(prevBlock.bbox, currentBlock.bbox);

    // 处理 mergedItems：如果 prevBlock 已经有 mergedItems（后续合并），则追加；否则创建新的
    let mergedItems = [prevIndex, currentIndex];
    if (prevBlock.mergedItems && Array.isArray(prevBlock.mergedItems)) {
      // prevBlock 已经是合并后的块，保留其原有的 mergedItems，只添加当前块的索引
      mergedItems = [...prevBlock.mergedItems, currentIndex];
    }

    // 处理 originalType：如果已经有 originalType，则追加；否则创建新的
    let originalType = `${prevBlock.type}+${currentBlock.type}`;
    if (prevBlock.originalType && prevBlock.originalType !== prevBlock.type) {
      // prevBlock 已经是合并后的块，在其 originalType 基础上追加
      originalType = `${prevBlock.originalType}+${currentBlock.type}`;
    }
    return {
      ...prevBlock,
      text: mergedText,
      bbox: mergedBbox,
      mergedItems: mergedItems,
      originalType: originalType,
      type: currentBlock.type
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Excluded-page helpers (re-created; Vibero's versions were not part of the ported slice)
  // ---------------------------------------------------------------------------------------------------------

  _getIncludedOriginalPageIndices(totalPages, excludedSet = new Set()) {
    const included = [];
    for (let i = 0; i < totalPages; i++) {
      if (!excludedSet.has(i)) included.push(i);
    }
    return included;
  }

  /** A MinerU run on a subset PDF numbers pages 0..n-1; map them back to the original page indices. */
  _remapMinerUPageFieldsInPlace(contentList, includedOriginalIndices) {
    for (const item of contentList || []) {
      if (item && typeof item.page_idx === "number" && includedOriginalIndices[item.page_idx] !== undefined) {
        item.page_idx = includedOriginalIndices[item.page_idx];
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Full pipeline (re-creates Vibero's _onFlowReparse data steps without UI / credits / DB).
   * @returns {Promise<{resultDir, contentList, markdown, hierarchicalData, articleSummary, blockMapping, sourceLocale}>}
   */
  async run({ excludedPageIndices = [] } = {}) {
    this._llmPromptLanguage = this._getCurrentLlmPromptLanguage();
    this._checkFlowAborted();

    const pdfApp = this._getPdfApp();
    if (!pdfApp || !pdfApp.pdfDocument) {
      console.error('[pipeline/run] PDFViewerApplication 不可用');
      throw new Error(this._l10n('reader-error-pdf-reader-not-ready'));
    }
    this._summaryManager.clear({ preserveGitHub: true });
    this._reparsePageLanguageSampleCache.clear();

    this._setFlowProgress({
      percent: 15,
      message: this._l10n('reader-flow-starting')
    });
    const totalPages = pdfApp.pdfViewer?.pagesCount || pdfApp.pdfDocument.numPages || 0;
    const excludedForParse = new Set(excludedPageIndices || []);
    const includedOriginalIndices = this._getIncludedOriginalPageIndices(totalPages, excludedForParse);

    // 1. MinerU parse result
    this._setFlowProgress({
      percent: 18,
      message: this._l10n('reader-flow-parsing-pdf-structure')
    });
    const parseOpts = excludedForParse.size ? JSON.stringify({
      excludedPageIndices: Array.from(excludedForParse).sort((a, b) => a - b)
    }) : '';
    const parseResult = await this._parsePDF(parseOpts, (status) => {
      if (status && status.message) this._setFlowProgressMessage(status.message);
    });
    this._checkFlowAborted();
    if (!parseResult.success) {
      const errorMsg = parseResult.error || parseResult.message || this._l10n('reader-flow-parse-failed');
      throw new Error(errorMsg);
    }
    const pdfContentList = parseResult.pdfProcessResult.contentList;
    if (excludedForParse.size > 0) {
      this._remapMinerUPageFieldsInPlace(pdfContentList, includedOriginalIndices);
    }
    this._setFlowProgress({
      percent: 38,
      message: this._l10n('reader-flow-parse-complete-init')
    });

    // 2. markdown etc.
    await this.setParseResultInSummaryManager(parseResult.pdfProcessResult);
    this._setFlowProgress({
      percent: 40,
      message: this._l10n('reader-flow-extracting-text')
    });

    // Synchronous page geometry for the ported helpers (getPageView(i).viewport, _pages).
    if (typeof pdfApp.prepareGeometry === 'function') {
      await pdfApp.prepareGeometry();
    }

    // 3. structured chars of the included pages
    const charsDataList = [];
    const nIncluded = includedOriginalIndices.length;
    for (let idx = 0; idx < nIncluded; idx++) {
      this._checkFlowAborted();
      const i = includedOriginalIndices[idx];
      const pageData = await pdfApp.pdfDocument.getPageData({
        pageIndex: i
      });
      for (let j = 0; j < pageData.chars.length; j++) {
        const char = pageData.chars[j];
        char.offset = charsDataList.length;
        char.pageIndex = i;
        charsDataList.push(char);
      }
      if (idx === 0 || idx === nIncluded - 1 || idx % 3 === 0) {
        const percent = 40 + Math.floor((idx + 1) / Math.max(1, nIncluded) * 10);
        this._setFlowProgress({
          percent,
          message: this._l10n('reader-flow-extracting-text-progress', {
            current: idx + 1,
            total: nIncluded
          })
        });
      }
    }
    this._summaryManager.setCharsDataList(charsDataList);
    this._checkFlowAborted();
    this._setFlowProgress({
      percent: 50,
      message: this._l10n('reader-flow-organizing-paragraphs')
    });

    // 4. paragraphs
    const paragraphs = this.processParagraphData(charsDataList);
    this._setFlowProgress({
      percent: 53,
      message: this._l10n('reader-flow-extracting-main-content')
    });

    // 5. main blocks from the MinerU result
    let mainBlocks = this.selectMainBlocks(pdfContentList);
    this._checkFlowAborted();

    // 5.5 author list filtering (first pages)
    if (this._filterAuthors) {
      this._setFlowProgress({
        percent: 56,
        message: this._l10n('reader-flow-filtering-headers-footers')
      });
      mainBlocks = await this.filterAuthorListByLLM(mainBlocks);
      this._checkFlowAborted();
    }

    this._setFlowProgress({
      percent: 58,
      message: this._bilingual('检测原文语言...', 'Detecting source text language...')
    });
    await this._detectSourceTextLanguageForSegmentation(mainBlocks);

    const matchedResults = this.bboxMatch(mainBlocks, paragraphs, charsDataList);
    const sentenceData = this.processSentenceData(matchedResults);
    this._checkFlowAborted();
    this._setFlowProgress({
      percent: 65,
      message: this._l10n('reader-flow-generating-article-summary')
    });

    // 6-10. article summary and per-page summary/translation in parallel
    const [, llmResult] = await Promise.allSettled([
      this.articleSummaryRequest(mainBlocks, pdfContentList),
      this.llmRequest(sentenceData)
    ]).then((results) => {
      let articleSummaryData = null;
      if (results[0].status === 'rejected') {
        console.error('[pipeline/run] ⚠️ articleSummaryRequest 失败 (非致命):', results[0].reason);
        if (results[0].reason && results[0].reason.name === 'AbortError') {
          throw results[0].reason;
        }
        this._showNotification(this._l10n('reader-flow-article-summary-failed'), 'warning');
      } else {
        articleSummaryData = results[0].value;
      }
      if (results[1].status === 'rejected') {
        console.error('[pipeline/run] ❌ llmRequest 失败:', results[1].reason);
        if (results[1].reason && results[1].reason.name === 'AbortError') {
          throw results[1].reason;
        }
        throw new Error(this._l10n('reader-flow-llm-request-failed', {
          error: String(results[1].reason)
        }));
      }
      return [articleSummaryData, results[1].value];
    });
    this._checkFlowAborted();

    // 11. hierarchy + rects (needs the real page sizes for the MinerU-bbox based rects)
    this._setFlowProgress({
      percent: 90,
      message: this._l10n('reader-flow-building-hierarchy')
    });
    const pageSizes = {};
    const pagesInResult = new Set();
    for (const para of llmResult || []) {
      if (para && typeof para.page_idx === 'number') pagesInResult.add(para.page_idx);
    }
    for (const pageIndex of pagesInResult) {
      const dims = await this._getPageDimensions(pageIndex);
      pageSizes[pageIndex] = {
        width: dims.originalWidth,
        height: dims.originalHeight
      };
    }
    this._summaryManager.setPageSizes(pageSizes);
    this._summaryManager.buildHierarchicalData(llmResult);

    this._setFlowProgress({
      percent: 100,
      message: this._l10n('reader-general-complete')
    });
    return {
      ...this.getState(),
      sourceLocale: this._sourceTextSegmenterLocale
    };
  }

  /**
   * AI outline (data path of Vibero's generateOutlineForSidebar({ forceAI: true, regenerate: true })).
   * Needs run() or loadState() first. Returns the outline root node and stores it as the manager's sections.
   */
  async generateOutline() {
    this._llmPromptLanguage = this._getCurrentLlmPromptLanguage();
    this._checkFlowAborted();
    const hierarchicalData = this._summaryManager.getHierarchicalData();
    if (!Array.isArray(hierarchicalData) || hierarchicalData.length === 0) {
      throw new Error(this._l10n('reader-error-no-full-parse-data'));
    }
    const {
      llmInputData
    } = await this.prepareOutlineInputData();
    const outlineResult = await this._getOutline(llmInputData);
    if (!outlineResult?.outline) {
      throw new Error(this._bilingual('大纲生成结果为空', 'Outline result is empty'));
    }
    this._validateLLMOutlinePayload(outlineResult.outline);
    this._summaryManager.setSections(outlineResult.outline);
    return outlineResult.outline;
  }

  /**
   * Re-generate the full article summary (data path of Vibero's regenerateArticleSummary).
   * @returns {Promise<{articleSummary, blockMapping}>}
   */
  async regenerateArticleSummary() {
    this._llmPromptLanguage = this._getCurrentLlmPromptLanguage();
    this._checkFlowAborted();
    const pdfContentList = this._buildFallbackContentListForArticleSummary();
    if (!Array.isArray(pdfContentList) || pdfContentList.length === 0) {
      throw new Error(this._l10n('reader-error-no-full-parse-data'));
    }
    let mainBlocks = this.selectMainBlocks(pdfContentList);
    if (this._filterAuthors) {
      mainBlocks = await this.filterAuthorListByLLM(mainBlocks);
    }
    await this.articleSummaryRequest(mainBlocks, pdfContentList);
    return {
      articleSummary: this._summaryManager.getArticleSummary(),
      blockMapping: this._summaryManager.getBlockMapping()
    };
  }

  /** Restore previously saved state (e.g. from DeepRead.Store) so generateOutline()/regenerateArticleSummary() work. */
  loadState({ resultDir, contentList, markdown, hierarchicalData, articleSummary, blockMapping, sections } = {}) {
    const sm = this._summaryManager;
    if (resultDir !== undefined) sm.setResultDir(resultDir);
    if (contentList !== undefined) sm.setPdfContentList(contentList);
    if (markdown !== undefined) {
      sm.setMarkdownContent(markdown);
      this._lastMarkdown = markdown || "";
    }
    if (hierarchicalData !== undefined) sm.setHierarchicalData(hierarchicalData);
    if (articleSummary !== undefined) sm.setArticleSummary(articleSummary);
    if (blockMapping !== undefined) sm.setBlockMapping(blockMapping);
    if (sections !== undefined) sm.setSections(sections);
  }

  getState() {
    const sm = this._summaryManager;
    return {
      resultDir: sm.getResultDir(),
      contentList: sm.getPdfContentList(),
      markdown: sm.getMarkdownContent(),
      hierarchicalData: sm.getHierarchicalData(),
      articleSummary: sm.getArticleSummary(),
      blockMapping: sm.getBlockMapping(),
      sections: sm.getSections()
    };
  }
};
