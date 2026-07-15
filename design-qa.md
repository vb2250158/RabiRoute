# Project Docs Layout Design QA

- Source visual truth: user-provided reference image (not committed)
- Implementation screenshot: `docs-layout-implementation.png`
- Viewport: 1568 × 1100
- State: `/docs`, 项目总览，桌面宽屏，默认搜索为空

## Full-view comparison evidence

参考图的核心布局由顶部文档栏、左侧章节目录、中间连续正文、右侧页内目录组成。实现保留 RabiRoute 现有应用外壳与浅色品牌主题，在内容区域复现相同的三栏阅读结构；浏览器计算结果为 `244px 764px 190px`，右侧目录在宽屏显示。

## Focused region comparison evidence

重点核对了参考图与实现的左侧章节层级、正文标题/分隔线/连续阅读节奏、右侧锚点目录。实现不复制 ROKID.js 的深色主题、品牌导航或具体文案，这些属于产品差异；布局层级与阅读行为一致。页面没有需要额外生成或替换的图片资产。

## Findings

- P3：RabiRoute 主应用自身已有一层全局左侧栏，因此文档内容区比参考图更窄。该差异是现有产品外壳约束，不影响三栏阅读结构。
- P3：功能详情继续使用轻量信息卡承载“真源/消费点/生效时机/副作用”，以保留现有结构化信息密度；章节整体已改为连续文档排版。

## Required fidelity surfaces

- Fonts and typography: 沿用项目现有中文字体与字重；标题、导语、正文和小目录建立清楚层级，无截断。
- Spacing and layout rhythm: 三栏比例、分隔线、章节间距和粘性目录均符合参考布局；窄屏降级为单栏与横向章节导航。
- Colors and visual tokens: 保留 RabiRoute 浅色青绿色 token，没有照搬参考产品的黑色主题。
- Image quality and asset fidelity: 参考目标仅提供布局，不含需迁移的内容图片；现有 RabiRoute 品牌资产保持不变。
- Copy and content: 所有 RabiRoute 文档数据继续来自原页面常量，未用参考图文案替换。

## Interaction and runtime checks

- 左侧“边界规则”切换成功，目标标题唯一出现。
- 搜索 `Outbox` 后目录筛选为相关页面集合。
- 右侧目录锚点由当前页面内容动态生成。
- 浏览器控制台无应用错误。
- `npm run webgui:build` 通过。

## Comparison history

1. 首轮：旧 `.docs-layout` 样式覆盖三栏网格，右侧目录未显示（P1）。
2. 修复：提高文档页网格选择器作用域，复核计算列宽为 `244px 764px 190px`，右侧目录可见；P1 已消除。

## Follow-up polish

- 若未来希望文档拥有与参考图更接近的可用宽度，可在 `/docs` 路由单独提供“专注阅读”模式，折叠全局应用侧栏。

## Collapsible navigation follow-up

- Source visual truth: user-provided reference image (not committed)
- Implementation screenshot: `docs-menu-implementation.png`
- State: desktop `/docs`, “开始” collapsed, “配置” group selected
- Full-view evidence: left navigation now uses highlighted group rows, independent chevrons, indented child pages, and continuous document content matching the source interaction pattern.
- Focused evidence: “折叠开始” changed its child container to `display: none`; clicking the “配置” group label navigated to its landing page “Route 配置”.
- Typography, spacing, colors, assets, and copy remain within the existing RabiRoute design system. No new image assets were required.
- Responsive behavior: desktop groups collapse; mobile keeps all page pills reachable and hides only the redundant group chevron.
- Console errors: none.
- Comparison result: no actionable P0/P1/P2 findings; the light RabiRoute theme is an intentional product difference from the dark reference.

final result: passed
