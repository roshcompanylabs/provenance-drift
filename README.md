# provenance-drift

Does an npm provenance attestation name a commit whose tree actually contains the version
that was published?

For 22 of the 95 packages this could check, no. And which trigger fired the publishing
workflow predicts it almost perfectly.

Measured twice, a week apart. All 22 were still wrong a week later, and the eight that
published a new version in between reproduced it exactly. The second table is committed beside
the first.

```
  packages in frame                     298
    no provenance attestation           196
    manifest did not belong to the pkg    5   (rejected, see below)
    provenance, but tree unreadable       2
    provenance, tree read                95

      attested tree HAS the version      69   <- the control
      attested tree has a 0.0.0-* stub    4   (semantic-release, by design)
      attested tree has ANOTHER version  22   = 23.2% of those read
```

Split by the event that triggered the publishing workflow:

```
  GITHUB_SHA is the commit being published      (release, push)
       0 wrong out of 67

  GITHUB_SHA is the default branch tip, or the
  tip of whatever ref was dispatched            (workflow_dispatch, schedule, workflow_run)
      22 wrong out of 28     = 79%
```

**`workflow_run` moved groups after this was first published**, and it is worth saying why
rather than quietly re-grouping it. The first version of this table put it with `release` and
`push` because the one `workflow_run` row in the frame is clean. That was reading n=1 as a
mechanism. GitHub documents `workflow_run`'s `GITHUB_SHA` as "Last commit on default branch" —
the same words, exactly, that it uses for `schedule`. `release` is "Last commit in the tagged
release" and `push` is the tip commit pushed; those two are the group that can be right by
construction, and `workflow_run` is not one of them. The grouping follows the documented
semantics, not the observed outcome, because grouping by outcome is what produced the error.
The numbers as first published were 0 of 68 and 22 of 27.

**And the obvious piece of evidence for that does not survive this repo's own control, so it is
not offered as one.** `@typescript-eslint/parser@8.71.3-alpha.4`, published 2026-10-13 on the
`canary` tag, is a `workflow_run` publish off `refs/heads/main` attesting commit `61372369`
whose `packages/parser/package.json` holds 8.71.2 — which looks like the defect on that
trigger. But 8.71.3-alpha.4 was never committed or tagged: all four tag spellings `attack.cjs`
tries return 404, and GitHub's matching-refs API has no `tags/v8.71.3` at all. The canary job
applies the version in-tree at build time and publishes without writing to the repository. So
there was never a commit holding that version, the attestation had nothing better to name, and
this is the case the control section below exists to reject — `attack.cjs` would print
`NO TAG FOUND` and refuse it. It belongs here as what it is: an illustration of where a
`workflow_run` build's `GITHUB_SHA` points, not an instance of the thing being counted.

## Measured again a week later

A single run cannot say whether this is a snapshot nobody has released past or a property
of the pipeline that repeats. So two runs are committed — `rows.json` (7 October) and
`rows-2026-10-14.json` (14 October) — and `node drift.cjs` compares them from those two
files and nothing else. No network.

In the seven days between them, **all 22 were still wrong**, and none left the set. Eight of
them published a new version, and all eight new releases are wrong the same way: each attests
the version immediately before itself, off a new build commit, on the same trigger.

```
  @typescript-eslint/*   7 packages   8.71.1 -> 8.71.2   attesting 8.71.1
                                      e8593b2b -> d28bd0a7       schedule
  node-releases                       2.0.57 -> 2.0.58   attesting 2.0.57
                                      8f447097 -> d29b26aa       schedule
```

The other 14 are the `@babel/*` train, which did not release that week: same version, same
attested commit, unchanged.

**Which is the limit of what a week can show.** This reads the `latest` dist-tag, so it sees a
pipeline only when that pipeline publishes. For those 14 the window is silent by construction:
Babel's 8.0.7 releases landed on 7 October between 09:59Z and 10:00Z, ten hours before the
first run recorded them, and none of the 14 has published anything since — so a project that fixed its workflow that afternoon and a
project that did nothing look identical here. **The observable subset is the eight that
published, and eight of eight reproduced the defect.** "Nobody has fixed this" is not what this
measures; "nobody who published in the window published a corrected one" is.

Three packages had an unattested version at `latest` in the first run and an attested one in
the second. `drift.cjs` prints the three; which of them is actually new to provenance takes a
registry read it does not make, so here it is:

```
  fast-uri             4.2.1 -> 4.2.2   workflow_dispatch   tree has 4.2.1
      no version of fast-uri had ever carried an attestation before 4.2.2 (2026-10-10)

  express              5.2.1 -> 5.3.0   release             tree HAS the version
      but 4.22.3 (2026-09-14) already carried one: release, refs/tags/v4.22.3,
      commit 899b5249, whose tree holds 4.22.3

  why-is-node-running  3.2.2 -> 3.2.3   release             tree HAS the version
      but 3.2.0 (2024-07-12) and 3.2.1 (2024-10-29) already carried ones: release,
      refs/tags/v3.2.x, both attested trees holding the published version. Only
      3.2.2, which happened to be `latest` on 7 October, has none
```

So **the out-of-sample part is one package, not three.** `fast-uri`'s first attestation of any
kind is on `workflow_dispatch` and names a commit whose tree holds 4.2.1 — the side the split
predicts. The other two produced new attestation *records*, but their release-trigger
behaviour was already readable on the registry before the split was published, so they
corroborate it rather than test it. One point is one point.

Totals moved from 22 of 95 to 23 of 98, and the split from 0-of-67 / 22-of-28 to
0-of-69 / 23-of-29. The tag control was re-run on the second table as well:
`node attack.cjs --rows=rows-2026-10-14.json` reports **23 of 23**.

## Run it

These two read the committed tables and nothing else, so they need no network:

```bash
node drift.cjs              # the two recorded runs, compared
node measure.cjs --report   # re-print a recorded table
```

The control does need it, and refuses rather than concluding without it. It reads release tags
from `raw.githubusercontent.com` and has no cache, so an unreachable tag looks exactly like a
tag that was never pushed — which is the evidence it exists to look for. Run offline it would
report that none of the mismatches has a correct commit, the opposite of the finding, so a
request that fails for any reason other than a 404 stops the run and nothing is written:

```bash
node attack.cjs                               # the 7 October table
node attack.cjs --rows=rows-2026-10-14.json   # the 14 October table
```

To re-measure. A run reads the registry as it is today, which is a third measurement rather
than a reproduction of either recorded one, so it is recorded under its own name:

```bash
rm -rf cache/                        # the packument cache key is the bare package name, so
                                     # a warm cache replays the previous latest and
                                     # reproduces the previous table
node measure.cjs --out=rows-$(date +%F).json
node drift.cjs rows-2026-10-14.json rows-$(date +%F).json
```

The date in the filename is the date the run gets recorded under — `measure.cjs` reads it off
the name — so it has to be the day you ran it. It says so if the two disagree, and it refuses
to record a table that is byte-identical to one already recorded, which is what a warm
`cache/` produces.

`runs.json` holds the date, row count and sha256 of each recorded table, and `measure.cjs`
adds the table it just wrote to it. The three things that record buys:

- `measure.cjs` refuses to write over a recorded table. Without that, a plain
  `node measure.cjs` would replace the 7 October one.
- `drift.cjs` refuses to compare a recorded table whose bytes have changed, instead of
  printing today against 14 October under a column header saying 7 October.
- `drift.cjs` refuses a pair in the wrong order, because every label it prints — entered,
  left, published a new version in between — inverts when the arguments do, and both hashes
  would still verify. Where a table is not in `runs.json` it takes the date from the filename.

Node 18+. **No credentials, no tokens, no install.** Everything comes from the public npm
registry and `raw.githubusercontent.com`. A clean clone re-prints both recorded tables and the
comparison between them with no network at all. The control needs it, and so does a new
measurement — which produces a third table rather than a copy of either of these two, because
it reads the registry as it is on the day it runs.

## What it does

For each package at its `latest` version:

1. `GET registry.npmjs.org/-/npm/v1/attestations/<pkg>@<version>`
2. base64-decode the `slsa.dev/provenance/v1` DSSE payload and read
   `buildDefinition.resolvedDependencies[0].digest.gitCommit` (the attested commit) and
   `internalParameters.github.event_name` (the trigger)
3. `GET registry.npmjs.org/<pkg>/<version>` for `repository.directory`, which is how
   monorepo packages declare their subdirectory
4. read that `package.json` **at the attested commit** from raw.githubusercontent
5. compare its `version` with the one that was published

One by hand, if you prefer:

```bash
curl -s https://registry.npmjs.org/-/npm/v1/attestations/@babel/types@8.0.6
#   gitCommit  = 68b6a2ab39696752e008ef9a186f444d6f80c262
#   event_name = workflow_dispatch

curl -s https://raw.githubusercontent.com/babel/babel/68b6a2ab39696752e008ef9a186f444d6f80c262/packages/babel-types/package.json
#   "version": "8.0.5"        ... 8.0.6 was published

curl -s https://raw.githubusercontent.com/babel/babel/refs/tags/v8.0.6/packages/babel-types/package.json
#   "version": "8.0.6"        ... so a correct commit existed
```

## The sampling frame, stated so it can be re-derived

Every package reachable through runtime `dependencies` to depth 2 from 20 seeds: `react`,
`vue`, `next`, `vite`, `typescript`, `eslint`, `webpack`, `rollup`, `jest`, `vitest`,
`axios`, `express`, `@babel/core`, `playwright`, `prettier`, `esbuild`, `tailwindcss`,
`zod`, `rxjs`, `@typescript-eslint/parser`.

Deliberately **not** "the top N packages by downloads". npm publishes no such enumeration,
so a rate built on one cannot be checked by anybody.

## The control, and why the script exits non-zero without it

69 packages in the same sample attest a commit whose tree *does* hold the published
version — 71 of them on 14 October. That is what makes the other 22 a finding rather than a bug
in this script. If
that number ever reaches zero, `measure.cjs` exits 1 and says so, because at that point it
is measuring itself.

`attack.cjs` is the other half. If a project never commits its version bump, the attested
tree *could not* have held the release, there was nothing better to name, and "names the
wrong commit" would be the wrong description. So for every mismatch it looks for the
release tag and reads the version there. **22 of 22 have a published tag whose tree holds
the released version**, and **23 of 23** on the 14 October table. That defence is not
available.

## The mechanism

GitHub defines `GITHUB_SHA` per event. For `workflow_dispatch` it is the last commit on the
dispatched branch or tag; for `schedule` and for `workflow_run`, the last commit on the
default branch. None of the three is "the commit holding the version about to be published".
For `release` it is the last commit in the tagged release, and for `push` the tip commit
pushed — those two are the group that can be right by construction.

A release train that bumps versions *during* the run therefore attests the commit before
the bump. That is the shape of every `@babel/*` and `@typescript-eslint/*` row here, and it
is why `release`-triggered publishes are clean 5 times out of 5 here, and 7 of 7 a week later.

Note that this is not always a missing `ref:` on checkout. Babel's `release.yml`, for one,
does the right thing — it `git checkout`s the branch holding the bump before building, so
the **artifact is correct**. Provenance records the event's sha regardless of what the job
later checked out. Pinning `ref:` would not change it.

## Found while building this, and left in on purpose

The first version located a package's manifest with `repository.directory` and fell back to
the repository root when that field was absent. In a monorepo the root is a *different
package*, so the version read is unrelated. That produced two false mismatches —
`@humanfs/core` and `@humanfs/types`, whose root manifest is a package called `hfs` at
1.0.0 while the real manifest at the attested commit matches what was published.

The fix is the check that should have been there from the start: **the manifest must declare
the package being measured.** Five rows are now rejected rather than counted —
`@humanfs/core`, `@humanfs/types`, `next`, `playwright`, `playwright-core` — and **two** of
them, `playwright` and `playwright-core`, had been counted as *matches*: their root manifest
is a package called `playwright-internal` which happened to carry the same version they
published. So the bug was inflating the control too, 71 down to 69. (`next` was not one of
them: its root manifest is `nextjs-project` at `0.0.0`, which the placeholder rule already
caught.) Correcting all five moved the result from 24/100 to 22/95 and took `push` from 2
mismatches to zero.

## What this does not establish

- Not a security claim. The artifacts are what the projects built and the signatures over
  them are valid. This is a verifiability gap.
- The 23.2% is the rate **inside this frame**, which is a dependency closure of 20 popular
  seeds and skews heavily towards large, well-maintained projects. 196 of 298 packages carry
  no attestation at all (193 a week later).
- Two release trains account for 21 of the 22, and for 21 of the 23 a week later. By project
  it is about four, not twenty-two.
- Whether npm *should* verify that the attested tree matches the release is a design
  argument, not a measurement. Its documented behaviour is to check that the commit exists.

## A failure mode this cannot see

`no-provenance` — 196 of the 298 — is the bucket for a package whose `latest` carries no
attestation at the registry. The script cannot tell *why*. One reason is that the project
never configured provenance. Another is that it did, the statement was signed, and the
publish died before the registry recorded it.

The second happened to a package of mine, `llm-stream-guardrails@0.7.1`, and the run log
has both halves in four lines:

```
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=2907065549
npm error code EOTP
npm error This operation requires a one-time password from your authenticator.
```

That statement is in Sigstore's public log, integrated 2026-09-21T21:34:12Z. The publish
then failed on the 2FA prompt, and the version reached npm 27 minutes later from a laptop:
`_npmUser` is the account, on npm 10.8.2, where 0.7.2 and every version after it carry
`_npmUser: GitHub Actions` with a `trustedPublisher` block. `dist.attestations` is absent on
0.7.1 and present on all seven that follow.

So the registry has no attestation, the transparency log has one, and nothing reconciles the
two. This sweep reads the registry, so that version lands in `no-provenance` beside packages
that never tried — the mirror image of what the table measures. There, an attestation names a
commit that does not hold the release. Here it was signed for the commit CI built from — the
run's head was `04b794e`, which is where the `v0.7.1` tag points — and never arrived. I did
not read the statement's own subject: Rekor returned the entry for that index as `intoto/0.0.2`
without an inspectable payload, so the commit is the run's, not the statement's.

How many of the 196 are this rather than the ordinary kind is not a question the registry can
answer. It would mean reading the transparency log instead, which is a different measurement.

## Prior art

The mechanism was already understood. [`opensoma/opensoma#137`](https://github.com/opensoma/opensoma/issues/137)
(2026-09-21, still open) describes it and the one-line fix. Solarin, Kalu, Davis & Amusuo,
[*Reproducibility is Not Enough*](https://arxiv.org/abs/2608.18180) (arXiv:2608.18180,
2026-08-18) study artifact verifiability across four ecosystems and report that recovering
the source commit is the dominant obstacle.

What is new here is how often it happens and what predicts it.

## Licence

MIT.
