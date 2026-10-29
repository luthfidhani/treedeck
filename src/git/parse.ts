// Pure git output parsers. No vscode import so they can be unit-tested with plain fixture strings.

export interface Worktree {
  path: string;
  head?: string;
  /** Short branch name (`feature/x`). Undefined when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  /** Present (possibly '') when locked; the value is the lock reason. */
  locked?: string;
  /** Present when git considers the worktree prunable (usually: its folder is gone). */
  prunable?: string;
  /** git always lists the main worktree first. */
  isMain: boolean;
}

/**
 * Parses `git worktree list --porcelain`: blank-line separated records of `key[ value]` lines.
 * Keys we care about: worktree, HEAD, branch, bare, detached, locked [reason], prunable [reason].
 * Unknown keys are ignored so newer git versions don't break us.
 */
export function parseWorktreeList(out: string): Worktree[] {
  const result: Worktree[] = [];
  for (const block of out.replace(/\r\n/g, '\n').split('\n\n')) {
    let wt: Worktree | undefined;
    for (const line of block.split('\n')) {
      if (!line) continue;
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      const val = sp < 0 ? '' : line.slice(sp + 1);
      if (key === 'worktree') wt = { path: val, bare: false, detached: false, isMain: result.length === 0 };
      else if (!wt) continue;
      else if (key === 'HEAD') wt.head = val;
      else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'bare') wt.bare = true;
      else if (key === 'detached') wt.detached = true;
      else if (key === 'locked') wt.locked = val;
      else if (key === 'prunable') wt.prunable = val;
    }
    if (wt) result.push(wt);
  }
  return result;
}

export interface FileChange {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** Source path for renames/copies. */
  origPath?: string;
  /** Index (staged) status char. */
  x: string;
  /** Working-tree status char. */
  y: string;
}

/**
 * Parses `git status --porcelain=v1 -z`. Each entry is `XY path`, NUL-terminated.
 * For renames/copies the entry is `XY new\0old\0`: the source path is the *next* field.
 * With -z paths are never quoted, so spaces/unicode come through verbatim.
 */
export function parseStatusPorcelainZ(out: string): FileChange[] {
  const parts = out.split('\0');
  const result: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue; // trailing empty field
    const change: FileChange = { x: entry[0], y: entry[1], path: entry.slice(3) };
    if (change.x === 'R' || change.x === 'C') change.origPath = parts[++i];
    if (change.x !== '!') result.push(change); // ignored files, only shown with --ignored
  }
  return result;
}

/** Single letter matching the built-in Git extension: U untracked, ! conflict. */
export type StatusLetter = 'M' | 'A' | 'D' | 'R' | 'U' | '!';

export function statusLetter({ x, y }: FileChange): StatusLetter {
  if (x === '?') return 'U';
  // Unmerged: any U, or both-added / both-deleted.
  if (x === 'U' || y === 'U' || (x === y && (x === 'A' || x === 'D'))) return '!';
  if (x === 'R') return 'R';
  if (x === 'A' || x === 'C' || y === 'A') return 'A'; // y === 'A' is `git add -N` (intent to add)
  if (x === 'D' || y === 'D') return 'D';
  return 'M';
}

export interface NameStatus {
  status: string;
  path: string;
  origPath?: string;
}

/**
 * Parses `git diff --name-status -z`: `S\0path\0`, or for renames/copies `R100\0old\0new\0`.
 */
export function parseNameStatus(out: string): NameStatus[] {
  const p = out.split('\0');
  const result: NameStatus[] = [];
  for (let i = 0; i < p.length;) {
    const s = p[i++];
    if (!s) continue;
    const status = s[0];
    if (status === 'R' || status === 'C') result.push({ status, origPath: p[i++], path: p[i++] });
    else result.push({ status, path: p[i++] });
  }
  return result;
}

/** Minimal glob → RegExp: `**` (any depth), `*` (one segment), `?`. Match against `/`-separated paths. */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

/** Parses `git --version` → [major, minor], e.g. "git version 2.39.3 (Apple Git-146)". */
export function parseGitVersion(out: string): [number, number] | undefined {
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export interface BranchRef {
  name: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** An upstream is configured but no longer exists on the remote. */
  gone: boolean;
  /** Committer date, unix seconds; used for "most recent first". */
  date: number;
  /** Author of the branch's last commit. git records no "who created this branch". */
  author: string;
  authorEmail: string;
  /** A remote-tracking branch (`origin/x`) with no local branch of its own. */
  remote: boolean;
}

/**
 * Parses `git for-each-ref` with BRANCH_FORMAT (tab separated; git forbids tabs in ref names).
 * `%(upstream:track)` reads `[ahead 2, behind 1]`, `[gone]`, or is empty.
 */
export function parseBranchRefs(out: string): BranchRef[] {
  const result: BranchRef[] = [];
  for (const line of out.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const [name, head, upstream, track, date, author, email] = line.split('\t');
    if (!name) continue;
    result.push({
      name,
      head: head ?? '',
      upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
      gone: (track ?? '').includes('[gone]'),
      date: Number((date ?? '').trim().split(' ')[0]) || 0,
      author: author ?? '',
      authorEmail: email ?? '',
      remote: false,
    });
  }
  return result;
}

/** `git diff --name-status` letter → the same status letters the panel uses for working-tree changes. */
export function nameStatusLetter(status: string): StatusLetter {
  if (status === 'A') return 'A';
  if (status === 'D') return 'D';
  if (status === 'R' || status === 'C') return 'R';
  if (status === 'U') return '!';
  return 'M';
}

export interface Commit {
  sha: string;
  short: string;
  author: string;
  authorEmail: string;
  /** Author date, unix seconds. */
  date: number;
  subject: string;
}

/**
 * Parses `git log` written with COMMIT_FORMAT: five tab separated fields then the subject,
 * one record per line. The subject keeps any tabs it contains, since it is taken as the rest.
 */
export function parseCommits(out: string): Commit[] {
  const result: Commit[] = [];
  for (const line of out.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 6) continue;
    result.push({
      sha: f[0],
      short: f[1],
      author: f[2],
      authorEmail: f[3],
      date: Number(f[4]) || 0,
      subject: f.slice(5).join('\t'),
    });
  }
  return result;
}
