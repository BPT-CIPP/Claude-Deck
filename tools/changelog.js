'use strict';
// CHANGELOG.md helpers for the release process (docs/CONTRIBUTING.md#versioning-and-releases).
//
//   node tools/changelog.js check              fail unless the package.json version is valid semver
//                                              and CHANGELOG.md has a dated section for it
//   node tools/changelog.js notes [version]    print that version's section (default: package.json's),
//                                              used as the GitHub release notes

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

// The body of "## [version] - date", up to the next "## " heading or the link references.
function section(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && (l.startsWith('## ') || /^\[[^\]]+\]: /.test(l)));
  if (end === -1) end = lines.length;
  return { heading: lines[start], body: lines.slice(start + 1, end).join('\n').trim() };
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (cmd === 'notes') {
    const s = section(text, arg || version);
    if (!s) { console.error(`CHANGELOG.md has no section for ${arg || version}.`); process.exit(1); }
    process.stdout.write(`${s.body}\n`);
    return;
  }
  if (cmd !== 'check') { console.error('Usage: node tools/changelog.js check | notes [version]'); process.exit(2); }
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`package.json version "${version}" isn't MAJOR.MINOR.PATCH.`);
  const s = section(text, version);
  if (!s) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section. Add one describing this change.`);
  else {
    if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/.test(s.heading)) problems.push(`CHANGELOG.md heading "${s.heading}" should read "## [${version}] - YYYY-MM-DD".`);
    if (!s.body) problems.push(`CHANGELOG.md section for ${version} is empty.`);
    if (!new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: `, 'm').test(text)) problems.push(`CHANGELOG.md has no "[${version}]: <link>" reference at the bottom.`);
  }
  if (problems.length) { console.error(`Changelog check failed:\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log(`Changelog OK: ${version}.`);
}

if (require.main === module) main();
module.exports = { section };
