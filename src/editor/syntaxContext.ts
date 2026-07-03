/** Syntax-tree context checks for editor autocompletes. The char
 *  triggers (`#` types, `@` places) match on raw line text, so without
 *  a tree check they fire inside markdown code — `#define FOO` in a
 *  fence, `` `#deploy` `` inline, a CSS `#id` — where the dropdown's
 *  Enter-accepts-completion binding then EATS the code text and (for
 *  `#`) mints a junk type. Kept beside triggerMatch.ts so any trigger
 *  source can share it. */

import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/** @lezer/markdown node names that mean "this text is code". FencedCode
 *  (``` blocks), CodeBlock (indented), InlineCode (backticks); CodeText
 *  is the content node inside the block forms. */
const CODE_NODE_NAMES: ReadonlySet<string> = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'CodeText',
])

/** True when `pos` sits inside a markdown code node. Fail-open: if the
 *  tree hasn't been parsed up to `pos` yet (resolve lands on the top
 *  node), the trigger stays allowed — a rare transient dropdown beats
 *  suppressing completions while the parser catches up. */
export const isInsideMarkdownCode = (state: EditorState, pos: number): boolean => {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (CODE_NODE_NAMES.has(node.name)) return true
  }
  return false
}
