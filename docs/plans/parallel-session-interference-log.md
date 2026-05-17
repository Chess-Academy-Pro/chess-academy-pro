# Parallel-Session Interference Log

Running log of incidents where another Claude Code session (sharing
this repo via the macOS file system) has moved a session's working
state — checkout, stash, branch creation — without that session's
intent. Recovery has worked every time, but the underlying setup is
leaking. After enough incidents land, this log is the input to
diagnosing the source rather than recovering each time.

**Threshold for triggering a "fix at the source" investigation:** 3
more incidents past 2026-05-16 (total target: 6). Sample size where
the pattern becomes diagnosable.

## Format

For each incident:

- **When** — timestamp / WO / phase
- **What** — branch they moved you to, what state your work was in
- **How detected** — `git status` check, failed checkout, lost
  working-tree changes, etc.
- **Recovery** — what got me back to where I was, time cost

---

## Incident 1 — PLUMBING-01 PR-A finalization (2026-05-16)

- **When:** Mid-PR-A, after the plan-docs commit pushed but before
  the PR-A code commit
- **What:** I ran `git commit` for PR-A's code (alias map +
  appRoutesManifest entry). Commit message returned
  `[claude/trap-orientation-phase-1 a2dd948a] feat(rolodex): PR-A
  — alias map + opening-traps in app manifest` — landed on the
  PARALLEL session's branch, not `claude/rolodex-plumbing-plan`.
- **How detected:** Read the commit-output branch name; reflog
  showed the parallel session had checked their branch out at
  `HEAD@{1}` mid-session.
- **Recovery:** `git reset --hard be5aa5af` to restore the
  parallel branch's pre-my-commit state, cherry-pick my commit
  `a2dd948a` onto `claude/rolodex-plumbing-plan`, force-push the
  rebased plumbing-plan branch. ~10 min.

## Incident 2 — PLUMBING-01 PR-B tightening (2026-05-16)

- **When:** Between PR-B initial push and the tightening commit
  (the rule-6 stem fix + Dexie poll attempt + retro to chat-mirror)
- **What:** Working tree had my 4 in-flight edits to PR-B
  tightening files. Parallel session ran `git stash` on those
  changes with the label `OTHER-SESSION rolodex+coachgametest WIP
  — DO NOT pop on coach-master-integration branch`, then moved
  the branch to `claude/coach-master-integration`. Also left
  untracked `masterPlayLookup.ts` / `masterPlayCache.ts` /
  `masterPlayTypes.ts` files in my working tree that broke
  typecheck.
- **How detected:** `git branch --show-current` returned the wrong
  branch; `git stash list` showed an explicitly-labeled "OTHER-
  SESSION" entry; my expected files weren't in the working tree.
- **Recovery:** `git checkout claude/rolodex-plumbing-b` to switch
  back; `git stash pop stash@{1}` to restore my work; removed the
  three untracked masterPlay files (they belonged to the parallel
  session). ~15 min including troubleshooting cherry-pick
  conflicts.

## Incident 3 — WO-TEST-CLEANUP-01 Step 0 kickoff (2026-05-16)

- **When:** Right after PLUMBING-01 retro merged, opening the
  envelope.test.ts one-liner branch
- **What:** Parallel session moved local checkout to
  `claude/openings-db-enrichment` (HEAD `6743dbb7`, audit
  enrichment work). The puzzlesFamilyFallbackNotify file the WO
  references didn't exist on that branch — the WO's reference
  list verification surfaced the mismatch immediately.
- **How detected:** `find src -name '*FamilyFallback*'` returned
  empty; ran `git branch --show-current` and confirmed wrong
  branch.
- **Recovery:** `git checkout main`; verified HEAD at `165cbf4f`
  (the PLUMBING-01 retro merge); resumed work. ~30 seconds.

---

## What's working

- **`git status` + `git branch --show-current` before any commit**
  — caught all three incidents within seconds of switching
  contexts.
- **`git status --short | head` after `cd`-equivalent state
  changes** — the untracked-file leak in Incident 2 surfaced
  immediately.
- **Labeled stashes** — the parallel session's "OTHER-SESSION ...
  DO NOT pop on X branch" stash label made it trivial to identify
  whose work was whose. (Whether that label is human-written or
  automated, it helps either way.)

## What's NOT working

- The shared local working tree itself is the failure mode. Two
  Claude sessions operating on the same `/Users/davidyahnke/Developer/chess-academy-pro`
  directory have racing access to the index, HEAD, and untracked
  files.
- Even with discipline, each incident costs 30 seconds to 15
  minutes of recovery — non-zero tax on every WO.

## Hypothesis (provisional, to refine with more data)

- Both sessions use the same repo directory and same `gh`/git
  auth. There's no per-session isolation.
- One possible fix at the source: **per-session git worktrees**.
  Each Claude session opens its own worktree off `main` (e.g.
  `git worktree add ../chess-academy-pro-session-N <branch>`),
  isolating index/HEAD/working-tree state per session while
  sharing the underlying object store.
- Another possibility: **explicit session pinning** — at session
  start, lock `git checkout` to a known branch and refuse to
  switch unless the user types a confirmation. Less ergonomic.

These are guesses. The log accumulates concrete data; we diagnose
at the source after Incident 6.
