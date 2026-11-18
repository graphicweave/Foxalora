// Dev-dependency audit for CI: fails on high or critical advisories, except those listed in
// .github/audit-exceptions.json that have not expired. Production dependencies are audited
// separately with plain `npm audit --omit=dev`, without exceptions.
// Usage (from a package directory): node ../.github/scripts/audit-dev.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const listFile = fileURLToPath(new URL('../audit-exceptions.json', import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const active = new Map();
for (const e of JSON.parse(readFileSync(listFile, 'utf8')).exceptions) {
  if (e.expires >= today) active.set(e.advisory, e);
  else console.log(`Exception ${e.advisory} (${e.package}) expired on ${e.expires}; it counts again.`);
}

let raw;
try {
  raw = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout; // npm audit exits non-zero when it finds anything
}
const report = JSON.parse(raw);
if (report.error) {
  console.error('npm audit failed:', report.error.summary ?? report.error);
  process.exit(1);
}

const blocking = new Map();
const accepted = new Set();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue;
    const id = via.url.split('/').pop();
    if (active.has(id)) accepted.add(id);
    else blocking.set(id, `${via.severity}: ${via.name} ${via.range} - ${via.title} (${via.url})`);
  }
}

for (const id of accepted) console.log(`Accepted until ${active.get(id).expires}: ${id} (${active.get(id).package})`);
if (blocking.size) {
  console.error('High or critical advisories in dev dependencies:');
  for (const line of blocking.values()) console.error('  ' + line);
  process.exit(1);
}
console.log('No unaccepted high or critical advisories in dev dependencies.');
