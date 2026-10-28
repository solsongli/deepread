# 保留原文段落与列表结构

本轮依据用户提供的两个截图：同一解析框内包含两个带粗体标题的列表项，以及两个首行缩进的正文段落。旧代码先把块内换行归一为空格，再把各要点译文用空格拼接；源结构没有进入渲染数据，因而被挤成连续文字。

## RetainPDF 参考

已读取上游源码，固定版本 `a665c2aea2cd0860c737e7f9685d8071fbef1b3a`：

- [首行缩进](https://github.com/wxyhgk/retain-pdf/blob/a665c2aea2cd0860c737e7f9685d8071fbef1b3a/backend/pipeline/retainpdf_pipeline/render/layout/payload/first_line_indent.py)：从文字层的行起点测量缩进，区分没有缩进和无法读取。
- [结构化行](https://github.com/wxyhgk/retain-pdf/blob/a665c2aea2cd0860c737e7f9685d8071fbef1b3a/backend/pipeline/retainpdf_pipeline/render/layout/payload/line_structure.py)：保留源行与结构标记，并区别普通软换行和应保留的列表结构。

本插件适配了上述列表标记和缩进规则，MIT 许可与归属见 `NOTICE.md` 和随插件打包的 `content/lib/retainpdf/LICENSE`。本轮使用 Zotero 的 PDF.js 文字层和 DOM 渲染；没有引入完整的 Typst/PDF 重绘后端。

## 实现

1. 在换行归一化之前，根据文字坐标、行距、缩进和列表符号提取 `translationLayout.units`。每一项保留固定 ID、类型、原文、原文强调、列表符号、首行／悬挂缩进及源高度比例。
2. 含多个真实段落或列表项时，逐页请求携带固定 `source layout units`，模型用 `layout_translations` 按 ID 分别返回译文；缺项、重复 ID 或未知 ID 不被采纳。要点分组不再决定译文的段落结构。
3. 单段可复用原有要点译文；多段仅在要点确实落在唯一源段落内时复用。旧混合译文无法可靠分配时，按源单元补译，不按字符长度猜测切分位置。
4. 显示时由代码恢复列表标记、悬挂缩进和段落缩进；原段落对应不同的 DOM 单元，按源高度预留空间。模型自己添加的换行不创建新段落。字体仍有可读性下限，超长译文允许滚动，不删减内容。
5. 旧缓存打开后从本地 PDF 文字层恢复结构，仅对缺失的译文单元追加请求，不重新调用 MinerU。成功的结构和译文会保存；取消／重新精读时丢弃过期结果。多段或列表结构不会被跨页续段功能压成一个段落。

独立公式、含显示公式的合并段落和图注沿用既有通道。扫描件缺少文字坐标、OCR 内容与文字层不匹配、复杂嵌套列表等情况可能无法恢复全部结构；这不等于任意 PDF 的像素级复刻。

## 卡片交互与颜色

正常布局的卡片以前移除“展开”状态后仍会显示正文；增加明确的手动收起状态，正文、译文、要点和笔记在再次点击原文后真正隐藏。导航打开会清除收起状态，保留展开的其他卡片不受影响。

角色采用七种不同的高对比色带和实色标签：背景灰蓝、空白橙、已有工作金、贡献紫、方法蓝、结果绿、局限红。深色主题保留类别区别，角色文字继续显示。

## 验证

```bash
npm test
python3 -E test/build-layout-fixture.py
E2E_BASE="$PWD/.test-profile/layout" E2E_SKIP_SERVICES=1 E2E_PDF="$PWD/test/fixtures/reading/paragraph-layout.pdf" scripts/e2e.sh test/e2e/translationLayout.js
```

构造了与截图同结构的两栏 PDF，检查真实 PDF.js 字符、粗斜体、两个列表项、两个首行缩进段落、旧缓存修复、SQLite 持久化、二次点击后的实际 CSS 可见性，以及角色标签对比度。另运行跨页／跨图回归，避免破坏上轮行为。模型响应在测试中模拟，因此这些检查验证结构协议和渲染链路，不是对真实模型翻译质量的评价。

对照截图在 `.test-profile/layout/shots/translation-lists.png` 和 `translation-paragraphs.png`。
