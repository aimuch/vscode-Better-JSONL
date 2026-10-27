import * as vscode from 'vscode';
import { t } from './shared/i18n';
import { compactText, minifyJson, prettyJson } from './shared/jsonText';

function eolOf(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function fullLines(doc: vscode.TextDocument, sel: vscode.Selection): vscode.Range {
  let end = sel.end.line;
  if (end > sel.start.line && sel.end.character === 0) end--;
  return new vscode.Range(sel.start.line, 0, end, doc.lineAt(end).text.length);
}

/** The indent text of this editor (its Tab Size and Insert Spaces), so the result matches the editor. */
function editorIndent(editor: vscode.TextEditor): string {
  const { tabSize, insertSpaces } = editor.options;
  if (insertSpaces === false) return '\t';
  return ' '.repeat(typeof tabSize === 'number' ? tabSize : 4);
}

/** Pretty-prints each selected JSONL line in place. The file is not JSONL until "Compact Lines" runs. */
export async function expandLines(editor: vscode.TextEditor): Promise<number> {
  const doc = editor.document;
  const indent = editorIndent(editor);
  const eol = eolOf(doc);
  let count = 0;
  const ok = await editor.edit((b) => {
    for (const sel of editor.selections) {
      const range = fullLines(doc, sel);
      const out: string[] = [];
      let changed = false;
      for (let l = range.start.line; l <= range.end.line; l++) {
        const text = doc.lineAt(l).text;
        if (!text.trim()) {
          out.push(text);
          continue;
        }
        try {
          JSON.parse(text);
          const pretty = prettyJson(text, indent);
          if (pretty !== text) {
            changed = true;
            count++;
          }
          out.push(pretty.split('\n').join(eol));
        } catch {
          out.push(text);
        }
      }
      if (changed) b.replace(range, out.join(eol));
    }
  });
  const cfg = vscode.workspace.getConfiguration('betterJsonl');
  if (ok && count > 0 && cfg.get('expandLines.showReminder', true)) {
    // Not awaited: the command must finish without waiting for the notification.
    const compact = t('Compact Lines');
    const never = t("Don't Show Again");
    void vscode.window
      .showInformationMessage(
        t('Better JSONL: expanded {0} record(s). The file is not valid JSON Lines until you compact it again.', count),
        compact,
        never,
      )
      .then((pick) => {
        if (pick === compact) return vscode.commands.executeCommand('betterJsonl.compactLines');
        if (pick === never) return cfg.update('expandLines.showReminder', false, vscode.ConfigurationTarget.Global);
        return undefined;
      });
  }
  return count;
}

/** Compacts the selection (or the whole file) back to one JSON value per line. */
export async function compactLines(editor: vscode.TextEditor): Promise<boolean> {
  const doc = editor.document;
  const eol = eolOf(doc);
  const sel = editor.selection;
  const range = sel.isEmpty
    ? new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
    : fullLines(doc, sel);
  const src = doc.getText(range);
  const res = compactText(src, eol);
  if (!res.ok) {
    void vscode.window.showErrorMessage(
      t('Better JSONL: line {0} is not valid JSON ({1}). Nothing changed.', range.start.line + res.line, res.message),
    );
    return false;
  }
  const trailing = sel.isEmpty && /\r?\n\s*$/.test(src) ? eol : '';
  const text = res.text + trailing;
  if (text === src) return true;
  return editor.edit((b) => b.replace(range, text));
}

/**
 * "Format Document" for JSONL: one canonical compact line per record.
 * It never expands records, because that would break the JSONL format.
 */
export function formatJsonl(doc: vscode.TextDocument): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = [];
  let perLineOk = true;
  for (let l = 0; l < doc.lineCount; l++) {
    const line = doc.lineAt(l);
    if (!line.text.trim()) continue;
    try {
      JSON.parse(line.text);
      const min = minifyJson(line.text);
      if (min !== line.text) edits.push(vscode.TextEdit.replace(line.range, min));
    } catch {
      perLineOk = false;
    }
  }
  if (perLineOk) return edits;
  // Some records span several lines (for example after "Expand Selected Lines").
  const all = doc.getText();
  const res = compactText(all, eolOf(doc));
  if (!res.ok) return edits;
  const trailing = /\r?\n\s*$/.test(all) ? eolOf(doc) : '';
  const full = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
  return [vscode.TextEdit.replace(full, res.text + trailing)];
}
