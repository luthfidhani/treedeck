import * as path from 'path';
import { normPath } from '../util';
import { parseStatusPorcelainZ, parseWorktreeList, type FileChange, type Worktree } from './parse';
import { git, GitError } from './run';

export interface Repo {
  /** Normalized shared git dir; identifies the repo across all its worktrees. */
  commonDir: string;
  name: string;
  /** Any folder inside the repo, used as cwd for repo-wide commands. */
  cwd: string;
  /** Normalized toplevels of workspace folders in this repo = worktrees open in this window. */
  openPaths: Set<string>;
  worktrees: Worktree[];
}

/** Finds the git repos behind the given folders, deduped by common dir (two folders from one repo = one repo). */
export async function discoverRepos(folders: string[]): Promise<Repo[]> {
  const repos = new Map<string, Repo>();
  const found = await Promise.all(
    folders.map(async (f) => {
      try {
        // --git-common-dir points at the main .git even from a linked worktree; may be relative to cwd.
        const common = normPath(path.resolve(f, (await git(['rev-parse', '--git-common-dir'], f)).trim()));
        // Fails in a bare repo (no work tree); that's fine, nothing is "current" then.
        const top = await git(['rev-parse', '--show-toplevel'], f).then(
          (s) => normPath(s.trim()),
          () => undefined,
        );
        return { f, common, top };
      } catch (e) {
        if (e instanceof GitError && e.notInstalled) throw e;
        return undefined; // not a git repo
      }
    }),
  );
  for (const x of found) {
    if (!x) continue;
    let repo = repos.get(x.common);
    if (!repo)
      repos.set(
        x.common,
        (repo = { commonDir: x.common, cwd: x.f, name: '', openPaths: new Set(), worktrees: [] }),
      );
    if (x.top) repo.openPaths.add(x.top);
  }
  await Promise.all(
    [...repos.values()].map(async (r) => {
      r.worktrees = parseWorktreeList(await git(['worktree', 'list', '--porcelain'], r.cwd));
      const main = r.worktrees[0];
      r.name = path
        .basename(main && !main.bare ? main.path : r.commonDir.replace(/[\\/]\.git$/, ''))
        .replace(/\.git$/, '');
    }),
  );
  return [...repos.values()];
}

export async function statusOf(worktreePath: string): Promise<FileChange[]> {
  const out = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    worktreePath,
    30_000,
  );
  return parseStatusPorcelainZ(out);
}

export async function listBranches(cwd: string): Promise<{ local: string[]; remote: string[] }> {
  const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], cwd)).split(
    '\n',
  );
  return {
    local: refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)),
    remote: refs
      .filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')) // skip the origin/HEAD alias
      .map((r) => r.slice('refs/remotes/'.length)),
  };
}

const refExists = (cwd: string, ref: string) =>
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).then(
    () => true,
    () => false,
  );

/** Configured base, else main, master, then whatever origin/HEAD points at. */
export async function detectBaseBranch(cwd: string, configured: string): Promise<string> {
  const originHead = configured
    ? ''
    : await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).then(
        (s) => s.trim(),
        () => '',
      );
  const candidates = configured ? [configured] : ['main', 'master', originHead].filter(Boolean);
  for (const c of candidates) if (await refExists(cwd, c)) return c;
  throw new GitError(
    configured
      ? `Base branch "${configured}" not found. Check the "treedeck.baseBranch" setting.`
      : 'No base branch found (tried main, master, origin/HEAD). Set "treedeck.baseBranch".',
  );
}

/** [ahead, behind] vs the branch's upstream, or undefined when there's no upstream (or detached). */
export async function aheadBehind(worktreePath: string): Promise<[number, number] | undefined> {
  try {
    const out = await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], worktreePath);
    const [ahead, behind] = out.trim().split(/\s+/).map(Number);
    return [ahead, behind];
  } catch {
    return undefined;
  }
}
