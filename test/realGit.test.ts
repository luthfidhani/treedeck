// Runs the parsers against real git output in a throwaway repo, so fixture assumptions can't drift from git.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parseBranchRefs,
  parseNameStatus,
  parseStatusPorcelainZ,
  parseWorktreeList,
  statusLetter,
} from '../src/git/parse';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'treedeck-')));
const main = path.join(tmp, 'main repo');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('real git', () => {
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t');
  git(main, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(main, 'old name.txt'), 'x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');

  it('lists worktrees: unicode path, locked w/ reason, detached, prunable', () => {
    const feat = path.join(tmp, 'feat ünï');
    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', feat);
    git(main, 'worktree', 'lock', '--reason', 'on usb', feat);
    git(main, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'det'));
    git(main, 'worktree', 'add', '-q', '-b', 'gone', path.join(tmp, 'gone'));
    fs.rmSync(path.join(tmp, 'gone'), { recursive: true });

    const wts = parseWorktreeList(git(main, 'worktree', 'list', '--porcelain'));
    expect(wts.map((w) => [path.basename(w.path), w.branch, w.isMain])).toEqual([
      ['main repo', 'main', true],
      ['det', undefined, false],
      ['feat ünï', 'feature/x', false],
      ['gone', 'gone', false],
    ]);
    expect(wts[1].detached).toBe(true);
    expect(wts[2].locked).toBe('on usb');
    expect(wts[3].prunable).toBeDefined();
  });

  it('parses status with rename, untracked dir, modify', () => {
    git(main, 'mv', 'old name.txt', 'new näme.txt');
    fs.writeFileSync(path.join(main, 'a.txt'), 'b\n');
    fs.mkdirSync(path.join(main, 'sub dir'));
    fs.writeFileSync(path.join(main, 'sub dir', 'u.txt'), 'u\n');
    const ch = parseStatusPorcelainZ(git(main, 'status', '--porcelain=v1', '-z', '--untracked-files=all'));
    expect(ch.map((c) => [c.path, statusLetter(c), c.origPath])).toEqual([
      ['a.txt', 'M', undefined],
      ['new näme.txt', 'R', 'old name.txt'],
      ['sub dir/u.txt', 'U', undefined],
    ]);
  });

  it('parses diff --name-status -z with rename', () => {
    git(main, 'commit', '-qam', 'rename');
    const out = git(main, 'diff', '--name-status', '-z', '-M', 'HEAD~1', 'HEAD');
    expect(parseNameStatus(out)).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'R', origPath: 'old name.txt', path: 'new näme.txt' },
    ]);
  });

  it('parses for-each-ref branch output from this git version', () => {
    const format =
      '%(refname:short)\t%(objectname)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:raw)';
    const refs = parseBranchRefs(git(main, 'for-each-ref', `--format=${format}`, 'refs/heads'));
    // main plus the branches created by the worktree test above.
    expect(refs.map((r) => r.name).sort()).toEqual(['feature/x', 'gone', 'main']);
    const m = refs.find((r) => r.name === 'main')!;
    expect(m.head).toMatch(/^[0-9a-f]{40}$/);
    expect(m.date).toBeGreaterThan(1_600_000_000); // a real unix timestamp, not NaN
    expect(m.upstream).toBeUndefined(); // no remote in this fixture
    expect([m.ahead, m.behind, m.gone]).toEqual([0, 0, false]);
  });
});
