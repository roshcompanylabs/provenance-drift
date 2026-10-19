/**
 * Rebuild-eligibility: before spending a runner trying to re-derive an artifact
 * from its attested commit, which packages are even eligible — and on what?
 *
 * measure.cjs asks whether the attested commit's TREE holds the released version.
 * This asks the next question down: if you took that commit and tried to reproduce
 * the published tarball, is "re-derive it" a decidable instruction from the bundle,
 * or would a clean rebuild diverge for a reason that has nothing to do with the
 * source? It reads as a funnel, and it ends at a wall the attestation puts there.
 *
 * Same sampling frame as measure.cjs (depth-2 runtime-dep closure of the same 20
 * seeds), same cache, same refuse-on-unanswered-read discipline. For every package
 * whose `latest` carries a readable SLSA provenance attestation:
 *
 *   source pinnable       resolvedDependencies[0].digest.gitCommit is present. This
 *                         is the only immutable coordinate in the bundle, and you
 *                         rebuild against it. Expected to be all of them.
 *   artifact identified   subject[0].digest.sha512 decodes to exactly dist.integrity,
 *                         so the thing you would diff against is named. Expected all.
 *   dependency set        resolvedDependencies holds ONLY that commit — depCount 1 —
 *     recorded?           for the whole frame. The installed dependency tree is never
 *                         an attested input. So two runs of the same commit can resolve
 *                         different trees, and the attestation cannot tell them apart.
 *                         This is the wall: from the bundle ALONE, re-derivation is
 *                         decidable for none, because the resolve is not in it.
 *   committed lock        a lockfile is committed at the repo root at the attested
 *                         commit. This is the precondition for making the resolve
 *                         deterministic OUTSIDE the attestation — the ceiling on what
 *                         is recoverable at all.
 *
 * Two things are reported but NOT folded into a verdict, because neither is
 * decidable the way the four above are:
 *   source ref is a branch   externalParameters.workflow.ref / resolvedDependencies[0].uri
 *                            name a moving ref rather than a tag. Not a disqualifier —
 *                            you pin gitCommit regardless — but a hazard for any rebuild
 *                            that reads the ref instead of the commit.
 *   install discipline       what the publish workflow runs to install dependencies.
 *                            A grep over one YAML cannot follow a publish that goes
 *                            through a package script (`pnpm run ci-publish`) or a
 *                            reusable workflow, and it must not pretend to: those are
 *                            'indeterminate', and global tool installs (`npm i -g pnpm`)
 *                            are stripped so they are not read as the dependency install.
 *
 * Not a security claim: every signature is valid and every artifact is what the
 * project built. It is about whether "re-derive it" is a decidable instruction.
 *
 *   node eligible.cjs --report                      # re-print eligibility.json
 *   rm -rf cache/
 *   node eligible.cjs --out=eligibility-<today>.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const PARTIAL = path.join(CACHE, '.partial-run');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT_NAME = path.basename(arg('out', 'eligibility.json'));
const OUT = path.join(HERE, OUT_NAME);

const SEEDS = [
  'react', 'vue', 'next', 'vite', 'typescript', 'eslint', 'webpack', 'rollup',
  'jest', 'vitest', 'axios', 'express', '@babel/core', 'playwright', 'prettier',
  'esbuild', 'tailwindcss', 'zod', 'rxjs', '@typescript-eslint/parser',
];
const DEPTH = 2;
const RECORDED = ['eligibility.json'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheKey = (kind, id) => path.join(CACHE, kind + '__' + id.replace(/[^\w.@-]/g, '_') + '.json');

let unreachable = 0;

async function getJSON(url, kind, id) {
  const f = cacheKey(kind, id);
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8');
    if (raw === 'NULL') return null;
    try { return JSON.parse(raw); } catch { unreachable++; return null; }
  }
  let out = null, answered = false;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'provenance-drift-eligibility' } });
    if (res.ok) { out = await res.json(); answered = true; }
    else if (res.status === 404) { answered = true; }
  } catch {}
  if (!answered) { unreachable++; await sleep(40); return null; }
  fs.writeFileSync(f, out === null ? 'NULL' : JSON.stringify(out));
  await sleep(40);
  return out;
}

async function ghText(repo, ref, filePath) {
  const id = `${repo}@${ref}@${filePath}`;
  const f = cacheKey('ghtext', id);
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8');
    return raw === 'NULL' ? null : raw;
  }
  let out = null, answered = false;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`, {
      headers: { 'user-agent': 'provenance-drift-eligibility' },
    });
    if (res.ok) { out = await res.text(); answered = true; }
    else if (res.status === 404) { answered = true; }
  } catch {}
  if (!answered) { unreachable++; await sleep(40); return null; }
  fs.writeFileSync(f, out === null ? 'NULL' : out);
  await sleep(40);
  return out;
}

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

async function provenance(name, version) {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name).replace('%40', '@')}@${version}`;
  const doc = await getJSON(url, 'attest', `${name}@${version}`);
  if (!doc || !doc.attestations) return null;
  let slsa = null;
  for (const b of doc.attestations) {
    const env = b.bundle && b.bundle.dsseEnvelope;
    if (!env) continue;
    let pay;
    try { pay = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')); } catch { continue; }
    if (pay.predicateType !== 'https://slsa.dev/provenance/v1') continue;
    const bd = (pay.predicate && pay.predicate.buildDefinition) || {};
    const rd = bd.resolvedDependencies || [];
    if (!rd.length || !rd[0].digest || !rd[0].digest.gitCommit) continue;
    slsa = {
      commit: rd[0].digest.gitCommit,
      depCount: rd.length,
      uri: rd[0].uri || '',
      subjectSha512: (pay.subject && pay.subject[0] && pay.subject[0].digest && pay.subject[0].digest.sha512) || '',
      event: ((bd.internalParameters || {}).github || {}).event_name || '?',
      workflowRef: ((bd.externalParameters || {}).workflow || {}).ref || '',
      workflowPath: ((bd.externalParameters || {}).workflow || {}).path || '',
      repo: ((bd.externalParameters || {}).workflow || {}).repository || '',
    };
  }
  return slsa;
}

const isTag = (ref) => /\/tags\//.test(ref || '');
const hexToB64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

/**
 * What the publish workflow runs to install dependencies, read from the one YAML
 * the attestation names. Global tool installs (`npm i -g pnpm`, `npm i -g npm@11`)
 * are stripped per command fragment so they are not read as the dependency install.
 * A publish that goes through a package script or a reusable workflow is reported
 * as indeterminate — a grep cannot follow it and does not pretend to. This is a
 * reported signal, not a pass/fail: it is NOT one of the decidable columns.
 */
function installSignal(wf) {
  if (wf === null) return 'workflow-unreadable';
  const frags = wf.split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim());
  const isGlobal = (f) => /\b(?:npm (?:i|install)|pnpm add|yarn (?:global )?add)\b[^\n]*(?:\s-g\b|--global|--location=global)/.test(f);
  const dep = frags.filter((f) => f && !isGlobal(f));
  const has = (re) => dep.some((f) => re.test(f));
  if (has(/\bnpm ci\b/) || has(/--frozen-lockfile\b/) || has(/--immutable\b/)) return 'frozen-explicit';
  if (has(/\bpnpm (?:i\b|install\b)/)) return 'pnpm-install';
  if (has(/\bnpm (?:i\b|install\b)/)) return 'npm-install-unpinned';
  if (has(/\byarn(?:\s+install)?\b/)) return 'yarn-install';
  if (/uses:\s*["']?(?:[\w.-]+\/[\w.-]+|\.)\/\.github\/workflows\//.test(wf)) return 'indeterminate-reusable';
  return 'indeterminate-script'; // publish via a package script, no direct dep install in the workflow
}

async function lockfileAt(repo, commit) {
  for (const lf of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const t = await ghText(repo, commit, lf);
    if (t !== null) return lf;
  }
  return null;
}

function recordRun(file, text) {
  const p = path.join(HERE, 'runs-eligibility.json');
  let runs = [];
  if (fs.existsSync(p)) { try { runs = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { runs = []; } }
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const recorded = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const entry = { file, recorded, rows: JSON.parse(text).length, sha256: crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex') };
  runs = runs.filter((r) => r.file !== file);
  runs.push(entry);
  runs.sort((a, b) => String(a.recorded).localeCompare(String(b.recorded)));
  fs.writeFileSync(p, JSON.stringify(runs, null, 2));
  console.log(`  recorded in runs-eligibility.json as ${recorded}, sha256 ${entry.sha256.slice(0, 12)}…`);
}

async function main() {
  if (RECORDED.includes(OUT_NAME) && fs.existsSync(OUT)) {
    console.log(`\n  ${OUT_NAME} is a recorded table; a new run needs its own name:`);
    console.log('    node eligible.cjs --out=eligibility-<today>.json\n');
    process.exit(1);
  }
  if (fs.existsSync(PARTIAL)) {
    console.log(`\n  cache/ is from a run that did not finish: ${fs.readFileSync(PARTIAL, 'utf8').trim()}.`);
    console.log('    rm -rf cache/   and run again.\n');
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
    const integrity = (meta.dist && meta.dist.integrity) || '';

    const prov = await provenance(name, latest);
    if (!prov) { rows.push({ name, version: latest, status: 'no-provenance' }); continue; }

    const repo = (prov.repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (!repo || repo.split('/').length !== 2) { rows.push({ name, version: latest, status: 'no-github-repo' }); continue; }

    const sourcePinnable = !!prov.commit;
    const subjectMatch = !!prov.subjectSha512 && !!integrity && ('sha512-' + hexToB64(prov.subjectSha512)) === integrity;
    const depSetRecorded = prov.depCount > 1; // the commit is entry 0; >1 would mean deps are named
    const branchHazard = !(isTag(prov.workflowRef) || isTag(prov.uri));

    const wf = prov.workflowPath ? await ghText(repo, prov.commit, prov.workflowPath) : null;
    const install = installSignal(wf);
    const lock = await lockfileAt(repo, prov.commit);

    rows.push({
      name, version: latest, repo, commit: prov.commit, event: prov.event,
      workflowRef: prov.workflowRef, workflowPath: prov.workflowPath,
      sourcePinnable, subjectMatch, depCount: prov.depCount, depSetRecorded,
      branchHazard, lock, install,
      status: 'provenance',
    });
  }

  if (unreachable) {
    fs.writeFileSync(PARTIAL, `${unreachable} unanswered read(s)\n`);
    console.log(`\n  ${unreachable} request(s) failed for a reason other than a 404. Nothing written.`);
    console.log('    rm -rf cache/   and run again.\n');
    process.exitCode = 1;
    return;
  }

  report(rows);
  if (process.exitCode) { console.log('\n  checks did not pass, nothing written.\n'); return; }
  const text = JSON.stringify(rows, null, 2);
  fs.writeFileSync(OUT, text);
  console.log(`\n  written to ${OUT_NAME}`);
  if (!RECORDED.includes(OUT_NAME)) recordRun(OUT_NAME, text);
}

function report(rows) {
  const prov = rows.filter((r) => r.status === 'provenance');
  const n = prov.length;
  const c = (f) => prov.filter(f).length;
  const lock = c((r) => r.lock);
  console.log('');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  packages in frame                     ${rows.length}`);
  console.log(`    no provenance / no github repo      ${rows.length - n}`);
  console.log(`    readable SLSA provenance            ${n}   <- the denominator`);
  console.log('');
  console.log('  decidable from the bundle (a funnel):');
  console.log(`    source pinnable (gitCommit)         ${c((r) => r.sourcePinnable)} / ${n}`);
  console.log(`    artifact identified (subject==int)  ${c((r) => r.subjectMatch)} / ${n}`);
  console.log(`    dependency set recorded in bundle   ${c((r) => r.depSetRecorded)} / ${n}   <- the wall: the resolve is not attested`);
  console.log('');
  console.log(`  committed lock at the attested commit ${lock} / ${n}   (the ceiling on recovering the resolve OUTSIDE the bundle)`);
  console.log(`    no committed lock                   ${n - lock} / ${n}`);
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('\n  So: re-derivable from the attestation ALONE for 0 of ' + n + ' — the');
  console.log('  resolved dependency set is never one of its inputs. At most ' + lock + ' could be');
  console.log('  made deterministic with the committed lock, IF the build installs frozen.');

  console.log('\n  reported, not a verdict —');
  console.log(`  source ref is a moving branch (rebuild hazard): ${c((r) => r.branchHazard)} / ${n}`);
  const inst = {};
  for (const r of prov) inst[r.install] = (inst[r.install] || 0) + 1;
  console.log('  install discipline read from the publish workflow (coarse; indeterminate = a grep cannot follow it):');
  for (const [k, v] of Object.entries(inst).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(26)} ${v}`);
  const lk = {};
  for (const r of prov) lk[r.lock || 'none'] = (lk[r.lock || 'none'] || 0) + 1;
  console.log('  committed lockfile kind:');
  for (const [k, v] of Object.entries(lk).sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(26)} ${v}`);

  if (!n) { console.log('\n  no attested packages read — measuring a bug, not the ecosystem.'); process.exitCode = 1; }
  if (c((r) => r.subjectMatch) !== n || c((r) => r.sourcePinnable) !== n) {
    console.log('\n  note: a package that is not source-pinnable or whose subject != integrity is a');
    console.log('  different kind of row and would need its own bucket before any count is trusted.');
  }
}

if (process.argv.includes('--report')) {
  const which = path.basename(arg('rows', 'eligibility.json'));
  console.log(`\n  ${which}`);
  report(JSON.parse(fs.readFileSync(path.join(HERE, which), 'utf8')));
} else {
  main();
}
