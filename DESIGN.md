# Better JSONL — 设计方案

> 一份数据，三种视图：格式化（Formatted）、表格（Grid）、图（Graph）。
> 文档语言：中文，按 ASD-STE100 规则书写（短句，一句一个意思，主动语态）。

## 1. 需求分析

| # | 需求 | 解读 |
|---|------|------|
| R1 | 起一个合适的名字 | 见第 4 节。 |
| R2 | 格式化显示 JSON 和 JSONL | 只做"显示格式化"。源文件不变。 |
| R3 | JSONL 支持"全部行格式化"和"只格式化当前行/选中行" | 两种模式：Focus（选中行展开）和 Expand All（全部展开）。"当前行"指原生编辑器光标所在行，也指视图里点选的行。 |
| R4 | 可切换视图：默认格式化视图，可切到 JSON Crack 风格图视图、JSON Grid / JSONL Lens 风格表格视图 | 一个 Webview，顶栏切换三种视图。三种视图共享"当前行"。 |

### 1.1 需要指出的问题

1. **作为参考的 "Better JSONL" 插件不存在。** Marketplace 和 GitHub 都查不到这个名字。你描述的交互（卡片 + 跟随光标）在 `ChaconneLuo.jsonl-lens`（"synchronized, formatted JSON cards"）和 `skyer.jsonl-preview`（"navigation and synchronization"）中存在。本方案按这个交互实现，并使用 Better JSONL 作为本插件的名字。
2. **"当前行"需要原生编辑器。** 如果 Webview 完全替代文本编辑器，就没有光标。所以主入口是"侧边预览"（像 Markdown Preview）：左边原生编辑器，右边 Better JSONL 视图，双向同步。完整替代编辑器（Open With…）是第二入口。
3. **JSONL 不能被"Format Document"展开成多行。** 展开会破坏 JSONL 格式。插件的目标是"格式化显示"，所以 JSONL 的 Format Document 默认不做任何修改。用户打开 `betterJsonl.formatDocument.enabled` 后，它只做"每行规范化为单行"。

## 2. 参考插件：借鉴什么

| 插件 | 借鉴点 | 不照搬的点 |
|------|--------|-----------|
| JSONL Lens（ChaconneLuo）/ JSONL Preview | 卡片列表；跟随编辑器光标；行号对应 | — |
| JSON Crack | 对象 = 节点，节点里列出原始类型的 key: value；嵌套对象/数组 = 子节点 + 连线；左到右树布局；节点折叠 | 不用 reaflow/ELK。JSON 是树，不是 DAG，手写分层树布局足够。 |
| JSON Grid Viewer | 嵌套对象/数组折叠为标签，点击后行内展开子表格；对象数组显示为表格；列宽可拖动 | — |
| JSONL Lens: JSON Lines and NDJSON Viewer | JSONL 一行一条记录；列 = 顶层 key 并集；虚拟滚动；全文搜索 | 不做付费功能。 |

## 3. 对另一份方案的评估

| 项 | 结论 | 原因 |
|----|------|------|
| React + Vite + Tailwind | 不采用 | Webview UI 用原生 TS + DOM。零运行时依赖，VSIX 体积小。主题用 `--vscode-*` CSS 变量，比 Tailwind 更贴合 VS Code 主题。 |
| Monaco / CodeMirror 做格式化视图 | 不采用 | Monaco 体积 4MB 以上，主题和快捷键与宿主冲突。编辑交给原生编辑器（双向同步）和单条记录编辑面板。 |
| TanStack Table / Virtual | 不采用 | 手写定高行虚拟滚动（约 100 行代码）。 |
| React Flow + elkjs | 不采用 | elkjs 约 1.4MB。手写树布局 + SVG 渲染 + 平移缩放。SVG 可以直接导出。 |
| CustomTextEditorProvider | 采用，作为第二入口 | 主入口改为侧边预览。原因见 1.1 第 2 条。 |
| DocumentFormattingEditProvider 给 .json | 不采用 | VS Code 内置 JSON 格式化器已经存在。重复注册会弹出"选择格式化器"。 |
| DocumentFormattingEditProvider 给 .jsonl | 默认关闭，设置开启 | 默认不注册，Format Document 不改文件。开启 `betterJsonl.formatDocument.enabled` 后才注册：只做每行规范化（无损压缩为单行），不展开。 |
| Focus / Expand All 两种模式 | 采用 | 与 R3 一致。 |
| 编辑后自动压缩回单行 | 采用 | 用无损压缩（只删字符串外的空白），不经过 `JSON.parse → stringify`，所以大整数和转义不变。 |
| 行解析失败只标记该行 | 采用 | 见失效模式 F1。 |
| Graph 的行选择器 | 采用 | 默认显示当前行；多选时（最多 10 行）挂在一个虚拟根节点下对比。 |
| JSONPath / key:value 过滤 | 部分采用 | 支持 `path:text`（包含）和 `path=value`（等于）。不做完整 JSONPath。 |
| 文件大小统计 | 采用 | — |
| 缺少的项 | 补充 | 大整数精度、JSONC 回退、50MB 同步上限、CSP、双向同步防回环、编辑冲突检测。 |

## 4. 命名

- **名字：Better JSONL。** 与工作目录同名。Marketplace 上没有同名插件。
- 扩展 ID 是 `publisher.better-jsonl`。命令和设置的前缀是 `betterJsonl.`。
- 图标：一个棱镜。三行 JSON 进入棱镜，变成三束彩色的光。这表示一份数据，三种视图。

## 5. 架构

```
┌──────────── Extension Host (Node, TS) ────────────┐
│ extension.ts      注册命令、预览、自定义编辑器、格式化器 │
│ session.ts        一个 Webview ↔ 一个 TextDocument     │
│                   · 文档变化 → 发送全文（防抖 150ms）    │
│                   · 编辑器选区 → 发送选中行             │
│                   · Webview 点选 → reveal 到原生编辑器   │
│                   · Webview 编辑 → WorkspaceEdit 回写    │
│ preview.ts        侧边预览面板，跟随活动编辑器           │
│ customEditor.ts   CustomTextEditorProvider (option)     │
│ jsonlText.ts      无损压缩、拆分拼接的 JSON、展开/压缩行  │
│ locate.ts         JSONPath → 源码偏移（jsonc-parser）     │
└───────────────────────┬───────────────────────────┘
                        │ postMessage（协议见 src/shared/protocol.ts）
┌───────────────────────▼──── Webview (浏览器, 原生 TS) ┐
│ main.ts        状态、顶栏、视图切换                     │
│ model.ts       行切分、惰性解析、后台统计、搜索/过滤      │
│ views/formatted.ts  定高行虚拟列表（卡片 + 折叠）        │
│ views/grid.ts       记录表格 + 行内子表格                │
│ views/graph.ts      树布局 + SVG + 平移缩放 + 检查器     │
└──────────────────────────────────────────────────────┘
```

构建：esbuild 两个入口。`extension` 输出 CJS（node），`webview` 输出 IIFE（browser）。

### 5.1 入口

| 入口 | 方式 | 说明 |
|------|------|------|
| 侧边预览（主） | 右键菜单第一级 `Better JSONL: Open Preview to the Side`（编辑器内、标签页、资源管理器）、编辑器标题栏右上角的棱镜按钮、快捷键 `Cmd/Ctrl+K J` | 跟随活动的 JSON/JSONL 编辑器。与光标双向同步。 |
| 完整视图 | 右键菜单第一级 `Better JSONL: Open Full View`（同上三处） | CustomTextEditor，`priority: option`。文件本身仍可保存/撤销。它也出现在 "Open With…" 列表里，但不依赖它。 |
| 原生编辑器命令 | 右键菜单第一级 `Better JSONL: Expand Selected Lines`、`Better JSONL: Compact Lines`；Format Document（jsonl） | 编辑场景使用。 |

菜单显示条件只用 `==` 和 `||`，不用正则（`=~`）。所有命令标题都以 `Better JSONL: ` 开头，在右键菜单里容易识别。

标题栏按钮的两条规则（都已在真实 VS Code 中验证）：
- 条件用 `resourceLangId` / `resourceExtname`。`editorLangId` 只在文本编辑器有焦点时对标题栏可见。
- 分组是 `navigation@-100`。VS Code 的编辑器标题栏最多显示 9 个按钮（拆分编辑器等内置按钮也占名额），多出的按钮进入 `…` 菜单。排序规则是：分组 → 序号（默认 0）→ 标题。负序号让本按钮排在其他扩展前面，不会被挤掉。

### 5.2 共享状态（Webview 内）

`view`（formatted/grid/graph）、`expandMode`（focus/all）、`selection`（选中记录集合）、`active`（当前记录）、`query`、`filterOnly`、每条记录的折叠状态。用 `vscode.setState` 持久化。文档更新时按行号保留状态。

## 6. 三种视图

### 6.1 Formatted（默认）

- JSONL：每条记录一张卡片，左侧行号槽。
  - **Focus 模式**：未选中记录显示为单行预览（语法高亮，超长截断）。选中记录展开为多行缩进格式。多选时多条展开。
  - **Expand All 模式**：全部记录展开。
  - 展开后可按节点折叠（点击 ▸/▾）。
- JSON：整个文档是一条记录，总是展开。顶栏显示"全部展开 / 全部折叠"。
- 错误行：红色左边框 + 错误信息 + 原文，错误位置下划线。
- 实现：把所有记录"拍平"为定高的文本行（折叠记录 = 1 行，展开记录 = N 行），按前缀和定位，只渲染可见行。行号跳转是 O(log n)。
- 单条编辑：点 `Edit` 或按 `Enter` → 编辑面板（多行文本框）→ `Cmd/Ctrl+Enter` 应用 → 宿主做无损压缩并替换该行。
- 双击任意一行：跳到原生编辑器中对应的成员（JSONPath 定位）。
- 自动换行（`Alt+Z` / `Option+Z`，或工具栏按钮）：不换行时每行定高（上面的实现）。换行时每行高度不同：先按文本估算（等宽字体，中日韩字符按 2 列），渲染后测量真实高度并修正；修正时以屏幕顶部那一行为锚点，内容不跳动。展开的行用悬挂缩进（`padding-left: N ch`），折行部分对齐本行的第一个字符。

### 6.2 Grid

- JSONL / 根数组：一行一条记录。列 = 顶层 key 并集（按首次出现排序），首列是行号。非对象记录放在行号后的 `(value)` 列。
- 根对象：Key / Value 两列。
- 嵌套值显示为标签 `{3}` / `[5]`。点击后在该行下方展开子表格（递归），子表格从被点击的那一列的左边缘开始（CSS 变量 `--xN` 记录每列的左边缘，拖动列宽时同步更新）。对象数组显示为表格。
- 自动换行时，单元格内长文本换行，行高由测量得到。
- 列排序（升序/降序/无）、列宽拖动、过滤。点击行 = 设置当前记录。

### 6.3 Graph

- 节点 = 对象/数组。节点内列出原始类型的 `key: value`。嵌套值 = 子节点，连线从对应的行引出。左到右分层树布局。
- JSONL：显示当前记录。多选（≤10）时挂在虚拟根节点下。顶部有行选择器（◀ 行号 ▶）。
- 平移（拖动或滚动）、缩放（`Cmd/Ctrl`+滚轮或按钮）、适应窗口、节点折叠、搜索高亮。
- 点击节点 → 右侧检查器：JSONPath、类型、值、`Copy Path` / `Copy Value` / `Reveal in Editor`。
- 节点数超过 `betterJsonl.graph.maxNodes`（默认 1500）时截断并提示。
- 导出 SVG / PNG（画布右上角按钮，经宿主保存对话框）。

### 6.4 设置面板与主题

- 工具栏右侧的齿轮按钮打开右侧抽屉（结构参考 Git Map 的设置面板）：分段按钮、复选框，底部链接打开 VS Code 设置编辑器。
- 面板的每次修改都发消息给宿主，宿主写入 VS Code 用户设置（`ConfigurationTarget.Global`）。所有视图通过配置变更事件同步，所以面板和 `settings.json` 始终一致。宿主只接受白名单里的设置键。
- 主题：`vscode` 时直接使用 VS Code 注入的 `--vscode-*` 变量；`light` / `dark` 时在 `body[data-theme]` 上用一整套固定配色（VS Code Light Modern / Dark Modern）覆盖这些变量；`system` 时按 `prefers-color-scheme` 选择 light 或 dark，并监听系统切换。VS Code 默认把 Electron 的 `nativeTheme.themeSource` 设为 `system`，所以它反映操作系统；如果用户设置了 `window.systemColorTheme`，则以它为准。

## 7. 数据与性能

- 宿主发送全文。Webview 按行切分，**惰性解析**：只解析可见或需要的记录。后台按时间片（每片 8ms）解析全部，更新统计、错误列表、列集合。
- 大整数：行中出现 16 位以上数字时，用 `JSON.parse` reviver 的 `context.source` 保留原文（Chromium 114+）。显示原文。
- `.json` 解析失败时，用 JSONC 宽松解析（注释、尾逗号），并显示 `JSONC` 标记。
- VS Code 不把超过 50MB 的文档同步给扩展。超过时显示明确提示，建议用文本编辑器。
- Webview CSP：只允许本扩展的脚本（nonce）和样式。不加载外部资源。

## 8. 设置

| 设置 | 默认 | 说明 |
|------|------|------|
| `betterJsonl.defaultView` | `formatted` | 打开时的视图 |
| `betterJsonl.theme` | `vscode` | `vscode`（跟随 VS Code）/ `light` / `dark` / `system`（跟随操作系统） |
| `betterJsonl.wordWrap` | `followEditor` | `followEditor`（跟随 `editor.wordWrap`）/ `on` / `off`。`Alt+Z` 在当前视图里临时切换。 |
| `betterJsonl.jsonl.expandMode` | `focus` | `focus` / `all` |
| `betterJsonl.indent` | `2` | 视图和单条编辑面板的缩进空格数。原生编辑器里的 `Expand Selected Lines` 不用它，而是用该编辑器自己的 Tab Size 和空格/Tab 设置。 |
| `betterJsonl.graph.maxNodes` | `1500` | 图节点上限 |
| `betterJsonl.preview.followActiveEditor` | `true` | 预览是否跟随活动编辑器切换文件 |
| `betterJsonl.syncSelection` | `true` | 是否与原生编辑器双向同步选区 |
| `betterJsonl.expandLines.showReminder` | `true` | `Expand Selected Lines` 之后是否提醒“文件暂时不是合法 JSONL”，并提供 `Compact Lines` 按钮。提醒里的 `Don't Show Again` 会把它设为 `false`。 |
| `betterJsonl.formatDocument.enabled` | `false` | 是否让 Format Document 压缩 JSONL 的每一行。关闭时 Format Document 不改 JSONL 文件。 |

## 9. 失效模式清单（先写清单，再写代码）

| ID | 失效模式 | 必须的行为 |
|----|---------|-----------|
| F1 | 某行 JSON 无效 | 只标记该行（行号 + 列号 + 信息）。其他行正常显示。 |
| F2 | 整数超过 2^53 | 显示值与源文本完全一致。 |
| F3 | 回写/规范化改变数据 | 无损压缩：数字、字符串转义、键顺序、重复键都不变。 |
| F4 | 空行、只有空白的行 | 不算错误。保留行号对应关系。 |
| F5 | CRLF 行尾 | 行内容不带 `\r`。回写保持原行尾。 |
| F6 | UTF-8 BOM | 首行不能因 BOM 解析失败。 |
| F7 | 单行超长（>1MB） | 折叠预览截断显示，界面不卡死。 |
| F8 | 深度嵌套（>1000 层） | 渲染不栈溢出（迭代或深度上限）。 |
| F9 | 图节点过多 | 截断并提示，不卡死。 |
| F10 | .json 带注释/尾逗号 | JSONC 回退解析并标记。 |
| F11 | 文档变化 | 视图、选中行、折叠状态保持。 |
| F12 | 双向同步回环 | 编辑器 → Webview → reveal → 编辑器，不能无限循环。 |
| F13 | 编辑冲突（Webview 编辑期间文档已变） | 回写前比对原行文本。不一致时拒绝并提示。 |
| F14 | 浅色/深色/高对比主题 | 全部可读（只用 `--vscode-*` 变量）。 |
| F15 | 文件超过 50MB | 显示明确提示。 |
| F16 | 根值是原始类型、空对象、空数组 | 三种视图都能显示。 |
| F17 | key 含 `.`、空格、引号 | JSONPath 用 `["a.b"]` 形式正确转义。Reveal 定位正确。 |
| F18 | "展开选中行"后文件不再是合法 JSONL | 命令提示用户；`Compact Lines` 能恢复。 |

## 10. 测试方案（只做 E2E，最后运行）

1. **宿主 E2E**：`@vscode/test-electron` + mocha。打开夹具文件，执行命令，断言文档文本、会话状态、选区位置。覆盖 F1–F6、F11–F13、F17、F18。
2. **Webview E2E**：`playwright-core` + 本机 Chrome。加载测试页（模拟 `acquireVsCodeApi`），驱动三种视图，截图。覆盖 F1、F2、F4、F7–F10、F14、F16。
3. **产物**：`test-results/report.html`（截图 + 每条断言结果）和 `test-results/host-e2e.json`。可重复运行：`npm run test:e2e`。

## 11. 不做 / 延后

- 超过 50MB 的文件的只读流式视图（需要 CustomReadonlyEditor + 分块读取）。
- 完整 JSONPath / jq 查询。
- Graph 小地图。
- 表格内直接编辑单元格。
