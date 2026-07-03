// @vitest-environment jsdom
/**
 * The on-demand audit results dialog. Covers the contracts it owns:
 *   1. offending block ids are shown IN FULL and are copy-to-clipboard,
 *   2. clicking an id opens it in the SIDE PANEL (sidebar-stack) and KEEPS the
 *      dialog open,
 *   3. it reads the target workspace's result from the per-workspace store, so it
 *      re-opens without re-running (empty state when nothing has run) and a
 *      foreign-workspace audit can't blank an open dialog,
 *   4. the non-modal presentation renders NO dimming overlay but is still
 *      closable.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsistencyAuditResult } from '@/plugins/data-integrity/audit'
import {
  publishConsistencyAudit,
  resetConsistencyAuditStore,
} from '@/plugins/data-integrity/store'
import { ConsistencyAuditDialog } from '../ConsistencyAuditDialog.tsx'

const navigate = vi.fn()
const runConsistencyAuditNow = vi.fn()
const setActiveWorkspaceId = vi.fn()
const setHash = vi.fn()
// Mutable so a test can simulate the user switching workspaces while the dialog
// is open — the dialog reads `repo.activeWorkspaceId` fresh on each render.
const repoState: { activeWorkspaceId: string | null } = { activeWorkspaceId: 'ws-1' }

vi.mock('@/utils/navigation.js', () => ({
  useNavigate: () => navigate,
}))
vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({
    activeWorkspaceId: repoState.activeWorkspaceId,
    setActiveWorkspaceId,
  }),
}))
vi.mock('react-use', async (importActual) => ({
  ...(await importActual<typeof import('react-use')>()),
  useHash: () => ['', setHash] as const,
}))
vi.mock('@/utils/routing.js', () => ({
  buildAppHash: (workspaceId: string) => `hash:${workspaceId}`,
}))
vi.mock('@/plugins/data-integrity/schedule.js', () => ({
  runConsistencyAuditNow: (...args: unknown[]) => runConsistencyAuditNow(...args),
}))
vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
}))

const FULL_ID = '01234567-89ab-cdef-0123-456789abcdef'

const withSamples = (): ConsistencyAuditResult => ({
  workspaceId: 'ws-1',
  checkedAt: 1_700_000_000_000,
  anomalies: 1,
  checks: {
    references_index_mirror: {
      status: 'anomaly',
      missingIndexRows: 3,
      samples: [FULL_ID],
    },
  },
})

const renderDialog = (props: { workspaceId?: string } = {}) => {
  const resolve = vi.fn()
  const cancel = vi.fn()
  render(<ConsistencyAuditDialog resolve={resolve} cancel={cancel} {...props} />)
  return { resolve, cancel }
}

afterEach(() => {
  cleanup()
  resetConsistencyAuditStore()
  navigate.mockReset()
  runConsistencyAuditNow.mockReset()
  setActiveWorkspaceId.mockClear()
  setHash.mockClear()
  repoState.activeWorkspaceId = 'ws-1'
})

describe('ConsistencyAuditDialog', () => {
  it('renders the FULL offending id (not truncated) from the store', () => {
    publishConsistencyAudit(withSamples())
    renderDialog()
    expect(screen.getByText(FULL_ID)).toBeTruthy()
  })

  it('copies the full id to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    publishConsistencyAudit(withSamples())
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Copy id' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_ID))
  })

  it('opens a clicked id in the side panel WITHOUT closing the dialog', () => {
    publishConsistencyAudit(withSamples())
    const { cancel } = renderDialog()

    fireEvent.click(screen.getByText(FULL_ID))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: FULL_ID, target: 'sidebar-stack' }),
    )
    // The dialog must stay open so the (expensive) audit results aren't discarded.
    expect(cancel).not.toHaveBeenCalled()
  })

  it('switches to the sample’s workspace before opening it when that workspace is inactive', () => {
    // Dialog pinned to ws-A while the user is viewing ws-1 (the mocked active one).
    // `navigate` alone writes the panel into ws-A's layout WITHOUT switching to it,
    // so the click would look dead — the dialog must switch to ws-A first.
    publishConsistencyAudit({ ...withSamples(), workspaceId: 'ws-A' })
    renderDialog({ workspaceId: 'ws-A' })

    fireEvent.click(screen.getByText(FULL_ID))
    expect(setActiveWorkspaceId).toHaveBeenCalledWith('ws-A')
    expect(setHash).toHaveBeenCalledWith('hash:ws-A')
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: FULL_ID, target: 'sidebar-stack', workspaceId: 'ws-A' }),
    )
  })

  it('does NOT switch workspace when the sample already belongs to the active one', () => {
    // Same-workspace open (the common case) must not churn the active workspace/hash.
    publishConsistencyAudit(withSamples()) // ws-1 == active
    renderDialog()

    fireEvent.click(screen.getByText(FULL_ID))
    expect(setActiveWorkspaceId).not.toHaveBeenCalled()
    expect(setHash).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: FULL_ID, workspaceId: 'ws-1' }),
    )
  })

  it('renders NO dimming overlay (non-modal) but stays closable via ✕', () => {
    publishConsistencyAudit(withSamples())
    const { cancel } = renderDialog()
    // hideOverlay: the app behind the dialog must stay visible/interactive, so the
    // Radix overlay node (bg-black/80) must not be in the tree.
    expect(document.querySelector('[class*="bg-black/80"]')).toBeNull()
    // …and the ✕ still closes it (guards a regression where non-modal breaks close).
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(cancel).toHaveBeenCalled()
  })

  it('shows an empty state (and no results) when nothing has run this session', () => {
    resetConsistencyAuditStore()
    renderDialog()
    expect(screen.getByText(/no audit has run/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /run audit/i })).toBeTruthy()
  })

  it('ignores a snapshot from a different workspace (treats it as empty)', () => {
    // Audit ran in another workspace; while ws-1 (the mocked active workspace) is
    // active, its counts/ids must NOT show — else a click would open a foreign id.
    publishConsistencyAudit({ ...withSamples(), workspaceId: 'ws-OTHER' })
    renderDialog()
    expect(screen.queryByText(FULL_ID)).toBeNull()
    expect(screen.getByRole('button', { name: /run audit/i })).toBeTruthy()
  })

  it('pins the audited workspace when opening a sample', () => {
    publishConsistencyAudit(withSamples())
    renderDialog()
    fireEvent.click(screen.getByText(FULL_ID))
    expect(navigate).toHaveBeenCalledWith({
      blockId: FULL_ID,
      target: 'sidebar-stack',
      workspaceId: 'ws-1',
    })
  })

  it('shows a pinned workspace’s results even when a different workspace is active', () => {
    // The run action audited ws-A; the user switched to ws-1 (active) before the
    // dialog opened. Pinning ws-A keeps its just-published result visible, and a
    // sample opens against ws-A — not the now-active ws-1.
    publishConsistencyAudit({ ...withSamples(), workspaceId: 'ws-A' })
    renderDialog({ workspaceId: 'ws-A' })
    expect(screen.getByText(FULL_ID)).toBeTruthy()
    fireEvent.click(screen.getByText(FULL_ID))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'sidebar-stack', workspaceId: 'ws-A' }),
    )
  })

  it('keeps an open dialog’s result when a DIFFERENT workspace’s audit publishes', () => {
    // Regression: the store is per-workspace, so a cadenced/manual audit for
    // another workspace completing while this dialog is open must NOT evict the
    // (expensive) result it is showing — nor swap in the foreign result.
    const OTHER_ID = 'foreign-workspace-sample-id'
    publishConsistencyAudit(withSamples()) // ws-1 (active)
    renderDialog()
    expect(screen.getByText(FULL_ID)).toBeTruthy()

    act(() => {
      publishConsistencyAudit({
        workspaceId: 'ws-OTHER',
        checkedAt: 2,
        anomalies: 1,
        checks: { references_index_mirror: { status: 'anomaly', missingIndexRows: 1, samples: [OTHER_ID] } },
      })
    })

    // Still ws-1's result — not blanked, and not swapped to the foreign one.
    expect(screen.getByText(FULL_ID)).toBeTruthy()
    expect(screen.queryByText(OTHER_ID)).toBeNull()
    expect(screen.queryByText(/no audit has run/i)).toBeNull()
  })

  it('re-runs on demand and updates the shown result in place', async () => {
    // A distinct, plainly-synthetic id (not UUID-shaped, to keep the repo's
    // no-uuids-in-commits guard happy); the test only needs it to be findable.
    const NEW_ID = 'rerun-sample-block-id'
    // The engine publishes on success; the store-driven dialog re-renders.
    runConsistencyAuditNow.mockImplementation(async () => {
      const updated: ConsistencyAuditResult = {
        workspaceId: 'ws-1',
        checkedAt: 2_000_000_000_000,
        anomalies: 1,
        checks: {
          references_index_mirror: { status: 'anomaly', missingIndexRows: 1, samples: [NEW_ID] },
        },
      }
      publishConsistencyAudit(updated)
      return updated
    })
    publishConsistencyAudit(withSamples())
    renderDialog()
    expect(screen.getByText(FULL_ID)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /re-run/i }))
    await waitFor(() => expect(runConsistencyAuditNow).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorkspaceId: 'ws-1' }),
      'ws-1',
    ))
    // In place: the fresh result's id replaces the old one — no re-open needed.
    await waitFor(() => expect(screen.getByText(NEW_ID)).toBeTruthy())
    expect(screen.queryByText(FULL_ID)).toBeNull()
  })

  it('runs and shows its PINNED workspace (not the active one) and survives an active switch', async () => {
    // Dialog pinned to ws-A while active is ws-1. An in-dialog run must target the
    // pinned ws-A (the shown workspace), and a later switch to ws-2 must not blank
    // it — pinning at open is what keeps the result coherent across the switch.
    const RUN_ID = 'run-pinned-sample-id'
    runConsistencyAuditNow.mockImplementation(async (...args: unknown[]) => {
      const ws = args[1] as string
      const updated: ConsistencyAuditResult = {
        workspaceId: ws,
        checkedAt: 2_000_000_000_000,
        anomalies: 1,
        checks: {
          references_index_mirror: { status: 'anomaly', missingIndexRows: 1, samples: [RUN_ID] },
        },
      }
      publishConsistencyAudit(updated)
      return updated
    })
    const { rerender } = render(
      <ConsistencyAuditDialog resolve={vi.fn()} cancel={vi.fn()} workspaceId="ws-A" />,
    )
    fireEvent.click(screen.getByRole('button', { name: /run audit/i }))
    // Targets the pinned workspace, not the mocked-active ws-1.
    await waitFor(() => expect(runConsistencyAuditNow).toHaveBeenCalledWith(expect.anything(), 'ws-A'))
    await waitFor(() => expect(screen.getByText(RUN_ID)).toBeTruthy())

    repoState.activeWorkspaceId = 'ws-2'
    rerender(<ConsistencyAuditDialog resolve={vi.fn()} cancel={vi.fn()} workspaceId="ws-A" />)
    expect(screen.getByText(RUN_ID)).toBeTruthy()
    expect(screen.queryByText(/no audit has run/i)).toBeNull()
  })
})
