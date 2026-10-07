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
 *   node measure.cjs            # run, caching as it goes
 *   node measure.cjs --report   # re-print from cache without refetching
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

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

async function getJSON(url, kind, id) {
  const f = cacheKey(kind, id);
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8');
    return raw === 'NULL' ? null : JSON.parse(raw);
  }
  let out = null;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'provenance-drift-measurement' } });
    if (res.ok) out = await res.json();
  } catch {}
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
    return raw === 'NULL' ? null : raw;
  }
  let out = null;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`, {
      headers: { 'user-agent': 'provenance-drift-measurement' },
    });
    if (res.ok) out = await res.text();
  } catch {}
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

  fs.writeFileSync(path.join(HERE, 'rows.json'), JSON.stringify(rows, null, 2));
  report(rows);
}

function report(rows) {
  const by = (s) => rows.filter((r) => r.status === s);
  const checked = rows.filter((r) => ['MATCH', 'MISMATCH', 'placeholder'].includes(r.status));
  console.log('');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  packages in frame                     ${rows.length}`);
  console.log(`    no provenance attestation           ${by('no-provenance').length}`);
  console.log(`    provenance, but tree unreadable     ${by('tree-unreadable').length + by('tree-no-version').length + by('no-github-repo').length}`);
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
  report(JSON.parse(fs.readFileSync(path.join(HERE, 'rows.json'), 'utf8')));
} else {
  main();
}
