# provenance-drift

Does an npm provenance attestation name a commit whose tree actually contains the version
that was published?

For 22 of the 95 packages this could check, no. And which trigger fired the publishing
workflow predicts it almost perfectly.

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
  GITHUB_SHA points at the release commit   (release, push, workflow_run)
       0 wrong out of 68

  GITHUB_SHA points somewhere else          (workflow_dispatch, schedule)
      22 wrong out of 27     = 81%
```

## Run it

```bash
node measure.cjs            # the measurement; caches as it goes
node measure.cjs --report   # re-print from cache
node attack.cjs             # try to kill the finding (see below)
```

Node 18+. **No credentials, no tokens, no install.** Everything comes from the public npm
registry and `raw.githubusercontent.com`. A clean clone reproduces the table.

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
version. That is what makes the other 22 a finding rather than a bug in this script. If
that number ever reaches zero, `measure.cjs` exits 1 and says so, because at that point it
is measuring itself.

`attack.cjs` is the other half. If a project never commits its version bump, the attested
tree *could not* have held the release, there was nothing better to name, and "names the
wrong commit" would be the wrong description. So for every mismatch it looks for the
release tag and reads the version there. **22 of 22 have a published tag whose tree holds
the released version.** That defence is not available.

## The mechanism

GitHub defines `GITHUB_SHA` per event. For `workflow_dispatch` it is the last commit on the
dispatched branch or tag; for `schedule`, the last commit on the default branch. Neither is
"the commit holding the version about to be published".

A release train that bumps versions *during* the run therefore attests the commit before
the bump. That is the shape of every `@babel/*` and `@typescript-eslint/*` row here, and it
is why `release`-triggered publishes are clean 5 times out of 5.

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
`@humanfs/core`, `@humanfs/types`, `next`, `playwright`, `playwright-core` — and three of
them had been counted as *matches*, so the bug was inflating the control too. Correcting it
moved the result from 24/100 to 22/95 and took `push` from 2 mismatches to zero.

## What this does not establish

- Not a security claim. The artifacts are what the projects built and the signatures over
  them are valid. This is a verifiability gap.
- The 23.2% is the rate **inside this frame**, which is a dependency closure of 20 popular
  seeds and skews heavily towards large, well-maintained projects. 196 of 298 packages carry
  no attestation at all.
- Two release trains account for 21 of the 22. By project it is about four, not twenty-two.
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
