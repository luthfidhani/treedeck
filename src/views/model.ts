import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  globToRegExp,
  nameStatusLetter,
  statusLetter,
  type BranchRef,
  type Commit,
  type FileChange,
  type NameStatus,
  type StatusLetter,
  type Worktree,
} from '../git/parse';
import {
  aheadBehind,
  branchDiff,
  commitFiles,
  detectBaseBranch,
  discoverRepos,
  listCommits,
  listLocalBranches,
  listMergedBranches,
  listRemoteBranches,
  statusOf,
  upstreamOf,
  withoutRemote,
  type Repo,
} from '../git/repo';
import { ensureGit, GitError } from '../git/run';
import { cfg, normPath } from '../util';

export interface WorktreeNode {
  repo: Repo;
  wt: Worktree;
  /** normPath(wt.path); cache key and the id the panel uses. */
  key: string;
  current: boolean;
  /** Matches treedeck.agentWorktreeGlobs (e.g. Cursor parallel-agent worktrees). */
  agent: boolean;
}
interface RepoEntry {
  repo: Repo;
  children: WorktreeNode[];
}

export const wtLabel = (wt: Worktree): string =>
  wt.branch ?? (wt.bare ? '(bare)' : wt.head ? wt.head.slice(0, 8) : '(unknown)');

/** Path relative to the main checkout's parent (`repo-feature`), else `~/…`, else absolute. */
export function shortPath(wt: Worktree, repo: Repo): string {
  const main = repo.worktrees[0];
  if (main) {
    const rel = path.relative(path.dirname(main.path), wt.path);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  const home = os.homedir();
  return wt.path.startsWith(home) ? '~' + wt.path.slice(home.length) : wt.path;
}

// ---- What the webview receives (plain JSON) ----
export interface FileView {
  path: string;
  orig?: string;
  letter: StatusLetter;
}
export interface WorktreeView {
  key: string;
  label: string;
  path: string;
  short: string;
  head?: string;
  branch?: string;
  current: boolean;
  main: boolean;
  agent: boolean;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
  /** Its branch is already contained in the base branch. */
  merged: boolean;
  /** Its branch tracked a remote branch that has since been deleted. */
  gone: boolean;
  /** Undefined until status has loaded. */
  files?: FileView[];
  changed?: number;
  error?: string;
  ahead?: number;
  behind?: number;
  /** Visible only because a changed file matched the search: the panel auto-expands it. */
  matchedByFile: boolean;
}
export interface BranchView {
  /** Full ref name: `feature/x`, or `origin/feature/x` for a branch that is only on the remote. */
  name: string;
  /** What the row shows: the name without its remote prefix. */
  label: string;
  /** No local branch of its own yet — it exists only on the remote. */
  remote: boolean;
  /** Checked out in the worktree open in this window. */
  current: boolean;
  /** Key of the worktree that has this branch checked out, if any (git allows only one). */
  worktreeKey?: string;
  /** Short folder name of that worktree, for the row's description. */
  worktreeShort?: string;
  /** Last commit date, unix seconds, and who wrote it. */
  date: number;
  author: string;
  authorEmail: string;
  upstream?: string;
  ahead: number;
  behind: number;
  gone: boolean;
  /** Already contained in the base branch. */
  merged: boolean;
  /** What `files` is compared against (base branch, or the branch's upstream for the base itself). */
  base?: string;
  /** Undefined until the branch is expanded; the files a PR for this branch would show. */
  files?: FileView[];
  changed?: number;
  error?: string;
  matchedByFile: boolean;
  /** Undefined until the branch is expanded in the Commits tab. */
  commits?: CommitView[];
}
export interface CommitView {
  sha: string;
  short: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: number;
  /** Undefined until the commit is expanded. */
  files?: FileView[];
}
/** Which rows the filter chips let through. */
export type FilterMode = 'all' | 'unmerged' | 'merged';

export interface PanelState {
  state: 'loading' | 'ok' | 'noFolder' | 'noRepo' | 'noGit';
  multiRepo: boolean;
  mode: FilterMode;
  repos: { key: string; name: string; worktrees: WorktreeView[]; branches: BranchView[] }[];
}

// ponytail: cap per worktree so a huge untracked dir can't bloat the webview; raise if someone needs more.
const MAX_FILES = 500;
const STATUS_CONCURRENCY = 2;
const AHEAD_BEHIND_TTL_MS = 60_000; // upstream only moves on fetch; a minute of staleness is fine
const RECENT_KEY = 'treedeck.recent';

export class WorktreeModel implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Anything shown in the panel changed (list, status, counts, filter). */
  readonly onDidChange = this.changed.event;
  private readonly loaded = new vscode.EventEmitter<WorktreeNode[]>();
  /** Fires after each (re)load of the worktree list. */
  readonly onDidLoad = this.loaded.event;

  private loading?: Promise<RepoEntry[]>;
  private roots: RepoEntry[] = [];
  private state: PanelState['state'] = 'loading';
  /** Status cache per worktree key. */
  private status = new Map<string, FileChange[]>();
  private errors = new Map<string, string>();
  /** In-flight status loads; a load only writes the cache if it's still the registered one (stale work is dropped). */
  private inflight = new Map<string, Promise<FileChange[]>>();
  private queue: WorktreeNode[] = [];
  private running = 0;
  private generation = 0;
  /** Keyed by `${key}@${head}`, so a new commit naturally misses the cache; TTL covers fetches. */
  private ab = new Map<string, { v?: [number, number]; at: number }>();
  private filter = '';
  /** Local branches per repo (commonDir). */
  private branches = new Map<string, BranchRef[]>();
  /** Base branch per repo, and the branches already merged into it. */
  private bases = new Map<string, string>();
  private merged = new Map<string, Set<string>>();
  /** Files per branch, keyed by branchKey(); loaded when the branch is expanded. */
  private branchFiles = new Map<string, { base: string; mergeBase: string; files: NameStatus[] }>();
  private branchErrors = new Map<string, string>();
  private branchInflight = new Set<string>();
  /** Commits per branch (branchKey) and files per commit sha, both loaded on expand. */
  private commits = new Map<string, Commit[]>();
  private commitFileCache = new Map<string, NameStatus[]>();
  private mode: FilterMode = 'all';

  /** @param memento persists last-open times for sortBy=recent */
  constructor(private readonly memento: vscode.Memento) {}

  get nodes(): WorktreeNode[] {
    return this.roots.flatMap((r) => r.children);
  }

  setFilter(f: string): void {
    this.filter = f.trim().toLowerCase();
    this.changed.fire();
  }

  setMode(mode: FilterMode): void {
    this.mode = mode;
    this.changed.fire();
  }

  /** Accepts a node, or `{ worktreeKey }` as sent by the panel and its context menus. */
  resolve(arg: unknown): WorktreeNode | undefined {
    if (arg && typeof arg === 'object') {
      if ('wt' in arg) return arg as WorktreeNode;
      const key = (arg as { worktreeKey?: unknown }).worktreeKey;
      if (typeof key === 'string') return this.nodes.find((n) => n.key === key);
    }
    return undefined;
  }

  resolveRepo(arg: unknown): Repo | undefined {
    const key = arg && typeof arg === 'object' ? (arg as { repoKey?: unknown }).repoKey : undefined;
    return this.resolve(arg)?.repo ?? this.roots.find((r) => r.repo.commonDir === key)?.repo;
  }

  changeFor(key: string, file: string): FileChange | undefined {
    return this.status.get(key)?.find((c) => c.path === file);
  }

  refresh(): void {
    this.loading = undefined;
    this.status.clear();
    this.errors.clear();
    this.inflight.clear();
    this.branches.clear();
    this.bases.clear();
    this.merged.clear();
    this.branchFiles.clear();
    this.branchErrors.clear();
    this.branchInflight.clear();
    this.commits.clear();
    this.commitFileCache.clear();
    this.queue = [];
    void this.repos(); // reload even while the panel is hidden, so the status bar stays current
    this.changed.fire();
  }

  /** Drops the cached status of the worktree containing `fsPath` and reloads it. */
  invalidate(fsPath: string): void {
    const p = normPath(fsPath) + path.sep;
    const node = this.nodes
      .filter((n) => p.startsWith(n.key + path.sep))
      .sort((a, b) => b.key.length - a.key.length)[0]; // nested worktrees: most specific wins
    if (!node) return;
    this.status.delete(node.key);
    this.inflight.delete(node.key);
    this.enqueue([node]);
  }

  repos(): Promise<RepoEntry[]> {
    this.loading ??= this.load();
    return this.loading;
  }

  /** User expanded a worktree: load its status now (ahead of the queue) and surface errors. */
  expand(key: string): void {
    const n = this.nodes.find((x) => x.key === key);
    if (n && !this.status.has(key)) {
      this.loadStatus(n).catch((e: Error) => void vscode.window.showErrorMessage(e.message));
    }
  }

  private async load(): Promise<RepoEntry[]> {
    const gen = ++this.generation;
    let state: PanelState['state'] = 'ok';
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    try {
      await ensureGit();
      const repos = await discoverRepos(folders);
      if (gen !== this.generation) return this.roots; // a newer refresh superseded us
      const agentRes = cfg('agentWorktreeGlobs').map((g) => globToRegExp(g, process.platform === 'win32'));
      this.roots = repos.map((repo) => ({
        repo,
        children: repo.worktrees.map((wt): WorktreeNode => {
          const key = normPath(wt.path);
          const agent = !wt.isMain && agentRes.some((re) => re.test(wt.path.replace(/\\/g, '/')));
          return { repo, wt, key, current: repo.openPaths.has(key), agent };
        }),
      }));
      if (!folders.length) state = 'noFolder';
      else if (!repos.length) state = 'noRepo';
    } catch (e) {
      this.roots = [];
      if (e instanceof GitError && e.notInstalled) state = 'noGit';
      else void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
    this.state = state;
    const current = this.nodes.filter((n) => n.current);
    if (current.length) {
      const recent = { ...this.memento.get<Record<string, number>>(RECENT_KEY, {}) };
      for (const n of current) recent[n.key] = Date.now();
      void this.memento.update(RECENT_KEY, recent);
    }
    this.loaded.fire(this.nodes);
    this.enqueue(this.nodes); // badges for everything, throttled
    for (const r of this.roots) void this.loadBranches(r.repo); // one cheap for-each-ref per repo
    this.changed.fire();
    return this.roots;
  }

  private async loadBranches(repo: Repo): Promise<void> {
    try {
      const [local, remote] = await Promise.all([
        listLocalBranches(repo.cwd),
        listRemoteBranches(repo.cwd).catch(() => []),
      ]);
      // A remote branch you already have locally is the same branch; keep only the ones you don't.
      const have = new Set(local.map((b) => b.name));
      this.branches.set(repo.commonDir, [
        ...local,
        ...remote.filter((r) => !have.has(withoutRemote(r.name))),
      ]);
    } catch {
      this.branches.set(repo.commonDir, []); // branches are a bonus; the worktree list still works
    }
    const base = await detectBaseBranch(repo.cwd, cfg('baseBranch')).catch(() => '');
    if (base) {
      this.bases.set(repo.commonDir, base);
      const merged = await listMergedBranches(repo.cwd, base).catch(() => []);
      this.merged.set(repo.commonDir, new Set(merged));
    }
    this.changed.fire();
  }

  /** True when the branch tracked a remote branch that no longer exists. */
  private isGone(repoKey: string, branch?: string): boolean {
    return !!branch && !!this.branches.get(repoKey)?.find((b) => b.name === branch)?.gone;
  }

  /** True when `branch` is already contained in the repo's base branch (the base itself doesn't count). */
  private isMerged(repoKey: string, branch?: string): boolean {
    const base = this.bases.get(repoKey);
    return !!branch && !!base && branch !== base && !!this.merged.get(repoKey)?.has(branch);
  }

  private static branchKey(repoKey: string, name: string): string {
    return `${repoKey}\0${name}`;
  }

  /** The worktree a branch is checked out in, if any. git allows at most one. */
  private worktreeOf(repoKey: string, name: string): WorktreeNode | undefined {
    return this.roots.find((r) => r.repo.commonDir === repoKey)?.children.find((n) => n.wt.branch === name);
  }

  /**
   * Loads the files a PR for this branch would show: its changes since it forked from the base branch.
   * The base branch itself is compared against its own upstream instead, so it isn't empty.
   */
  async expandBranch(repoKey: string, name: string): Promise<void> {
    const key = WorktreeModel.branchKey(repoKey, name);
    if (this.branchFiles.has(key) || this.branchInflight.has(key)) return;
    const repo = this.roots.find((r) => r.repo.commonDir === repoKey)?.repo;
    if (!repo) return;
    this.branchInflight.add(key);
    this.branchErrors.delete(key);
    try {
      const base = this.bases.get(repoKey) ?? (await detectBaseBranch(repo.cwd, cfg('baseBranch')));
      const against = base === name ? await upstreamOf(repo.cwd, name) : base;
      if (!against) {
        this.branchFiles.set(key, { base: '', mergeBase: '', files: [] });
        return;
      }
      const { mergeBase, files } = await branchDiff(repo.cwd, against, name);
      this.branchFiles.set(key, { base: against, mergeBase, files });
    } catch (e) {
      this.branchErrors.set(key, e instanceof Error ? e.message : String(e));
    } finally {
      this.branchInflight.delete(key);
      this.changed.fire();
    }
  }

  /**
   * Commits that this branch added on top of the base branch, newest first — the commits a PR
   * for it would list. For the base branch itself, its own latest commits.
   */
  async expandCommits(repoKey: string, name: string): Promise<void> {
    const key = WorktreeModel.branchKey(repoKey, name);
    if (this.commits.has(key) || this.branchInflight.has(key)) return;
    const repo = this.roots.find((r) => r.repo.commonDir === repoKey)?.repo;
    if (!repo) return;
    this.branchInflight.add(key);
    this.branchErrors.delete(key);
    try {
      const base = this.bases.get(repoKey);
      const range = base && base !== name ? `${base}..${name}` : name;
      this.commits.set(key, await listCommits(repo.cwd, range));
    } catch (e) {
      this.branchErrors.set(key, e instanceof Error ? e.message : String(e));
    } finally {
      this.branchInflight.delete(key);
      this.changed.fire();
    }
  }

  async expandCommit(repoKey: string, sha: string): Promise<void> {
    if (this.commitFileCache.has(sha) || this.branchInflight.has(sha)) return;
    const repo = this.roots.find((r) => r.repo.commonDir === repoKey)?.repo;
    if (!repo) return;
    this.branchInflight.add(sha);
    try {
      this.commitFileCache.set(sha, await commitFiles(repo.cwd, sha));
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      this.branchInflight.delete(sha);
      this.changed.fire();
    }
  }

  /** Everything the multi-file "Changes" view of one commit needs. */
  async commitChanges(
    repoKey: string,
    sha: string,
  ): Promise<{ cwd: string; files: NameStatus[]; short: string } | undefined> {
    await this.expandCommit(repoKey, sha);
    const repo = this.roots.find((r) => r.repo.commonDir === repoKey)?.repo;
    const files = this.commitFileCache.get(sha);
    return repo && files ? { cwd: repo.cwd, files, short: sha.slice(0, 7) } : undefined;
  }

  /** Everything the multi-file "Changes" view of a whole branch needs (its diff against the base). */
  async branchChanges(
    repoKey: string,
    name: string,
  ): Promise<{ cwd: string; mergeBase: string; base: string; files: NameStatus[] } | undefined> {
    await this.expandBranch(repoKey, name);
    const repo = this.roots.find((r) => r.repo.commonDir === repoKey)?.repo;
    const loaded = this.branchFiles.get(WorktreeModel.branchKey(repoKey, name));
    const error = this.branchErrors.get(WorktreeModel.branchKey(repoKey, name));
    if (error) throw new Error(error);
    return repo && loaded ? { cwd: repo.cwd, ...loaded } : undefined;
  }

  /** What one file of one commit needs to open as a diff against the commit's parent. */
  commitDiffTarget(
    repoKey: string,
    sha: string,
    file: string,
  ): { cwd: string; entry: NameStatus; short: string } | undefined {
    const repo = this.roots.find((r) => r.repo.commonDir === repoKey)?.repo;
    const entry = this.commitFileCache.get(sha)?.find((f) => f.path === file);
    return repo && entry ? { cwd: repo.cwd, entry, short: sha.slice(0, 7) } : undefined;
  }

  /** Where a checkout of `name` should run: the worktree open in this window, else the main checkout. */
  checkoutTarget(
    repoKey: string,
    name: string,
  ): { repo: Repo; cwd: string; takenBy?: WorktreeNode; remote: boolean } | undefined {
    const entry = this.roots.find((r) => r.repo.commonDir === repoKey);
    if (!entry) return undefined;
    const open = entry.children.find((n) => n.current);
    const main = entry.children.find((n) => n.wt.isMain && !n.wt.bare);
    const cwd = (open ?? main)?.wt.path;
    if (!cwd) return undefined;
    const takenBy = this.worktreeOf(repoKey, name);
    const remote = !!this.branches.get(repoKey)?.find((b) => b.name === name)?.remote;
    return { repo: entry.repo, cwd, takenBy: takenBy?.current ? undefined : takenBy, remote };
  }

  /** Current view of everything, filtered and sorted. Synchronous: reads caches only. */
  snapshot(): PanelState {
    const f = this.filter;
    const sort = cfg('sortBy');
    const recent = this.memento.get<Record<string, number>>(RECENT_KEY, {});
    const rank = (n: WorktreeNode) =>
      sort === 'recent'
        ? -(recent[n.key] ?? 0)
        : sort === 'currentFirst' && n.current
          ? -1
          : n.wt.isMain
            ? 0
            : 1;

    const repos = this.roots.map((r) => {
      const worktrees: WorktreeView[] = [];
      // Array.sort is stable, so ties keep git's order.
      const sorted = [...r.children].sort(
        (a, b) => rank(a) - rank(b) || (sort === 'name' ? wtLabel(a.wt).localeCompare(wtLabel(b.wt)) : 0),
      );
      for (const n of sorted) {
        const all = this.status.get(n.key);
        const nameHit = !f || `${wtLabel(n.wt)} ${n.wt.path}`.toLowerCase().includes(f);
        // Matched only by a file name: show just the matching files.
        const files = nameHit ? all : all?.filter((c) => c.path.toLowerCase().includes(f));
        if (!nameHit && !files?.length) continue;
        const ab = n.wt.head ? this.ab.get(`${n.key}@${n.wt.head}`)?.v : undefined;
        worktrees.push({
          key: n.key,
          label: wtLabel(n.wt),
          path: n.wt.path,
          short: shortPath(n.wt, n.repo),
          head: n.wt.head,
          branch: n.wt.branch,
          current: n.current,
          main: n.wt.isMain,
          agent: n.agent,
          bare: n.wt.bare,
          detached: n.wt.detached,
          locked: n.wt.locked,
          prunable: n.wt.prunable,
          merged: this.isMerged(n.repo.commonDir, n.wt.branch),
          gone: this.isGone(n.repo.commonDir, n.wt.branch),
          files: files
            ?.slice(0, MAX_FILES)
            .map((c) => ({ path: c.path, orig: c.origPath, letter: statusLetter(c) })),
          changed: all?.length,
          error: this.errors.get(n.key),
          ahead: ab?.[0],
          behind: ab?.[1],
          matchedByFile: !nameHit,
        });
      }
      return { key: r.repo.commonDir, name: r.repo.name, worktrees, branches: this.branchViews(r.repo) };
    });
    return {
      state: this.state,
      mode: this.mode,
      multiRepo: repos.length > 1,
      repos: f ? repos.filter((r) => r.worktrees.length || r.branches.length) : repos,
    };
  }

  /** Branches of one repo: current first, then ones held by a worktree, then most recently committed. */
  private branchViews(repo: Repo): BranchView[] {
    const f = this.filter;
    const out: BranchView[] = [];
    for (const b of this.branches.get(repo.commonDir) ?? []) {
      const key = WorktreeModel.branchKey(repo.commonDir, b.name);
      const loaded = this.branchFiles.get(key);
      const label = b.remote ? withoutRemote(b.name) : b.name;
      const nameHit = !f || b.name.toLowerCase().includes(f);
      const files = nameHit ? loaded?.files : loaded?.files.filter((x) => x.path.toLowerCase().includes(f));
      if (!nameHit && !files?.length) continue;
      const wt = this.worktreeOf(repo.commonDir, b.name);
      out.push({
        name: b.name,
        label,
        remote: b.remote,
        current: !!wt?.current,
        worktreeKey: wt?.key,
        worktreeShort: wt && shortPath(wt.wt, repo),
        date: b.date,
        author: b.author,
        authorEmail: b.authorEmail,
        upstream: b.upstream,
        ahead: b.ahead,
        behind: b.behind,
        gone: b.gone,
        merged: this.isMerged(repo.commonDir, b.name),
        base: loaded?.base,
        files: files
          ?.slice(0, MAX_FILES)
          .map((x) => ({ path: x.path, orig: x.origPath, letter: nameStatusLetter(x.status) })),
        changed: loaded?.files.length,
        error: this.branchErrors.get(key),
        matchedByFile: !nameHit,
        commits: this.commits.get(key)?.map((c) => ({
          sha: c.sha,
          short: c.short,
          subject: c.subject,
          author: c.author,
          authorEmail: c.authorEmail,
          date: c.date,
          files: this.commitFileCache
            .get(c.sha)
            ?.slice(0, MAX_FILES)
            .map((x) => ({ path: x.path, orig: x.origPath, letter: nameStatusLetter(x.status) })),
        })),
      });
    }
    // The branch you are on stays first; everything else is newest commit first (or by name on request).
    return out.sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (cfg('sortBy') === 'name' ? a.label.localeCompare(b.label) : b.date - a.date),
    );
  }

  private loadStatus(node: WorktreeNode): Promise<FileChange[]> {
    const cached = this.status.get(node.key);
    if (cached) return Promise.resolve(cached);
    let p = this.inflight.get(node.key);
    if (!p) {
      const mine: Promise<FileChange[]> = statusOf(node.wt.path).then(
        (files) => {
          if (this.inflight.get(node.key) === mine) {
            this.inflight.delete(node.key);
            this.errors.delete(node.key);
            this.status.set(node.key, files);
            this.changed.fire();
          }
          return files;
        },
        (e: Error) => {
          if (this.inflight.get(node.key) === mine) {
            this.inflight.delete(node.key);
            this.errors.set(node.key, e.message);
            this.changed.fire();
          }
          throw e;
        },
      );
      this.inflight.set(node.key, (p = mine));
    }
    return p;
  }

  /** Background badge loading, at most STATUS_CONCURRENCY git processes at once. */
  private enqueue(nodes: WorktreeNode[]): void {
    for (const n of nodes) {
      if (!n.wt.bare && n.wt.prunable === undefined && !this.status.has(n.key) && !this.queue.includes(n))
        this.queue.push(n);
    }
    while (this.running < STATUS_CONCURRENCY && this.queue.length) {
      const n = this.queue.shift()!;
      this.running++;
      this.loadStatus(n)
        .then(() => this.loadAheadBehind(n))
        .catch(() => undefined) // best-effort; the error is shown on the row
        .finally(() => {
          this.running--;
          this.enqueue([]);
        });
    }
  }

  private async loadAheadBehind(n: WorktreeNode): Promise<void> {
    if (!n.wt.branch || !n.wt.head) return; // detached: no upstream
    const k = `${n.key}@${n.wt.head}`;
    const hit = this.ab.get(k);
    if (hit && Date.now() - hit.at < AHEAD_BEHIND_TTL_MS) return;
    this.ab.set(k, { v: await aheadBehind(n.wt.path), at: Date.now() });
    if (this.nodes.includes(n)) this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
    this.loaded.dispose();
  }
}
