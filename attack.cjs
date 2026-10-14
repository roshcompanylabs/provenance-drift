/**
 * Try to kill the finding.
 *
 * The finding only means something if, for each mismatch, a commit DOES exist that
 * holds the published version. If no such commit exists, then the project simply
 * never commits its version bump — the tree could not have contained it, the
 * attestation had nothing better to name, and "the attestation names the wrong
 * commit" is the wrong description.
 *
 * So: for every mismatch, look for the release tag and read the version there.
 *   tag holds the published version  -> a correct commit existed. The finding stands.
 *   no tag, or tag disagrees         -> the finding is mis-described for that row.
 *
 *   node attack.cjs                              # the table in rows.json
 *   node attack.cjs --rows=rows-2026-10-14.json  # any other recorded run
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * A recorded run is evidence, so this script must not be able to destroy one.
 * Both the table it reads and the verdicts it writes stay inside the repository,
 * and the output name can never collide with the input: a file not called
 * rows*.json gets an `attack-` prefix rather than keeping its own name, which
 * would otherwise write the verdicts straight over the table they came from.
 */
const ROWS = (process.argv.find((a) => a.startsWith('--rows=')) || '--rows=rows.json').slice(7);
const IN = path.resolve(__dirname, ROWS);
const inside = (p) => {
  const rel = path.relative(__dirname, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
if (!inside(IN)) {
  console.log(`\n  --rows must name a file inside this repository; got ${ROWS}`);
  process.exit(1);
}
const base = path.basename(IN);
const OUT = path.join(__dirname, base.startsWith('rows') ? base.replace(/^rows/, 'attack') : `attack-${base}`);
if (OUT === IN) {
  console.log(`\n  refusing to write the verdicts over the table they came from (${base})`);
  process.exit(1);
}
if (!fs.existsSync(IN)) {
  console.log(`\n  cannot read ${ROWS}`);
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(IN, 'utf8'));
const mismatches = rows.filter((r) => r.status === 'MISMATCH');

/**
 * If the table is one runs.json records, it has to be that table. This script
 * is the control, and a control run against a file whose bytes have moved since
 * it was recorded is testing something other than the recorded measurement.
 */
(() => {
  let recorded = [];
  const rp = path.join(__dirname, 'runs.json');
  if (fs.existsSync(rp)) {
    try { recorded = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch {
      console.log('\n  runs.json cannot be read, so there is nothing to check this table against.');
      console.log('  Restore it:  git checkout -- runs.json\n');
      process.exit(1);
    }
  }
  const rec = Array.isArray(recorded) ? recorded.find((r) => r && r.file === base) : null;
  if (!rec) return;
  const sha = crypto.createHash('sha256')
    .update(fs.readFileSync(IN, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  if (sha !== rec.sha256) {
    console.log(`\n  ${base} is not the run recorded on ${rec.recorded}.`);
    console.log(`    recorded sha256  ${rec.sha256}`);
    console.log(`    this file        ${sha}`);
    console.log(`\n  Restore it:  git checkout -- ${base}\n`);
    process.exit(1);
  }
})();

/**
 * The point of this script is that it can fail. On a table with no mismatches
 * there is nothing for it to try, and saying "every mismatch has a published
 * tag" of an empty set states the conclusion without having tested anything —
 * which is exactly the answer a reader would get right after an accident
 * drained the mismatch set.
 */
if (!mismatches.length) {
  console.log(`\n  ${base}: ${rows.length} rows, no mismatches.`);
  console.log('  There is nothing for this control to try, so it concludes nothing. If the');
  console.log('  table it came from is expected to have mismatches, that is the thing to look');
  console.log('  at: this script cannot tell you a finding survived when there was none.\n');
  process.exitCode = 1;
  return;
}

/**
 * This script needs the network. It has no cache, and that matters more than it
 * sounds: a missing tag is the evidence it is looking for, so an unreachable
 * registry looks exactly like a project that never tagged its release. Read
 * offline it would report that none of the mismatches has a correct commit —
 * the opposite of the finding — so a request that fails for any reason other
 * than a 404 is counted as unreachable and the run refuses to conclude.
 *
 * No credentials: raw.githubusercontent serves public content anonymously.
 */
let unreachable = 0;
const versionAt = async (repo, ref, p) => {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${p}`, {
      headers: { 'user-agent': 'provenance-drift-measurement' },
    });
    if (res.status === 404) return null;          // the tag really is not there
    if (!res.ok) { unreachable++; return null; }  // 5xx, rate limit: not evidence
    return JSON.parse(await res.text()).version;
  } catch { unreachable++; return null; }
};

async function main() {
console.log('');
console.log('  ' + base + ': ' + rows.length + ' rows, ' + mismatches.length + ' mismatches; verdicts -> ' + path.basename(OUT));
console.log('');
console.log('  package                              published   attested   tag tried            tag holds');
let standsCount = 0, failsCount = 0;
const verdicts = [];

for (const r of mismatches) {
  // Try the tag spellings these ecosystems actually use.
  const candidates = [
    `refs/tags/v${r.version}`,
    `refs/tags/${r.version}`,
    `refs/tags/${r.name}@${r.version}`,
    `refs/tags/${r.name.split('/').pop()}@${r.version}`,
  ];
  let found = null, usedTag = null;
  for (const t of candidates) {
    const v = await versionAt(r.repo, t, r.pkgPath);
    if (v) { found = v; usedTag = t.replace('refs/tags/', ''); break; }
  }
  const stands = found === r.version;
  if (found === null) { verdicts.push({ ...r, tag: null, tagVersion: null, verdict: 'NO TAG FOUND' }); failsCount++; }
  else if (stands) { verdicts.push({ ...r, tag: usedTag, tagVersion: found, verdict: 'stands' }); standsCount++; }
  else { verdicts.push({ ...r, tag: usedTag, tagVersion: found, verdict: 'TAG DISAGREES' }); failsCount++; }

  const last = verdicts[verdicts.length - 1];
  console.log(
    `  ${r.name.padEnd(36)} ${String(r.version).padEnd(11)} ${String(r.treeVersion).padEnd(10)} ${String(usedTag || '(none of 4)').padEnd(20)} ${String(found ?? '-').padEnd(9)} ${last.verdict === 'stands' ? '' : '  <<< ' + last.verdict}`,
  );
}

console.log('');
if (unreachable) {
  console.log(`  ${unreachable} request(s) failed for a reason other than a missing tag.`);
  console.log('  This script reads raw.githubusercontent.com and has no cache, so an');
  console.log('  unreachable tag is indistinguishable from a tag that was never pushed.');
  console.log('  Nothing is concluded and nothing is written. Re-run with the network up.');
  console.log('');
  process.exitCode = 1;
  return;
}
console.log(`  a correct commit demonstrably existed : ${standsCount} of ${mismatches.length}`);
console.log(`  could not show one                    : ${failsCount}`);
console.log('');
if (standsCount === mismatches.length) {
  console.log('  Every mismatch has a published tag whose tree holds the released version.');
  console.log('  So "the attestation names a commit that does not hold the release" is accurate,');
  console.log('  and the defence "there was no better commit to name" is not available.');
} else {
  console.log('  NOT every row survives. The rows marked above must be dropped or re-described');
  console.log('  before any of this is published.');
  process.exitCode = 1;
}

fs.writeFileSync(OUT, JSON.stringify(verdicts, null, 2));
console.log(`  verdicts written to ${path.basename(OUT)}\n`);
}

main().catch((e) => {
  console.log(`\n  the run did not finish: ${e.message}\n`);
  process.exitCode = 1;
});
