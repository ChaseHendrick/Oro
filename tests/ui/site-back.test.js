import { describe, it, expect } from 'vitest';
import { isOnSite } from '../../src/ui/topbar.js';

describe('back link to hendrickresearch.com', () => {
  const loc = (protocol, pathname) => ({ protocol, pathname });
  it('shows only for the copy hosted under /music/oro/ (or the old /music/orograph/)', () => {
    expect(isOnSite(loc('https:', '/music/oro/'))).toBe(true);
    expect(isOnSite(loc('https:', '/music/oro'))).toBe(true);
    expect(isOnSite(loc('https:', '/music/orograph/'))).toBe(true);
    expect(isOnSite(loc('https:', '/music/orograph'))).toBe(true);
    expect(isOnSite(loc('http:', '/music/orograph/index.html'))).toBe(true);
  });
  it('stays hidden in the desktop app, the offline file and other paths', () => {
    expect(isOnSite(loc('app:', '/index.html'))).toBe(false);
    expect(isOnSite(loc('file:', '/Users/me/Oro.html'))).toBe(false);
    expect(isOnSite(loc('http:', '/'))).toBe(false);
    expect(isOnSite(loc('https:', '/music/orographs/'))).toBe(false);
    expect(isOnSite(loc('https:', '/music/oros/'))).toBe(false);
    expect(isOnSite(null)).toBe(false);
  });
});
