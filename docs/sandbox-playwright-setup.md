# Sandbox runbook — Playwright + audit streams in Claude Code on the web

This is the load-bearing playbook for running Playwright specs, the
custom `scripts/audit-*.mjs` browser audits, and the live audit-stream
poller from inside a Claude Code on the web session. Every fresh
container hits the same four blockers; the fixes are baked into the
repo, this doc just spells out which knobs to turn.

> **Audience:** Claude sessions and humans paired with one. Read this
> before you waste tokens trying to `apt install chromium` or
> `npx playwright install`. Both fail. The sandbox image ships
> Chromium pre-installed under `/opt/pw-browsers/`.

---

## Quick start — full audit run

```bash
# 1. Start the dev server. Vite's `reuseExistingServer` picks it up
#    when audits target localhost.
npm run dev > /tmp/vite.log 2>&1 &
disown
sleep 12
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/   # expect 200

# 2. Point audits at localhost + pre-installed Chromium and run.
export AUDIT_SMOKE_URL=http://localhost:5173
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell

node scripts/audit-dashboard.mjs
node scripts/audit-coach-play.mjs
node scripts/audit-coach-review.mjs
node scripts/audit-coach-chat.mjs
node scripts/audit-tactics.mjs
node scripts/audit-weaknesses.mjs
node scripts/audit-openings-ui.mjs
node scripts/audit-settings-behavior.mjs
node scripts/audit-untouched-surfaces.mjs
node scripts/audit-back-from-review.mjs
node scripts/audit-smoke.mjs
```

Each script drops a JSON report under `audit-reports/<surface>-<iso>/`.
All custom scripts go through `scripts/audit-lib/chromium.mjs` which
resolves the binary from the env override or the `/opt/pw-browsers/`
fallback candidates.

For Playwright **specs** (`e2e/*.spec.ts`), use:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  npx playwright test e2e/your-spec.spec.ts --reporter=list --workers=1
```

`playwright.config.ts` already reads the env var and feeds it to
`launchOptions.executablePath`.

---

## The four blockers, and the fix for each

### 1. `npx playwright install` fails (browser CDN blocked)

```
Error: Failed to download Chrome Headless Shell 145.0.7632.6
Download failure ... server returned code 403 body 'Host not in allowlist'
URL: https://cdn.playwright.dev/builds/cft/.../chrome-headless-shell-linux64.zip
```

`cdn.playwright.dev` is not on the sandbox network allowlist. So is
`playwright.azureedge.net` and `edgedl.me.gvt1.com`. **Do not retry
the install — it can never succeed from this container.**

**Fix:** use the pre-bundled Chromium:

```bash
ls /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
ls /opt/pw-browsers/chromium-1194/chrome-linux/chrome            # headed variant
```

The custom audit scripts call `resolveChromiumExecutable(headed)` from
`scripts/audit-lib/chromium.mjs`, which honors
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and falls back to the
`/opt/pw-browsers/` candidates. Specs go through
`playwright.config.ts` which honors the same env var.

If you write a **new** audit script that launches Chromium directly:

```js
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './audit-lib/chromium.mjs';

const executablePath = await resolveChromiumExecutable(HEADED);
const browser = await chromium.launch({ headless: !HEADED, executablePath });
```

### 2. HTTPS cert errors (`net::ERR_CERT_AUTHORITY_INVALID`)

The sandbox MITM-intercepts HTTPS through its own root CA. The audit
scripts target `http://localhost:5173` so this rarely matters, but if
you must hit an HTTPS target:

```js
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
```

### 3. External Vercel hosts return `403 Host not allowed`

```
curl -sI https://chess-academy-pro.vercel.app/
HTTP/2 403
x-deny-reason: host_not_allowed
```

The sandbox can't reach prod / preview URLs at all. `cdn.playwright.dev`
hits the same wall.

**Fix:** target the local dev server. Every `audit-*.mjs` script reads
`AUDIT_SMOKE_URL` (defaults to prod when unset). Set it to
`http://localhost:5173` and Vite serves the build.

`playwright.config.ts` uses `baseURL: http://localhost:5173` and
`reuseExistingServer: !process.env.CI` — Playwright won't fight a
manually started Vite.

If Vite crashes mid-run (hot-reload churn, OOM), Playwright errors
`ERR_CONNECTION_REFUSED`. Restart with `npm run dev > /tmp/vite.log 2>&1 &`.

### 4. Cold-start timeouts on `/openings` and other DB-heavy routes

First hit triggers `seedDatabase()` loading 3,641 ECO entries + 15K
puzzles. The 30s Playwright default isn't enough.

**Fix:** bump timeouts and hit `/` first so seeding starts before you
navigate to the heavy surface.

```ts
test.describe('your suite', () => {
  test.setTimeout(240_000);   // 4 minutes total
  test('full e2e', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    await page.goto('/openings');
    await page.waitForSelector('[data-testid="opening-explorer"]', { timeout: 120_000 });
    // ...
  });
});
```

Subsequent tests in the same context are sub-second — Dexie keeps the
seed.

---

## Voice intercept — proving silence on a surface

Pattern for "this surface must never speak" contracts (e.g.
drill-silence, kid sandbox before tutor):

```ts
import { test, expect } from '@playwright/test';

test('your surface stays silent', async ({ page }) => {
  // MUST register before page.goto — early speak calls fire fast.
  await page.addInitScript(() => {
    // @ts-expect-error — page context
    window.__audit_speak_calls = [];
    const ss = window.speechSynthesis;
    if (ss) {
      ss.speak = (u) => {
        // @ts-expect-error
        window.__audit_speak_calls.push({
          t: Date.now(),
          text: u?.text ?? '<no-text>',
          location: location.pathname,
        });
        // Don't actually speak — keeps timing deterministic.
      };
    }
  });

  // ... drive the surface ...

  const speakCalls = await page.evaluate(() => {
    // @ts-expect-error
    return window.__audit_speak_calls || [];
  });

  // Filter to ONLY the surface under test — global init paths
  // (boot warmup, nav hooks) can fire from anywhere.
  const onTarget = speakCalls.filter((c) => c.location.includes('/your/surface'));
  expect(onTarget, `speak fired on /your/surface: ${JSON.stringify(onTarget)}`).toEqual([]);
});
```

**Gotchas:**

- `addInitScript` MUST run before `page.goto()`. Register right after
  `const page = await ctx.newPage()`.
- Always filter by `location.pathname` at assert time — don't trust
  an empty array; voice can fire from boot warmup or nav hooks.
- Headless Chromium has `speechSynthesis` but no audio engine, so
  calls succeed silently. The intercept still catches them.
- If Polly cloud voice is enabled, voice goes through `fetch` not
  `speechSynthesis`. For Polly intercept also
  `page.route('**/polly/**', route => route.fulfill({ status: 200, body: '' }))`
  and assert no requests captured. Local dev with fake keys 401s
  Polly, so the speechSynthesis path is sufficient there.

---

## `/api/audit-stream` runtime endpoint (different thing)

This is the live-events stream from a deployed Vercel build — NOT
the voice intercept above. It pulls events the running app pushed via
`logAppAudit()` so Claude can debug a reproducible runtime issue.

**Sandbox limitation:** can't `curl` prod from inside this container
— same `HTTP 403 Host not allowed`. The workflow per
`/root/.claude/CLAUDE.md`: hand the curl to the user and have them
paste back the JSON.

```bash
# Loads AUDIT_STREAM_SECRET + AUDIT_STREAM_PROD_URL (chmod 600,
# NOT in memory file).
set -a && . /root/.claude/secrets/chess-academy-pro.env && set +a

SINCE=$(($(date +%s%3N) - 600000))  # last 10 min
curl -s "$AUDIT_STREAM_PROD_URL/api/audit-stream?since=$SINCE" \
  -H "x-audit-secret: $AUDIT_STREAM_SECRET" | jq '.[]'
```

The secret is also hardcoded as a fallback in most `audit-*.mjs`
files (search for `AUDIT_STREAM_SECRET ??`) so the scripts work
even without the secrets file.

**Common failure modes:**

- `/root/.claude/secrets/chess-academy-pro.env` doesn't exist — fresh
  sandbox; ask David for the values.
- `error: "server misconfigured: AUDIT_STREAM_SECRET not set"` — a
  Preview deploy got aliased to the prod URL (Preview env lacks the
  secret). Re-alias the most recent Production deploy:
  ```bash
  npx vercel ls   # find most recent Environment=Production row
  npx vercel alias <that-url> chess-academy-pro.vercel.app
  ```
- Empty array — app isn't open in a browser. Normal. Just report
  "no events since `<ts>`" and move on.

---

## Network allowlist — known good vs known blocked

Probed 2026-05-15. Add to this list as you discover new ones.

| Host | Status | Use |
|---|---|---|
| `registry.npmjs.org` | ✅ | npm install |
| `github.com` | ✅ | gh CLI, raw git clone |
| `archive.ubuntu.com` | ✅ | apt — but Ubuntu 24.04 dropped chromium → snap-only stub, useless |
| `cdn.playwright.dev` | ❌ 403 | Playwright browser CDN |
| `playwright.azureedge.net` | ❌ 403 | Playwright legacy CDN |
| `edgedl.me.gvt1.com` | ❌ 403 | Chrome auto-update CDN |
| `chess-academy-pro.vercel.app` | ❌ 403 | prod app |
| `vercel.com` | ❌ 403 | Vercel dashboard / API |
