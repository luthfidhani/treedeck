import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { globToRegExp, statusLetter, type FileChange, type StatusLetter, type Worktree } from '../git/parse';
import { aheadBehind, discoverRepos, statusOf, type Repo } from '../git/repo';
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
  /** Undefined until status has loaded. */
  files?: FileView[];
  changed?: number;
  error?: string;
  ahead?: number;
  behind?: number;
  /** Visible only because a changed file matched the search: the panel auto-expands it. */
  matchedByFile: boolean;
}
export interface PanelState {
  state: 'loading' | 'ok' | 'noFolder' | 'noRepo' | 'noGit';
  multiRepo: boolean;
  repos: { key: string; name: string; worktrees: WorktreeView[] }[];
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

  /** @param memento persists last-open times for sortBy=recent */
  constructor(private readonly memento: vscode.Memento) {}

  get nodes(): WorktreeNode[] {
    return this.roots.flatMap((r) => r.children);
  }

  setFilter(f: string): void {
    this.filter = f.trim().toLowerCase();
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
    this.changed.fire();
    return this.roots;
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
      return { key: r.repo.commonDir, name: r.repo.name, worktrees };
    });
    return {
      state: this.state,
      multiRepo: repos.length > 1,
      repos: f ? repos.filter((r) => r.worktrees.length) : repos,
    };
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
