// Turns a parsed value into display lines for the Formatted view.
// Iterative on purpose: deep nesting must not overflow the call stack.
import { t } from '../../shared/i18n';
import { childKey, entriesOf, esc, isContainer, primClass, primText, sizeOf, type JVal } from '../json';

export interface PLine {
  d: number;
  /** Object member name. Undefined for array items and the root. */
  key?: string;
  kind: 'open' | 'close' | 'prim' | 'folded' | 'empty';
  /** Bracket for open/close, or the pair for empty/folded containers. */
  br?: string;
  value?: JVal;
  count?: number;
  comma: boolean;
  /** Path key of the value on this line (see json.childKey). */
  path: string;
}

type Frame = { ents: [string | number, JVal][]; i: number; d: number; arr: boolean; path: string; comma: boolean };

export function buildLines(root: JVal, folds: ReadonlySet<string>): PLine[] {
  const out: PLine[] = [];
  const stack: Frame[] = [];
  const emit = (v: JVal, key: string | number | undefined, d: number, path: string, comma: boolean) => {
    const k = typeof key === 'string' ? key : undefined;
    if (!isContainer(v)) {
      out.push({ d, key: k, kind: 'prim', value: v, comma, path });
      return;
    }
    const arr = Array.isArray(v);
    const n = sizeOf(v);
    if (n === 0) {
      out.push({ d, key: k, kind: 'empty', br: arr ? '[]' : '{}', comma, path });
    } else if (folds.has(path)) {
      out.push({ d, key: k, kind: 'folded', br: arr ? '[]' : '{}', count: n, comma, path });
    } else {
      out.push({ d, key: k, kind: 'open', br: arr ? '[' : '{', count: n, comma: false, path });
      stack.push({ ents: entriesOf(v), i: 0, d, arr, path, comma });
    }
  };
  emit(root, undefined, 0, '', false);
  while (stack.length) {
    const f = stack[stack.length - 1];
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

/** Same count as buildLines(root, folds).length, without building the lines. */
export function countLines(root: JVal, folds: ReadonlySet<string>): number {
  let n = 0;
  if (folds.size === 0) {
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
  const stack: [JVal, string][] = [[root, '']];
  while (stack.length) {
    const [v, p] = stack.pop() as [JVal, string];
    if (!isContainer(v)) {
      n++;
      continue;
    }
    const ents = entriesOf(v);
    if (!ents.length || folds.has(p)) n++;
    else {
      n += 2;
      for (const [k, c] of ents) stack.push([c, childKey(p, k)]);
    }
  }
  return n;
}

/** Path keys of every non-root container with members. */
export function containerKeys(root: JVal): string[] {
  const out: string[] = [];
  const stack: [JVal, string][] = [[root, '']];
  while (stack.length) {
    const [v, p] = stack.pop() as [JVal, string];
    if (!isContainer(v) || sizeOf(v) === 0) continue;
    if (p) out.push(p);
    for (const [k, c] of entriesOf(v)) stack.push([c, childKey(p, k)]);
  }
  return out;
}

const MAX_STRING = 10_000;

/** HTML for one line. With `indentText` false the caller indents the line (hanging indent when wrapping). */
export function lineHtml(l: PLine, indent: number, indentText = true): string {
  const parts: string[] = [indentText ? ' '.repeat(l.d * indent) : ''];
  if (l.key !== undefined) parts.push(`<span class="tk">${esc(JSON.stringify(l.key))}</span><span class="tp">: </span>`);
  switch (l.kind) {
    case 'prim': {
      let t = primText(l.value as JVal);
      if (t.length > MAX_STRING) t = t.slice(0, MAX_STRING) + '…';
      parts.push(`<span class="${primClass(l.value as JVal)}">${esc(t)}</span>`);
      break;
    }
    case 'open':
    case 'close':
    case 'empty':
      parts.push(`<span class="tp">${l.br}</span>`);
      break;
    case 'folded': {
      const what = l.br === '[]' ? t(l.count === 1 ? '{0} item' : '{0} items', l.count as number) : t(l.count === 1 ? '{0} key' : '{0} keys', l.count as number);
      parts.push(
        `<span class="tp">${l.br![0]}</span><button class="ph" data-k="${esc(l.path)}" title="${t('Expand')}">… ${what}</button><span class="tp">${l.br![1]}</span>`,
      );
      break;
    }
  }
  if (l.comma) parts.push('<span class="tp">,</span>');
  return parts.join('');
}

/** Plain text of a line, for search in single JSON documents. */
export function lineText(l: PLine): string {
  let s = l.key !== undefined ? JSON.stringify(l.key) + ': ' : '';
  if (l.kind === 'prim') s += primText(l.value as JVal);
  else s += l.br ?? '';
  return s;
}
