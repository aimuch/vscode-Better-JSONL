import * as vscode from 'vscode';
import { isJsonlDocument } from './config';
import { t } from './shared/i18n';
import { compactText, convertJsonAndJsonl, minifyJson, prettyJson, stripBom } from './shared/jsonText';

function eolOf(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function fullLines(doc: vscode.TextDocument, sel: vscode.Selection): vscode.Range {
  let end = sel.end.line;
  if (end > sel.start.line && sel.end.character === 0) end--;
  return new vscode.Range(sel.start.line, 0, end, doc.lineAt(end).text.length);
}

/** The selections as whole-line ranges in file order. Ranges that share a line are joined: one edit cannot touch a line twice. */
function lineRanges(doc: vscode.TextDocument, selections: readonly vscode.Selection[]): vscode.Range[] {
  const out: vscode.Range[] = [];
  for (const r of selections.map((s) => fullLines(doc, s)).sort((a, b) => a.start.line - b.start.line)) {
    const last = out[out.length - 1];
    if (!last || r.start.line > last.end.line) out.push(r);
    else if (r.end.line > last.end.line) out[out.length - 1] = new vscode.Range(last.start, r.end);
  }
  return out;
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
  const expandedSpans: [number, number][] = [];
  let lineDelta = 0;
  const ok = await editor.edit((b) => {
    for (const range of lineRanges(doc, editor.selections)) {
      const out: string[] = [];
      let changed = false;
      for (let l = range.start.line; l <= range.end.line; l++) {
        const rawText = doc.lineAt(l).text;
        const text = l === 0 ? stripBom(rawText) : rawText;
        const bom = l === 0 && rawText !== text ? '\ufeff' : '';
        if (!text.trim()) {
          out.push(rawText);
          continue;
        }
        try {
          JSON.parse(text);
          const pretty = prettyJson(text, indent);
          if (pretty !== text) {
            changed = true;
            count++;
          }
          out.push(bom + pretty.split('\n').join(eol));
        } catch {
          out.push(rawText);
        }
      }
      if (changed) {
        const joined = out.join(eol);
        const newLines = joined.split(eol).length;
        const oldLines = range.end.line - range.start.line + 1;
        const startAfter = range.start.line + lineDelta;
        expandedSpans.push([startAfter, startAfter + newLines - 1]);
        lineDelta += newLines - oldLines;
        b.replace(range, joined);
      }
    }
  });
  const cfg = vscode.workspace.getConfiguration('betterJsonl');
  // In a JSON Lines file the expanded records break the format. In a .json file they do not.
  if (ok && count > 0 && isJsonlDocument(doc) && cfg.get('expandLines.showReminder', true)) {
    // Not awaited: the command must finish without waiting for the notification.
    const compact = t('Compact Lines');
    const never = t("Don't Show Again");
    void vscode.window
      .showInformationMessage(
        t('Better JSONL: expanded {0} record(s). The file is not valid JSON Lines until you compact it again.', count),
        compact,
        never,
      )
      .then(async (pick) => {
        if (pick === compact) {
          const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc) ?? (await vscode.window.showTextDocument(doc));
          if (expandedSpans.length && ed.selections.every((s) => s.isEmpty)) {
            ed.selections = expandedSpans
              .filter(([a, b]) => b < doc.lineCount && a <= b)
              .map(([a, b]) => new vscode.Selection(a, 0, b, doc.lineAt(b).text.length));
          }
          return compactLines(ed);
        }
        if (pick === never) {
          const target = cfg.inspect('expandLines.showReminder')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          return cfg.update('expandLines.showReminder', false, target);
        }
        return undefined;
      });
  }
  return count;
}

/**
 * Compacts the selections (or the whole file when nothing is selected) back to one JSON value
 * per line. Nothing changes when any value is invalid.
 */
export async function compactLines(editor: vscode.TextEditor): Promise<boolean> {
  const doc = editor.document;
  const eol = eolOf(doc);
  const whole = editor.selections.every((s) => s.isEmpty);
  const ranges = whole ? [new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)] : lineRanges(doc, editor.selections);
  const edits: { range: vscode.Range; text: string }[] = [];
  for (const range of ranges) {
    const src = doc.getText(range);
    const res = compactText(src, eol);
    if (!res.ok) {
      void vscode.window.showErrorMessage(
        t('Better JSONL: line {0} is not valid JSON ({1}). Nothing changed.', range.start.line + res.line, res.message),
      );
      return false;
    }
    const text = res.text + (whole && /\r?\n\s*$/.test(src) ? eol : '');
    if (text !== src) edits.push({ range, text });
  }
  if (!edits.length) return true;
  return editor.edit((b) => edits.forEach((e) => b.replace(e.range, e.text)));
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
    const text = l === 0 ? stripBom(line.text) : line.text;
    const bom = l === 0 && text !== line.text ? '\ufeff' : '';
    if (!text.trim()) continue;
    try {
      JSON.parse(text);
      const min = bom + minifyJson(text);
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

/** Converts a JSON array document to JSON Lines, or a JSON Lines document to a pretty JSON array. */
export async function convertFormat(editor: vscode.TextEditor): Promise<boolean> {
  const doc = editor.document;
  const src = doc.getText();
  const eol = eolOf(doc);
  const indent = editorIndent(editor);
  const res = convertJsonAndJsonl(src, indent, eol, isJsonlDocument(doc));
  if (!res.ok) {
    void vscode.window.showErrorMessage(t('Better JSONL: cannot convert invalid JSON ({0}).', res.message));
    return false;
  }
  const full = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(Math.max(0, doc.lineCount - 1)).text.length);
  const ok = await editor.edit((b) => b.replace(full, res.text));
  if (ok) {
    await vscode.languages.setTextDocumentLanguage(doc, res.to === 'jsonl' ? 'jsonl' : 'json');
    vscode.window.setStatusBarMessage(
      res.to === 'jsonl'
        ? t('Better JSONL: converted to JSON Lines ({0} records).', res.count)
        : t('Better JSONL: converted to JSON array ({0} items).', res.count),
      3000,
    );
  }
  return ok;
}
