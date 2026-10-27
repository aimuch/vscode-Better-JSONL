# Changelog

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
