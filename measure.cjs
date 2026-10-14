/**
 * Does an npm provenance attestation name a commit whose tree contains the
 * version that was published?
 *
 * For each package: read the SLSA attestation for `latest`, take the commit it
 * names, fetch that package's own package.json AT that commit, and compare the
 * version there with the version that was actually published.
 *
 * Sampling frame, stated so it can be re-derived: every package reachable
 * through runtime `dependencies` to depth 2 from the seed list below. No
 * "top N by downloads" — npm publishes no such enumeration, so any claim built
 * on one cannot be checked.
 *
 * The control is the point. If nothing in the sample matches, the check is
 * broken rather than the ecosystem.
 *
 *   node measure.cjs --report                 # re-print rows.json
 *   node measure.cjs --report --rows=rows-2026-10-14.json
 *
 *   rm -rf cache/                             # a warm cache replays the old run
 *   node measure.cjs --out=rows-<today>.json  # take and record a new measurement
 *
 * A run reads the registry as it is today, so two runs are two different
 * measurements and both are worth keeping. The tables listed in runs.json are
 * the recorded ones, and this script will not write to one of those filenames —
 * which includes the default, rows.json, in this repository. A new measurement
 * needs --out= and a name of its own. The date it is recorded under is the day
 * it ran, not whatever the filename says.
 *
 * Why the cache has to go first: its packument key is the bare package name, so
 * a warm cache/ re-reads the previous `latest` and reproduces the previous
 * table. A cache left behind by a run that did not finish is worse — it pins
 * the packages that attempt reached and leaves the rest live — so a refusal
 * marks it and the next run will not start until it is cleared.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

/**
 * Written when a run refuses because a read went unanswered, and checked before
 * the next one starts. Telling the reader to clear the cache is advice; this
 * makes it a condition. Without it the next run reads the reached packages from
 * the aborted attempt and the unreached ones live, and the table that comes out
 * is two days spliced together — byte-identical to nothing, so the duplicate
 * check cannot see it either.
 */
const PARTIAL = path.join(CACHE, '.partial-run');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT_NAME = path.basename(arg('out', 'rows.json'));
const OUT = path.join(HERE, OUT_NAME);

/**
 * No runs.json at all means nothing has been recorded yet, which is a fine state
 * for a fresh repository. A runs.json that exists and cannot be read is a
 * different thing entirely, and it must not be allowed to read as the first one:
 * swallowing the error returns an empty list, the output guard then finds no
 * record of the table it is about to replace, and a single damaged byte in this
 * file is enough to lose a recorded run and its record together, at exit 0.
 */
const readRuns = () => {
  const p = path.join(HERE, 'runs.json');
  if (!fs.existsSync(p)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.log(`\n  runs.json cannot be read: ${e.message}`);
    console.log('  It is the record of which table is which, so nothing runs without it.');
    console.log('  Restore it:  git checkout -- runs.json\n');
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.some((r) => !r || typeof r.file !== 'string' || typeof r.sha256 !== 'string')) {
    console.log('\n  runs.json is not a list of {file, recorded, rows, sha256} entries.');
    console.log('  It is the record of which table is which, so nothing runs without it.');
    console.log('  Restore it:  git checkout -- runs.json\n');
    process.exit(1);
  }
  return parsed;
};

/**
 * Record the table that was just written, so that the next comparison can tell
 * whether it still is that table. Without this step a reader's own run stays
 * unrecorded, and an unrecorded table is one drift.cjs cannot hash-check or put
 * in order — which made the documented path for a third run the one case the
 * guards did not cover.
 */
/**
 * The recorded date is the day the run happened, read from the clock, not from
 * the filename. A filename is a convenience and gets copied from examples; the
 * day the registry was read is the fact the comparison depends on. Taking it
 * from the name meant a copied example stamped a run with a day it was not taken
 * on, and the only way offered to correct that was a rename, which is not a
 * re-measurement and which the duplicate check then refused.
 *
 * Local, not UTC: a reader naming the file from their own `date` should not see
 * their correct name disagree with the record for the hours their offset spans.
 */
const runDay = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function recordRun(file, text) {
  const entry = {
    file,
    recorded: runDay(),
    rows: JSON.parse(text).length,
    sha256: crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex'),
  };
  const runs = readRuns().filter((r) => r.file !== file);
  runs.push(entry);
  runs.sort((a, b) => String(a.recorded).localeCompare(String(b.recorded)));
  fs.writeFileSync(path.join(HERE, 'runs.json'), JSON.stringify(runs, null, 2));
  console.log(`  recorded in runs.json as ${entry.recorded}, sha256 ${entry.sha256.slice(0, 12)}…`);
}

/**
 * Refuse before measuring, not after: a run takes minutes and a record is
 * irreplaceable.
 *
 * The record is the authority here, not the file on disk. An earlier version of
 * this guard checked that the file still matched its recorded hash and stepped
 * aside when it did not — which stood down in precisely the state where the
 * record is the only thing left: a recorded table that had been edited or
 * deleted got overwritten, and the run then rewrote its runs.json entry with a
 * new date and hash, so both the table and the record of what it had been were
 * gone at exit 0.
 */
function guardOutput() {
  const rec = readRuns().find((r) => r.file === OUT_NAME);
  if (!rec) return;
  const state = !fs.existsSync(OUT)
    ? 'is missing from the working tree'
    : crypto.createHash('sha256').update(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex') === rec.sha256
      ? 'is intact'
      : 'has been changed since it was recorded';
  console.log(`\n  ${OUT_NAME} is the run recorded on ${rec.recorded}, and it ${state}.`);
  console.log('  Writing here would overwrite that record, so nothing has been measured.');
  if (state !== 'is intact') {
    console.log(`\n  Restore it first:  git checkout -- ${OUT_NAME}`);
  }
  console.log('\n  To take a new measurement, record it as its own table:');
  console.log('\n    node measure.cjs --out=rows-<today>.json');
  console.log(`\n  then compare them:  node drift.cjs ${OUT_NAME} rows-<today>.json\n`);
  process.exit(1);
}

const SEEDS = [
  'react', 'vue', 'next', 'vite', 'typescript', 'eslint', 'webpack', 'rollup',
  'jest', 'vitest', 'axios', 'express', '@babel/core', 'playwright', 'prettier',
  'esbuild', 'tailwindcss', 'zod', 'rxjs', '@typescript-eslint/parser',
];
const DEPTH = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheKey(kind, id) {
  return path.join(CACHE, kind + '__' + id.replace(/[^\w.@-]/g, '_') + '.json');
}

/**
 * A 404 is an answer: this package has no attestation, that file is not in that
 * tree. Anything else — a throw, a 429, a proxy's 403 — is not an answer, and
 * the difference decides whether the measurement means anything.
 *
 * Cached as NULL, a rate-limited attestation read becomes `no-provenance`,
 * indistinguishable from a package that never configured provenance. Fourteen of
 * them, on the one endpoint most likely to throttle under 298 sequential
 * anonymous reads, silently turns the @babel/* train from mismatches into
 * absences: the control still passes, the partition still closes, the rate falls
 * from 23.5% to 10.7%, and the next comparison reports that Babel fixed it. So a
 * failure that is not a 404 is counted, not cached, and a run that has any
 * refuses to write a table at all.
 */
let unreachable = 0;

async function getJSON(url, kind, id) {
  const f = cacheKey(kind, id);
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8');
    if (raw === 'NULL') return null;
    try { return JSON.parse(raw); } catch { unreachable++; return null; }
  }
  let out = null;
  let answered = false;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'provenance-drift-measurement' } });
    if (res.ok) { out = await res.json(); answered = true; }
    else if (res.status === 404) { answered = true; }
  } catch {}
  if (!answered) { unreachable++; await sleep(40); return null; }
  fs.writeFileSync(f, out === null ? 'NULL' : JSON.stringify(out));
  await sleep(40);
  return out;
}

/**
 * Read one file from a public repo at a given ref. No credentials: this is
 * raw.githubusercontent.com, which serves public content anonymously. Every ref
 * used here is a commit sha or a tag, both immutable, so the cache is safe and a
 * re-run a month from now reads exactly the same bytes.
 */
async function ghFile(repo, ref, filePath) {
  const id = `${repo}@${ref}@${filePath}`;
  const f = cacheKey('ghfile', id);
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8');
    if (raw === 'NULL') return null;
    // A cache entry that is not parseable is a half-written one — a run killed
    // mid-write, say. Reading it as a manifest with no version puts the row in
    // tree-no-version beside genuine version-less workspace roots and moves the
    // control, so it counts as a read that was never answered.
    try { JSON.parse(raw); } catch { unreachable++; return null; }
    return raw;
  }
  let out = null;
  let answered = false;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`, {
      headers: { 'user-agent': 'provenance-drift-measurement' },
    });
    if (res.ok) {
      const body = await res.text();
      // A 200 is not an answer on its own. A proxy, a captive portal or a CDN
      // error page returns one with HTML in it, and res.text() does not object.
      // Taken as a manifest it reads as a package.json with no version, which
      // files the row under tree-no-version beside the genuine ones and moves
      // the control — the same thing a half-written cache entry does, and
      // rejected here for the same reason.
      try { JSON.parse(body); out = body; answered = true; } catch {}
    } else if (res.status === 404) { answered = true; }
  } catch {}
  if (!answered) { unreachable++; await sleep(40); return null; }
  fs.writeFileSync(f, out === null ? 'NULL' : out);
  await sleep(40);
  return out;
}

/** Walk runtime dependencies to DEPTH, breadth-first, from SEEDS. */
async function buildFrame() {
  const seen = new Set();
  let layer = [...SEEDS];
  for (let d = 0; d <= DEPTH; d++) {
    const next = new Set();
    for (const name of layer) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (d === DEPTH) continue;
      const doc = await getJSON(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`, 'packument', name);
      const latest = doc && doc['dist-tags'] && doc['dist-tags'].latest;
      const v = latest && doc.versions && doc.versions[latest];
      for (const dep of Object.keys((v && v.dependencies) || {})) next.add(dep);
    }
    layer = [...next];
    process.stdout.write(`  depth ${d}: ${seen.size} packages known\n`);
  }
  return [...seen].sort();
}

/** The SLSA predicate for name@version, or null. */
async function provenance(name, version) {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name).replace('%40', '@')}@${version}`;
  const doc = await getJSON(url, 'attest', `${name}@${version}`);
  if (!doc || !doc.attestations) return null;
  for (const b of doc.attestations) {
    const env = b.bundle && b.bundle.dsseEnvelope;
    if (!env) continue;
    let pay;
    try { pay = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')); } catch { continue; }
    const bd = (pay.predicate && pay.predicate.buildDefinition) || {};
    const rd = bd.resolvedDependencies || [];
    if (!rd.length || !rd[0].digest || !rd[0].digest.gitCommit) continue;
    return {
      commit: rd[0].digest.gitCommit,
      uri: rd[0].uri || '',
      event: ((bd.internalParameters || {}).github || {}).event_name || '?',
      workflowRef: ((bd.externalParameters || {}).workflow || {}).ref || '',
      repo: ((bd.externalParameters || {}).workflow || {}).repository || '',
    };
  }
  return null;
}

const SEMANTIC_PLACEHOLDER = /^0\.0\.0(-|$)/;

async function main() {
  guardOutput();
  if (fs.existsSync(PARTIAL)) {
    console.log(`\n  cache/ is left over from a run that did not finish: ${fs.readFileSync(PARTIAL, 'utf8').trim()}.`);
    console.log('  Re-using it would pin the packages that attempt reached to the versions they');
    console.log('  had then, and splice two days into one table.');
    console.log('\n    rm -rf cache/   and run it again.\n');
    process.exit(1);
  }
  console.log('\n  building the sampling frame...');
  const frame = await buildFrame();
  console.log(`\n  frame: ${frame.length} distinct packages\n`);

  const rows = [];
  let i = 0;
  for (const name of frame) {
    i++;
    if (i % 25 === 0) process.stdout.write(`  ...${i}/${frame.length}\n`);
    const doc = await getJSON(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`, 'packument', name);
    const latest = doc && doc['dist-tags'] && doc['dist-tags'].latest;
    if (!latest) { rows.push({ name, status: 'no-latest' }); continue; }
    const meta = doc.versions[latest];

    const prov = await provenance(name, latest);
    if (!prov) { rows.push({ name, version: latest, status: 'no-provenance' }); continue; }

    const repo = (prov.repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (!repo || repo.split('/').length !== 2) { rows.push({ name, version: latest, status: 'no-github-repo', prov }); continue; }

    const dir = (meta.repository && meta.repository.directory) || '';
    const pkgPath = dir ? `${dir.replace(/\/$/, '')}/package.json` : 'package.json';

    const raw = await ghFile(repo, prov.commit, pkgPath);
    if (!raw) { rows.push({ name, version: latest, status: 'tree-unreadable', prov, pkgPath }); continue; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (!parsed || !parsed.version) { rows.push({ name, version: latest, status: 'tree-no-version', prov, pkgPath }); continue; }

    // The manifest must BELONG to this package. Without repository.directory the
    // fallback is the repo root, which in a monorepo is a different package
    // entirely - that produced two false mismatches before this check existed.
    if (parsed.name && parsed.name !== name) {
      rows.push({ name, version: latest, status: 'wrong-manifest', prov, pkgPath, foundName: parsed.name });
      continue;
    }
    const treeVersion = parsed.version;

    const placeholder = SEMANTIC_PLACEHOLDER.test(treeVersion);
    const match = treeVersion === latest;
    rows.push({
      name, version: latest, treeVersion, pkgPath, repo,
      commit: prov.commit, event: prov.event, workflowRef: prov.workflowRef,
      status: match ? 'MATCH' : placeholder ? 'placeholder' : 'MISMATCH',
    });
  }

  if (unreachable) {
    fs.writeFileSync(PARTIAL, `${unreachable} unanswered read(s)\n`);
    console.log(`\n  ${unreachable} request(s) failed for a reason other than a 404.`);
    console.log('  An unanswered read is not a measurement: a rate-limited attestation looks');
    console.log('  exactly like a package that never configured provenance, and a table built');
    console.log('  from a few of those reports the opposite of the finding while every internal');
    console.log('  check still passes. Nothing written, nothing recorded.');
    console.log('\n  The reads that DID answer are still in cache/, and the packument cache is');
    console.log('  keyed by package name, so re-running now would pin those packages to the');
    console.log('  version they had on this attempt and mix two days into one table. Clear it:');
    console.log('\n    rm -rf cache/   and run it again.\n');
    process.exitCode = 1;
    return;
  }

  // Report first: it carries the control, and a table that fails the control must
  // not end up in runs.json as a run anyone can compare against.
  report(rows);
  if (process.exitCode) {
    console.log('\n  The checks above did not pass, so nothing was written or recorded.\n');
    return;
  }
  const text = JSON.stringify(rows, null, 2);

  // Same bytes as a table already recorded means the registry was never re-read:
  // the packument cache is keyed by bare package name, so a warm cache/ replays
  // the previous `latest` and reproduces the previous table exactly. Written and
  // recorded, that would read as a week in which nothing moved.
  const sha = crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const twin = readRuns().find((r) => r.sha256 === sha && r.file !== OUT_NAME);
  if (twin) {
    console.log(`\n  this is byte-identical to ${twin.file}, the run recorded on ${twin.recorded}.`);
    console.log('  The registry was not re-read: the packument cache is keyed by package name,');
    console.log('  so a warm cache/ reproduces the previous table. Nothing written or recorded.');
    console.log('\n    rm -rf cache/   and run it again.\n');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT, text);
  console.log(`\n  written to ${OUT_NAME}`);
  recordRun(OUT_NAME, text);
}

function report(rows) {
  const by = (s) => rows.filter((r) => r.status === s);
  const checked = rows.filter((r) => ['MATCH', 'MISMATCH', 'placeholder'].includes(r.status));
  console.log('');
  console.log('  ─────────────────────────────────────────────────────────');
  // The indented column is a partition of the frame, so it has to close. Leaving
  // a bucket out of the print is how a reader ends up reconciling 293 against a
  // header saying 298 and assuming they misread one of them.
  const unreadable = by('tree-unreadable').length + by('tree-no-version').length +
    by('no-github-repo').length + by('no-latest').length;
  console.log(`  packages in frame                     ${rows.length}`);
  console.log(`    no provenance attestation           ${by('no-provenance').length}`);
  console.log(`    manifest did not belong to the pkg  ${by('wrong-manifest').length}   (rejected, see the README)`);
  console.log(`    provenance, but tree unreadable     ${unreadable}`);
  console.log(`    provenance, tree read               ${checked.length}`);
  console.log('');
  console.log(`      attested tree HAS the version     ${by('MATCH').length}   <- the control`);
  console.log(`      attested tree has 0.0.0-* stub    ${by('placeholder').length}   (semantic-release, by design)`);
  console.log(`      attested tree has ANOTHER version ${by('MISMATCH').length}`);
  if (checked.length) {
    const pct = (by('MISMATCH').length / checked.length) * 100;
    console.log(`      mismatch rate of those read       ${pct.toFixed(1)}%`);
  }
  console.log('  ─────────────────────────────────────────────────────────');

  const partition = by('no-provenance').length + by('wrong-manifest').length + unreadable + checked.length;
  if (partition !== rows.length) {
    console.log(`\n  the column above sums to ${partition}, not ${rows.length}: a status is not being printed.`);
    process.exitCode = 1;
  }

  if (!by('MATCH').length) {
    console.log('\n  CONTROL FAILED: nothing matched, so this is measuring my own bug.');
    process.exitCode = 1;
  }

  const ev = {};
  for (const r of checked) ev[r.event] = ev[r.event] || { total: 0, mismatch: 0 };
  for (const r of checked) { ev[r.event].total++; if (r.status === 'MISMATCH') ev[r.event].mismatch++; }
  console.log('\n  by the event that triggered the publishing workflow:');
  console.log('    event                total   mismatched');
  for (const [k, v] of Object.entries(ev).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`    ${k.padEnd(20)} ${String(v.total).padEnd(8)}${v.mismatch}`);
  }

  const mm = by('MISMATCH');
  if (mm.length) {
    console.log('\n  every mismatch, in full:');
    console.log('    package                              published    attested tree   event');
    for (const r of mm.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${r.name.padEnd(36)} ${String(r.version).padEnd(12)} ${String(r.treeVersion).padEnd(15)} ${r.event}`);
    }
  }
}

if (process.argv.includes('--report')) {
  const which = path.basename(arg('rows', 'rows.json'));
  console.log(`\n  ${which}`);
  report(JSON.parse(fs.readFileSync(path.join(HERE, which), 'utf8')));
} else {
  main();
}
