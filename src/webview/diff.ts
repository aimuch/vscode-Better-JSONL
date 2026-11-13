// Field-by-field differences between two JSON values (two JSON Lines records).
import { isContainer, type JObj, type JVal } from './json';
import { compactJson } from './query';

export interface Difference {
  path: (string | number)[];
  /** added: only in b; removed: only in a; changed: a different value (or type) in each. */
  kind: 'added' | 'removed' | 'changed';
  a?: JVal;
  b?: JVal;
}

type Pair = { a: JVal; b: JVal; path: (string | number)[] };

/**
 * The differences, in document order: object members by key (the keys of a first, then the
 * new keys of b), array items by index. A value whose type changed counts once.
 */
export function diffValues(a: JVal, b: JVal, max = 2000): { rows: Difference[]; more: boolean } {
  const rows: Difference[] = [];
  const stack: Pair[] = [{ a, b, path: [] }];
  while (stack.length) {
    const x = stack.pop() as Pair;
    const ca = isContainer(x.a);
    const cb = isContainer(x.b);
    if (ca && cb && Array.isArray(x.a) === Array.isArray(x.b)) {
      // Members in order; a nested container is checked where it is (the stack is last in, first out).
      const items: (Difference | Pair)[] = [];
      const add = (k: string | number, va: JVal | undefined, vb: JVal | undefined) => {
        const path = [...x.path, k];
        if (va === undefined) items.push({ path, kind: 'added', b: vb });
        else if (vb === undefined) items.push({ path, kind: 'removed', a: va });
        else items.push({ a: va, b: vb, path });
      };
      if (Array.isArray(x.a)) {
        const xb = x.b as JVal[];
        for (let i = 0; i < Math.max(x.a.length, xb.length); i++) add(i, i < x.a.length ? x.a[i] : undefined, i < xb.length ? xb[i] : undefined);
      } else {
        const oa = x.a as JObj;
        const ob = x.b as JObj;
        const has = (o: JObj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
        for (const k of Object.keys(oa)) add(k, oa[k], has(ob, k) ? ob[k] : undefined);
        for (const k of Object.keys(ob)) if (!has(oa, k)) add(k, undefined, ob[k]);
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if ('kind' in it) stack.push({ a: null, b: null, path: it.path, done: it } as Pair & { done: Difference });
        else stack.push(it);
      }
    } else if ((x as Pair & { done?: Difference }).done) {
      rows.push((x as Pair & { done: Difference }).done);
    } else if (ca || cb || compactJson(x.a) !== compactJson(x.b)) {
      rows.push({ path: x.path, kind: 'changed', a: x.a, b: x.b });
    }
    if (rows.length > max) return { rows: rows.slice(0, max), more: true };
  }
  return { rows, more: false };
}
