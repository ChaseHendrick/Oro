import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const require = createRequire(import.meta.url);

function pngSize(buf) {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('icons', () => {
  it('ships every PNG at the advertised size', () => {
    expect(pngSize(read('build/icon.png'))).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(read('public/icon-192.png'))).toEqual({ width: 192, height: 192 });
    expect(pngSize(read('public/icon-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(read('public/icon-maskable-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(read('public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('has a Windows .ico with 16 to 256 px images', () => {
    const ico = read('build/icon.ico');
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      const size = ico[e] || 256;
      const length = ico.readUInt32LE(e + 8);
      const offset = ico.readUInt32LE(e + 12);
      expect(pngSize(ico.subarray(offset, offset + length))).toEqual({ width: size, height: size });
      sizes.push(size);
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('has SVG sources with the Oro palette', () => {
    for (const file of ['build/icon.svg', 'public/favicon.svg']) {
      const svg = read(file).toString('utf8');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).toContain('viewBox="0 0 1024 1024"');
      expect(svg.toLowerCase()).toContain('#ff7a45');
      expect(svg.trim().endsWith('</svg>')).toBe(true);
    }
  });
});

describe('web manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest').toString('utf8'));
  it('describes an installable standalone app', () => {
    expect(manifest).toMatchObject({ name: 'Oro', short_name: 'Oro', display: 'standalone', start_url: './', scope: './' });
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('only references icons that exist, including a maskable one', () => {
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(false); // relative, so sub-path hosting works
      expect(fs.existsSync(path.join(ROOT, 'public', icon.src))).toBe(true);
    }
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('electron-builder config proposal', () => {
  const add = JSON.parse(read('docs/package-json-additions.json').toString('utf8'));
  const b = add.build;
  it('matches the agreed identity and outputs', () => {
    expect(add.main).toBe('electron/main.cjs');
    expect(b).toMatchObject({ appId: 'com.hendrickresearch.orograph', productName: 'Oro', asar: true });
    expect(b.directories.output).toBe('release');
    expect(b.files).toEqual(['dist/**', 'electron/**', 'package.json']);
    expect(add.dependencies).toEqual({});
    expect(Object.keys(add.devDependencies)).toEqual(expect.arrayContaining(['three', '@dimforge/rapier3d-compat', 'electron', 'electron-builder']));
  });
  it('targets every platform with stable download names', () => {
    expect(b.mac.target).toEqual([{ target: 'dmg', arch: ['x64', 'arm64'] }, { target: 'zip', arch: ['x64', 'arm64'] }]);
    expect(b.mac).toMatchObject({ category: 'public.app-category.music', hardenedRuntime: false });
    expect(b.win.target.map((t) => t.target)).toEqual(['nsis', 'portable']);
    expect(b.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true });
    expect(b.linux.target.map((t) => t.target)).toEqual(['AppImage', 'tar.gz']);
    expect(b.linux.category).toBe('Audio');
    const names = [b.mac.artifactName, b.dmg.artifactName, b.nsis.artifactName, b.portable.artifactName, b.linux.artifactName];
    for (const n of names) expect(n).not.toContain('${version}');
    for (const icon of [b.icon, b.mac.icon, b.win.icon, b.linux.icon]) expect(fs.existsSync(path.join(ROOT, icon))).toBe(true);
  });
  it('packs everything main.cjs requires', () => {
    const main = read('electron/main.cjs').toString('utf8');
    for (const [, rel] of main.matchAll(/require\('(\.\/[^']+)'\)/g)) {
      expect(fs.existsSync(path.join(ROOT, 'electron', rel))).toBe(true);
    }
  });
});

describe('GitHub workflows', () => {
  let yaml = null;
  try { yaml = require('js-yaml'); } catch { /* optional: only present via electron-builder */ }

  it.skipIf(!yaml)('parse and pin actions to major versions', () => {
    for (const file of ['ci.yml', 'desktop.yml']) {
      const wf = yaml.load(read(`.github/workflows/${file}`).toString('utf8'));
      expect(Object.keys(wf.jobs).length).toBeGreaterThan(0);
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) {
          if (step.uses) expect(step.uses).toMatch(/^actions\/(checkout|setup-node|upload-artifact|download-artifact)@v4$/);
        }
      }
    }
  });

  it.skipIf(!yaml)('publishes a release only from pushes, with write access only there', () => {
    const wf = yaml.load(read('.github/workflows/desktop.yml').toString('utf8'));
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.release.permissions).toEqual({ contents: 'write' });
    expect(wf.jobs.release.if).toContain("github.event_name == 'push'");
    expect(wf.jobs.release.needs).toEqual(['web', 'desktop']);
    expect(wf.jobs.desktop.strategy.matrix.include.map((m) => m.os)).toEqual(['macos-latest', 'windows-latest', 'ubuntu-latest']);
  });
});
