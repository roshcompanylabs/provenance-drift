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
 */
const fs = require('fs');
const path = require('path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'rows.json'), 'utf8'));
const mismatches = rows.filter((r) => r.status === 'MISMATCH');

/** No credentials: raw.githubusercontent serves public content anonymously. */
const versionAt = async (repo, ref, p) => {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${p}`, {
      headers: { 'user-agent': 'provenance-drift-measurement' },
    });
    if (!res.ok) return null;
    return JSON.parse(await res.text()).version;
  } catch { return null; }
};

async function main() {
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
}

fs.writeFileSync(path.join(__dirname, 'attack.json'), JSON.stringify(verdicts, null, 2));
}

main();
