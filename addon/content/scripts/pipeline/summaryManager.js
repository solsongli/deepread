/* DeepRead — SummaryManager: in-memory store for parsed paper data (chars, hierarchical paragraphs/sentences/points,
 * article summary, outline sections, block mapping).
 * Ported from Vibero (AGPL-3.0, a Zotero fork). License: AGPL-3.0-or-later
 * Changes: printAllData() dropped; setPageSizes()/pageSizes added so MinerU per-mille bboxes are converted with real
 * PDF page sizes (falls back to 612x792 only when unknown).
 */
/* global DeepRead */

DeepRead.SummaryManager = class SummaryManager {
  constructor() {
    // 核心数据1：全局字符数组（扁平结构）
    this.charsDataList = []; // Array<{c, u, rect, offset, pageIndex, ...}>

    // 核心数据2：层级结构
    this.hierarchicalData = []; // Array<{pageIndex, paragraphs: Array<{paragraphIndex, sentences: Array<{...}>}>}>

    // 核心数据3：PDF解析结果目录和内容列表
    this.resultDir = null;
    this.pdfContentList = null;

    // 核心数据4：图片、表格、标题映射
    this.imageMap = [];
    this.tableMap = [];
    this.titleMap = [];

    // 核心数据5：Markdown 内容
    this.markdownContent = null;

    // 核心数据6：全文总结
    this.articleSummary = null;
    this.sections = null;
    this.blockMapping = null;

    // 核心数据7：当前选中的 paragraphRef 集合（用于缩放后恢复 gold 主题）
    // 格式：Set<"pageIndex_paragraphIndex">
    this.selectedParagraphRefs = new Set();

    // 核心数据8：从论文中提取的 GitHub 仓库链接
    this.githubUrl = null;

    // 核心数据9：真实页面尺寸（PDF points），{ [pageIndex]: { width, height } }
    this.pageSizes = {};
  }

  /**
   * 添加选中的 paragraphRef
   * @param {Object} paragraphRef - {pageIndex, paragraphIndex}
   */
  addSelectedParagraphRef(paragraphRef) {
    const key = `${paragraphRef.pageIndex}_${paragraphRef.paragraphIndex}`;
    this.selectedParagraphRefs.add(key);
  }

  /**
   * 移除选中的 paragraphRef
   * @param {Object} paragraphRef - {pageIndex, paragraphIndex}
   */
  removeSelectedParagraphRef(paragraphRef) {
    const key = `${paragraphRef.pageIndex}_${paragraphRef.paragraphIndex}`;
    this.selectedParagraphRefs.delete(key);
  }

  /**
   * 检查 paragraphRef 是否被选中
   * @param {Object} paragraphRef - {pageIndex, paragraphIndex}
   * @returns {boolean}
   */
  isSelectedParagraphRef(paragraphRef) {
    const key = `${paragraphRef.pageIndex}_${paragraphRef.paragraphIndex}`;
    return this.selectedParagraphRefs.has(key);
  }

  /**
   * 清空所有选中的 paragraphRef
   */
  clearSelectedParagraphRefs() {
    this.selectedParagraphRefs.clear();
  }

  /**
   * PDF解析结果目录
   * @param {string} resultDir - PDF解析结果目录路径
   */
  setResultDir(resultDir) {
    this.resultDir = resultDir;
  }
  getResultDir() {
    return this.resultDir || null;
  }

  /**
   * PDF解析结果内容列表
   * @param {Array} pdfContentList - PDF解析结果内容列表
   */
  setPdfContentList(pdfContentList) {
    this.pdfContentList = pdfContentList;
  }
  getPdfContentList() {
    return this.pdfContentList || null;
  }

  /**
   * 设置标题映射
   */
  setTitleMap(titleMap) {
    this.titleMap = titleMap;
  }
  getTitleMap() {
    return this.titleMap || [];
  }

  /**
   * 设置 Markdown 内容
   */
  setMarkdownContent(markdownContent) {
    this.markdownContent = markdownContent;
  }
  getMarkdownContent() {
    return this.markdownContent || null;
  }

  /**
   * 设置全文总结
   */
  setArticleSummary(articleSummary) {
    this.articleSummary = articleSummary;
  }
  getArticleSummary() {
    return this.articleSummary || null;
  }

  /**
   * 设置章节
   */
  setSections(sections) {
    this.sections = sections;
  }
  getSections() {
    return this.sections || null;
  }

  /**
   * 设置block映射关系
   */
  setBlockMapping(blockMapping) {
    this.blockMapping = blockMapping;
  }
  getBlockMapping() {
    return this.blockMapping || null;
  }

  /**
   * 设置从论文中提取的 GitHub 仓库链接
   * @param {string} url - GitHub 仓库 URL
   */
  setGitHubUrl(url) {
    this.githubUrl = url;
  }

  /**
   * 获取从论文中提取的 GitHub 仓库链接
   * @returns {string|null} GitHub 仓库 URL 或 null
   */
  getGitHubUrl() {
    return this.githubUrl || null;
  }
  getArticleSummaryMarkdown() {
    return this.articleSummary.articleSummary || '';
  }
  getArticleOutline() {
    return this.articleSummary.outline || [];
  }

  /**
   * 全局字符数组（扁平结构）
   * @param {Array} charsDataList - 全局字符数组
   */
  setCharsDataList(charsDataList) {
    this.charsDataList = charsDataList;
  }
  getCharsDataList() {
    return this.charsDataList || [];
  }

  /**
   * 层级结构化的数据
   * 格式：[{ pageIndex, paragraphs: [{ paragraphIndex, sentences: [...], rects: [...] }] }]
   */
  setHierarchicalData(hierarchicalData) {
    this.hierarchicalData = hierarchicalData;
  }
  getHierarchicalData() {
    return this.hierarchicalData || [];
  }

  /**
   * 用运行时编辑后的数据同步单个段落，避免 UI 已更新但 hierarchicalData 仍是旧 point 划分
   * @param {Object} paragraphRef - { pageIndex, paragraphIndex }
   * @param {Object} updates - { paragraphSummary?, points? }
   * @returns {boolean}
   */
  updateParagraphRuntimeData(paragraphRef, updates = {}) {
    if (!paragraphRef) return false;
    const {
      pageIndex,
      paragraphIndex
    } = paragraphRef;
    const pageData = this.hierarchicalData.find((p) => p.pageIndex === pageIndex);
    const paragraphData = pageData?.paragraphs?.find((p) => p.paragraphIndex === paragraphIndex);
    if (!paragraphData) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'paragraphSummary')) {
      paragraphData.paragraphSummary = updates.paragraphSummary || '';
    }
    if (Array.isArray(updates.points)) {
      paragraphData.points = updates.points.map((point, index) => ({
        ...point,
        pointIndex: typeof point.pointIndex === 'number' ? point.pointIndex : index,
        sentenceIndices: Array.isArray(point.sentenceIndices) ? [...point.sentenceIndices] : [],
        charMapping: Array.isArray(point.charMapping) ? [...point.charMapping] : [],
        rects: Array.isArray(point.rects) ? point.rects.map((rect) => Array.isArray(rect) ? [...rect] : rect) : []
      }));
    }
    return true;
  }

  /**
   * 构建层级结构并计算rects
   * @param {Array} paragraphs - 段落数组，每个包含：{page_idx, paragraph_idx, paragraph_text, paragraph_summary, point_split, point_summaries, point_translations, sentences: [...]}
   */
  buildHierarchicalData(paragraphs) {
    // 1. 构建层级结构 hierarchicalData
    this.hierarchicalData = [];
    // 2. 清空并重新构建 imageMap、tableMap（从 paragraphs 中提取）
    this.imageMap = [];
    this.tableMap = [];

    // 按页分组
    const pageGroups = new Map();
    for (let para of paragraphs) {
      const pageIdx = para.page_idx;
      if (!pageGroups.has(pageIdx)) {
        pageGroups.set(pageIdx, []);
      }
      pageGroups.get(pageIdx).push(para);
    }

    // 构建每页的层级结构
    for (let [pageIdx, pageParagraphs] of pageGroups) {
      const pageData = {
        pageIndex: pageIdx,
        paragraphs: []
      };

      // 按paragraph_idx排序
      pageParagraphs.sort((a, b) => a.paragraph_idx - b.paragraph_idx);

      // 构建每段的数据
      for (let para of pageParagraphs) {
        const paragraphData = {
          paragraphIndex: para.paragraph_idx,
          paragraphType: para.paragraph_type,
          paragraphText: para.paragraph_text,
          typography: para.typography || null,
          translationLayout: para.translationLayout || null,
          translationLayoutVersion: !para.translationLayout || DeepRead.TranslationLayout?.ready(para.translationLayout) ? 1 : 0,
          continuation: para.continuation || null,
          continuationChecked: para.continuationChecked === true,
          paragraphSummary: para.paragraph_summary || '',
          minerUid: para.minerUid,
          importance_level: para.importance_level,
          bbox: para.bbox,
          // 保留 MinerU 的 bbox 信息
          sentences: [],
          points: [],
          rects: [] // 段落的所有rects
        };

        // 构建句子数据
        for (let sentence of para.sentences) {
          let sentenceRects;

          // 特殊处理：对于image、table和equation类型，如果没有charMapping，使用MinerU的bbox
          if ((para.paragraph_type === 'image' || para.paragraph_type === 'table' || para.paragraph_type === 'equation') && (!sentence.charMapping || sentence.charMapping.length === 0)) {
            sentenceRects = this._convertMinerUBboxToRects(para.bbox, para.page_idx);
            // console.log(`[SummaryManager] 为${para.paragraph_type}类型使用MinerU bbox:`, sentenceRects);
          } else {
            sentenceRects = this._getSentenceRectsFromCharMapping(sentence.charMapping);
          }
          const sentenceData = {
            id: `${para.page_idx}_${para.paragraph_idx}_${sentence.sentence_idx}`,
            sentenceIndex: sentence.sentence_idx,
            text: sentence.text,
            charMapping: sentence.charMapping,
            startCharIndex: sentence.startCharIndex,
            endCharIndex: sentence.endCharIndex,
            rects: sentenceRects
          };
          paragraphData.sentences.push(sentenceData);
          paragraphData.rects.push(...sentenceRects);
        }

        // 构建point数据（如果point_split有效）
        if (Array.isArray(para.point_split) && para.point_split.length > 0) {
          for (let pointIdx = 0; pointIdx < para.point_split.length; pointIdx++) {
            const sentenceIndices = para.point_split[pointIdx];
            if (!Array.isArray(sentenceIndices) || sentenceIndices.length === 0) {
              continue;
            }

            // 获取point包含的句子
            const pointSentences = sentenceIndices.map((idx) => para.sentences[idx]).filter((s) => s != null);
            if (pointSentences.length === 0) {
              continue;
            }

            // 计算point的charMapping（所有句子的charMapping合并）
            let pointCharMapping = [];
            for (let s of pointSentences) {
              if (s.charMapping && Array.isArray(s.charMapping)) {
                pointCharMapping.push(...s.charMapping);
              }
            }

            // 检查是否为equation point（合并段落中的equation句子）
            const isEquationPoint = pointSentences.some((s) => s.specialType === 'equation');

            // 计算point的rects
            let pointRects;
            // 特殊处理：对于image、table、equation类型，或合并段落中的equation point
            if ((para.paragraph_type === 'image' || para.paragraph_type === 'table' || para.paragraph_type === 'equation') && (!pointCharMapping || pointCharMapping.length === 0)) {
              pointRects = this._convertMinerUBboxToRects(para.bbox, para.page_idx);
            } else if (isEquationPoint && (!pointCharMapping || pointCharMapping.length === 0)) {
              // 合并段落中的equation point，优先使用equationBbox，否则回退到段落bbox
              const eqBbox = para.equationBbox || para.bbox;
              pointRects = eqBbox ? this._convertMinerUBboxToRects(eqBbox, para.page_idx) : [];
            } else {
              pointRects = this._getSentenceRectsFromCharMapping(pointCharMapping);
            }

            // 获取point的summary和translation
            const pointSummary = para.point_summaries?.[pointIdx] || '';
            const pointTranslation = para.point_translations?.[pointIdx] || '';
            // 获取point的importance_level（从para.point_importance_levels数组中获取，默认为1）
            const pointImportanceLevel = para.point_importance_levels?.[pointIdx] || 1;
            const pointData = {
              id: `${para.page_idx}_${para.paragraph_idx}_point_${pointIdx}`,
              pointIndex: pointIdx,
              sentenceIndices: sentenceIndices,
              summary: pointSummary,
              translation: pointTranslation,
              charMapping: pointCharMapping,
              rects: pointRects,
              importance_level: pointImportanceLevel // 添加 importance_level 字段（Requirements: 3.1, 3.2）
            };
            if (Array.isArray(para.point_importance_levels)) pointData.importance_source = "model";
            paragraphData.points.push(pointData);
          }
        }
        pageData.paragraphs.push(paragraphData);

        // 如果是 image 或 table 类型，直接从 para 中构建完整的 map 数据
        // 因为 para 已经包含了从 pdfContentList 传递过来的所有字段
        if (para.paragraph_type === 'image') {
          const imageData = {
            type: 'image',
            minerUid: para.minerUid,
            // 使用 MinerU 原始 ID（从 selectMainBlocks 传递）
            page_idx: pageIdx,
            paragraph_idx: para.paragraph_idx,
            img_path: para.img_path || '',
            image_caption: para.image_caption || '',
            bbox: para.bbox || null
          };
          this.imageMap.push(imageData);
        } else if (para.paragraph_type === 'table') {
          const tableData = {
            type: 'table',
            minerUid: para.minerUid,
            // 使用 MinerU 原始 ID（从 selectMainBlocks 传递）
            page_idx: pageIdx,
            paragraph_idx: para.paragraph_idx,
            img_path: para.img_path || '',
            table_caption: para.table_caption || '',
            table_body: para.table_body || '',
            bbox: para.bbox || null
          };
          this.tableMap.push(tableData);
        }
      }
      this.hierarchicalData.push(pageData);
    }

    // 按pageIndex排序
    this.hierarchicalData.sort((a, b) => a.pageIndex - b.pageIndex);

    // console.log('[SummaryManager] 构建完成 - imageMap:', this.imageMap);
    // console.log('[SummaryManager] 构建完成 - tableMap:', this.tableMap);
  }

  /**
   * 设置真实页面尺寸（PDF points）
   * @param {Object} pageSizes - { [pageIndex]: { width, height } }
   */
  setPageSizes(pageSizes) {
    this.pageSizes = pageSizes && typeof pageSizes === 'object' ? { ...pageSizes } : {};
  }
  getPageSizes() {
    return this.pageSizes;
  }

  /**
   * 将MinerU的bbox（千分比‰格式，左上右下）转换为PDF rect
   * @param {Array} mineruBbox - MinerU bbox [x0, y0, x1, y1] (千分比‰，左上右下)
   * @param {number} pageIndex - 页面索引
   * @returns {Array} PDF rect [x1, y1, x2, y2] (左下右上)
   */
  _convertMinerUBboxToRects(mineruBbox, pageIndex) {
    if (!mineruBbox || mineruBbox.length < 4) {
      // console.warn('[SummaryManager] 无效的MinerU bbox:', mineruBbox);
      return [];
    }
    try {
      // 假设可以访问到全局的PDF文档信息
      // 这里简化处理，实际实现需要根据具体的PDF viewer接口
      const [x0_permille, y0_permille, x1_permille, y1_permille] = mineruBbox;

      // 临时实现：返回基于千分比计算的估算rect
      // 实际项目中应该使用与reader.js中相同的转换逻辑
      // DeepRead: 优先使用 setPageSizes 提供的真实页面尺寸，未知时才回退到 612×792
      const pageSize = this.pageSizes && this.pageSizes[pageIndex];
      const estimatedWidth = pageSize?.width > 0 ? pageSize.width : 612; // 页面宽度
      const estimatedHeight = pageSize?.height > 0 ? pageSize.height : 792; // 页面高度

      // 将千分比转换为像素坐标
      const x0 = x0_permille / 1000 * estimatedWidth;
      const x1 = x1_permille / 1000 * estimatedWidth;
      const y0 = (1 - y0_permille / 1000) * estimatedHeight; // Y轴翻转
      const y1 = (1 - y1_permille / 1000) * estimatedHeight;

      // 返回PDF格式的rect [x1, y1, x2, y2] (左下右上)
      return [[x0, y1, x1, y0]];
    } catch (error) {
      console.error('[SummaryManager] 转换MinerU bbox失败:', error);
      return [];
    }
  }

  /**
   * 根据charMapping获取对应的rects
   * 使用与pdf-find-controller.js一致的机制
   */
  _getSentenceRectsFromCharMapping(charMapping) {
    if (!charMapping || !Array.isArray(charMapping) || charMapping.length === 0) {
      console.warn('[SummaryManager._getSentenceRectsFromCharMapping] Invalid charMapping');
      return [];
    }

    // Excluded figure labels may sit between the first and last mapped character.
    // Build only contiguous runs, otherwise those labels reappear in the hit area.
    const indices = [...new Set(charMapping.filter(Number.isInteger))].sort((a, b) => a - b);
    const rects = [];
    let start = indices[0], end = start;
    for (const index of indices.slice(1)) {
      if (index !== end + 1) {
        rects.push(...this._getRangeRects(this.charsDataList, start, end));
        start = index;
      }
      end = index;
    }
    if (start !== undefined) rects.push(...this._getRangeRects(this.charsDataList, start, end));
    return rects;
  }

  /**
   * 获取指定字符范围的rects（按行合并）
   * 参考 reader/src/pdf/lib/utilities.js::getRangeRects
   */
  _getRangeRects(chars, offsetStart, offsetEnd) {
    let rects = [];
    let start = offsetStart;
    for (let i = start; i <= offsetEnd; i++) {
      let char = chars[i];
      if (!char) {
        console.warn(`[SummaryManager._getRangeRects] char at index ${i} is undefined`);
        continue;
      }

      // 遇到换行或到达结尾时，合并当前行的字符为一个rect
      if (char.lineBreakAfter || i === offsetEnd) {
        let firstChar = chars[start];
        let lastChar = char;
        if (firstChar && lastChar && firstChar.rect && lastChar.rect) {
          let rect = [firstChar.rect[0],
          // 左边界
          firstChar.inlineRect ? firstChar.inlineRect[1] : firstChar.rect[1],
          // 上边界
          lastChar.rect[2],
          // 右边界
          firstChar.inlineRect ? firstChar.inlineRect[3] : firstChar.rect[3] // 下边界
          ];
          rects.push(rect);
        }
        start = i + 1;
      }
    }
    return rects;
  }

  /**
   * 清空所有数据
   * @param {Object} [options]
   * @param {boolean} [options.preserveGitHub=false] onflow/重解析时仅保留 GitHub URL；AI outline/mind map 会被清空
   */
  clear(options = {}) {
    const preserveGitHub = !!options.preserveGitHub;
    const savedGithubUrl = preserveGitHub ? this.githubUrl : null;
    this.charsDataList = [];
    this.hierarchicalData = [];
    this.resultDir = null;
    this.pdfContentList = null;
    this.imageMap = [];
    this.tableMap = [];
    this.titleMap = [];
    this.markdownContent = null;
    this.articleSummary = null;
    this.sections = null;
    this.blockMapping = null;
    this.githubUrl = null;
    this.selectedParagraphRefs.clear();
    this.pageSizes = {};
    if (preserveGitHub) {
      this.githubUrl = savedGithubUrl;
    }
  }
};
