import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { JsonPath } from './shared/protocol';

export interface TextSpan {
  offset: number;
  length: number;
}

/**
 * Finds the text span of `path` inside `text`. For an object member the span
 * starts at the key, so the selection shows `"key": value`.
 */
export function locatePath(text: string, path: JsonPath): TextSpan | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!root) return undefined;
  const node = findNodeAtLocation(root, path);
  if (!node) return undefined;
  const parent = node.parent;
  if (parent && parent.type === 'property' && parent.children && parent.children[1] === node) {
    return { offset: parent.offset, length: node.offset + node.length - parent.offset };
  }
  return { offset: node.offset, length: node.length };
}
