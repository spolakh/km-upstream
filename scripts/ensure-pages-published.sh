#!/usr/bin/env bash
# Ensure our just-pushed gh-pages content is actually PUBLISHED and served,
# retrying GitHub's flaky Pages publisher on transient failure.
#
# Why this exists: production and PR previews are served from the gh-pages branch
# ("Deploy from a branch"). Each push to gh-pages auto-triggers GitHub's own
# "pages build and deployment" run, which we do NOT author and cannot configure.
# That publisher is intermittently flaky: its deploy step returns
#   "Deployment failed, try again later."
# or stalls in deployment_queued. When a push's publish fails, that push's
# content stays 404 until the *next* successful publish sweeps it in — so a
# preview (or a master deploy) can silently fail to go live. GitHub's own remedy
# for the error is, literally, to try again. This script does that automatically.
#
# How it decides success: it polls the LIVE site for our exact build sha at our
# own path's version.json. That file is per-deploy — only our build writes the
# copy under our base path (production root, or pr-preview/pr-<n>/) — so seeing
# our sha there means our content is served. This is precise and immune to
# concurrent deploys: no build-id/timestamp correlation (the Pages "build"
# object has no id field, and timestamps race), just "is my content live yet?".
# On stall it re-requests a build via POST /pages/builds (the "try again later").
#
# Requires: GITHUB_REPOSITORY, APP_BASE_PATH, and a token with `pages: write` in
# GH_TOKEN. `dist/version.json` (produced by the build) must still be present.
# Run this AFTER the step that pushes to gh-pages.
set -euo pipefail

: "${GH_TOKEN:?set GH_TOKEN to a token with pages:write}"
: "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY (owner/repo)}"
: "${APP_BASE_PATH:?set APP_BASE_PATH (the base path the build was made for)}"

owner="${GITHUB_REPOSITORY%%/*}"
host="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]').github.io"
url="https://${host}${APP_BASE_PATH}version.json"

# The exact build we just pushed; read from the artifact so we track whatever the
# build actually stamped (not a re-derivation of the sha logic).
want="$(python3 -c 'import json; print(json.load(open("dist/version.json"))["sha"])')"
echo "waiting for ${url} to serve sha=${want}"

builds="https://api.github.com/repos/${GITHUB_REPOSITORY}/pages/builds"
auth=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")

# Prints the sha the live site currently serves at our path, or empty (404 /
# stale-before-publish / transient error all collapse to empty -> keep waiting).
served() {
  curl -fsS "${url}?cb=${RANDOM}${RANDOM}" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sha",""))' 2>/dev/null \
    || true
}

ROUNDS="${PAGES_PUBLISH_ROUNDS:-4}"   # rebuild requests before giving up
POLLS="${PAGES_PUBLISH_POLLS:-40}"    # status polls per round (~10s each)

for round in $(seq 1 "$ROUNDS"); do
  # Round 1 rides the auto-build our push already triggered. Later rounds are the
  # actual retry: explicitly request a fresh Pages build of the current branch.
  if [ "$round" -gt 1 ]; then
    echo "== not live yet; requesting a Pages rebuild (round ${round}/${ROUNDS}) =="
    curl -fsS -X POST "${auth[@]}" "$builds" >/dev/null || true
    sleep 10
  fi
  for _ in $(seq 1 "$POLLS"); do
    got="$(served)"
    echo "  serving=${got:-<none>} want=${want}"
    if [ -n "$got" ] && [ "$got" = "$want" ]; then
      echo "Published: ${url} serves ${want}"
      exit 0
    fi
    sleep 10
  done
done

echo "::error::${url} did not serve sha ${want} after ${ROUNDS} rebuild attempts"
exit 1
