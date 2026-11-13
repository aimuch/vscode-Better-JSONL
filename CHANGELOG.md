# Changelog

## Unreleased

- **jq**: variables and patterns (`as $x`, `as [$a, $b]`, `as {a: $x}`), `def` with filter and `$value` parameters (and recursion), `reduce`, `foreach`, `try … catch`, `label` / `break`, and assignment (`=`, `|=`, `+=`, `-=`, `*=`, `/=`, `%=`, `//=`), plus `del`, `getpath`, `setpath`, `delpaths`, `with_entries`, `paths(f)` and `leaf_paths`.
- **Compressed files and other encodings can be edited** record by record: the line is written in the file's encoding (UTF-16, gbk, shift_jis, windows-1252, …) and a compressed file is compressed again.
- **Follow mode for compressed files**: the file is decompressed again and only the new part is added to the view.
- **One JSON value above about 512 MB**: an array (or an object that is mostly one array) is read item by item; its items are records, and only their byte ranges stay in memory. 600 MB with 4.4 million items opens in about 9 seconds with about 1 GB of memory.
- **Expand all** on a file over 50 MB asks first (it parses every line), instead of being off.

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
