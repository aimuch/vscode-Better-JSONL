// Turns a parsed value into display lines for the Formatted view.
// Iterative on purpose: deep nesting must not overflow the call stack.
import { t } from '../../shared/i18n';
import { tryUnpackJsonString } from '../inspect';
import { childKey, entriesOf, esc, isContainer, primClass, primText, sizeOf, type JVal } from '../json';

export interface PLine {
  d: number;
  /** Object member name. Undefined for array items and the root. */
  key?: string;
  kind: 'open' | 'close' | 'prim' | 'folded' | 'empty' | 'mtext';
  /** Bracket for open/close, or the pair for empty/folded containers. */
  br?: string;
  value?: JVal;
  mtext?: string;
  count?: number;
  comma: boolean;
  /** Path key of the value on this line (see json.childKey). */
  path: string;
  /** True when this container was unpacked from a JSON-encoded string. */
  unpackedRoot?: boolean;
  /** True when a multiline string is currently expanded below this line. */
  mlExpanded?: boolean;
}

type Frame =
  | { kind: 'container'; ents: [string | number, JVal][]; i: number; d: number; arr: boolean; path: string; comma: boolean }
  | { kind: 'multiline'; lines: string[]; i: number; d: number; path: string };

/**
 * `folds` holds the containers the user toggled. A container at depth `foldDepth` or deeper
 * starts folded, so a toggle there opens it; above that depth a toggle folds it.
 */
export function isFolded(folds: ReadonlySet<string>, path: string, depth: number, foldDepth: number): boolean {
  return folds.has(path) !== depth >= foldDepth;
}

export function buildLines(
  root: JVal,
  folds: ReadonlySet<string>,
  foldDepth = Infinity,
  unpacked?: ReadonlySet<string>,
  multiline?: ReadonlySet<string>,
): PLine[] {
  const out: PLine[] = [];
  const stack: Frame[] = [];
  const emit = (v: JVal, key: string | number | undefined, d: number, path: string, comma: boolean) => {
    const k = typeof key === 'string' ? key : undefined;
    if (typeof v === 'string' && unpacked?.has(path)) {
      const parsed = tryUnpackJsonString(v);
      if (parsed !== undefined && isContainer(parsed)) {
        const arr = Array.isArray(parsed);
        const n = sizeOf(parsed);
        if (n === 0) {
          out.push({ d, key: k, kind: 'empty', br: arr ? '[]' : '{}', comma, path, unpackedRoot: true });
        } else if (isFolded(folds, path, d, foldDepth)) {
          out.push({ d, key: k, kind: 'folded', br: arr ? '[]' : '{}', count: n, comma, path, unpackedRoot: true });
        } else {
          out.push({ d, key: k, kind: 'open', br: arr ? '[' : '{', count: n, comma: false, path, unpackedRoot: true });
          stack.push({ kind: 'container', ents: entriesOf(parsed), i: 0, d, arr, path, comma });
        }
        return;
      }
    }
    if (!isContainer(v)) {
      const mlOpen = typeof v === 'string' && v.includes('\n') && !!multiline?.has(path);
      out.push({ d, key: k, kind: 'prim', value: v, comma, path, mlExpanded: mlOpen });
      if (mlOpen) {
        const rawLines = (v as string).replace(/\r\n/g, '\n').split('\n');
        stack.push({ kind: 'multiline', lines: rawLines, i: 0, d: d + 1, path });
      }
      return;
    }
    const arr = Array.isArray(v);
    const n = sizeOf(v);
    if (n === 0) {
      out.push({ d, key: k, kind: 'empty', br: arr ? '[]' : '{}', comma, path });
    } else if (isFolded(folds, path, d, foldDepth)) {
      out.push({ d, key: k, kind: 'folded', br: arr ? '[]' : '{}', count: n, comma, path });
    } else {
      out.push({ d, key: k, kind: 'open', br: arr ? '[' : '{', count: n, comma: false, path });
      stack.push({ kind: 'container', ents: entriesOf(v), i: 0, d, arr, path, comma });
    }
  };
  emit(root, undefined, 0, '', false);
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.kind === 'multiline') {
      if (f.i < f.lines.length) {
        out.push({ d: f.d, kind: 'mtext', mtext: f.lines[f.i++], comma: false, path: f.path });
      } else {
        stack.pop();
      }
      continue;
    }
    if (f.i < f.ents.length) {
      const [k, v] = f.ents[f.i++];
      emit(v, k, f.d + 1, childKey(f.path, k), f.i < f.ents.length);
    } else {
      stack.pop();
      out.push({ d: f.d, kind: 'close', br: f.arr ? ']' : '}', comma: f.comma, path: f.path });
    }
  }
  return out;
}

/** Same count as buildLines(root, folds, foldDepth, unpacked, multiline).length, without building the lines. */
export function countLines(
  root: JVal,
  folds: ReadonlySet<string>,
  foldDepth = Infinity,
  unpacked?: ReadonlySet<string>,
  multiline?: ReadonlySet<string>,
): number {
  let n = 0;
  const hasExtras = (unpacked && unpacked.size > 0) || (multiline && multiline.size > 0);
  if (!hasExtras && folds.size === 0 && foldDepth === Infinity) {
    const stack: JVal[] = [root];
    while (stack.length) {
      const v = stack.pop() as JVal;
      if (!isContainer(v)) {
        n++;
        continue;
      }
      const ents = Array.isArray(v) ? v : Object.values(v);
      if (!ents.length) n++;
      else {
        n += 2;
        for (let i = 0; i < ents.length; i++) stack.push(ents[i]);
      }
    }
    return n;
  }
  const stack: [JVal, string, number][] = [[root, '', 0]];
  while (stack.length) {
    const [v, p, d] = stack.pop() as [JVal, string, number];
    if (typeof v === 'string' && unpacked?.has(p)) {
      const parsed = tryUnpackJsonString(v);
      if (parsed !== undefined && isContainer(parsed)) {
        if (sizeOf(parsed) === 0 || isFolded(folds, p, d, foldDepth)) n++;
        else {
          n += 2;
          for (const [k, c] of entriesOf(parsed)) stack.push([c, childKey(p, k), d + 1]);
        }
        continue;
      }
    }
    if (!isContainer(v)) {
      n++;
      if (typeof v === 'string' && v.includes('\n') && multiline?.has(p)) {
        n += v.replace(/\r\n/g, '\n').split('\n').length;
      }
      continue;
    }
    if (sizeOf(v) === 0 || isFolded(folds, p, d, foldDepth)) n++;
    else {
      n += 2;
      for (const [k, c] of entriesOf(v)) stack.push([c, childKey(p, k), d + 1]);
    }
  }
  return n;
}

const MAX_STRING = 10_000;

/** HTML for one line. With `indentText` false the caller indents the line (hanging indent when wrapping). */
export function lineHtml(l: PLine, indent: number, indentText = true): string {
  if (l.kind === 'mtext') {
    return (indentText ? ' '.repeat(l.d * indent) : '') + `<span class="ml-line">${esc(l.mtext ?? '')}</span>`;
  }
  const parts: string[] = [indentText ? ' '.repeat(l.d * indent) : ''];
  if (l.key !== undefined) parts.push(`<span class="tk">${esc(JSON.stringify(l.key))}</span><span class="tp">: </span>`);
  switch (l.kind) {
    case 'prim': {
      const val = l.value as JVal;
      let txt = primText(val);
      if (txt.length > MAX_STRING) txt = txt.slice(0, MAX_STRING) + '…';
      parts.push(`<span class="${primClass(val)}">${esc(txt)}</span>`);
      if (typeof val === 'string') {
        const inner = val.length <= 262_144 ? tryUnpackJsonString(val) : undefined;
        if (inner !== undefined && isContainer(inner)) {
          const badge = Array.isArray(inner) ? `JSON [${inner.length}]` : `JSON {${Object.keys(inner).length}}`;
          parts.push(` <button class="pill unpack-btn" data-unpack="${esc(l.path)}" aria-expanded="false" title="${esc(t('Unpack JSON'))}">${badge}</button>`);
        } else if (val.includes('\n')) {
          const lc = val.replace(/\r\n/g, '\n').split('\n').length;
          const label = l.mlExpanded ? t('Collapse') : `↵ ${t('{0} lines text', lc)}`;
          parts.push(
            ` <button class="pill ml-btn${l.mlExpanded ? ' on' : ''}" data-ml="${esc(l.path)}" aria-expanded="${!!l.mlExpanded}" title="${esc(t(l.mlExpanded ? 'Collapse multiline text' : 'Show multiline text'))}">${esc(label)}</button>`,
          );
        }
      }
      break;
    }
    case 'open':
    case 'close':
    case 'empty':
      parts.push(`<span class="tp">${l.br}</span>`);
      if (l.unpackedRoot && l.kind !== 'close') {
        parts.push(` <button class="pill unpack-btn on" data-unpack="${esc(l.path)}" aria-expanded="true" title="${esc(t('Fold unpacked JSON'))}">JSON ↩</button>`);
      }
      break;
    case 'folded': {
      const what = l.br === '[]' ? t(l.count === 1 ? '{0} item' : '{0} items', l.count as number) : t(l.count === 1 ? '{0} key' : '{0} keys', l.count as number);
      parts.push(
        `<span class="tp">${l.br![0]}</span><button class="ph" data-k="${esc(l.path)}" aria-expanded="false" title="${t('Expand')}">… ${what}</button><span class="tp">${l.br![1]}</span>`,
      );
      if (l.unpackedRoot) {
        parts.push(` <button class="pill unpack-btn on" data-unpack="${esc(l.path)}" aria-expanded="true" title="${esc(t('Fold unpacked JSON'))}">JSON ↩</button>`);
      }
      break;
    }
  }
  if (l.comma) parts.push('<span class="tp">,</span>');
  return parts.join('');
}

/** Plain text of a line, for search in single JSON documents. */
export function lineText(l: PLine): string {
  if (l.kind === 'mtext') return l.mtext ?? '';
  let s = l.key !== undefined ? JSON.stringify(l.key) + ': ' : '';
  if (l.kind === 'prim') s += primText(l.value as JVal);
  else s += l.br ?? '';
  return s;
}
