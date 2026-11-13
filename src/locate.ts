import { parseTree, type Node } from 'jsonc-parser';
import type { JsonPath } from './shared/protocol';

export interface TextSpan {
  offset: number;
  length: number;
}

/**
 * The node at `path`. When an object has the same key twice, the last one counts:
 * that is the value JSON.parse keeps, so it is the value the views show.
 */
function nodeAt(root: Node, path: JsonPath): Node | undefined {
  let node: Node | undefined = root;
  for (const seg of path) {
    if (!node) return undefined;
    if (typeof seg === 'number') {
      node = node.type === 'array' ? node.children?.[seg] : undefined;
      continue;
    }
    if (node.type !== 'object' || !node.children) return undefined;
    let found: Node | undefined;
    for (let i = node.children.length - 1; i >= 0 && !found; i--) {
      const prop = node.children[i];
      if (prop.children && prop.children[0].value === seg) found = prop.children[1];
    }
    node = found;
  }
  return node;
}

/** The span of the value at `path` (without its key). Undefined when it is not there. */
export function valueSpan(text: string, path: JsonPath): TextSpan | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  const node = root && nodeAt(root, path);
  return node ? { offset: node.offset, length: node.length } : undefined;
}

/**
 * Finds the text span of `path` inside `text`. For an object member the span
 * starts at the key, so the selection shows `"key": value`.
 */
export function locatePath(text: string, path: JsonPath): TextSpan | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!root) return undefined;
  const node = nodeAt(root, path);
  if (!node) return undefined;
  const parent = node.parent;
  if (parent && parent.type === 'property' && parent.children && parent.children[1] === node) {
    return { offset: parent.offset, length: node.offset + node.length - parent.offset };
  }
  return { offset: node.offset, length: node.length };
}
