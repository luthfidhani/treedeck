# TreeDeck — Plan

Lightweight git worktree manager for VS Code / Cursor. Zero runtime deps, git via `execFile`.

## Architecture

```
src/
  extension.ts          activation + wiring only
  util.ts               typed settings, error-friendly command registration, path normalization
  git/
    run.ts              execFile wrapper (timeout, cwd, GitError w/ friendly message, version check)
    parse.ts            pure parsers: parseWorktreeList, parseStatusPorcelainZ, parseNameStatus, globToRegExp
    repo.ts             repo discovery (per workspace folder, dedup by common dir), worktree/status/ahead-behind queries
  views/
    model.ts            worktree list, status + ahead/behind caches, throttled queue, filter/sort → PanelState JSON
    panel.ts            WebviewViewProvider for the Worktrees panel (search + list in one section)
  diff/
    provider.ts         `treedeck-base:` TextDocumentContentProvider (`git show <ref>:<path>`) + openDiff helpers
  commands/
    open.ts             open / new window / copy path / reveal / switch (QuickPick)
    manage.ts           create / remove / prune worktree, post-create setup
    compare.ts          compare with base, compare two worktrees
    view.ts             refresh, collapse all, focus search
  watch/
    watcher.ts          FileSystemWatcher on <common-dir>/{HEAD,logs/HEAD,worktrees/*/…} + debounce
  statusBar.ts          `<repo> · <branch>` item → switch QuickPick
test/
  parse.test.ts         vitest, fixture strings
  realGit.test.ts       parsers vs real git output in a temp repo
media/
  panel.js / panel.css  panel UI: rendering, search, expand, keyboard nav, theme colors
```

Data flow: `TreeProvider.refresh()` → discover repos → `git worktree list --porcelain` per repo →
render worktree nodes → background queue (concurrency 2) fills status count + ahead/behind into cache →
node re-render. Expanding a node reads/fills the same cache. Watcher events / saves invalidate cache (debounced 300ms).

## Phases

1. **MVP** — view container, worktree list w/ icons/tooltips/current marker, open (same/new window), copy/reveal,
   changed files w/ git colors, diff via content provider, lazy badges, auto refresh, multi-root, welcome views, status bar.
2. **Management** — create (existing/new branch, path pattern, open prompt), remove (dirty/locked/main guard),
   prune (dry-run preview), compare with base (merge-base), compare two worktrees, post-create copy/command, agent tag.
3. **Polish** — sortBy, ahead/behind (TTL cache), filter box, README/CHANGELOG/LICENSE/icon/.vscodeignore, publish notes.

## Edge-case decisions

- Detached → short SHA label; bare → "(bare)"; first porcelain entry = main checkout.
- Prunable / missing path → message instead of open.
- Path compare via `realpath` (symlinks) and case-insensitive on Windows; git's `C:/x` forward slashes normalized.
- `--git-common-dir` resolved relative to cwd, so running from a linked worktree works.
- Git missing (ENOENT) / git < 2.7 (no `worktree list --porcelain`) → friendly error + welcome view.
- Status uses `--ignore-submodules=all`; all git calls async with timeout.
