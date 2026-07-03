/**
 * The `attachments` plugin (design §11) — packages the media block model + its
 * renderer, mirroring the video-player plugin's facet wiring.
 *
 * Scope: the `media` block TYPE + its property schemas (typesFacet /
 * propertySchemasFacet), the {@link MediaBlockRenderer} (blockRenderersFacet), the
 * boot upload reconciler (appMountsFacet), and the paste rule that turns a file paste
 * into a media capture (pasteDecisionVerb decorator). Everything the feature adds is
 * gated on this one toggle — disable it and a file paste falls through to a text
 * paste, no media blocks are minted, and the renderer/reconciler aren't mounted.
 */

import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import { actionsFacet, appMountsFacet, blockRenderersFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'
import { mobileKeyboardToolbarItemsFacet } from '@/plugins/mobile-keyboard-toolbar/facet.js'
import { MediaBlockRenderer } from './MediaBlockRenderer.js'
import { audioMediaViewer, imageMediaViewer } from './mediaViewers.js'
import { mediaViewersFacet } from './mediaViewersFacet.js'
import { MediaDownLaneReplicator } from './MediaDownLaneReplicator.js'
import { MediaUploadReconciler } from './MediaUploadReconciler.js'
import { captureMediaContribution, mediaPasteDecisionContribution } from './pasteCapture.js'
import {
  insertImageAction,
  insertImageNormalModeAction,
  insertImageToolbarItem,
} from './insertImageContribution.js'
import { uploadLaneDiagnosticSource } from './uploadLaneStatus.js'
import {
  ASSETS_TYPE_CONTRIBUTION,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE_CONTRIBUTION,
} from './mediaBlock.js'

export const attachmentsPlugin: AppExtension = systemToggle({
  id: 'system:attachments',
  name: 'Attachments',
  description: 'Image & file attachments — content-addressed media blocks embedded via !((id)).',
}).of([
  typesFacet.of(MEDIA_TYPE_CONTRIBUTION, { source: 'attachments' }),
  typesFacet.of(ASSETS_TYPE_CONTRIBUTION, { source: 'attachments' }),
  MEDIA_PROPERTY_SCHEMAS.map((schema) => propertySchemasFacet.of(schema, { source: 'attachments' })),
  blockRenderersFacet.of({ id: 'media', renderer: MediaBlockRenderer }, { source: 'attachments' }),
  // The image + audio mime-family viewers. A PDF / video plugin registers its own viewer
  // on this facet and the renderer dispatches to it — no renderer change.
  mediaViewersFacet.of(imageMediaViewer, { source: 'attachments' }),
  mediaViewersFacet.of(audioMediaViewer, { source: 'attachments' }),
  // The capture path: DECIDE a file paste is media (decorator) + ACT on it (the
  // captureMediaVerb impl). Both gated here, so disabling the plugin disables capture
  // (a file paste falls through to a text paste, and the verb is a no-op).
  mediaPasteDecisionContribution,
  captureMediaContribution,
  // Image insertion (beyond paste): the edit-mode (at-caret) + normal-mode
  // (append-to-block) actions, and the mobile keyboard toolbar button that
  // dispatches the edit-mode one. Gated here so they only exist when capture
  // does — reachable from the command palette. Precedence 50 slots the toolbar
  // button between the reference triggers and the move buttons.
  actionsFacet.of(insertImageAction, { source: 'attachments' }),
  actionsFacet.of(insertImageNormalModeAction, { source: 'attachments' }),
  mobileKeyboardToolbarItemsFacet.of(insertImageToolbarItem, { source: 'attachments', precedence: 50 }),
  // Boot recovery for crashed captures (§9) — gated on initial-sync settle.
  appMountsFacet.of({ id: 'attachments.upload-reconciler', component: MediaUploadReconciler }, { source: 'attachments' }),
  // Background replication of the active workspace's bytes to the local store (§8/§9).
  appMountsFacet.of({ id: 'attachments.down-lane-replicator', component: MediaDownLaneReplicator }, { source: 'attachments' }),
  // Surface background upload FAILURES in the status indicator (a failed drain is
  // otherwise silent — off the paste hot-path).
  diagnosticsFacet.of(uploadLaneDiagnosticSource, { source: 'attachments' }),
])
