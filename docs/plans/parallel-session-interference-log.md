# Parallel-Session Interference Log

Running log of incidents where another Claude Code session (sharing
this repo via the macOS file system) has interfered with this
session's work. Recovery has worked every time, but the underlying
setup is leaking. After enough incidents land, this log is the input
to diagnosing the source rather than recovering each time.

**Threshold for triggering a "fix at the source" investigation:** 3
more incidents past 2026-05-16 (total target: 6). Sample size where
the pattern becomes diagnosable.

**Category-aware threshold (added 2026-05-16, post-Incident-4):**
the threshold above was set when all observed incidents were
state-clobbering. Incident 4 surfaced a second category —
informational pollution, see "Incident categories" below — with a
different failure mode and a different mitigation. When the
6-incident threshold triggers an investigation, consider whether
the data splits into two distinct problems with separate root
causes, not one. Three state-clobbering + one informational ≠ four
state-clobbering for diagnosis purposes. Don't revise the threshold
now; just keep the split visible.

**Protocol when threshold trips (added 2026-05-16, post-Incident-5):**
when incident 6 lands, the active session MUST stop whatever
they're doing, log the incident, stash if needed, and surface to
Dave. Do NOT auto-pivot into the source-fix investigation
mid-PR. That investigation deserves its own focused scope and its
own session — not a hijack of whatever WO was in flight when the
threshold tripped. Same scope-sprawl pattern that was killed at
PLUMBING-01 kickoff; do not reintroduce it under a different name.
The source-fix investigation only starts after Dave green-lights it
as the next session's primary task.

## Format

For each incident:

- **Category** — `state-clobbering` or `informational pollution`
  (see below)
- **When** — timestamp / WO / phase
- **What** — branch they moved you to, what state your work was in
- **How detected** — `git status` check, failed checkout, lost
  working-tree changes, etc.
- **Recovery** — what got me back to where I was, time cost

## Incident categories

Two distinct failure modes have surfaced. They are NOT the same
problem with different surface details — different what-broke,
different how-detected, different what-fixes-it. Diagnosis should
treat them separately.

- **`state-clobbering`** (Incidents 1, 2, 3, 5) — the parallel
  session moves working-tree state on the shared file system:
  branch switches via `git checkout`, `git stash` on in-flight
  edits, untracked files leaking in from their branch. Visible
  in `git status` / `git branch --show-current` / `git stash
  list`. Detection is reflexive (next git command surfaces it).
  Mitigation is recovery — checkout back, stash pop, clean up
  leaked files. Cost: 30s–15min per incident.

- **`informational pollution`** (Incident 4) — the parallel
  session bakes an incorrect claim into a commit message or doc
  that future sessions reading git log will treat as ground
  truth. Not visible in `git status` — only surfaces when
  another session encounters the contradicting evidence and
  reads back. Mitigation is forward-correction in the next PR
  that touches the affected area (PR-B1 #570 corrected
  `a4bac342`'s "pre-existing flaky async-timing failures" claim
  in its body). Cost: not measured per-incident — costs
  accumulate as future sessions are misled before correction.

Different mitigations means the fix-at-source for each may also
differ. State-clobbering points at working-tree isolation
(worktrees, session pinning). Informational pollution points at
cross-session communication discipline (handoff docs, commit
message review). Possibly the same root cause produces both;
possibly not.

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

## Incident 4 — WO-TEST-CLEANUP-01 PR-B1 pre-merge review (2026-05-16)

- **Category:** `informational pollution` — first observed instance
  of this category.
- **When:** Dave caught it during PR-B1 (#570) pre-merge review, ~2h
  after the parallel session's commit `a4bac342` merged to `main`.
- **What:** Commit `a4bac342` ("fix(kid): remove phantom padding +
  coach state leaks (P10b)", co-authored by Claude session
  `session_01U8XD7efj3JXn29N98umX6x`) contained the trailing
  sentence: *"The 2 chapter-page hint tests in vitest are
  pre-existing flaky async-timing failures unrelated to this PR."*
  They were not flaky — they were test-side reconciliation failures
  caused by Part A (#568) tightening the `coachService.ask` mock to
  resolve with `text: ''`, which broke `{nudgeText && (...)}`
  conditional renders downstream. PR-B1 is the corrective fix. The
  parallel session's misdiagnosis was on its way to becoming durable
  context for any future session greppping git log for "flaky
  test" patterns in the kid surfaces.
- **How detected:** Dave read PR-B1's PR body, noticed the line
  flagging `a4bac342`'s misdiagnosis, and asked two questions
  before greenlighting merge: (1) where does the misleading claim
  live, durable or commit-message-only; (2) whose commit was
  `a4bac342` — this session's or parallel.
  - `grep -rn "flaky async"` and `grep -rn "pre-existing flaky"`
    across `*.ts *.tsx *.md *.mjs` returned empty — the only
    location is the immutable commit message itself.
  - `git show a4bac342 --no-patch --pretty=fuller` showed the
    `claude.ai/code/session_...` trailer pointing at a session ID
    that is not this conversation; my Part A merge was a
    different SHA (`5b2eb30f`).
- **Recovery:** Forward-correction only — there is no working-tree
  state to undo. The commit message is immutable in git history.
  Mitigation is layered: (1) PR-B1's PR body on origin (#570)
  explicitly identifies and corrects the misdiagnosis on the next
  commit in the log, so future-us reading the kid-test thread sees
  the correction immediately after the false claim; (2) this log
  entry documents the pattern so the category gets tracked. Time
  cost: ~10 min including grep verification, author identification,
  and Dave's review round-trip.

## Incident 5 — Incident 4 log addition (2026-05-16)

- **Category:** `state-clobbering` (recurrence of the Incident 3
  pattern on the same enrichment branch).
- **When:** Mid-Incident-4 investigation — between Dave green-
  lighting "go with A, atomic log entry on the same branch" and the
  first Edit landing on the log file.
- **What:** Parallel session checked out `claude/openings-db-
  enrichment` (HEAD `6743dbb7`, same audit-enrichment work as
  Incident 3) and ran `scripts/audit-pgn-vs-masters.mjs` edits in
  the shared working tree. The `docs/plans/parallel-session-
  interference-log.md` file vanished from disk because it doesn't
  exist on that branch.
- **How detected:** `Read` tool returned `File does not exist` for
  a path I had read 60 seconds earlier; `git status` confirmed I
  was on `claude/openings-db-enrichment` with a `modified:
  scripts/audit-pgn-vs-masters.mjs` entry that wasn't mine.
- **Recovery:** Stopped immediately per Dave's "do not interfere
  with other sessions work" order — did NOT `git checkout` back
  while the other session was active. Stashed the rogue
  `audit-pgn-vs-masters.mjs` with an explicit `OTHER-SESSION ...
  DO NOT pop` label (same pattern as Incident 2's stash) so their
  work is recoverable if they come looking. Waited for Dave's
  "other session is done with the audit" signal, then
  `git checkout claude/wo-test-cleanup-01-part-b-investigation`,
  verified the log file returned to disk, resumed the Edit. Time
  cost: ~5 min plus the wait window.
- **Meta-note:** This incident happened DURING the investigation
  of Incident 4. Recursive — the very file documenting parallel-
  session interference got hit by parallel-session interference.
  Reinforces the diagnosis that the shared working tree is the
  failure mode.

---

## What's working

- **`git status` + `git branch --show-current` before any commit**
  — caught every state-clobbering incident (1, 2, 3, 5) within
  seconds of switching contexts. Does NOT catch informational
  pollution (Incident 4) — that requires reading commit history
  + greppping for the claim.
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

- **Strongest single signal: the Incident 5 recursion.** The
  parallel session interfered with the file documenting
  parallel-session interference — and the file vanished from
  disk because it doesn't exist on their branch. Workflow-class
  fixes (run `git status` more often, label your stashes,
  communicate before checkout) cannot prevent a session from
  clobbering a file that does not exist on the other branch.
  The failure mode is structural, not workflow. When the
  6-incident threshold trips, the recursion alone is sufficient
  evidence to act — no additional data is needed to justify
  source-fix work.
- Both sessions use the same repo directory and same `gh`/git
  auth. There's no per-session isolation.
- One possible fix at the source: **per-session git worktrees**.
  Each Claude session opens its own worktree off `main` (e.g.
  `git worktree add ../chess-academy-pro-session-N <branch>`),
  isolating index/HEAD/working-tree state per session while
  sharing the underlying object store. Directly addresses the
  Incident 5 failure mode — each worktree has its own copy of
  every tracked file at HEAD, so "file doesn't exist on the
  other branch" can't manifest as "file vanished from disk."
- Another possibility: **explicit session pinning** — at session
  start, lock `git checkout` to a known branch and refuse to
  switch unless the user types a confirmation. Less ergonomic,
  and doesn't fix the untracked-file-leak sub-pattern of
  Incident 2.

These are guesses. The log accumulates concrete data; we diagnose
at the source after Incident 6. Per the category-aware threshold
note above, the diagnosis at that point should ask whether the
data splits into two root causes rather than one — Incident 4's
informational-pollution mode may need a separate mitigation
(commit-message review discipline, handoff doc convention) from
whatever fixes the state-clobbering mode.
