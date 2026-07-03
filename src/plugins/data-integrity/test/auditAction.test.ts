// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The queue + openDialog the view handler drives. getDialogQueue returns this
// array so a test can seed "an audit dialog is already open (pinned to X)".
const openDialog = vi.fn()
const dialogQueue: Array<{ Component: unknown; props: Record<string, unknown> }> = []

vi.mock('@/utils/dialogs.js', () => ({
  openDialog: (...args: unknown[]) => openDialog(...args),
  getDialogQueue: () => dialogQueue,
}))
vi.mock('@/plugins/data-integrity/schedule.js', () => ({
  runConsistencyAuditNow: vi.fn(),
}))
vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
  showProgress: vi.fn(),
}))
// Stub the dialog so importing the action doesn't pull its whole render graph;
// the guard compares Component identity, and both the action and this test see
// the SAME stub, so the identity match still holds.
vi.mock('../ConsistencyAuditDialog.tsx', () => ({
  ConsistencyAuditDialog: () => null,
}))

import { viewDataIntegrityAuditAction } from '../auditAction.ts'
import { ConsistencyAuditDialog } from '../ConsistencyAuditDialog.tsx'

const invokeView = (activeWorkspaceId: string | null) =>
  // handler is (dependencies, trigger, dispatch?); this action only reads
  // dependencies.uiStateBlock, so the trigger is a throwaway.
  viewDataIntegrityAuditAction.handler(
    { uiStateBlock: { repo: { activeWorkspaceId } } } as never,
    {} as never,
  )

afterEach(() => {
  openDialog.mockReset()
  dialogQueue.length = 0
})

describe('view_data_integrity_audit action', () => {
  it('opens the results dialog pinned to the active workspace', () => {
    invokeView('ws-1')
    expect(openDialog).toHaveBeenCalledWith(ConsistencyAuditDialog, { workspaceId: 'ws-1' })
  })

  it('does not stack a second dialog already pinned to the active workspace', () => {
    dialogQueue.push({ Component: ConsistencyAuditDialog, props: { workspaceId: 'ws-1' } })
    invokeView('ws-1')
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('opens for the active workspace even if a dialog for a DIFFERENT one is open', () => {
    // The regression the exact-match guard fixes: a dialog pinned to ws-1 must NOT
    // suppress Inspect for ws-2 (previously an unpinned/self-pinned dialog would).
    dialogQueue.push({ Component: ConsistencyAuditDialog, props: { workspaceId: 'ws-1' } })
    invokeView('ws-2')
    expect(openDialog).toHaveBeenCalledWith(ConsistencyAuditDialog, { workspaceId: 'ws-2' })
  })
})
