#!/usr/bin/env bash
# Delete every `claude/*` branch on the remote whose PR is already
# merged. The list lives in `scripts/branches-to-delete.txt` —
# generated from the GitHub API and committed alongside this script
# so you can review before running.
#
# Why this script exists: the Claude Code harness blocks both
# `git push --delete origin <branch>` and the GitHub `delete_branch`
# API call, so a session can't clean its own mess. This script
# runs from your local terminal with your own auth.
#
# Requirements:
#   - `gh` CLI installed and authenticated against this repo
#   - working directory anywhere (the script doesn't touch your
#     working tree)
#
# Usage:
#   bash scripts/delete-stale-branches.sh                # interactive
#   bash scripts/delete-stale-branches.sh --yes          # no prompt
#   bash scripts/delete-stale-branches.sh --dry-run      # show only
#
# Safety:
#   - Only deletes branches listed in `scripts/branches-to-delete.txt`.
#   - That list contains ONLY branches whose PR was MERGED (per the
#     GitHub API at the time the list was generated). Open / closed-
#     unmerged PRs' branches are NOT in the list.
#   - Skips `main` defensively.
#   - Skips any branch where deletion fails (404 / 422) — those are
#     already gone or protected.
#   - Prints a summary at the end (deleted / skipped / failed).

set -uo pipefail

REPO="dyahnke-pro/chess-academy-pro"
LIST="$(dirname "$0")/branches-to-delete.txt"

if [[ ! -f "$LIST" ]]; then
  echo "ERROR: list file not found: $LIST" >&2
  exit 1
fi

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    *)         echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

mapfile -t BRANCHES < <(grep -v '^\s*$\|^\s*#' "$LIST")
TOTAL=${#BRANCHES[@]}

echo "Repo:     $REPO"
echo "List:     $LIST"
echo "Branches: $TOTAL"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Mode:     DRY RUN (no deletions)"
else
  echo "Mode:     LIVE (will delete)"
fi
echo

if [[ $ASSUME_YES -eq 0 && $DRY_RUN -eq 0 ]]; then
  read -r -p "Delete $TOTAL branches from $REPO? [y/N] " ans
  if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
    echo "aborted."
    exit 0
  fi
fi

DELETED=0
SKIPPED=0
FAILED=0

for branch in "${BRANCHES[@]}"; do
  # Defensive: never touch main.
  if [[ "$branch" == "main" ]]; then
    echo "skip (main):        $branch"
    SKIPPED=$((SKIPPED+1))
    continue
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "would delete:       $branch"
    DELETED=$((DELETED+1))
    continue
  fi
  if gh api -X DELETE "repos/$REPO/git/refs/heads/$branch" >/dev/null 2>&1; then
    echo "deleted:            $branch"
    DELETED=$((DELETED+1))
  else
    echo "skip (404/error):   $branch"
    FAILED=$((FAILED+1))
  fi
done

echo
echo "Summary:"
echo "  deleted: $DELETED"
echo "  skipped: $SKIPPED"
echo "  failed:  $FAILED"
