import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import type { Repo } from '@/data/repo'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { diagnosticsFacet } from '@/plugins/diagnostics/facet.js'
import { createDataIntegrityDiagnosticSource } from './diagnosticsSource.ts'
import { consistencyAuditEffectContribution } from './schedule.ts'
import {
  runDataIntegrityAuditActionContribution,
  viewDataIntegrityAuditActionContribution,
} from './auditAction.ts'

/** Owns the built-in consistency audit (L3) end to end: the engine + cadenced
 *  scheduling (AppEffect), the on-demand run/view actions and their results
 *  dialog, and the diagnostics-seam contribution the system-status chip
 *  aggregates generically. Keeping the actions + dialog here (not in
 *  system-status) means the chip has no data-integrity-specific knowledge — it
 *  only knows the generic seam. */
export const dataIntegrityPlugin = ({ repo }: { repo: Repo }): AppExtension =>
  systemToggle({
    id: 'system:data-integrity',
    name: 'Data integrity',
    description:
      'Runs the built-in consistency audit and surfaces its health in the system-status indicator.',
  }).of([
    consistencyAuditEffectContribution,
    diagnosticsFacet.of(createDataIntegrityDiagnosticSource(repo), {
      source: 'data-integrity',
    }),
    // "Run data integrity audit" — command palette + a fresh run.
    runDataIntegrityAuditActionContribution,
    // "View last data integrity audit" — command palette + the status dropdown's
    // generic "Inspect" button (routed here by the diagnostics snapshot's
    // actionId); re-opens the last results without re-scanning.
    viewDataIntegrityAuditActionContribution,
    // Both audit actions open ConsistencyAuditDialog via `openDialog`, which is
    // inert without DialogHost mounted. Pull the mount in here so this plugin is
    // self-sufficient — the dialog renders even if every other dialog-using
    // plugin (and default-actions) is disabled. The resolver dedupes the shared
    // contribution by reference, so this still registers exactly one host.
    dialogAppMountExtension,
  ])
