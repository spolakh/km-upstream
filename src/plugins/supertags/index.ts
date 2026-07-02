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
 *  `structural` contributions (kernel structure, plugin plumbing) are
 *  hidden from both surfaces; `hideTag` types from chips only — see
 *  `TypeContribution`. */

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
  blockContentDecoratorsFacet.of(typeChipsDecoratorContribution, {source: 'supertags'}),
])
