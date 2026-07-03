/** Supertags plugin — Tana-style `#` type tagging.
 *
 *  Two surfaces over the first-class type system (`typesProp` +
 *  `repo.addType`/`removeType`, registry = `typesFacet`):
 *   - typing `#` in a block's editor opens an autocomplete over the
 *     registered types (plus a "Create type" option that materializes
 *     a user-defined type-definition block on the fly); picking one
 *     tags the block and removes the trigger text;
 *   - a block's types render as trailing `#label` chips after its
 *     content, each with a remove button.
 *
 *  Display opt-outs: `hideFromCompletion` keeps a type out of the `#`
 *  dropdown, `hideFromBlockDisplay` out of the chip row; infrastructure
 *  types set both — see `TypeContribution`. */

import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions.js'
import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'
import { supertagsCodeMirrorExtensions } from './codeMirrorExtensions'
import { typeChipsDecoratorContribution } from './TypeChipsDecorator'

export const supertagsPlugin: AppExtension = systemToggle({
  id: 'system:supertags',
  name: 'Type tags (#)',
  description: 'Type # in a block to tag it with a type (or create one); a block\'s types show as #chips at the end of its content. For your own types, chip color and visibility live on the type\'s definition block; built-in types declare them in code.',
}).of([
  codeMirrorExtensionsFacet.of(supertagsCodeMirrorExtensions, {source: 'supertags'}),
  // Negative precedence → innermost decorator: the chip row attaches
  // directly to the text renderer, and every other decorator's chrome
  // (geo's map, counters, badges) wraps OUTSIDE the [text + chips]
  // unit. Ordered the other way, the chips wrapper's fit-content
  // column would squeeze full-width chrome (a map iframe has no
  // intrinsic width) down to the text's width.
  blockContentDecoratorsFacet.of(typeChipsDecoratorContribution, {source: 'supertags', precedence: -100}),
])
