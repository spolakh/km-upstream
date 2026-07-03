/** Syntax-tree context checks for editor autocompletes. The char
 *  triggers (`#` types, `@` places) match on raw line text, so without
 *  a tree check they fire inside markdown spans whose text is literal
 *  syntax, not prose — and with the dropdown open, Enter accepts the
 *  auto-selected completion and eats that text. Kept beside
 *  triggerMatch.ts (not in it: that module is deliberately import-free
 *  so its tests stay in the cheap node environment). */

import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/** @lezer/markdown node names whose text is literal, never prose:
 *  code — FencedCode (```), CodeBlock (indented), InlineCode
 *  (backticks), CodeText (the content node of the block forms);
 *  URL — autolinks and link targets (`http://…/#anchor`, `[t](#anchor)`
 *  are anchors, not tags); raw HTML, comments, and entities
 *  (`<div>#foo`, `<!-- #todo`, `&#123;`). */
const LITERAL_NODE_NAMES: ReadonlySet<string> = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'CodeText',
  'URL',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
  'Entity',
])

/** True when `pos` sits inside a literal markdown span (code, URL, raw
 *  HTML, comment). Fail-open: if the tree hasn't been parsed up to
 *  `pos` yet (resolve lands on the top node), the trigger stays
 *  allowed — a rare transient dropdown beats suppressing completions
 *  while the parser catches up. */
export const isInsideLiteralMarkdown = (state: EditorState, pos: number): boolean => {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (LITERAL_NODE_NAMES.has(node.name)) return true
  }
  return false
}
