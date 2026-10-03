// Regenerates THIRD_PARTY_NOTICES.md from the license files that ship inside
// node_modules, so the notices always match the versions actually bundled.
//
//   node dev/packaging/make-notices.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const nm = (...p) => path.join(ROOT, 'node_modules', ...p);
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
const version = (pkg) => JSON.parse(fs.readFileSync(nm(pkg, 'package.json'), 'utf8')).version;

function copyrightLines(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^copyright\b/i.test(l) && !/\[yyyy\]/.test(l));
}

const threeLicense = read(nm('three', 'LICENSE'));
const rapierLicense = read(nm('@dimforge', 'rapier3d-compat', 'LICENSE'));
const electronLicense = read(nm('electron', 'LICENSE'));
const viteLicense = read(nm('vite', 'LICENSE.md'));

const rapierCopyright = copyrightLines(rapierLicense);
if (rapierCopyright.length === 0) throw new Error('No copyright line found in the Rapier license');
const viteCopyright = copyrightLines(viteLicense)[0];

const fence = (text) => '```text\n' + text + '\n```';

const out = `# Third-party notices

Oro is MIT licensed (see [LICENSE](LICENSE)). It is an independent, clean-room
implementation; the only third-party code it ships is listed below. Every build of
Oro (the web app, the offline HTML file and the desktop apps) contains the first
two components. The desktop apps additionally contain Electron.

## three.js ${version('three')}

3D rendering. https://threejs.org, MIT License.

${copyrightLines(threeLicense).join('\n')}

${fence(threeLicense)}

## Rapier (@dimforge/rapier3d-compat) ${version('@dimforge/rapier3d-compat')}

Physics for the rolling dot. https://rapier.rs, Apache License 2.0.

${rapierCopyright.join('\n')}

Oro uses the published package unmodified (it is bundled into the app as is).
The full license text follows.

${fence(rapierLicense)}

## Electron ${version('electron')} (desktop apps only)

The desktop shell. https://www.electronjs.org, MIT License. Electron includes Chromium
and other open source components; their licenses ship inside every desktop app as
\`LICENSES.chromium.html\` next to \`LICENSE.electron.txt\`.

${fence(electronLicense)}

## Vite runtime helpers

The build tool, Vite, adds a few lines of loader code to the web build.
${viteCopyright}. MIT License (same terms as three.js above). https://vite.dev
`;

fs.writeFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), out);
console.log('wrote THIRD_PARTY_NOTICES.md');
