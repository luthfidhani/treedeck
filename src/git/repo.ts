import * as path from 'path';
import { normPath } from '../util';
import {
  parseBranchRefs,
  parseCommits,
  parseNameStatus,
  parseStatusPorcelainZ,
  parseWorktreeList,
  type BranchRef,
  type Commit,
  type FileChange,
  type NameStatus,
  type Worktree,
} from './parse';
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

// Tab separated: git forbids tabs (and spaces) in ref names, so this can't be ambiguous.
const BRANCH_FORMAT =
  '%(refname:short)\t%(objectname)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:raw)' +
  '\t%(authorname)\t%(authoremail:trim)';

export async function listLocalBranches(cwd: string): Promise<BranchRef[]> {
  return parseBranchRefs(await git(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'], cwd, 30_000));
}

/**
 * Remote-tracking branches (`origin/x`). A branch someone else pushed — the branch behind a pull
 * request, say — exists only here until you check it out, so the list would miss it otherwise.
 * These are only as fresh as the last `git fetch`; TreeDeck never fetches by itself.
 */
export async function listRemoteBranches(cwd: string): Promise<BranchRef[]> {
  const refs = parseBranchRefs(
    await git(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/remotes'], cwd, 30_000),
  );
  // `origin/HEAD` is an alias for the default branch, not a branch of its own.
  return refs.filter((r) => !r.name.endsWith('/HEAD')).map((r) => ({ ...r, remote: true }));
}

/** `origin/feature/x` → `feature/x`. */
export const withoutRemote = (name: string): string => name.slice(name.indexOf('/') + 1);

/** Files changed on `branch` since it forked from `base` — three-dot, the same set a PR shows. */
export async function branchDiff(
  cwd: string,
  base: string,
  branch: string,
): Promise<{ mergeBase: string; files: NameStatus[] }> {
  const mergeBase = (await git(['merge-base', base, branch], cwd)).trim();
  const files = parseNameStatus(
    await git(['diff', '--name-status', '-z', '-M', `${base}...${branch}`], cwd, 60_000),
  );
  return { mergeBase, files };
}

/** Upstream of a branch (`origin/main`), or undefined when it has none. */
export function upstreamOf(cwd: string, branch: string): Promise<string | undefined> {
  return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], cwd).then(
    (s) => s.trim() || undefined,
    () => undefined,
  );
}

export function checkoutBranch(cwd: string, branch: string): Promise<string> {
  return git(['checkout', branch], cwd, 120_000);
}

/** Creates a local branch that tracks `origin/x` and checks it out. */
export function checkoutRemoteBranch(cwd: string, remoteRef: string): Promise<string> {
  return git(['checkout', '-b', withoutRemote(remoteRef), '--track', remoteRef], cwd, 120_000);
}

/**
 * Local branches whose tip is already reachable from `base`, i.e. merged the ordinary way.
 * One call for the whole repo. A squash- or rebase-merge rewrites commits, so it isn't listed here;
 * that case usually shows up as a deleted upstream ("gone") instead.
 */
export async function listMergedBranches(cwd: string, base: string): Promise<string[]> {
  const out = await git(
    ['for-each-ref', '--merged', base, '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    cwd,
    30_000,
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const COMMIT_FORMAT = '%H%x09%h%x09%an%x09%ae%x09%at%x09%s';

/** Commits in `range` (e.g. `main..feature`, or just a branch name), newest first. */
export async function listCommits(cwd: string, range: string, limit = 50): Promise<Commit[]> {
  const out = await git(['log', `--max-count=${limit}`, `--format=${COMMIT_FORMAT}`, range], cwd, 60_000);
  return parseCommits(out);
}

/** Files a single commit touched, compared with its first parent. */
export async function commitFiles(cwd: string, sha: string): Promise<NameStatus[]> {
  // --format= silences the commit header; -m --first-parent gives a merge commit a file list too.
  const out = await git(
    ['show', '--name-status', '-z', '-M', '--format=', '-m', '--first-parent', sha],
    cwd,
    60_000,
  );
  return parseNameStatus(out);
}

/**
 * The one command TreeDeck runs that touches the network, and only when you press Fetch.
 * `--prune` drops remote-tracking branches whose remote branch is gone, which is what makes
 * the branch list match the remote again.
 */
export function fetchAll(cwd: string): Promise<string> {
  return git(['fetch', '--all', '--prune'], cwd, 300_000);
}
