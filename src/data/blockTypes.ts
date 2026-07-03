import { defineBlockType, INFRASTRUCTURE_TYPE_DISPLAY, type TypeContribution } from '@/data/api'
import {
  aliasesProp,
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  extensionDescriptionProp,
  extensionNameProp,
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
  userIdProp,
} from '@/data/properties'

export const EXTENSION_TYPE = 'extension'
export const PAGE_TYPE = 'page'
export const PANEL_TYPE = 'panel'
export const PANEL_STACK_TYPE = 'panel-stack'
/** User-defined property schemas live as blocks of this type
 *  (user-defined-properties §4). Kernel-owned; users don't create or
 *  remove the type contribution itself. */
export const PROPERTY_SCHEMA_TYPE = 'property-schema'
/** Marker type for the singleton Properties page that hosts every
 *  property-schema block in a workspace. */
export const PROPERTIES_PAGE_TYPE = 'panel:properties'
/** User-defined types live as blocks of this type
 *  (user-defined-types Phase 1). Kernel-owned; users don't create or
 *  remove the type contribution itself. */
export const BLOCK_TYPE_TYPE = 'block-type'
/** Marker type for the singleton Types page that hosts every
 *  block-type block in a workspace. */
export const TYPES_PAGE_TYPE = 'panel:types'
/** Marker type for the singleton Recents page — a Tana-style view of
 *  recently-edited blocks in the workspace. */
export const RECENTS_PAGE_TYPE = 'panel:recents'
/** Per-user "user page" type. Tagged alongside `PAGE_TYPE` (so the page
 *  stays navigable) and carries the user's opaque id as a property,
 *  letting `block_types`-indexed lookups enumerate users and attribution
 *  surfaces resolve an id to its page/name. Kernel-owned. */
export const USER_TYPE = 'user'

export const KERNEL_TYPE_CONTRIBUTIONS: readonly TypeContribution[] = [
  defineBlockType({
    id: EXTENSION_TYPE,
    label: 'Extension',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    properties: [extensionNameProp, extensionDescriptionProp],
  }),
  defineBlockType({id: PAGE_TYPE, label: 'Page', ...INFRASTRUCTURE_TYPE_DISPLAY, properties: [aliasesProp]}),
  defineBlockType({id: PANEL_TYPE, label: 'Panel', ...INFRASTRUCTURE_TYPE_DISPLAY}),
  defineBlockType({id: PANEL_STACK_TYPE, label: 'Panel stack', ...INFRASTRUCTURE_TYPE_DISPLAY}),
  defineBlockType({
    id: PROPERTY_SCHEMA_TYPE,
    label: 'Property schema',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    // Lift these so addType('property-schema') auto-materialises them
    // and the panel surfaces them through the type-section path.
    properties: [propertyNameProp, presetIdProp, presetConfigProp],
  }),
  defineBlockType({
    id: PROPERTIES_PAGE_TYPE,
    label: 'Properties page',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    properties: [aliasesProp],
  }),
  defineBlockType({
    id: BLOCK_TYPE_TYPE,
    label: 'Type',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    // Lift label / description / properties / tag-display fields so the
    // panel surfaces them through the type-section path when editing a
    // block-type block.
    properties: [
      blockTypeLabelProp,
      blockTypeDescriptionProp,
      blockTypePropertiesProp,
      blockTypeHideFromBlockDisplayProp,
      blockTypeColorProp,
    ],
  }),
  defineBlockType({
    id: TYPES_PAGE_TYPE,
    label: 'Types page',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    properties: [aliasesProp],
  }),
  defineBlockType({
    id: RECENTS_PAGE_TYPE,
    label: 'Recents page',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    properties: [aliasesProp],
  }),
  defineBlockType({
    id: USER_TYPE,
    label: 'User',
    ...INFRASTRUCTURE_TYPE_DISPLAY,
    // Lift aliases + id so the property panel surfaces them and the id
    // auto-materialises when `addType('user')` runs.
    properties: [aliasesProp, userIdProp],
  }),
]
