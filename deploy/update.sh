#!/usr/bin/env bash
# Deploys one commit of the deploy branch (default: dev) on this server: fetch, check, rebuild, migrate.
# Data, deploy/.env and certificates are kept (they are not tracked by git).
#
# Called by the Deploy workflow over SSH with a key that may run only this script
# (forced command, see docs/runbooks/auto-deploy.md). By hand: ./deploy/update.sh <40-character commit id>
#
# Everything runs inside main() so bash has read the whole script before git replaces this file.
set -euo pipefail

main() {
  local sha="${1:-${SSH_ORIGINAL_COMMAND:-}}"
  local branch="${DEPLOY_BRANCH:-dev}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: update.sh <40-character commit id>" >&2; exit 2; }

  cd "$(dirname "$(readlink -f "$0")")/.."
  [ -d .git ] || { echo "$(pwd) is not a git checkout; see docs/runbooks/auto-deploy.md" >&2; exit 1; }
  [ -f deploy/.env ] || { echo "Run deploy/install.sh once before automatic deploys." >&2; exit 1; }

  # One deploy at a time.
  exec 9>/tmp/foxalora-deploy.lock
  flock 9

  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git merge-base --is-ancestor "$sha" "origin/$branch" \
    || { echo "Commit $sha is not on $branch; not deploying." >&2; exit 1; }

  local current
  current=$(git rev-parse HEAD)
  if [ "$current" = "$sha" ]; then
    echo "Commit $sha is already deployed; rebuilding anyway."
  elif git merge-base --is-ancestor "$sha" "$current" 2>/dev/null; then
    echo "A newer commit ($current) is already deployed; skipping $sha."
    exit 0
  fi

  echo "Deploying $branch at $sha (was $current)"
  git reset --quiet --hard "$sha"

  local domain
  domain=$(sed -n 's/^DOMAIN=//p' deploy/.env)
  # The installer prints the setup link while setup is unfinished; keep it out of CI logs.
  ./deploy/install.sh "$domain" 2>&1 | sed -E 's/(token=)[0-9a-f]+/\1<hidden: grep SETUP_TOKEN deploy\/.env>/'
  echo "Deployed $(git log -1 --format='%h %s')"
}

main "$@"
exit
