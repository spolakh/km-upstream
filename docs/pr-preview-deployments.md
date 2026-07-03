# PR preview deployments

> **Status:** current — last verified against code 2026-07-02 (`.github/workflows/deploy-pages.yml`, `.github/workflows/pr-preview.yml`, `scripts/ensure-pages-published.sh`).

Every pull request gets its own live, clickable build of the app so you can
open it and click around before merging:

```
https://stvad.github.io/knowledge-medium/pr-preview/pr-<number>/
```

`rossjrw/pr-preview-action` posts a sticky comment on the PR with that link on
each push, and removes the preview when the PR is merged or closed.

## How it works

Both production and previews are served from **one `gh-pages` branch**, because
GitHub Pages serves a single site per repo:

- `gh-pages` **root** — production (`.github/workflows/deploy-pages.yml`, on push
  to `master`). Built with `APP_BASE_PATH=/knowledge-medium/`.
- `gh-pages` **`pr-preview/pr-<n>/`** — one subtree per open PR
  (`.github/workflows/pr-preview.yml`, on `pull_request`). Built with
  `APP_BASE_PATH=/knowledge-medium/pr-preview/pr-<n>/`.

The build is already base-path aware: Vite's `base` comes from `APP_BASE_PATH`
(`vite.config.ts`), the service worker registers at `${BASE_URL}sw.js` scoped to
that path (`src/registerServiceWorker.ts`), and `inject-sw-build-id.mjs`
base-prefixes precache URLs. So each preview's assets and its *own* service
worker are scoped to its subpath.

Previews share production's **origin** (`stvad.github.io`), so per-origin client
state (Cache Storage, OPFS, IndexedDB, localStorage) is a shared namespace with
production. The two riskiest overlaps are handled explicitly (namespaced per
deploy):

- **Service-worker caches / offline shell** (`public/sw.js`) — production's SW no
  longer intercepts or caches `/pr-preview/…` requests (so an offline production
  load can't boot a preview build), and each SW's `activate` GC deletes only its
  own deploy's generations, so a preview SW no longer evicts production's caches
  (and vice-versa). Verified in a real browser (both directions).
- **Local SQLite DB** (`kmp-v6-<user>.db`, `src/data/repoProvider.ts`) — preview
  builds suffix the filename with `-pr-<n>`, so a preview gets its **own** local
  DB and a preview PR's client migration can't touch production's real store.
  Production's filename is unchanged.

> **⚠️ Still shared with production:** the **remote backend** (same Supabase /
> PowerSync — a preview reads/writes real synced data) and a few minor
> per-origin `localStorage` keys (e.g. the e2ee mode pin, last-workspace). So a
> preview is a preview of the *frontend* against live data — for anything that
> writes, use a scratch page (and, if you want belt-and-braces, a separate
> browser profile).

Coexistence on the shared branch is kept safe by two settings on the production
deploy: `clean-exclude: pr-preview` (production never wipes live preview
subtrees) and `force: false` (a normal fetch+rebase push, so a concurrent
preview deploy isn't force-overwritten). The two workflows also use separate
concurrency groups so a queued preview can't cancel a queued production deploy.

### Publish reliability (retry the flaky publisher)

A push to `gh-pages` only updates the branch. What actually *serves* it is
GitHub's own auto-triggered **"pages build and deployment"** run (a dynamic
workflow we don't author), and that publisher is intermittently flaky — its
deploy step returns `Deployment failed, try again later.` or stalls in
`deployment_queued`. When a push's publish flakes, that push's content stays
**404 until the next successful publish sweeps it in** (any later build rebuilds
the whole branch HEAD). This bit the first production cutover and early previews.

Both workflows therefore end with an **`Ensure Pages published`** step
(`scripts/ensure-pages-published.sh`, needs `pages: write`): after the push it
watches the latest Pages build and, on error/stall, re-requests one via
`POST /pages/builds` (a few rounds) — automating the "try again later" retry we
used to do by hand. It only accepts a build **newer** than the one present
before the push, so a stale pre-push `built` can't be mistaken for our publish.
This is also what makes a routine `master` merge reliably go live.

### Why same-origin matters here

Previews live on `stvad.github.io` (only the path differs), so two referrer /
origin-scoped things keep working with no extra config:

- the **Google Maps** key (HTTP-referrer restricted to the Pages host), and
- the **agent bridge** origin allowlist (`https://stvad.github.io`, README).

A different host (Netlify/Vercel/`*.pages.dev`) would have needed both updated.

## One-time setup (required — the workflows don't work until this is done)

The switch from the Pages *artifact* flow to *branch* serving needs one manual
change, and the order matters so production is never dark:

1. **Merge this to `master`** (or run **Deploy Pages** via *workflow_dispatch*).
   This runs the new production workflow, which creates/populates the
   `gh-pages` branch with an identical build. The live site is still served by
   the previous artifact deploy at this point, so nothing changes yet.
2. Confirm the built site is at the branch **root** — both `index.html` **and**
   `.nojekyll` at `gh-pages` `/`. The branch may **already exist** from a preview
   run, containing only `pr-preview/pr-<n>/` and *no root build* — mere existence
   is NOT readiness. Flipping the source before a production deploy populates the
   root would 404 production and leave Jekyll active site-wide (a root
   `.nojekyll` is what disables it; without it Jekyll strips the `_virtual/`
   chunks `preserveModules` emits, breaking previews too).
3. **Settings → Pages → Build and deployment → Source → "Deploy from a
   branch"**, branch **`gh-pages`**, folder **`/ (root)`**, Save. The live site
   is now served from the branch — the same build — so the cutover is seamless.

After that, master pushes update the root and PRs manage their own
`pr-preview/pr-<n>/` subtree automatically.

### If secrets are environment-scoped

The workflows read `VITE_*` as `vars.X || secrets.X` at the repo level (no
`environment:` block). If those values were configured as **environment**
secrets under the old `github-pages` environment rather than **repository**
secrets/variables, the "Validate build variables" step fails fast (before any
deploy) — move them to repository-level secrets/variables (Settings → Secrets
and variables → Actions). This is the standard setup and almost certainly
already the case.

### If a preview push 403s

The workflows request `contents: write` explicitly, which is enough on its own.
If a push is still rejected, enable Settings → Actions → General → Workflow
permissions → **Read and write permissions**.

## Notes / limitations

- **Forks are skipped by design.** Fork PRs get neither the `VITE_*` secrets nor
  write access to `gh-pages`, so the preview job is gated to same-repo PRs. All
  PRs to this repo come from same-repo branches.
- **Shared backend.** Previews use the same Supabase / PowerSync as production
  (same `VITE_*`); the SW caches and local DB are isolated per deploy, but the
  remote data and a few minor `localStorage` keys are shared (see the ⚠️ box). A
  preview is a preview of the *frontend* against live data — use a scratch page
  for anything that writes.
- **Merge-time branch race (self-limiting).** Merging a PR fires the production
  deploy (push→`master`) and the preview removal (`closed`) concurrently — they
  use separate concurrency groups and both push to `gh-pages`. `force: false`
  makes each fetch+rebase+retry, so production never goes dark; the worst case is
  a removed preview subtree that lingers (re-runnable, or cleared by a later
  branch squash). Not worth serializing given the low PR volume.
- **`gh-pages` history grows** (no `single-commit`, since squashing the branch
  would drop live preview subtrees). Squash the branch manually if it ever gets
  unwieldy.
- `public/.nojekyll` disables Jekyll on the branch-served site (Jekyll would
  otherwise drop the `_virtual/` chunks `preserveModules` emits). It must sit at
  the branch **root**; the copy in each preview subtree is inert.

## Same-origin isolation (implemented)

Because previews share production's origin, per-origin client state is
namespaced by deploy so a preview can't corrupt production:

- **`public/sw.js`** — (a) production's SW ignores `/pr-preview/…` requests
  (`isForeignPreviewRequest`), so it can't cache preview content under
  production's keys; (b) each SW's `activate` GC deletes only its own deploy's
  expired ledger generations rather than blanket-deleting every `km-*` cache on
  the origin, so a preview SW can't evict production's caches. Verified in a real
  browser (both directions).
- **`src/data/repoProvider.ts`** — `dbFilenameForUser` suffixes the local DB
  filename with `-pr-<n>` for preview builds only (`BASE_URL` under
  `/pr-preview/`); production's filename is byte-for-byte unchanged. The suffix
  is carved out of the user-segment budget to stay under wa-sqlite's 64-char
  pathname cap (covered by `repoProvider.test.ts`).

**Residual (not namespaced):** a few per-origin `localStorage` keys (the e2ee
mode pin `kmp-e2ee-mode:*`, last-workspace) remain shared. They're per-user and
low-risk for a same-user preview; namespacing them by deploy is a possible
future hardening if fuller isolation is wanted.
