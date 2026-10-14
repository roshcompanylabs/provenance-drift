/**
 * Two recorded runs, a week apart. What changed?
 *
 * The single-run table says how often an attestation names a commit whose tree
 * does not hold the published version. It cannot say whether that is a snapshot
 * nobody has released past, or a property of the release pipeline that repeats.
 * Only a second run can, and only if the first one is still on disk unmodified
 * to compare against — which is why both are committed and why `runs.json`
 * records the sha256 of each.
 *
 * That hash is not decoration. Without it, anything that replaced a recorded
 * table — a stray `--out=rows.json`, a half-finished edit, a bad merge — would
 * be compared as though it were still the run it is named after, and printed
 * under a column header giving that run's date, at exit 0. Both scripts refuse
 * instead: `measure.cjs` will not write to a filename runs.json records at all,
 * and this one will not read a recorded table whose bytes have moved.
 *
 * Reads the two recorded tables and nothing else. No network, no cache, no
 * credentials: the inputs are JSON files in this repository, so the comparison
 * re-derives from a clean clone offline.
 *
 *   node drift.cjs
 *   node drift.cjs rows.json rows-2026-10-14.json
 *
 * Exits non-zero if an input is not the run it is recorded as, or if its rows
 * carry a status this script does not know how to count. Either way the
 * comparison would be reading something other than the two complete runs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('-'));
if (flags.length) {
  console.log(`\n  drift.cjs takes two filenames, not flags; got ${flags.join(' ')}`);
  console.log('  usage: node drift.cjs [earlier-run.json] [later-run.json]\n');
  process.exit(1);
}
const [aPath = 'rows.json', bPath = 'rows-2026-10-14.json'] = argv;

/** Every status measure.cjs can write. An unknown one means the two are not comparable. */
const KNOWN = [
  'no-provenance', 'wrong-manifest', 'MATCH', 'placeholder', 'MISMATCH',
  'tree-unreadable', 'tree-no-version', 'no-github-repo', 'no-latest',
];
/** MATCH + MISMATCH + placeholder: the rows whose attested tree was readable. */
const READ = ['MATCH', 'MISMATCH', 'placeholder'];

let failed = false;

/**
 * Absent runs.json means nothing has been recorded yet. Present-but-unreadable
 * means the record of which table is which is damaged, and treating that as
 * "nothing recorded" silently drops the hash check and the ordering check at the
 * same time — the two things standing between a reader and a comparison that
 * prints the opposite of the finding at exit 0.
 */
const RECORDED = (() => {
  const p = path.join(__dirname, 'runs.json');
  if (!fs.existsSync(p)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.log(`\n  runs.json cannot be read: ${e.message}`);
    console.log('  Without it there is nothing to check these tables against.');
    console.log('  Restore it:  git checkout -- runs.json\n');
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.some((r) => !r || typeof r.file !== 'string' || typeof r.sha256 !== 'string')) {
    console.log('\n  runs.json is not a list of {file, recorded, rows, sha256} entries.');
    console.log('  Without it there is nothing to check these tables against.');
    console.log('  Restore it:  git checkout -- runs.json\n');
    process.exit(1);
  }
  return parsed;
})();

/**
 * A run is only comparable if it is the run it claims to be and every row in it
 * is counted. Both halves have to be checked here, because nothing in a row says
 * which run it came from: the files carry no date and no run id, so the filename
 * and this hash are the only things that tie a table to a day.
 */
function load(p) {
  let text, rows;
  try {
    text = fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.log(`\n  cannot read ${p}. The recorded runs are ${RECORDED.map((r) => r.file).join(' and ') || '(none recorded)'}.`);
    process.exit(1);
  }
  try {
    rows = JSON.parse(text);
  } catch (e) {
    console.log(`\n  ${p} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(rows)) {
    console.log(`\n  ${p} is not an array of rows.`);
    process.exit(1);
  }
  const rec = RECORDED.find((r) => r.file === path.basename(p));

  if (rec) {
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (sha !== rec.sha256) {
      console.log('');
      console.log(`  ${p} is not the run recorded on ${rec.recorded}.`);
      console.log(`    recorded sha256  ${rec.sha256}`);
      console.log(`    this file        ${sha}`);
      console.log(`    A recorded run is evidence, so this comparison stops here. Restore it with`);
      console.log(`    \`git checkout -- ${path.basename(p)}\`, or pass two tables that are what they say.`);
      failed = true;
    }
  }

  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  const unknown = Object.keys(by).filter((s) => !KNOWN.includes(s));
  if (unknown.length) {
    console.log('');
    console.log(`  ${p}: unknown status ${unknown.join(', ')} — these rows cannot be accounted for.`);
    failed = true;
  }
  const counted = KNOWN.reduce((acc, s) => acc + (by[s] || 0), 0);
  if (counted !== rows.length) {
    console.log('');
    console.log(`  ${p}: counted ${counted} rows of ${rows.length}.`);
    failed = true;
  }
  // A table recorded in runs.json carries its date there. One that is not — every
  // run made after this was published, until it is recorded — carries it in the
  // filename, which is enough to catch the arguments being the wrong way round.
  const named = path.basename(p).match(/(\d{4}-\d{2}-\d{2})/);
  const recorded = rec ? rec.recorded : named ? `${named[1]} (from the filename)` : 'undated';
  const day = rec ? rec.recorded : named ? named[1] : null;
  return { p, rows, by, recorded, day, index: new Map(rows.map((r) => [r.name, r])) };
}

const A = load(aPath);
const B = load(bPath);

/**
 * Order matters and nothing inside a table says which way round it goes, so
 * every label this script prints — "entered", "left", "published a new version
 * in between" — would come out inverted with the arguments swapped, and both
 * hashes would still verify. The date does it: from runs.json where the table is
 * recorded, from the filename where it is not.
 */
if (A.day && B.day && A.day > B.day) {
  console.log(`\n  ${aPath} is dated ${A.day}, after ${bPath} on ${B.day}.`);
  console.log('  Read in that order every label below would be backwards. Earlier run first:');
  console.log(`\n    node drift.cjs ${bPath} ${aPath}\n`);
  failed = true;
}
if (!A.day || !B.day) {
  console.log(`\n  note: ${!A.day ? aPath : bPath} carries no date, in runs.json or in its name,`);
  console.log('  so the order of the two cannot be checked. Every label below assumes the');
  console.log('  earlier run is first.');
}

if (failed) {
  console.log('');
  process.exitCode = 1;
} else {
  compare(A, B);
}

function compare(A, B) {
  /** The same partition the README table uses, so the two can be laid side by side. */
  const unreadable = (run) =>
    (run.by['tree-unreadable'] || 0) + (run.by['tree-no-version'] || 0) +
    (run.by['no-github-repo'] || 0) + (run.by['no-latest'] || 0);
  const read = (run) => run.rows.filter((r) => READ.includes(r.status));
  const mismatches = (run) => new Map(run.rows.filter((r) => r.status === 'MISMATCH').map((r) => [r.name, r]));

  const n = (x) => String(x).padStart(5);
  const col = (a, b) => n(a) + '                  ' + n(b);
  const head = (run, p) => `${p}  ${run.recorded}`;

  console.log('');
  console.log(`                                  ${head(A, aPath).padEnd(26)} ${head(B, bPath)}`);
  console.log('  packages in frame             ' + col(A.rows.length, B.rows.length));
  console.log('    no provenance attestation   ' + col(A.by['no-provenance'] || 0, B.by['no-provenance'] || 0));
  console.log('    manifest not this package   ' + col(A.by['wrong-manifest'] || 0, B.by['wrong-manifest'] || 0));
  console.log('    provenance, tree unreadable ' + col(unreadable(A), unreadable(B)));
  console.log('    provenance, tree read       ' + col(read(A).length, read(B).length));
  console.log('      tree HAS the version      ' + col(A.by.MATCH || 0, B.by.MATCH || 0));
  console.log('      tree has a 0.0.0-* stub   ' + col(A.by.placeholder || 0, B.by.placeholder || 0));
  console.log('      tree has ANOTHER version  ' + col(A.by.MISMATCH || 0, B.by.MISMATCH || 0));

  // The indented column is a partition of the frame, so it has to close. If it
  // ever does not, a status exists that this block does not print.
  for (const run of [A, B]) {
    const sum = (run.by['no-provenance'] || 0) + (run.by['wrong-manifest'] || 0) + unreadable(run) + read(run).length;
    if (sum !== run.rows.length) {
      console.log(`  ${run.p}: the column above sums to ${sum}, not ${run.rows.length}.`);
      process.exitCode = 1;
    }
  }

  const rate = (run) => (((run.by.MISMATCH || 0) / read(run).length) * 100).toFixed(1);
  console.log('  mismatch rate of those read   ' + n(rate(A)) + '%                 ' + n(rate(B)) + '%');

  const MA = mismatches(A), MB = mismatches(B);
  const names = [...new Set([...MA.keys(), ...MB.keys()])].sort();
  const rereleased = [], frozen = [], left = [], entered = [];
  for (const name of names) {
    const a = MA.get(name), b = MB.get(name);
    if (a && !b) left.push(a);
    else if (!a && b) entered.push(b);
    else if (a.version !== b.version) rereleased.push([a, b]);
    else frozen.push([a, b]);
  }

  // The frame is a dependency closure of 20 seeds, so it moves whenever a seed
  // changes a runtime dependency. A package that simply stopped being in the
  // frame would otherwise be printed as having left the mismatch set, which
  // reads as "fixed". Both committed runs hold the same 298 names, so this line
  // is 0/0 for them, and it is here for the runs that follow.
  const inA = new Set(A.index.keys()), inB = new Set(B.index.keys());
  const gone = [...inA].filter((n) => !inB.has(n));
  const arrived = [...inB].filter((n) => !inA.has(n));
  if (gone.length || arrived.length) {
    console.log('');
    console.log(`  the frame itself changed: ${gone.length} package(s) left it, ${arrived.length} joined`);
    console.log('    so the two rates are not measured over the same set, and a package that');
    console.log('    merely left the frame is not a package that was corrected.');
    for (const n of gone.slice(0, 10)) console.log(`      left   ${n}`);
    for (const n of arrived.slice(0, 10)) console.log(`      joined ${n}`);
    if (gone.length + arrived.length > 20) console.log('      ...');
  }

  console.log('');
  console.log(`  left the mismatch set                                      ${left.length}`);
  for (const r of left) console.log(`    ${r.name.padEnd(36)} was ${r.version} attesting ${r.treeVersion}`);

  console.log('');
  console.log(`  still wrong, and published a new version in between        ${rereleased.length}`);
  console.log('    package                              published           attested tree       build commit           trigger');
  for (const [a, b] of rereleased) {
    console.log(
      `    ${a.name.padEnd(36)} ${(a.version + ' -> ' + b.version).padEnd(19)} ${(a.treeVersion + ' -> ' + b.treeVersion).padEnd(19)} ` +
      `${(a.commit.slice(0, 8) + ' -> ' + b.commit.slice(0, 8)).padEnd(22)} ${a.event === b.event ? a.event : a.event + ' -> ' + b.event}`,
    );
  }
  const before = rereleased.filter(([a, b]) => b.treeVersion === a.version);
  console.log(`    of those, the new release attests the version before it:  ${before.length} of ${rereleased.length}`);

  console.log('');
  console.log(`  still wrong, no new release in between                     ${frozen.length}`);
  for (const [a, b] of frozen) {
    const stable = a.commit === b.commit && a.treeVersion === b.treeVersion;
    console.log(`    ${a.name.padEnd(36)} ${String(a.version).padEnd(10)} attests ${String(a.treeVersion).padEnd(12)} ${stable ? 'unchanged' : 'CHANGED - look at this row'}`);
  }

  console.log('');
  console.log(`  entered the mismatch set                                   ${entered.length}`);
  for (const r of entered) console.log(`    ${r.name.padEnd(36)} ${String(r.version).padEnd(10)} attests ${String(r.treeVersion).padEnd(12)} ${r.event}`);

  /**
   * Rows whose `latest` had no attestation in the first run and has one in the
   * second. Careful what this is: a new attestation RECORD, not necessarily a
   * project adopting provenance. A package can have carried attestations for
   * years and simply have had an unattested version sitting at `latest` on the
   * day of the first run. Telling those apart means reading that package's other
   * versions from the registry, which is a network call this script does not
   * make — so it prints the rows and leaves the distinction to whoever reads
   * them. The README names which of these is which.
   */
  console.log('');
  console.log('  latest had no attestation in the first run and has one in the second:');
  let fresh = 0;
  for (const [name, b] of B.index) {
    const a = A.index.get(name);
    if (!a || a.status !== 'no-provenance' || !READ.includes(b.status)) continue;
    fresh++;
    console.log(`    ${name.padEnd(36)} ${String(a.version).padEnd(8)} -> ${String(b.version).padEnd(10)} ${String(b.event).padEnd(20)} ${b.status}`);
  }
  if (!fresh) console.log('    none');

  /**
   * release: GITHUB_SHA is the last commit in the tagged release. push: the tip
   * commit pushed. Those two are the only events GitHub documents as pointing at
   * the thing being published. workflow_run sits with workflow_dispatch and
   * schedule, because GitHub documents its GITHUB_SHA as the last commit on the
   * default branch — identical wording to schedule. The first published version
   * of this table grouped it with release and push on the strength of the one
   * clean workflow_run row in the frame; that was reading n=1 as a mechanism.
   */
  const CLEAN = ['release', 'push'];
  const tally = (run, pred) => {
    const rs = read(run).filter(pred);
    return `${rs.filter((r) => r.status === 'MISMATCH').length} wrong of ${rs.length}`;
  };
  console.log('');
  console.log('  by trigger, both runs:');
  console.log('    trigger                 ' + head(A, aPath).padEnd(28) + head(B, bPath));
  const triggers = [...new Set([...read(A), ...read(B)].map((r) => r.event))].sort();
  for (const t of triggers) {
    console.log(`    ${t.padEnd(22)}  ${tally(A, (r) => r.event === t).padEnd(28)}${tally(B, (r) => r.event === t)}`);
  }
  console.log('');
  console.log('    GITHUB_SHA is the commit being published');
  console.log(`      ${"release, push".padEnd(24)}${tally(A, (r) => CLEAN.includes(r.event)).padEnd(28)}${tally(B, (r) => CLEAN.includes(r.event))}`);
  console.log('    GITHUB_SHA is the default branch tip, or the dispatched ref');
  console.log(`      ${"the other three".padEnd(24)}${tally(A, (r) => !CLEAN.includes(r.event)).padEnd(28)}${tally(B, (r) => !CLEAN.includes(r.event))}`);
  console.log('');
}
