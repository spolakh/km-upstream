/**
 * `ClientContext` — the client's indexical "acting-as" state: who is
 * acting (the authenticated user) and what they are acting on/at (the
 * active workspace pin, the active layout session).
 *
 * One instance per client, constructed and owned by its `Repo` (identity
 * is 1:1 with the Repo — `repo.client`). It is deliberately distinct
 * from the app's two other context notions:
 *
 *   - BLOCK context is positional — per-subtree, provided down the render
 *     tree, many per client;
 *   - the FACET runtime is contribution space — what code/capabilities
 *     are installed, not who is acting.
 *
 * Future acting-as state (device identity, impersonation, per-client
 * capability flags, …) belongs HERE, not on Repo: Repo composes this
 * object and keeps thin delegation shims for its existing public API,
 * but stops accreting indexical fields itself.
 *
 * This class holds bare state plus a change-notification channel (a
 * CallbackSet per observable field) — no Repo reference. Side-effectful
 * transitions (facet-bridge notification, projector re-pin,
 * seed-materialization rescheduling on a workspace switch) live in
 * Repo's setters, which delegate just the field read/write here;
 * notifying subscribers is state bookkeeping, not a Repo side effect.
 *
 * `repo.client` and `useClientContext()` expose only the
 * {@link ClientContextReader} view (no set methods) — see its doc for
 * why. Repo holds the concrete `ClientContext` privately and is the only
 * caller of the set methods below (plus the reverse-direction shim test).
 *
 * Note on the `getLayoutSessionId` import: this file is on the ambient
 * accessor's allowlist (see the `@ambient` tag in
 * `src/utils/layoutSessionId.ts`) because the base-seed FALLBACK read
 * lives here — everything else must go through `activeLayoutSessionId`.
 */

import { getLayoutSessionId } from '@/utils/layoutSessionId'
import { CallbackSet } from '@/utils/callbackSet'
import type { User } from '@/data/api/user.js'

export interface ClientContextOptions {
  user: User
}

/**
 * Read-only + subscribe view onto {@link ClientContext} — what `repo.client`
 * and `useClientContext()` expose. Deliberately omits `setActiveWorkspaceId`
 * / `setActiveLayoutSessionId`: those bypass Repo's transition (facet-bridge
 * notification, projector pin/rollback, seed-materialization generation
 * turnover), so a caller reaching them would silently desync those systems.
 * This type makes that mistake a compile error rather than a documented
 * convention. Mutate ONLY via `repo.setActiveWorkspaceId` /
 * `repo.setActiveLayoutSessionId`.
 */
export interface ClientContextReader {
  readonly user: User
  readonly activeWorkspaceId: string | null
  readonly activeLayoutSessionId: string
  /** Subscribe to EFFECTIVE changes of either field (no-op sets — including
   *  the layout-session id's null⇄base-id folding — do not notify). Returns
   *  an idempotent unsubscribe. */
  onActingAsChange(listener: () => void): () => void
}

export class ClientContext implements ClientContextReader {
  /** The authenticated user this client acts as. Written into
   *  `tx_context.user_id` / per-row `created_by` / `updated_by` by the
   *  commit pipeline (via `repo.tx`). */
  readonly user: User

  private _activeWorkspaceId: string | null = null
  /** `null` means "no override" — `activeLayoutSessionId` falls back to
   *  the per-device base id. */
  private _activeLayoutSessionId: string | null = null

  /** Fires on EFFECTIVE changes to `activeWorkspaceId` / `activeLayoutSessionId`
   *  — see {@link onActingAsChange}. Notified from THIS class's own set
   *  methods (single home for the state = single home for the notify); the
   *  Repo-side transition effects (facet-bridge, projectors, seed-generation)
   *  are separate and unrelated to this channel. */
  private readonly actingAsListeners = new CallbackSet<[]>('ClientContext.actingAsChange')

  constructor(opts: ClientContextOptions) {
    this.user = opts.user
  }

  onActingAsChange(listener: () => void): () => void {
    return this.actingAsListeners.add(listener)
  }

  /** UI-visible "active" workspace pin — used by plugin hooks and
   *  panels that need a default workspace when there's no other
   *  context. `repo.tx` does NOT consult this; tx workspaces come from
   *  the first write's row per spec §5.3. */
  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId
  }

  /** Bare state write — no propagation of the Repo-side switch effects.
   *  Everything outside Repo goes through `repo.setActiveWorkspaceId`,
   *  which owns those side effects (facet-bridge notification, projector
   *  pin/rollback, seed-materialization rescheduling) and delegates only
   *  the field write here. This method DOES fire {@link onActingAsChange}
   *  on an effective change — Repo's setter calls this first and performs
   *  its own side effects after, so a subscriber reacting synchronously
   *  could observe the pin already updated while the facet-bridge /
   *  projectors are still mid-transition (same hazard as any React
   *  re-render mid-transition today). */
  setActiveWorkspaceId(workspaceId: string | null): void {
    if (workspaceId === this._activeWorkspaceId) return
    this._activeWorkspaceId = workspaceId
    this.actingAsListeners.notify()
  }

  /** UI-visible "active" layout-session id — which panel-layout tree
   *  imperative code (actions, navigation helpers) should treat as "the
   *  session the user is looking at" (mirrors `activeWorkspaceId` above,
   *  replacing the module-global `getActiveLayoutSessionId` store it used
   *  to be). Falls back to the per-device BASE session id
   *  (`getLayoutSessionId()`, the boot seed) when no override has been
   *  set — so today, with nothing yet calling `setActiveLayoutSessionId`,
   *  this getter is behavior-identical to reading the base id directly. */
  get activeLayoutSessionId(): string {
    return this._activeLayoutSessionId ?? getLayoutSessionId()
  }

  /** Override the active layout-session id; `null` restores the
   *  per-device base id. Unlike `setActiveWorkspaceId`, this deliberately
   *  has NO side-effectful Repo-side counterpart (no facetBridge / runtime
   *  notification, no reprime) — layout-session switching has no Repo-level
   *  transition to run, only the {@link onActingAsChange} notify below,
   *  fired on an EFFECTIVE change (comparing the resolved getter value, so
   *  a set that folds to the same base id — `null` ⇄ the current base id —
   *  is a no-op and does not notify). The one reactive consumer today is
   *  `LayoutSessionHost`, via the `useActiveLayoutSessionId` hook
   *  (src/hooks) — thin sugar over this same channel, not a second one. */
  setActiveLayoutSessionId(id: string | null): void {
    const previous = this.activeLayoutSessionId
    this._activeLayoutSessionId = id
    if (this.activeLayoutSessionId !== previous) this.actingAsListeners.notify()
  }
}
