import { BlockTypeBlockRenderer } from '@/components/renderer/BlockTypeBlockRenderer.js'
import { CodeMirrorExtensionBlockRenderer } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.js'
import { LayoutSessionHost } from '@/components/renderer/LayoutSessionHost.js'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer.js'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.js'
import { PropertySchemaBlockRenderer } from '@/components/renderer/PropertySchemaBlockRenderer.js'
import { TopLevelRenderer } from '@/components/renderer/TopLevelRenderer.js'
import { blockRenderersFacet, createRendererRegistry, RendererContribution } from '@/extensions/core.js'
import { systemToggle } from '@/facets/togglable.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'

export const defaultRendererContributions: RendererContribution[] = [
  {id: 'default', renderer: DefaultBlockRenderer},
  {id: 'extension', renderer: CodeMirrorExtensionBlockRenderer},
  {id: 'propertySchema', renderer: PropertySchemaBlockRenderer},
  {id: 'blockType', renderer: BlockTypeBlockRenderer},
  {id: 'topLevel', renderer: TopLevelRenderer},
  // Default-off keep-alive host: claims ONLY the layout-sessions container
  // block (deterministic-id canRender, priority 30 > topLevel's 20). Inert
  // until something mounts the container as the layout root — App mounts
  // the SESSION block, so stock behavior is unchanged.
  {id: 'layoutSessionHost', renderer: LayoutSessionHost},
  {id: 'layout', renderer: LayoutRenderer},
  {id: 'panel', renderer: PanelRenderer},
  {id: 'missingData', renderer: MissingDataRenderer},
]

export const defaultRegistry = createRendererRegistry(defaultRendererContributions)

export const defaultRenderersExtension = systemToggle({
  id: 'system:default-renderers',
  name: 'Default renderers',
  description: 'Block renderer registry and the fallback renderer used when no plugin claims a block.',
  essential: true,
}).of([
  markdownExtensionsFacet.of(gfmMarkdownExtension, {source: 'defaultRenderers'}),
  ...defaultRendererContributions.map(contribution =>
    blockRenderersFacet.of(contribution),
  ),
])
