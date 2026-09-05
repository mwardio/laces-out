# Laces Out agent notes

Use the M1 Mini for ad hoc Darwin/ARM64 validation when a change may be platform-sensitive or when
local validation would compete with active work on Dakoota. Check it first with
`npm run remote:doctor`, then run a focused command with
`npm run remote:mini -- <command> [arguments...]`.

The remote CLI sends a secret-filtered snapshot of the current dirty working tree, including relevant
uncommitted and untracked files. Only Dakoota edits Laces Out; never edit the disposable Mini copy.
Start with a targeted test, not `npm run check`. Use `npm run test:mini` and `npm run build:mini` for
the Mini's conservative two-worker/two-CPU limits. Retrieve prior output with
`scripts/remote-validation logs <job-id>` or `artifacts <job-id>`, then remove only that verified
remote job with `cleanup <job-id>`.

`npm run audit:seo` is a separate Lighthouse pass, deliberately outside `npm run check`: it builds
the web app, serves the standalone output on a loopback port, and fails when the SEO score drops
below 0.95 or LCP exceeds 2.5 s. It needs a local Chrome or Chromium, so set `CHROME_PATH` when the
launcher cannot find one. Prefer running it on Dakoota; Mini numbers measure Darwin/ARM64 hardware
and its performance score does not transfer.

Always label Mini results Darwin/ARM64. They do not prove x86-64 Linux compatibility.
