# 从网络证据到 DeepRead：论文阅读方法调研

检索日期：2026-10-27。范围：读者如何筛选论文、建立理解、检查证据并记住结论；不追求单纯加快翻页。核验来源为作者论文、期刊、PubMed 和大学课程页面。学术 MCP 未挂载，OpenAlex 查询遇到 HTTP 429；本次以公开网页检索发现、逐条打开原始来源核验，不声称完成系统综述。

## 最值得采用的组合

建议把一次阅读组织成：**明确目标 → 浏览决定是否深读 → 带问题核对图表 → 用自己的话解释 → 隐藏答案回忆 → 返回证据纠错**。这是针对插件的设计综合，不是某一项研究验证过的完整流程。

| 方法 | 读者具体做什么 | 适用情境与证据边界 | DeepRead 的落地选择 |
| --- | --- | --- | --- |
| 目标驱动 | 阅读前写下“我要判断相关性、理解方法、复现实验，还是寻找证据”；不同目标决定阅读顺序 | Carey 等的经验性指导，不能当作效率提升的对照实验 [1] | 已在阅读问题顶部加入每篇阅读目标及相关章节入口 |
| 三遍阅读 | 第一遍看题目、摘要、结构、结论，决定是否继续；第二遍理解思路与图表；第三遍推导或复现关键步骤 | Keshav 的实践建议；不要求每篇都读三遍，也没有通用最优时长 [2] | 现有全文／重点／边注模式配合图表跳转；不恢复 Agent 带读 |
| Figure Facts：围绕数据读 | 对每张关键图记录“比较谁、测什么、观察到什么、能支持哪个结论”；先写自己的判断，再读作者解释 | 原研究为本科细胞神经科学课程中的教学实施与前后变化，不能直接推广为所有领域的因果效果；本次核验摘要 [3] | 图表卡片已加入三项证据笔记；AI 读图步骤折叠，读者可先作判断 |
| CREATE：还原研究推理 | 画出实验／方法关系，明确假设，区分对照和实验结果，最后想一个下一步实验 | 原研究围绕系列论文和课堂讨论，适合重点论文或组会，成本高于快速筛选 [4] | 在“我的理解”中记录“为什么这样设计／换一种设计会怎样”；不强迫每段填完整表单 |
| 问题导向 | 先问研究问题、关键设计、证据与限制，再跳到能回答问题的原文；答案必须能回到出处 | Paper Plain 针对非专家阅读医学论文；结果支持更易接近和更有信心，不等于所有读者答题正确率提高 [5] | 保留阅读问题和段落定位；AI 回答与原文并列，避免把 AI 文本当作证据 |
| 自我解释 | 不仅复述“是什么”，还说明“为什么、和前文有什么关系、哪里没懂” | Chi 等研究分析力学例题学习中的自我解释；不是论文阅读器的随机试验 [6] | 加入可选自测输入，保存读者自己的回答；AI 答案由读者主动展开 |
| 主动回忆 | 看完一节后遮住答案，尝试重建主张、方法与证据，再打开原文纠错 | Karpicke 与 Blunt 的科学教育文本实验比较了检索练习与概念图学习；支持学习和推断表现，不代表阅读速度更快 [7] | 阅读问题新增“自测：先自己解释，再看答案”，允许跳过；不恢复闪卡功能 |
| 间隔重访 | 过一段时间再尝试回答同一问题，而不是马上反复浏览已读文字 | Cepeda 等研究的是事实材料的记忆，最佳间隔随目标保持时间而变；不支持统一的“1、3、7 天最优” [8] | 先保留自测记录，方便下次打开论文重答；本轮不创建提醒或复习调度 |
| 可调的稀疏高亮 | 先用少量提示定位目标、方法与结果，需要时再增加；读者能取消或修正 | Scim 的界面研究支持按内容和密度调节，并报告信任、干扰等差异；自动高亮仍可能错 [9] | 修复模型重要度传递，增加四档密度和阅读目标排序；手动标记和取消优先 |

## 针对当前使用问题的优先级

1. **先修交互基础。** 译文宽度跟原文一致，优先适配高度，长内容可完整查看；再次点击原文块能收起；同一连续片段不会仅因解析边界而变成多张卡片。
2. **让证据定位可信。** 高亮应该落在对应句子上，能开关、改色和取消；不以“AI 判断重要”替代读者判断。
3. **增加一次小的主动思考。** 在现有阅读问题中输入自己的解释再对照答案，比继续增加侧栏模块更符合当前需求。
4. **保留纠错能力。** 自动分组不可能总对，提供可逆的“合并上一张／拆开”，保留各段原文和笔记。

一个可试用的阅读安排是：先用约 5 分钟判断是否相关；值得继续时，选 2–3 个问题，核对相关方法和图表；结束前用 1–2 分钟闭卷回答“主张是什么、哪条证据最关键、限制是什么”。这些时长是起始建议，不是实验确定的最佳参数。

## 怎么验证插件是否真的有帮助

不能只统计读了几页或点了多少卡片。小规模试用时可对同类论文比较：找到一条指定结论的原文出处所需时间、判断图表能否支持结论的准确性、隔日能否重述主张与限制，以及遮挡、误分组、误高亮的次数。先观察每个人相对于自己的变化；当前没有这类用户实验，因此不能宣称提高了多少效率。

## 核验来源

1. Carey MA, Steiner KL, Petri WA Jr. **Ten simple rules for reading a scientific paper.** PLOS Computational Biology, 2020, 16(7): e1008032. [期刊全文](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008032)，重点核验 Rules 1、3、4、8–10。
2. Keshav S. **How to Read a Paper.** 原文发表于 2007，另有 2016 修订。[大学托管原文](https://stanford.edu/class/cs114/reading-keshav.pdf)，核验三遍阅读；[MIT 课程实践](https://shd.mit.edu/2024/paperReadingGuidance.html)用于了解工程论文阅读场景，不作为独立实验依据。
3. Round JE, Campbell AM. **Figure Facts: Encouraging Undergraduates to Take a Data-Centered Approach to Reading Primary Literature.** CBE—Life Sciences Education, 2013, 12(1):39–46. DOI: 10.1187/cbe.11-07-0057。[PubMed 摘要](https://pubmed.ncbi.nlm.nih.gov/23463227/)。PMC 全文访问遇到验证页，未绕过，表中仅使用摘要支持的结论。
4. Hoskins SG, Stevens LM, Nehm RH. **Selective Use of the Primary Literature Transforms the Classroom Into a Virtual Laboratory.** Genetics, 2007. [公开全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC1931557/)，核验 CREATE 的假设、数据分析和下一步实验流程。
5. August T 等. **Paper Plain: Making Medical Research Papers Approachable to Healthcare Consumers with Natural Language Processing.** [作者预印本，2022](https://arxiv.org/abs/2203.00130)，[TOCHI 正式版本，DOI: 10.1145/3589955](https://doi.org/10.1145/3589955)。本表依据预印本摘要与期刊公开说明，未将主观易读性当作理解力提高。
6. Chi MTH, Bassok M, Lewis MW, Reimann P, Glaser R. **Self-Explanations: How Students Study and Use Examples in Learning to Solve Problems.** Cognitive Science, 1989, 13(2):145–182。[期刊摘要](https://onlinelibrary.wiley.com/doi/abs/10.1207/s15516709cog1302_1)。
7. Karpicke JD, Blunt JR. **Retrieval practice produces more learning than elaborative studying with concept mapping.** Science, 2011, 331:772–775. DOI: 10.1126/science.1199327。[作者实验室全文](https://learninglab.psych.purdue.edu/downloads/2011/2011_Karpicke_Blunt_Science.pdf)，[PubMed](https://pubmed.ncbi.nlm.nih.gov/21252317/)。
8. Cepeda NJ, Vul E, Rohrer D, Wixted JT, Pashler H. **Spacing Effects in Learning: A Temporal Ridgeline of Optimal Retention.** Psychological Science, 2008, 19(11):1095–1102。[期刊页面与摘要](https://doi.org/10.1111/j.1467-9280.2008.02209.x)。
9. Fok R 等. **Scim: Intelligent Skimming Support for Scientific Papers.** IUI 2023. DOI: 10.1145/3581641.3584034。[作者全文](https://arxiv.org/html/2205.04561v3)，重点核验 4.2–4.5 的提示与密度控制、7.2 的使用差异。

## 开发验证（本轮）

新增本地阅读目标、图表证据笔记、阅读记录复制／Zotero 笔记导出及四档自动高亮；不额外调用大模型。重新精读保留纸级记录，段落笔记按规范化原文唯一匹配，无法匹配的保留供手动查看。旧段落 ID 对应的高亮和合并关系会重置，避免套到不同内容上。

单元测试覆盖密度递增、目标排序、手动覆盖、缺失章节及安全重对齐；隔离 Zotero 的 35 项检查包括真实表单输入、SQLite 持久化、笔记导出和重新精读。测试使用构造论文与本地响应，未测真实 LLM 输出或阅读效率。
