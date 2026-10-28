/*
 * DeepRead.ResponseFormats: json_schema response_format builders for reader-side LLM calls
 * (OpenAI-compatible / DashScope json_schema). Each builder returns { response_format: {...} }.
 *
 * Ported from Vibero (AGPL-3.0, a Zotero fork): reader-llm-response-formats.js, UMD wrapper removed;
 * the factory body and its outputs are unchanged.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

DeepRead.ResponseFormats = (function () {
  /** @param {boolean} isEnglish */
  function articleSummaryTitleEnum(isEnglish) {
    return isEnglish ?
    ['Paper Title', 'Research Background', 'Core Innovations', 'Experimental Results', 'Conclusions'] :
    ['论文标题', '研究背景与问题', '核心创新点', '实验结果', '结论与价值'];
  }

  function outlineTreeForGetOutline() {
    return {
      type: 'object',
      properties: {
        outline: { $ref: '#/definitions/OutlineNode' }
      },
      required: ['outline'],
      additionalProperties: false,
      definitions: {
        OutlineNode: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1 },
            title_block_id: { type: 'integer', minimum: 0 },
            level: { type: 'integer', minimum: 0 },
            summary: { type: 'string', minLength: 5, maxLength: 100 },
            children: {
              type: 'array',
              items: { $ref: '#/definitions/OutlineNode' }
            }
          },
          required: ['title', 'title_block_id', 'level', 'summary', 'children'],
          additionalProperties: false
        }
      }
    };
  }

  /** @param {boolean} isEnglish */
  function articleSummaryOnlySchema(isEnglish) {
    return {
      type: 'object',
      properties: {
        article_summary: {
          type: 'array',
          items: { $ref: '#/definitions/ArticleSummaryItem' },
          minItems: 5,
          maxItems: 5
        }
      },
      required: ['article_summary'],
      additionalProperties: false,
      definitions: {
        ArticleSummaryItem: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              enum: articleSummaryTitleEnum(isEnglish)
            },
            content: { type: 'string' },
            points: {
              type: 'array',
              items: { $ref: '#/definitions/SummaryPoint' },
              minItems: 1
            }
          },
          required: ['title', 'content', 'points'],
          additionalProperties: false
        },
        SummaryPoint: {
          type: 'object',
          properties: {
            point_title: { type: 'string', minLength: 2, maxLength: 50 },
            content: { type: 'string', minLength: 10 },
            block_ids: {
              type: 'array',
              items: { type: 'integer', minimum: 0 },
              maxItems: 20
            }
          },
          required: ['point_title', 'content'],
          additionalProperties: false
        }
      }
    };
  }

  /** 段落条目：英文无翻译字段 */
  function paragraphItemSchema(includeTranslations) {
    const props = {
      id: { type: 'string', pattern: '^\\d+_\\d+$' },
      paragraph_summary: { type: 'string', minLength: 5, maxLength: 100 },
      point_split: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'integer', minimum: 0 },
          minItems: 1
        },
        minItems: 1
      },
      point_summaries: {
        type: 'array',
        items: { type: 'string', minLength: 5, maxLength: 100 }
      },
      point_importance_levels: {
        type: 'array',
        items: { type: 'integer', enum: [1, 2, 3] }
      }
    };
    const required = ['id', 'paragraph_summary', 'point_split', 'point_summaries', 'point_importance_levels'];
    if (includeTranslations) {
      props.point_translations = {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      };
      required.push('point_translations');
    }
    return {
      type: 'object',
      properties: props,
      required,
      additionalProperties: false
    };
  }

  /**
   * @param {boolean} isEnglish
   * @param {{ outputName: string, singleParagraph?: boolean }} opts
   */
  function pageSummaryRootSchema(isEnglish, singleParagraph) {
    const includeTranslations = !isEnglish;
    const paragraphs = {
      type: 'array',
      minItems: 1,
      items: paragraphItemSchema(includeTranslations)
    };
    if (singleParagraph) {
      paragraphs.maxItems = 1;
    }
    return {
      type: 'object',
      properties: { paragraphs },
      required: ['paragraphs'],
      additionalProperties: false
    };
  }

  function wrapJsonSchema(name, schemaRoot) {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name,
          strict: true,
          schema: schemaRoot
        }
      }
    };
  }

  return {
    /** _getOutline */
    outlineOnlyFormat() {
      return wrapJsonSchema('OutlineOutput', outlineTreeForGetOutline());
    },

    /** _getArticleSummary */
    articleSummaryOnlyFormat(isEnglish) {
      return wrapJsonSchema('ArticleSummaryOnlyOutput', articleSummaryOnlySchema(!!isEnglish));
    },

    /** _requestPageSummaryAndTranslation 整页 */
    pageSummaryFormat(isEnglish) {
      return wrapJsonSchema('PageSummaryOutput', pageSummaryRootSchema(!!isEnglish, false));
    },

    /** regenerateSummaryCard 单段 */
    singleParagraphPageSummaryFormat(isEnglish) {
      return wrapJsonSchema('SingleParagraphSummaryOutput', pageSummaryRootSchema(!!isEnglish, true));
    },

    /** 预留：filterAuthorListByLLM 现改用 json_object（百炼部分模型对 strict json_schema 不稳定） */
    authorFilterFormat() {
      return wrapJsonSchema('AuthorFilterOutput', {
        type: 'object',
        properties: {
          indices: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            uniqueItems: true
          }
        },
        required: ['indices'],
        additionalProperties: false
      });
    },

    /**
     * xpcom 全文总结：articleSummary 字符串 + outline（number/title/type/children）
     */
    legacyArticleSummaryWithOutlineFormat() {
      return wrapJsonSchema('ArticleSummaryWithOutlineOutput', {
        type: 'object',
        properties: {
          articleSummary: { type: 'string', minLength: 1 },
          outline: {
            type: 'array',
            items: { $ref: '#/definitions/LegacyOutlineNode' }
          }
        },
        required: ['articleSummary', 'outline'],
        additionalProperties: false,
        definitions: {
          LegacyOutlineNode: {
            type: 'object',
            properties: {
              number: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              type: { type: 'integer', enum: [0, 1] },
              children: {
                type: 'array',
                items: { $ref: '#/definitions/LegacyOutlineNode' }
              }
            },
            required: ['number', 'title', 'type', 'children'],
            additionalProperties: false
          }
        }
      });
    }
  };
})();
