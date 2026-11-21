# Changelog

## 1.0.1

- **Security & Robustness**: escaped `data-fd-eval` attribute values in Dataset Diff; disconnected toolbar `ResizeObserver` via `shellGone` abort signal; bounded Grid computed-column program cache (`200` entries) and cleared on column reset.
- **Interaction & UI Polish**: wired `⋯ Tools` overflow menu to keyboard navigation and outside-click dismissal; fixed exiting auto-detected `SELECT ...` SQL projection via the `Projected ×` chip; aligned `ChartsModal` and `SchemaValidateModal` headers/actions to the `.ep-head` / `.ep-actions` design system; raised responsive toolbar compact threshold (`940px`), added dual-tone icon accents, wrapped `Schema` language tabs, added High Contrast borders for cell ranges / cross-tab cells / summary footer, added `scrollIntoView` in Command Palette, and auto-switched X/Metric controls by chart type.
- **Data & Large-File Fixes**: enabled `isComputedCol` evaluation inside >200k-row Grid `readColumns()`; upgraded `readMergedJsonl` to parse pretty-printed `.json` arrays and concatenated JSON streams cleanly; added SQL standard zero-row aggregate output & normalized `JsonPath` `GROUP BY` matching; backfilled >20k-line `leftText` snippets in `streamDiffFiles`; switched `SchemaValidateModal` to non-blocking `runSliced` validation with cached regex patterns and `format` (`email`, `uri`, `uuid`, `date-time`) checks; added **Copy Eval JSONL** export to LLM Side-by-Side Eval.

## 1.0.0

- **Lightweight SQL Query Mode (`SELECT ... WHERE ... GROUP BY ... ORDER BY ... LIMIT`)**: run zero-dependency SQL queries directly in the search bar (auto-detected on `SELECT ` or via the `SQL` toggle) with `COUNT(*)`, `COUNT(DISTINCT col)`, `SUM`, `AVG`, `MIN`, `MAX`, `LIKE`, `IN`, `IS NULL`, nested paths, and aliases — projecting results into Formatted, Grid, Graph, and Export views.
- **Interactive Charts Explorer**: pure SVG **Time-Series Multi-Line**, **Grouped Bar**, and **2D Scatter** plots with click-to-jump record navigation and one-click SVG export.
- **2D Cross-Tab Pivot Matrix & Streaming Sketches**: Pivot now supports **Row × Column** 2D heatmap cross-tabs with click-to-filter cells, backed by $O(1)$-memory **QuantileSketch** (DDSketch) and **HyperLogLog** distinct cardinality estimation for multi-million-row datasets.
- **Grid Multi-Column Sort, Computed Virtual Columns, Range Selection & Summary Footer**: `Shift+Click` column headers for multi-column priority sorting (`1, 2, …`), add `jq`-powered **Computed Virtual Columns** in the Columns manager, `Shift+Click` cells for rectangular range selection (live `Range R×C · Σ · μ` + `Cmd/Ctrl+C` TSV copy), and toggle the sticky **Summary Footer (`Σ`)**.
- **JSON Schema Validation (`Validate JSON Schema`)**: load a `.schema.json` file from disk or paste a schema inline to validate every record (`type`, `required`, `properties`, `enum`, `const`, `minimum`/`maximum`, `pattern`, `items`, `anyOf`/`oneOf`/`allOf`), inspect violations, and filter invalid lines in one click.
- **Zstandard (`.zst`) & Multi-File Merge Viewer (`betterJsonl.mergeFiles`)**: native `.jsonl.zst` / `.ndjson.zst` / `.jsonlines.zst` / `.json.zst` streaming support (on Node 22.15+ runtimes), plus **Merge Open JSON/JSONL Files…** to view multiple shard files together with `_file` source metadata.
- **Streaming Hash-Indexed Large-File Comparison (>50 MB)**: comparing files over 20 MB automatically switches to host-side streaming FNV-1a hash indexing, breaking the previous 50 MB RAM barrier.
- **Multimodal Image Preview & LLM Eval Side-by-Side**: safe inline rendering of `data:image/*` thumbnails in Value Inspector and Chat Reader, plus side-by-side **Chat Eval** comparison (`A wins / Tie / B wins`) in Cross-File Dataset Diff.
- **Extended Schema & Analysis Code Generators**: added **Go `struct`**, **Rust `serde`**, **DuckDB SQL**, and **Python Polars** emitters alongside TypeScript, JSON Schema, Pydantic, and Zod.
- **Graph Viewport Culling, Responsive Overflow Toolbar & Command Palette (`?` / `Cmd/Ctrl+Shift+P`)**: Graph view now culls off-screen SVG nodes on pan/zoom; narrow sidebars collapse analysis tools into a `⋯ Tools` menu; inline Web Worker (`worker-src blob:`) + cancelable time-sliced runner (`compute.ts`) and modular `src/webview/modals/*.ts` architecture.

## 0.9.0

- **Promote & Flatten Nested Paths to Grid Columns**: right-click any nested field (`Add as Grid column`) or use the Grid **Columns** manager (`Add nested path`, `Flatten 1 level`) to promote nested paths like `user.name` or `usage.total_tokens` into first-class sortable, filterable, pinnable, and exportable Grid columns.
- **Interactive Pivot & Group-By Summary**: group records by any top-level or nested path and compute `Count`, `Share %`, `Sum`, `Avg`, `Min`, `p50`, `p95`, and `Max`, with one-click row drill-down filtering and Copy as Markdown or TSV.
- **Schema-Aware Search & `jq` Autocomplete**: live completion menu in the search bar suggesting discovered field paths (`.user.name`, `$.user.name`, `level=`), observed enum values, and `jq` built-in functions (`Tab` or `Enter` to accept).
- **LLM Conversation & Agent Trace Reader**: auto-detects OpenAI / ChatML `messages`, Anthropic `thinking` + `tool_use` / `tool_result`, Gemini `contents` / `parts`, SFT / DPO `prompt` / `completion` / `chosen` / `rejected`, and agent trajectory steps, adding an inline `Chat (N)` pill and a formatted **Chat** tab in the Value Inspector.
- **Data Quality, Anomaly & Duplicate Detector**: single-pass $O(N)$ scanner with 64-bit dual-hash fingerprinting that detects JSON syntax errors, exact duplicate lines, duplicate primary keys (`id`, `uuid`, or custom column), minority type-drift outliers, and missing core fields — with one-click **Filter N lines** and **Delete N duplicates**.
- **Cross-File Dataset Comparison (`betterJsonl.compareFiles`)**: compare the open dataset against another `.jsonl`, `.json`, `.gz`, or `.br` file aligned by primary key or line number, showing `+Added`, `-Removed`, and `~Modified` field diffs, numeric metric deltas, and **Open in the diff editor**.
- **Trace / Request Waterfall View**: right-click any `trace_id` / `request_id` / `session_id` / `correlation_id` field (`Trace call flow`) to correlate matching spans chronologically in a Gantt waterfall with offset, duration bars, error highlights, click-to-jump, and **Filter to trace**.
- **Go to Line / `%` / Timestamp (`Cmd/Ctrl+G`) & Full Paging**: press `Cmd/Ctrl+G` (or click `Line N` in the status bar) to jump by line number (`42`), file percentage (`50%`), or timestamp (`09:15:00` / ISO-8601), plus `Home`, `End`, `PageUp`, and `PageDown` navigation in Formatted and Grid views.
- **PII & Secret Redaction**: right-click **Copy redacted JSON** or enable **Redact secrets & PII** in the Export menu to mask sensitive keys, Bearer tokens, JWTs, API keys (`sk-…`, `ghp_…`, `AKIA…`), URL secret query parameters, and email addresses while preserving structure and token counts.
- **TSV Copy, SQL Export, Brotli (`.br`) & Concatenated JSON Streams**: added one-click **Copy as TSV (Excel / Sheets)**, streaming **TSV (`.tsv`)** and **SQL (`CREATE TABLE` + `INSERT`, `.sql`)** exports, native `.jsonl.br` / `.ndjson.br` / `.jsonlines.br` / `.json.br` streaming & record-by-record editing, and `jq`-style concatenated multi-line JSON stream auto-detection with exact source-line mapping.
- **Explicit State Machines & UX/DX/AX Hardening**: unified modal/popover exclusivity with WCAG `Tab` focus trapping and focus return (`OverlayController`), normalized `QuerySyntaxMode`, deterministic mutation & export stream machines, DOM `data-lifecycle` / `data-modal` attributes + `RenderReport.machines` + `api.inspect()`, toolbar visual grouping, memoized string-JSON unpacking, and zero-allocation lazy record iterators.

## 0.8.0

- **Nested JSON-in-String Unpack**: string values containing serialized JSON (`"{...}"`, `"[...]"`, or multi-line JSONL) get an inline `JSON {N}` / `JSON [N]` unpack pill in Formatted and Grid views (plus right-click **Unpack JSON**) so double-encoded logs, tool calls, and webhook payloads expand in place without modifying the file.
- **Multiline String Expansion & Value Inspector**: strings with `\n` can expand inline in Formatted view (`↵ N lines text`) or open in the full **Value Inspector** modal (`Text`, XSS-safe `Markdown`, pretty `JSON`, and `Decoded` tabs without preview truncation).
- **Smart Value Semantic Decoder**: hovering or inspecting Unix epoch timestamps (seconds / ms / µs / ns) and ISO-8601 dates shows local time, UTC time, and the delta from the previous record; JWT tokens decode header, payload, and expiry status; Base64 values decode UTF-8 / JSON; URLs list decoded query parameters.
- **jq Transform / Projection Virtual View**: toggle **Transform** (`xform`) in the search bar to project `jq` or `JSONPath` outputs (for example `{id, user: .user.name, fast: (.ms < 100)}`) into a virtual document across Formatted, Grid, Graph, Schema Generator, and Export.
- **Search Modes, History & Saved Queries**: added **Match Case** (`Aa`), **Regular Expression** (`.*`), and **Literal Text** (`""`) toggles, `>=` / `<=` / `==` path operators, copy-pasted `"key": value` fallback, `↑` / `↓` query history, and starred saved queries (`★`).
- **Timeline Sparkline & Numeric Percentiles**: JSONL files with timestamp columns can open an interactive 48-bucket **Timeline** bar with error markers and drag-to-brush time-window filtering; Grid column statistics now include `p50 · p95 · p99`, `sum`, and a 12-bin distribution histogram.
- **Grid Column Manager & Numeric Range Filter**: added a **Columns** popover to search, show/hide, reorder, sticky-pin columns to the left, and mount columns beyond the default 300-column cap; added `Min` / `Max` numeric range inputs in column filters, missing-cell & nested sub-grid primitive editing, and an always-visible **Clear all filters** action in the status bar.
- **Row Bookmarks**: press `B` (or `Alt+Click` a line number) to bookmark records, `[` / `]` to jump between bookmarks, and filter to **Bookmarked lines** only.
- **Schema & Type Generator**: infer **TypeScript** interfaces, **JSON Schema (2020-12)**, **Python Pydantic** models, and **Zod** schemas from visible records with one-click Copy or Save.
- **Field Context Menu, New Exports & Format Converter**: right-click any field or row for **Inspect value**, **Copy raw value / JSON / JSONPath / jq path**, **Filter `=` / `!=`**, bookmark, and row actions; export rows or selections as **JSON Array (`.json`)** and **Markdown Table (`.md`)**; added **Better JSONL: Convert JSON Array ↔ JSON Lines** (`betterJsonl.convertFormat`).
- **Row Insert / Duplicate / Delete & Batch `jq` Rewrite**: insert, duplicate, or delete JSONL lines directly from the viewer (including `.jsonl.gz` and non-UTF-8 files), or transform records in bulk with before/after diff preview via **Batch `jq` rewrite**.
- **Fixes & Hardening**: exact `RawNum` preservation for >=16-digit split decimals and overflow exponents, RFC 8259 control-byte validation in `byteJson`, jq recursion depth guard & recursive object `*` merge, symlink boundary check in `readModules`, virtual-filesystem read-only detection, High Contrast theme support, responsive Graph inspector drawer, and multi-URI webview state LRU.

## 0.7.0

- **Fixed: Export (CSV / JSON Lines)** now acknowledges every streamed chunk so exports above 2 MB write the full file, close their file handle, and finish cleanly.
- **Grid above 1.2 million rows**: virtual scroll scaling keeps every row reachable past the browser's 33.5M px height limit.
- **Faster word wrap and Expand all**: wrapped row heights update in `O(log n)` with a Fenwick tree instead of rebuilding the whole prefix-sum array on each scroll, and **Expand all** on files above 50 MB computes heights in background slices without churning the record cache.
- **jq**: added `index`, `rindex` and `indices`; fixed `|=` when the update filter returns `empty` on arrays; exact comparison for large integers above `2^53` in jq, JSONPath, path queries and Grid sorting; safer `'x'` regex flag parsing; module imports stay within the document or workspace folder.
- **Encodings and large files**: 4-byte `gb18030` and 3-byte `euc-jp` support when editing lines; standalone `CR` line endings in byte-streamed files; UTF-16 byte order mark encoding kept across `Follow` appends; symbolic links preserved on line edits; `< 3`-byte files handled in `replaceLine`.
- **Polish**: cross-token plain-text search highlights in Formatted view, jq/JSONPath search highlights and match counter in Graph view, nested sub-grid double-click source reveal, `Alt+Z` word wrap shortcut in `.gz` viewers, `.jsonlines` Format Document support, sticky JSON Lines mode while editing `.json` files with one value per line, and stricter active-editor checks when opening a preview from the Command Palette.

## 0.6.0

- **jq**: variables and patterns (`as $x`, `as [$a, $b]`, `as {a: $x}`), `def` with filter and `$value` parameters (and recursion), `reduce`, `foreach`, `try … catch`, `label` / `break`, and assignment (`=`, `|=`, `+=`, `-=`, `*=`, `/=`, `%=`, `//=`), plus `del`, `getpath`, `setpath`, `delpaths`, `with_entries`, `paths(f)` and `leaf_paths`.
- **Compressed files and other encodings can be edited** record by record: the line is written in the file's encoding (UTF-16, gbk, shift_jis, windows-1252, …) and a compressed file is compressed again.
- **Follow mode for compressed files**: the file is decompressed again and only the new part is added to the view.
- **One JSON value above about 512 MB**: an array (or an object that is mostly one array) is read item by item; its items are records, and only their byte ranges stay in memory. 600 MB with 4.4 million items opens in about 9 seconds with about 1 GB of memory.
- **Expand all** on a file over 50 MB asks first (it parses every line), instead of being off.
- **More jq**: string interpolation, format strings (`@csv`, `@tsv`, `@json`, `@html`, `@uri`, `@sh`, `@base64`, `@base64d`, `@base32`, `@base32d`), `?//` destructuring alternatives, `import` / `include` (module files next to the document, read through the host), and `input` / `inputs` (the query runs once over the whole file; records it gives back are matches, other results show in the status bar).
- Fixed: after a record of a compressed file was edited, follow mode read the whole file again on the next change.

## 0.5.0

- **jq and JSONPath** in the search box: a search that starts with `.` is a jq filter, one that starts with `$` is a JSONPath (RFC 9535). On JSON Lines they select records; in one JSON document `Enter` goes to each result, and a computed result shows in the status bar.
- **Large files**: a record of a large UTF-8 JSON Lines file can be edited (the line is replaced on disk). Follow mode adds new lines at the end of a growing file without reading it again. Files in other encodings (a UTF-16 byte order mark, or `files.encoding`) are read. One JSON value above about 512 MB is parsed from the bytes.
- **Compressed files**: `.jsonl.gz`, `.ndjson.gz` and `.json.gz` open in Better JSONL, read-only.
- **Grid**: sorting and column filters work on large files of any length (the columns are read in the background). The filter popup shows column statistics. Double-click a value to edit it in place.
- **Follow** button (JSON Lines): the view stays at the last line while lines are added.
- **Export** the lines or rows on screen, or the selected lines, as JSON Lines or CSV.
- **Compare** two selected lines field by field, or in the VS Code diff editor.
- **Graph overview** in the corner when the graph does not fit the view.
- Fixed: in the Grid, a double-click on a row that was not the current one did nothing (the first click painted the rows again).
- CI also runs the host tests on VS Code 1.85, and can publish to the Visual Studio Marketplace and Open VSX (when the repository has the tokens).

## 0.4.0

- **Large files.** A file above 50 MB (the size VS Code stops giving to extensions) now opens read-only: it is read from disk in chunks and shows while it loads. Lines are decoded and parsed only when they are needed, and search runs in the background. Measured: a 300 MB JSON Lines file shows its first rows in 0.3 s and is fully scanned in about 8 s; a 300 MB JSON array opens folded after about 2 s of parsing.
- Search in one JSON document finds text inside folded nodes. `Enter` goes to the next match and opens only the nodes on the way to it. A large JSON document opens folded, and before this its content could not be searched.
- JSON Lines edits go to the view as changes, not as the whole text: only the edited lines are patched. The view asks for the whole text when the two sides do not agree on the line count or length.
- Keyboard: fold arrows are buttons (Enter or Space; the focus stays on the arrow), grid headers sort with Enter, graph nodes take the focus (Enter selects, Left folds, Right unfolds; `+`, `-` and `0` zoom and fit).
- **Expand Selected Lines** and **Compact Lines** are in the right-click menu and the Command Palette for JSON and JSON Lines files.
- Fixed: the exported SVG was not valid XML for a graph with child nodes, and PNG export did nothing.
- Fixed: the view could show another line than the editor cursor after a line was added or removed above it.
- Fixed: Enter on a toolbar button opened the record editor.
- Faster on every file: opening no longer parses the whole file before the first paint, an edit re-parses only the lines that changed, and a hidden view is not updated until it shows again.
- A document update keeps folds, open sub-grids and the selection, also when lines move. The view state (search, filters, sort, folds) comes back after a restart.
- Fixed: a `.json` file with one value per line now reveals the right line and follows the editor cursor.
- Fixed: the view keeps following a file after VS Code closes its text document, and an edit is checked against the text that is in the file now.
- Fixed: Grid columns for keys named `#` or `(value)` showed row numbers or nothing.
- Fixed: the exported graph lost the box of the selected node.
- Limits that hide data (grid columns, lines in a graph, a long Shift selection) are now named in the status bar.
- The settings panel writes to the workspace settings when the workspace sets that value, and refuses values that are not valid.
- Cursor sync no longer depends on a 400 ms time window.
- **Compact Lines** keeps blank lines between records.
- Fixed: the background scan and a search over a large file almost stopped while the VS Code window was in the background.
- Fixed: every file the preview switched to left listeners (and its data) behind in the webview.
- Fixed: **Expand Selected Lines** failed with two cursors on the same line. **Compact Lines** now works on every selection too.
- Fixed: "Source" on a key that is in an object twice went to the first one; the views show the last one.
- A long number inside a string (a timestamp, an ID) no longer switches a file to the slower exact-number parse (about 6 times slower).
- Settings panel: the indent in use is offered when it is not 2 or 4; a switch for "the side preview follows the active editor".
- Fixed: a read error while a large file loads is shown in the view; the exported graph uses the edge color of the screen.
- Unit and property tests for the lossless JSON text helpers and the large-file line store (`npm run test:unit`).

## 0.3.0

- Grid: filter by column. The funnel button in each header opens a list of the column's values with counts (tick or untick them), a search box (cells that contain the text), sort buttons and Clear filter. Filters on several columns combine; the status bar shows how many rows are left.

## 0.2.0

- Word wrap in the Formatted and Grid views: `Alt+Z` (`Option+Z`), a toolbar button, and the setting `betterJsonl.wordWrap` (follows `editor.wordWrap` by default). Wrapped pretty lines keep their indent.
- Settings panel (gear button): theme, word wrap, indent, default view and mode, graph node limit, editor sync, Format Document and the Expand reminder. Changes are saved to your VS Code user settings.
- Theme setting `betterJsonl.theme`: follow VS Code, light, dark, or follow the operating system.
- Grid: a nested value now opens under its own column, not at the left edge.
- Language setting `betterJsonl.language` (Follow VS Code / English / 简体中文) for the views and messages, also in the settings panel. Menus and setting descriptions are translated through `package.nls.zh-cn.json`.

## 0.1.4

- Fixed: the title-bar button icon and the preview tab icon were empty files, so the button was invisible.
- The prism button now stays on the editor title bar when other extensions fill it. VS Code shows at most 9 title buttons and moved this one into "More Actions"; it is now ordered first.
- The reminder after Expand Selected Lines has a "Don't Show Again" button (setting `betterJsonl.expandLines.showReminder`).

## 0.1.3

- Format Document no longer changes JSON Lines files by default. Turn on `betterJsonl.formatDocument.enabled` to compact each line again.
- Expand Selected Lines now uses the editor's own indentation (Tab Size, spaces or tabs) instead of `betterJsonl.indent`, so the result lines up with the rest of the editor.

## 0.1.2

- The prism button in the editor title bar now shows for JSON and JSONL files even when the text editor does not have focus.

## 0.1.1

- The open commands are now at the top level of the right-click menus: inside the editor, on the editor tab, and in the Explorer. You no longer need "Open With…".
- All command titles start with "Better JSONL:".
- Menu and keybinding conditions use plain `==` / `||` checks instead of regular expressions.

## 0.1.0

- Formatted view with Focus and Expand all modes for JSON Lines, synced with the editor cursor.
- Grid view with nested sub-grids, sorting and column resize.
- Graph view with pan, zoom, fold, inspector, line compare and SVG/PNG export.
- Search with path queries (`path:text`, `path=value`, `path>n`).
- Record editor that saves one compact line.
- Expand Selected Lines, Compact Lines and Format Document for JSONL.
