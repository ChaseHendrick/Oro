'use strict';

// CI validates emitted metadata against the exact packages before publishing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function verifyUpdateArtifacts(root, platform) {
  const manifest = { mac: 'latest-mac.yml', windows: 'latest.yml', linux: 'latest-linux.yml' }[platform];
  if (!manifest) throw new Error('Unknown package platform.');
  const metadata = yaml.load(fs.readFileSync(path.join(root, manifest), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || !Array.isArray(metadata.files) || metadata.files.length === 0) throw new Error('Invalid update manifest.');
  for (const file of metadata.files) {
    if (typeof file.url !== 'string' || path.basename(file.url) !== file.url || !file.url.startsWith('Orograph-')) throw new Error('Unexpected update package path.');
    const bytes = fs.readFileSync(path.join(root, file.url));
    if (crypto.createHash('sha512').update(bytes).digest('base64') !== file.sha512 || (file.size != null && file.size !== bytes.length)) throw new Error(`Update integrity metadata does not match ${file.url}.`);
  }
  const names = fs.readdirSync(root);
  const configs = names.filter(name => platform === 'mac' ? /^mac(?:-|$)/.test(name) : name === `${platform === 'windows' ? 'win' : 'linux'}-unpacked`)
    .map(name => path.join(root, name, ...(platform === 'mac' ? ['Orograph.app', 'Contents', 'Resources'] : ['resources']), 'app-update.yml'))
    .filter(file => fs.existsSync(file));
  if (!configs.length) throw new Error('The packaged app has no app-update.yml.');
  const first = fs.readFileSync(configs[0], 'utf8');
  for (const file of configs) {
    const config = yaml.load(fs.readFileSync(file, 'utf8'));
    if (config.provider !== 'github' || config.owner !== 'ChaseHendrick' || config.repo !== 'synth' || config.private === true || config.token) throw new Error('Unexpected update provider.');
  }
  // Runtime configs already live inside every app. Publish a platform-labelled
  // copy as well so release metadata can be audited without opening a bundle.
  fs.writeFileSync(path.join(root, `Orograph-app-update-${platform}.yml`), first);
  return metadata;
}
if (require.main === module) {
  verifyUpdateArtifacts(path.resolve(process.argv[2] || 'release'), process.argv[3]);
  console.log('Update manifests and packaged provider verified.');
}
module.exports = { verifyUpdateArtifacts };
