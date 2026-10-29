import { describe, expect, it } from 'vitest';
import {
  globToRegExp,
  nameStatusLetter,
  parseBranchRefs,
  parseGitVersion,
  parseNameStatus,
  parseStatusPorcelainZ,
  parseWorktreeList,
  statusLetter,
} from '../src/git/parse';

describe('parseWorktreeList', () => {
  it('parses main, linked, detached, locked, prunable', () => {
    const out = [
      'worktree /repo/main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/my feature ünï',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/x',
      'locked',
      '',
      'worktree /repo/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'locked on usb drive',
      '',
      'worktree /repo/gone',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const wts = parseWorktreeList(out);
    expect(wts).toHaveLength(4);
    expect(wts[0]).toMatchObject({ path: '/repo/main', branch: 'main', isMain: true, detached: false });
    expect(wts[1]).toMatchObject({
      path: '/repo/my feature ünï',
      branch: 'feature/x',
      locked: '',
      isMain: false,
    });
    expect(wts[2]).toMatchObject({ detached: true, locked: 'on usb drive' });
    expect(wts[2].branch).toBeUndefined();
    expect(wts[3].prunable).toBe('gitdir file points to non-existent location');
  });

  it('parses a bare main repo and CRLF / Windows paths', () => {
    const out =
      'worktree C:/src/repo.git\r\nbare\r\n\r\nworktree C:/src/wt\r\nHEAD abc\r\nbranch refs/heads/dev\r\n';
    const wts = parseWorktreeList(out);
    expect(wts[0]).toMatchObject({ path: 'C:/src/repo.git', bare: true, isMain: true });
    expect(wts[1]).toMatchObject({ path: 'C:/src/wt', branch: 'dev' });
  });

  it('returns [] for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('parseStatusPorcelainZ', () => {
  it('handles staged, unstaged, untracked, renames, deletes, spaces', () => {
    const out = [
      'M  staged.ts',
      ' M unstaged.ts',
      '?? new dir/ü file.txt',
      'R  new.ts',
      'old.ts',
      ' D gone.ts',
      'AM added.ts',
      'UU conflict.ts',
      '',
    ].join('\0');
    const ch = parseStatusPorcelainZ(out);
    expect(ch.map((c) => [c.path, statusLetter(c)])).toEqual([
      ['staged.ts', 'M'],
      ['unstaged.ts', 'M'],
      ['new dir/ü file.txt', 'U'],
      ['new.ts', 'R'],
      ['gone.ts', 'D'],
      ['added.ts', 'A'],
      ['conflict.ts', '!'],
    ]);
    expect(ch[3].origPath).toBe('old.ts');
  });

  it('treats both-added and intent-to-add correctly', () => {
    const [aa, ita] = parseStatusPorcelainZ('AA both.ts\0 A ita.ts\0');
    expect(statusLetter(aa)).toBe('!');
    expect(statusLetter(ita)).toBe('A');
  });
});

describe('parseNameStatus', () => {
  it('parses -z output incl. renames', () => {
    const out = 'M\0src/a.ts\0R087\0old name.ts\0new name.ts\0A\0b.ts\0D\0c.ts\0';
    expect(parseNameStatus(out)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', origPath: 'old name.ts', path: 'new name.ts' },
      { status: 'A', path: 'b.ts' },
      { status: 'D', path: 'c.ts' },
    ]);
  });
});

describe('globToRegExp', () => {
  it('matches cursor agent worktrees', () => {
    const re = globToRegExp('**/.cursor/worktrees/**');
    expect(re.test('/Users/me/.cursor/worktrees/repo/abc')).toBe(true);
    expect(re.test('C:/Users/me/.cursor/worktrees/repo/abc')).toBe(true);
    expect(re.test('/Users/me/src/repo-feature')).toBe(false);
  });
  it('* stays within a segment', () => {
    expect(globToRegExp('/a/*/c').test('/a/b/c')).toBe(true);
    expect(globToRegExp('/a/*/c').test('/a/b/x/c')).toBe(false);
  });
});

describe('parseGitVersion', () => {
  it('parses Apple git', () => {
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual([2, 39]);
    expect(parseGitVersion('nope')).toBeUndefined();
  });
});

describe('parseBranchRefs', () => {
  it('parses tracking info, gone upstreams, authors and branches without one', () => {
    const ada = ['Ada Lovelace', '<ada@example.com>'];
    const out = [
      `main\taaa111\torigin/main\t\t1730000000 +0700\t${ada[0]}\t${ada[1]}`,
      'feature/x\tbbb222\torigin/feature/x\t[ahead 2, behind 1]\t1730001000 +0700\tGrace Hopper\t<g@h.dev>',
      `old\tccc333\torigin/old\t[gone]\t1729000000 +0000\t${ada[0]}\t${ada[1]}`,
      'local-only\tddd444\t\t\t1728000000 +0000\t\t',
      '',
    ].join('\n');
    expect(parseBranchRefs(out)).toEqual([
      {
        name: 'main',
        head: 'aaa111',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        gone: false,
        date: 1730000000,
        author: 'Ada Lovelace',
        authorEmail: '<ada@example.com>',
        remote: false,
      },
      {
        name: 'feature/x',
        head: 'bbb222',
        upstream: 'origin/feature/x',
        ahead: 2,
        behind: 1,
        gone: false,
        date: 1730001000,
        author: 'Grace Hopper',
        authorEmail: '<g@h.dev>',
        remote: false,
      },
      {
        name: 'old',
        head: 'ccc333',
        upstream: 'origin/old',
        ahead: 0,
        behind: 0,
        gone: true,
        date: 1729000000,
        author: 'Ada Lovelace',
        authorEmail: '<ada@example.com>',
        remote: false,
      },
      {
        name: 'local-only',
        head: 'ddd444',
        upstream: undefined,
        ahead: 0,
        behind: 0,
        gone: false,
        date: 1728000000,
        author: '',
        authorEmail: '',
        remote: false,
      },
    ]);
  });

  it('parses [ahead n] on its own and returns [] for empty output', () => {
    expect(parseBranchRefs('solo\tabc\torigin/solo\t[ahead 3]\t1 +0000\tAda\t<a@b.c>')[0]).toMatchObject({
      ahead: 3,
      behind: 0,
      author: 'Ada',
    });
    expect(parseBranchRefs('')).toEqual([]);
  });
});

describe('nameStatusLetter', () => {
  it('maps diff letters to panel status letters', () => {
    expect(['A', 'D', 'R', 'C', 'M', 'T', 'U'].map(nameStatusLetter)).toEqual([
      'A',
      'D',
      'R',
      'R',
      'M',
      'M',
      '!',
    ]);
  });
});
