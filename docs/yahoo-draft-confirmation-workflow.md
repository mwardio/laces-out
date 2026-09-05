# Yahoo draft confirmation workflow

Status: evidence-generation workflow only. It cannot admit a format, edit a release constant, write
to the database, or call Yahoo. Snake and auction remain `shadow-only` until a separate reviewed
change updates the format-specific release policy.

This workflow replaces the need to create two artificial leagues. One ordinary, completed,
authorized draft of a given format can serve as that format's post-freeze holdout if it was selected
before reveal, did not influence the implementation, and has independent final-board evidence.
Snake evidence cannot confirm auction behavior, or vice versa.

## Evidence files

Keep all real evidence outside the repository in a private, access-controlled directory. The raw
Yahoo response, manifest, and exact production configuration contain provider identifiers and may
contain league or player names. Do not commit them, upload them to CI, paste them into tickets, emit
them to shared logs, or retain the raw XML in the production database.

The four protected inputs are:

1. **Independent source capture.** A screenshot, PDF, HTML save, or Yahoo export of the completed
   final board. Capture this first, without viewing or using the Fantasy API `draftresults`
   response. Retain the source file and its SHA-256.
2. **Independent final-board manifest.** A complete transcription of that source using
   [the versioned example](./yahoo-draft-final-board-manifest-v1.example.json). The runtime schema is
   exported as `yahooDraftFinalBoardManifestSchema`. Unknown fields, noncontiguous picks, duplicate
   players, invalid compound Yahoo keys, and format-incompatible prices fail closed.
3. **Raw Yahoo observation.** After the independent source and manifest are frozen, make one
   separately authorized official Fantasy API read of `league/{league_key}/draftresults` and save
   the response body verbatim to a mode-`0600` file. Do not inspect it, normalize it manually, or
   store it through the production application. Record the raw file's SHA-256 immediately.
4. **Frozen confirmation context.** Copy
   [the versioned context example](./yahoo-draft-confirmation-context-v1.example.json) and replace
   every example value. It binds the two evidence hashes, preregistration checksum, clean Git
   revision, evidence timeline, league fingerprint, exact production draft configuration, and exact
   Yahoo-to-internal identity maps.

The checked-in examples are fabricated structural templates, not evidence. Their placeholder Git,
source-capture, and artifact hashes deliberately cannot confirm a real draft.

## Pre-reveal freeze

Do all of the following before inspecting a holdout's API artifact:

1. Identify the future holdout by a SHA-256 fingerprint of its Yahoo league key, format, and season.
   Record `holdoutSelectedAt` without recording a league name in the repository.
2. Finish selection using historical artifacts, malformed fixtures, and the registered property
   suite. A league whose artifact caused a parser, reconciler, configuration, or threshold change is
   selection evidence and cannot later become confirmation evidence.
3. Commit the parser, reconciler, confirmation harness, preregistration, and thresholds. Record the
   clean 40-character Git revision and the exact preregistration SHA-256 as the implementation
   freeze.
4. Do not change any frozen input before evaluation. The command refuses a dirty checkout or a Git
   revision/checksum mismatch. A necessary code change starts a new protocol version and requires a
   new unrevealed holdout.

## Independent board capture

After Yahoo reports the draft complete, capture the Yahoo final board before retrieving the API
artifact. Build the manifest only from that retained source:

- Record every overall pick, round, Yahoo team key, and Yahoo player key in order.
- Snake entries require `"cost": null`.
- Auction entries require the exact integer winning cost shown by Yahoo.
- Confirm from the independent Yahoo board/settings that there were no keepers, traded picks, or
  third-round reversal. If that cannot be established, this v1 scope cannot use the draft.
- Use Yahoo identifiers visible in the independently retained page/export. Do not fill missing
  identifiers from the API artifact; that would make the comparison tautological. If the
  independent source cannot establish exact identities, choose another holdout or define a new
  preregistered identity protocol.
- Hash the source capture and the completed manifest. Put the source hash and exact capture method
  in the manifest; put the exact manifest-file hash in the confirmation context.

The harness verifies the manifest's structure, hashes, identity, chronology, and exact agreement
with the API artifact. It cannot prove that a human transcription really came from the retained
source, so the literal independence and scope attestations are operator-controlled evidence and
must be reviewed alongside the source capture.

## Raw observation and context

Retrieve the raw XML only after freezing the independent manifest. Use the approved Yahoo
application and the existing official read path in a separately reviewed, one-time operator
session. Write the response directly to protected local storage; do not route it through application
logging or add a raw-payload column. Then record:

```bash
chmod 600 /protected/yahoo-final-board.png /protected/yahoo-final-board.json \
  /protected/yahoo-draftresults.xml
sha256sum /protected/yahoo-final-board.png /protected/yahoo-final-board.json \
  /protected/yahoo-draftresults.xml
sha256sum docs/yahoo-draft-polling-preregistration-v1.json
git rev-parse HEAD
git status --porcelain
```

`git status --porcelain` must be empty. Keep protected inputs outside the checkout so they do not
make the frozen worktree dirty.

Populate the context with:

- the manifest and raw XML hashes exactly as stored;
- the same format, season, and league-key SHA-256 as the manifest;
- timestamps ordered as holdout selection → implementation freeze → independent manifest capture →
  raw artifact capture → evidence freeze → evaluation;
- the exact production draft configuration, including full standard snake pick order or auction
  budgets and minimum bid;
- a one-to-one mapping for every configured team and every drafted player; and
- literal attestations that the configuration came through the frozen production path and the
  identity mappings existed independently of the final API artifact.

Set the completed context file to mode `0600` before running the evaluator.

For snake, the harness rejects unequal roster lengths, incomplete pick orders, traded/custom order,
and third-round reversal. For auction, the production reducer enforces roster legality, minimum bid,
and team budgets at every prefix. Both formats require a completed collection that fills every
configured roster slot and includes every team.

## Run the offline confirmation

From the clean frozen checkout:

```bash
npm run yahoo:draft-confirmation -w @laces-out/api -- \
  --source=/protected/yahoo-final-board.png \
  --manifest=/protected/yahoo-final-board.json \
  --context=/protected/yahoo-confirmation-context.json \
  --artifact=/protected/yahoo-draftresults.xml
```

The command:

- reads only the four named local files, the checked-in preregistration, and local Git metadata;
- has no network client, database import, credentials, or persistence path;
- verifies that the retained source capture matches the SHA-256 declared by the independent
  manifest without interpreting or emitting its contents;
- validates all JSON with closed, versioned schemas and parses raw XML with the production Yahoo
  parser;
- compares every final-board pick, round, team, player, and format-specific cost exactly;
- feeds prefixes zero through the complete board through `reconcileYahooDraftSnapshot` using the
  frozen production configuration and mappings;
- requires each newly extended prefix to append exactly one event, then requires an identical replay
  of that prefix to be idempotent;
- runs the completed event ledger through the production draft reducer; and
- emits only hashes, counts, format, timestamps, and a bounded verdict—never league, team, or player
  identities.

Any parsing, hash, chronology, identity, format, board-agreement, scope, reducer, or prefix failure
returns a bounded `failed-closed` result and a nonzero exit. A successful result says only
`eligible-for-manual-release-review`, with `releaseAdmission: false`, `releaseStateChanged: false`,
and `manualReviewRequired: true`.

## Review and retention

Run the focused suites at the frozen revision:

```bash
npx vitest run \
  packages/connector-yahoo/src/draft-xml.test.ts \
  apps/api/src/yahoo-draft-reconciler.test.ts \
  apps/api/src/yahoo-draft-confirmation.test.ts
```

Review the protected source capture, manifest, context, raw artifact, CLI result, property-test
count, and all registered forbidden mutations. Preserve their hashes in a sanitized review record.
Do not publish the protected inputs.

A passing review still does not change product behavior. Admission requires an explicit later code
review that changes only the passing format from `shadow-only` to `append-beta`, cites the sanitized
evidence checksums, and reruns the complete release checks. If either format fails, keep its Yahoo
observations in shadow mode and record the exact blocker without changing the gate.
