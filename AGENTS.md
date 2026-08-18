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

Always label Mini results Darwin/ARM64. They do not prove x86-64 Linux compatibility.
