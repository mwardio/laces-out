# Dakoota-to-Mini remote-validation installation manifest

Last reconciled: 2026-08-15 (America/Chicago)

This is a retroactive manifest. Mini-side setup was complete before this file was requested. Facts
below are classified as either **proven setup work**, **observed current state**, or **uncertain**.
An observed setting is not described as a setup change unless the pre-install value or earlier setup
output proves that attribution. Unknown baselines are written as `previous value unknown`.

The Laces Out worktree was dirty before this integration began. No reset, clean, stash, replacement,
or commit is part of this installation. Existing unrelated tracked and untracked work must remain
untouched.

## Installation status and evidence

- Controller: `dakoota`, user `mack`, repository `/home/mack/projects/laces-out`.
- Worker: `MackMini.local`, account `laces-worker`, observed macOS/Darwin on ARM64.
- Evidence used for reconstruction: current conversation history, pre-change `git status`, current
  `git diff`/file metadata, `ssh -G laces-mini`, SSH public-key fingerprints, and a post-install SSH
  inventory performed as `laces-worker` on 2026-08-15. All Mini inventory probes were read-only
  except the explicitly documented Homebrew cache side effect below.
- No setup commit exists and none should be created without explicit operator instruction.
- ARM64 results must be labeled **Darwin/ARM64**. They are not proof of x86-64 Linux compatibility.

## Repository resources

The following files are setup-owned. For a new file, the exact added section is the entire file.

| File                                         | Status                                                | Exact setup-owned section                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/remote-validation`                  | Added, untracked                                      | Entire file. Controller CLI with `doctor`, `run --`, `logs`, `artifacts`, and `cleanup` dispatch plus snapshot, transfer, result retrieval, and safety functions.          |
| `scripts/remote-validation-worker.sh`        | Added, untracked                                      | Entire file. Mini-side per-job helper streamed over SSH for verified allocation, execution, result bundling, and cleanup. It is not installed persistently on the Mini.    |
| `scripts/remote-validation-artifacts.txt`    | Added, untracked                                      | Entire file. Literal configured artifact paths: `coverage`, `playwright-report`, and `test-results`.                                                                       |
| `docs/remote-validation-install-manifest.md` | Added, untracked                                      | Entire file. This manifest.                                                                                                                                                |
| `package.json`                               | Modified                                              | The five scripts shown below: `test:mini`, `build:mini`, `check:mini`, `remote:doctor`, `remote:mini`; existing `build` remains the sequential basis used by `build:mini`. |
| `AGENTS.md`                                  | Added, untracked                                      | Entire file. Exact guidance is reproduced below.                                                                                                                           |
| `.gitignore`                                 | Existing file, not modified at initial reconstruction | No setup-owned section yet. Maintain its exact ignore lines below if added.                                                                                                |
| `vitest.config.ts`                           | Modified                                              | Adds the `isMiniRemoteValidation` platform guard and conditional `maxWorkers: 2` shown below.                                                                              |
| `apps/web/next.config.ts`                    | Modified                                              | Adds the `isMiniRemoteValidation` platform guard and conditional Next `experimental.cpus: 2` shown below.                                                                  |

Current setup-owned repository file metadata:

| File                                      | Mode/owner       | SHA256                                                             |
| ----------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `scripts/remote-validation`               | `0755 mack:mack` | `81f578e286f9fef451fc7845b8f5d7b21ca76ed5a348d365de46b57179f59b45` |
| `scripts/remote-validation-worker.sh`     | `0755 mack:mack` | `995deb9f9744e7a4c924a9dda425b1c61cc1f60159bb2e313ff65561fc54a031` |
| `scripts/remote-validation-artifacts.txt` | `0644 mack:mack` | `2071a092ac513f42084482bd86c09dfe2709d3c5d9c16ffb8a32fa8e3056de78` |
| `AGENTS.md`                               | `0644 mack:mack` | `b1ecfd4fc9f12a3ab7049a34b972f11cfc7779109c595bd265d620010e5def79` |

Verify current metadata and refresh this table after a setup-owned file changes:

```bash
stat -c '%A %a %U:%G %s %y %n' scripts/remote-validation \
  scripts/remote-validation-worker.sh scripts/remote-validation-artifacts.txt AGENTS.md
sha256sum scripts/remote-validation scripts/remote-validation-worker.sh \
  scripts/remote-validation-artifacts.txt AGENTS.md
```

### Package scripts

Exact setup-owned entries in `package.json`:

```json
"test:mini": "vitest run --maxWorkers=2",
"build:mini": "LACES_REMOTE_PLATFORM=darwin-arm64 GOMAXPROCS=2 NODE_OPTIONS=--max-old-space-size=3072 npm run build",
"check:mini": "npm run format:check && npm run lint && npm run typecheck && npm run test:mini && npm run build:mini",
"remote:doctor": "./scripts/remote-validation doctor",
"remote:mini": "./scripts/remote-validation run --"
```

The pre-existing root `build` script runs API, worker, ESPN bridge, and web builds sequentially.
`build:mini` retains that sequencing, caps the V8 heap at 3 GiB per Node process, asks Go-based build
tools to use two CPUs, and activates the conditional two-CPU Next build setting.

### `AGENTS.md` section

Exact file (the entire file is setup-owned):

```markdown
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
```

### `.gitignore` section

No setup-owned `.gitignore` lines had been added when the retroactive reconstruction began. Runtime
controller state is designed for `/home/mack/.local/state/laces-out/remote-validation`, outside the
repository, so an ignore entry may not be needed.

### Conservative Mini concurrency sections

Exact `vitest.config.ts` additions:

```ts
const isMiniRemoteValidation = process.env.LACES_REMOTE_PLATFORM === "darwin-arm64";
// Inside test:
...(isMiniRemoteValidation ? { maxWorkers: 2 } : {}),
```

Exact `apps/web/next.config.ts` additions:

```ts
const isMiniRemoteValidation = process.env.LACES_REMOTE_PLATFORM === "darwin-arm64";
// Inside nextConfig:
...(isMiniRemoteValidation ? { experimental: { cpus: 2 } } : {}),
```

The Mini has 8 GiB RAM. Two test workers and two Next build CPUs were chosen instead of mapping all
eight M1 cores, while the root build already serializes its four workspace builds.

### Snapshot and cleanup invariants implemented by the CLI

- The source manifest is built from `git ls-files --cached --others --exclude-standard`, so it sees
  tracked files and relevant non-ignored untracked files from the current working tree.
- Tracked deletions remain deleted in the snapshot.
- `.git`, `node_modules`, dotenv files, credential/key files, browser data, caches, reports, logs,
  build output, `.ds-sync`, `ds-bundle`, and `.draft-copilot-secrets` are excluded.
- Symlinks, non-regular files, unsafe paths, and individual files over 100 MiB are rejected.
- Transfer uses a compressed tar snapshot plus `scp`; the implementation never uses `rsync` and
  therefore never uses `rsync --delete`.
- Each job ID is unique and each remote job must canonicalize beneath
  `/Users/laces-worker/laces-worker/jobs` before use or cleanup.
- `npm ci` uses the persistent `/Users/laces-worker/laces-worker/npm-cache`; dependencies and build
  output otherwise remain inside the disposable job snapshot.
- Local retrieved state is under `/home/mack/.local/state/laces-out/remote-validation/jobs/<job-id>`.
- Remote cleanup validates the exact job path and removes only that job. Local retrieved logs and
  artifacts are retained.

### Repository verification

Run from `/home/mack/projects/laces-out`:

```bash
git status --short --branch
git diff -- package.json .gitignore vitest.config.ts apps/web/next.config.ts AGENTS.md \
  docs/remote-validation-install-manifest.md
git diff --no-index /dev/null scripts/remote-validation
git diff --no-index /dev/null scripts/remote-validation-worker.sh
git diff --no-index /dev/null scripts/remote-validation-artifacts.txt
bash -n scripts/remote-validation scripts/remote-validation-worker.sh
```

## Dakoota SSH resources

### Dedicated client key

**Proven setup work:** both target paths were checked and observed absent before creation. The key was
created without overwriting any existing path. The private key is intentionally not reproduced here.

| Resource                                 | Current mode/owner | Previous value        |
| ---------------------------------------- | ------------------ | --------------------- |
| `/home/mack/.ssh`                        | `0700 mack:mack`   | previous mode unknown |
| `/home/mack/.ssh/laces_mini_ed25519`     | `0600 mack:mack`   | absent                |
| `/home/mack/.ssh/laces_mini_ed25519.pub` | `0644 mack:mack`   | absent                |

Public key:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVeS+kaqgV9foOK+ee6JYiXZom2car368OcU9DZkRD8 mack@dakoota laces-out mini validation
```

Public-key fingerprint:

```text
SHA256:W1b6RGowvE7rh7WSk1Twx9L4t/sin1YK7YJNRDZ5Xw0
```

Verify:

```bash
stat -c '%A %a %U:%G %n' /home/mack/.ssh \
  /home/mack/.ssh/laces_mini_ed25519 \
  /home/mack/.ssh/laces_mini_ed25519.pub
ssh-keygen -E sha256 -lf /home/mack/.ssh/laces_mini_ed25519.pub
```

### SSH host alias

**Proven setup work:** `/home/mack/.ssh/config` and
`/home/mack/.ssh/laces_mini_known_hosts` were observed absent before creation. Both are currently
`0600 mack:mack`.

Dakoota did not resolve mDNS during setup. The current address `192.168.68.63` was identified from
active local neighbors and accepted only after its Ed25519 key matched the operator-supplied
fingerprint. The logical Mini hostname remains `MackMini.local`; DHCP address history and prior
values are unknown.

Exact `/home/mack/.ssh/config` section:

```sshconfig
# MackMini.local; Dakoota does not currently resolve mDNS, so this address was
# identified and verified against the operator-supplied Ed25519 fingerprint.
Host laces-mini
    HostName 192.168.68.63
    User laces-worker
    IdentityFile /home/mack/.ssh/laces_mini_ed25519
    IdentitiesOnly yes
    HostKeyAlias laces-mini
    UserKnownHostsFile /home/mack/.ssh/laces_mini_known_hosts
    StrictHostKeyChecking yes
    HostKeyAlgorithms ssh-ed25519
    BatchMode yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ConnectTimeout 10
```

Exact `/home/mack/.ssh/laces_mini_known_hosts` entry:

```text
laces-mini ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ1yvMBkoKJfz7fOI0xZqCAVH/x/NJVOd2kWu11+YZEO
```

Pinned Mini host-key fingerprint:

```text
SHA256:5rIKJRpEtSay/T3F44u9Mhg3KS6RgNyDj0Kfg6uGaIw
```

Verify without weakening host-key checking:

```bash
ssh -G laces-mini | awk '$1 ~ /^(hostname|user|identityfile|identitiesonly|hostkeyalias|userknownhostsfile|stricthostkeychecking|hostkeyalgorithms)$/ {print}'
ssh-keygen -E sha256 -lf /home/mack/.ssh/laces_mini_known_hosts
ssh laces-mini /usr/local/bin/laces-worker doctor
```

## Mini post-install inventory

Unless a row explicitly says **proven setup work**, it is only **observed current state**. Previous
values are unknown because no pre-install Mini inventory or Mini Codex transcript was available in
this conversation.

### Host and worker account

| Item             | Observed current state                                          | Attribution / previous value                                                               |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Hostname         | `MackMini.local`                                                | previous value unknown; not proven changed by setup                                        |
| OS               | `macOS 26.5.2 (25F84)` from the already-completed worker doctor | previous value unknown; not setup-installed                                                |
| Architecture     | `arm64`                                                         | hardware fact; not a setup change                                                          |
| Physical memory  | 8,589,934,592 bytes (8 GiB)                                     | hardware fact; not a setup change                                                          |
| Account          | `laces-worker`, UID `502`, primary GID `20` (`staff`)           | previous value unknown; account is setup-specific but pre-install absence was not observed |
| Home             | `/Users/laces-worker`, mode `0755`, owner `laces-worker:staff`  | previous value unknown                                                                     |
| Shell            | `/bin/zsh`                                                      | previous value unknown                                                                     |
| SSH access group | member of `com.apple.access_ssh` (GID `399`)                    | previous value unknown                                                                     |

The account, home, SSH directory, authorized key, worker root, root subdirectories, and worker command
all report birth epoch `1786814940` (`2026-08-15T17:29:00Z`). This strongly groups them as one setup
event, but it does not prove each prior value was absent.

Verify:

```bash
ssh laces-mini 'id; dscl . -read /Users/laces-worker RecordName UniqueID PrimaryGroupID NFSHomeDirectory UserShell'
ssh laces-mini 'stat -f "%Sp %Su:%Sg %z %B %m %N" /Users/laces-worker'
```

### Mini `authorized_keys`

**Observed current setup-specific state:** `/Users/laces-worker/.ssh` is `0700`; `authorized_keys` is
`0600`, owned by `laces-worker:staff`, and line 1 exactly matches Dakoota's dedicated public key:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVeS+kaqgV9foOK+ee6JYiXZom2car368OcU9DZkRD8 mack@dakoota laces-out mini validation
```

Previous entry/file value: `previous value unknown`.

Verify only the matching entry without printing unrelated keys:

```bash
ssh laces-mini 'awk '\''$2 == "AAAAC3NzaC1lZDI1NTE5AAAAIGVeS+kaqgV9foOK+ee6JYiXZom2car368OcU9DZkRD8" { print NR ":" $0 }'\'' ~/.ssh/authorized_keys'
```

### Worker command

**Observed current setup-specific state:** `/usr/local/bin/laces-worker` is a root-owned executable
Node script, mode `0755`, 985 bytes, SHA256
`6b4b6aec7276d752238534acd8d5d8ad96913e35133713d5534a13fb5a4cd32e`.
Previous file value: `previous value unknown`.

It implements one command:

```text
/usr/local/bin/laces-worker doctor
```

The command reports hostname, user, macOS version/build, ARM architecture, Node version, available
memory/disk, and the pinned worker root. Any other arguments exit with usage status `64`.

Verify:

```bash
ssh laces-mini 'stat -f "%Sp %Su:%Sg %z %B %m %N" /usr/local/bin/laces-worker; shasum -a 256 /usr/local/bin/laces-worker'
ssh laces-mini /usr/local/bin/laces-worker doctor
```

### Worker root, jobs, cache, logs, and artifacts

**Observed current setup-specific state:** all directories below were empty at post-install inventory
and had mode `0700`, owner `laces-worker:staff`, birth epoch `1786814940`. Prior values are unknown.

| Directory                                    | Purpose                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/Users/laces-worker/laces-worker`           | Verified persistent worker root                                                                    |
| `/Users/laces-worker/laces-worker/bin`       | Reserved worker-local commands; observed empty                                                     |
| `/Users/laces-worker/laces-worker/jobs`      | Parent for unique disposable validation jobs                                                       |
| `/Users/laces-worker/laces-worker/logs`      | Persistent top-level log directory; observed empty; per-run CLI logs live under each job           |
| `/Users/laces-worker/laces-worker/artifacts` | Persistent top-level artifact directory; observed empty; per-run CLI artifacts live under each job |
| `/Users/laces-worker/laces-worker/npm-cache` | Persistent npm download cache                                                                      |

`/Users/laces-worker/laces-worker/cache` was absent. The repository controller creates only individual
job directories beneath `jobs` and uses `npm-cache`; it does not write the top-level `logs` or
`artifacts` directories.

Each controller-created job has this shape:

```text
jobs/<job-id>/
  control/
  source/
  logs/
  metadata.env
  result.env
  artifacts.tar.gz
  results.tar.gz
```

Verify without traversing dependency caches:

```bash
ssh laces-mini 'find /Users/laces-worker/laces-worker -mindepth 1 -maxdepth 2 -type d -print | sort'
ssh laces-mini 'for p in /Users/laces-worker/laces-worker/{jobs,logs,artifacts,npm-cache}; do stat -f "%Sp %Su:%Sg %z %B %m %N" "$p"; done'
```

### Services and running processes

**Observed current state:** no LaunchAgent or LaunchDaemon with `laces` in its filename or loaded
label was found. No persistent `laces-worker` worker process was found; only ordinary per-user macOS
agents and the active SSH inventory session were visible. The validation design is on-demand over
SSH and does not require a persistent worker service.

Previous service/process state: `previous value unknown`.

Verify:

```bash
ssh laces-mini 'launchctl list 2>/dev/null | grep -i laces || true'
ssh laces-mini 'find ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons -maxdepth 1 -iname "*laces*" -print 2>/dev/null'
ssh laces-mini 'ps ax -o pid=,user=,command= | grep -i "[l]aces-worker" || true'
```

### Runtime and tools

| Tool                 | Observed location/version                                          | Setup attribution                                                          |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Node                 | `/opt/homebrew/opt/node@22/bin/node`, `v22.23.2`                   | Installation predates worker resources; not proven exclusive to this setup |
| npm                  | `/opt/homebrew/opt/node@22/bin/npm`, `10.9.8`                      | Bundled with observed Node; not proven exclusive                           |
| Homebrew Node cellar | `/opt/homebrew/Cellar/node@22`, birth `2026-07-31T02:14:24Z`       | Predates 2026-08-15 worker setup                                           |
| Git                  | `/usr/bin/git`, Apple Git `2.50.1 (Apple Git-155)`                 | macOS tool; not setup-exclusive                                            |
| tar                  | `/usr/bin/tar`, bsdtar `3.5.3` / libarchive `3.7.4`                | macOS tool; not setup-exclusive                                            |
| SSH/scp              | `/usr/bin/ssh`, `/usr/bin/scp`, OpenSSH `10.2p1`, LibreSSL `3.3.6` | macOS tools; not setup-exclusive                                           |
| rsync                | `/usr/bin/rsync`                                                   | Present but deliberately unused by this integration                        |

No package can be proven to have been installed exclusively for this setup from available evidence.
The custom `/usr/local/bin/laces-worker` command is setup-specific, but its previous path value is
unknown.

Safe verification that does not invoke Homebrew:

```bash
ssh laces-mini '/opt/homebrew/opt/node@22/bin/node --version; /opt/homebrew/opt/node@22/bin/npm --version; /usr/bin/git --version; /usr/bin/tar --version | head -1; /usr/bin/ssh -V'
```

### Remote Login

**Observed current state:** Remote Login is enabled. `launchctl print-disabled system` reports
`com.openssh.sshd => enabled`; `system/com.openssh.sshd` has passive SSH listener sockets and is
socket-activated. A successful strictly host-key-checked SSH session independently proves the
listener is usable. `systemsetup -getremotelogin` could not be queried as this non-admin account.

Previous value: `previous value unknown`. Do not claim setup changed Remote Login.

Verify read-only:

```bash
ssh laces-mini '/bin/launchctl print-disabled system | /usr/bin/grep com.openssh.sshd'
ssh laces-mini '/bin/launchctl print system/com.openssh.sshd | /usr/bin/sed -n "1,100p"'
```

### Power and sleep settings

**Observed current AC-power state:** previous values are unknown; no available evidence proves which,
if any, were changed for this setup.

```text
Sleep On Power Button 1
autorestartatconnect 0
standby 0
ttyskeepawake 1
powernap 1
displaysleep 20
womp 1
networkoversleep 0
sleep 0
tcpkeepalive 1
autorestart 1
disksleep 10
SleepDisabled 0
```

At inventory time, `pmset` reported system sleep prevented by `powerd`, `bluetoothd`, ChatGPT, and
Claude. No scheduled power events were reported by `pmset -g sched`.

Verify read-only:

```bash
ssh laces-mini '/usr/bin/pmset -g custom; /usr/bin/pmset -g; /usr/bin/pmset -g sched'
```

### Audit side effect recorded after discovery

The intended read-only inventory ran `/opt/homebrew/bin/brew list --versions node@22`. Homebrew
unexpectedly initialized/refreshed per-user caches at `2026-08-15T17:47:53Z`-`17:47:54Z`:

- Created `/Users/laces-worker/Library/Caches/Homebrew/bootsnap/` with 686 regular cache files.
- Created
  `/Users/laces-worker/Library/Caches/Homebrew/api/internal/packages.arm64_tahoe.jws.json.payload`
  (14,380,209 bytes).
- Refreshed the existing
  `/Users/laces-worker/Library/Caches/Homebrew/api/internal/packages.arm64_tahoe.jws.json`
  (birth epoch predates the audit; modification epoch changed to `1786816074`).
- New regular files attributable by birth time totaled 687 files and 20,211,839 bytes.

This command installed, restarted, or reconfigured no software or service. The caches were not
removed because removal was not authorized and the pre-command cache contents were not fully
inventoried. Previous contents: `previous value unknown`, except for the one API JSON whose earlier
birth epoch proves it already existed.

## Validation jobs

No controller job had been allocated when the retroactive inventory was first recorded. Subsequent
setup-validation jobs are recorded below. Do not record secret command arguments or secret output.

| Job ID                                      | Purpose/result                                                                                                                                                                              | Recorded provenance                                                                                                                                                                                                                 | Local results                                                                                        | Remote cleanup                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `job-20260815T175520Z-2012487-42a70574e8ed` | Source-transfer safety check, **Darwin/ARM64**, exit `0`; verified a relevant untracked source file arrived and `.git`, dotenv files, `.ds-sync`, and `ds-bundle` did not                   | commit `52cdc687c0f2528398d575c121fa115c834ea34d`, `dirty=true`, 860 files, 19,213,880 source bytes; local and Mini SHA256 for `apps/api/src/draft-read.ts` both `608d58d1be1181a2f9cf1eba0889a639fb2a05f6b1cb36695d2b129217fbfe61` | `/home/mack/.local/state/laces-out/remote-validation/jobs/job-20260815T175520Z-2012487-42a70574e8ed` | Completed through the CLI; exact remote job removed, local results retained |
| `job-20260815T175615Z-2015885-ca8dca54bc5c` | Exit-code propagation check, **Darwin/ARM64**; requested command exited `37` and the controller itself returned exactly `37` after retrieving results                                       | commit `52cdc687c0f2528398d575c121fa115c834ea34d`, `dirty=true`, 860 files, 19,214,888 source bytes; metadata records install `0`, command `37`, effective `37`                                                                     | `/home/mack/.local/state/laces-out/remote-validation/jobs/job-20260815T175615Z-2015885-ca8dca54bc5c` | Completed through the CLI; exact remote job removed, local results retained |
| `job-20260815T175721Z-2020086-b157ee6d7e1f` | Focused Vitest check, **Darwin/ARM64**, exit `0`; `packages/league-sync/src/yahoo-sync.test.ts` passed 2/2 tests in one test file through `npm run remote:mini -- npm run test:mini -- ...` | commit `52cdc687c0f2528398d575c121fa115c834ea34d`, `dirty=true`, 860 files, 19,215,380 source bytes; `npm ci` succeeded from the persistent cache and Vitest used the configured maximum of two workers                             | `/home/mack/.local/state/laces-out/remote-validation/jobs/job-20260815T175721Z-2020086-b157ee6d7e1f` | Completed through the CLI; exact remote job removed, local results retained |

The job used `npm ci` successfully with the persistent Mini npm cache, streamed output, retrieved its
result bundle, and the local `logs` and `artifacts` subcommands both returned `0`. The configured
artifact set was empty for this command. The job metadata reports `remote_os=Darwin`,
`remote_architecture=arm64`, Node `v22.23.2`, and command/effective exit status `0`.

After all three exact cleanup operations, the Mini `jobs` directory contained zero job directories;
the verified worker root and `jobs` directory remained mode `0700`. The persistent `npm-cache`
remained mode `0700` and contained 144 MiB of downloads from the three reproducible installs. No
top-level Mini `logs` or `artifacts` data was created; per-job logs/artifacts were retrieved locally
before cleanup.

## Final controller verification

- `npm run remote:doctor` returned `0`, strictly verified the pinned host key, and reported the
  expected hostname, account, worker root, Node `v22.23.2`, and Darwin/ARM64 platform.
- Source transfer, exit-code propagation, focused Vitest, log retrieval, artifact retrieval, and
  exact per-job cleanup passed in that order. `logs` and `artifacts` continued to return `0` from
  retained local results after the remote jobs were removed.
- Loading the Mini-conditional configs locally with `LACES_REMOTE_PLATFORM=darwin-arm64` reported
  `vitestMaxWorkers=2` and `nextBuildCpus=2`.
- `bash -n scripts/remote-validation scripts/remote-validation-worker.sh` passed.
- Prettier checks for all setup-modified JSON, TypeScript, and Markdown files passed.
- `git diff --check` for all setup-owned paths passed.
- `npm run typecheck` passed. Its first run exposed exact-optional-property errors in conditional
  config fields; both were corrected to conditional object spreads before the successful final run.
- `.gitignore` has no setup diff (`git diff --quiet -- .gitignore` returned `0`) because runtime state
  is outside the repository and the snapshot denylist independently excludes generated content.
- The complete `npm run check` was deliberately not run; initial validation remained focused as
  required. No commit, reset, clean, or stash was performed.

## Safe removal order

This is documentation only. Do not perform removal without explicit operator authorization.

1. Stop launching new validations. Record all job IDs from
   `/home/mack/.local/state/laces-out/remote-validation/jobs` and the Mini `jobs` directory.
2. Retrieve any required logs/artifacts, then invoke
   `scripts/remote-validation cleanup <job-id>` for each verified job. Never remove the worker root
   or use a broad recursive target while jobs remain unreviewed.
3. Confirm no `laces-worker` validation/SSH process is active. No setup-specific launchd service is
   currently known; if one appears later, inventory its exact label and plist before unloading it.
4. Remove only the exact matching Dakoota public-key line from
   `/Users/laces-worker/.ssh/authorized_keys`; preserve every unrelated key and the file's safe mode.
5. After verifying exact paths, remove setup-specific Mini resources in narrow order: individual
   job directories, the setup npm cache, the empty top-level `logs`/`artifacts`/`bin` directories,
   `/usr/local/bin/laces-worker`, and finally the now-empty worker root. Account removal is last and
   requires separate administrator approval.
6. Do **not** uninstall Node, npm, Homebrew, Git, tar, SSH, scp, or rsync based on this manifest; none
   is proven exclusive to this setup.
7. Do **not** restore or alter Remote Login, power, or sleep settings from this manifest; their
   previous values are unknown. Establish an independent desired baseline first.
8. In the repository, manually remove only the exact setup-owned sections/files listed above. Do not
   use `git reset`, `git clean`, or commands that affect unrelated dirty work.
9. Remove the `Host laces-mini` stanza and its one dedicated known-hosts entry. If those files contain
   other content by then, preserve it.
10. Remove `/home/mack/.ssh/laces_mini_ed25519` and `.pub` only after Mini authorization is removed
    and no other system uses the key. Preserve all other SSH keys and configuration.
11. The Homebrew cache side effect requires separate review. Do not broadly remove
    `/Users/laces-worker/Library/Caches/Homebrew`; earlier contents were not fully known.

## Uncertainties requiring an earlier Mini transcript or administrator evidence

- Pre-install existence/values for the `laces-worker` account, its home, SSH membership and files,
  authorized key, worker root/subdirectories, and `/usr/local/bin/laces-worker`.
- Whether Node/npm or any other package was deliberately installed for this setup; timestamps show
  Node predates the worker resources.
- Previous Remote Login state.
- Previous power, sleep, wake-on-network, auto-restart, and scheduled-power settings.
- Any administrator-only actions performed during Mini setup that leave no user-readable artifact.
- Whether the current DHCP address `192.168.68.63` will remain stable while Dakoota lacks mDNS.
