import * as vscode from 'vscode';
import { resetGitCheck } from '../git/run';
import type { WorktreeModel } from '../views/model';

const DEBOUNCE_MS = 300;

/**
 * Files inside the common git dir that change when worktrees are added/removed/locked or any HEAD moves.
 * `refs/heads/**` and `packed-refs` catch branches being created, deleted or moved by a commit or fetch.
 * `index` is deliberately excluded: other tools refresh it constantly, which would cause refresh storms.
 */
const GIT_DIR_GLOB =
  '{HEAD,logs/HEAD,packed-refs,refs/heads/**,worktrees/*,worktrees/*/HEAD,worktrees/*/logs/HEAD,worktrees/*/locked}';

export function watchRepos(tree: WorktreeModel): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => tree.refresh(), DEBOUNCE_MS);
  };

  // Edits only affect one worktree's status: batch paths, then invalidate just those.
  let dirty = new Set<string>();
  let dirtyTimer: NodeJS.Timeout | undefined;
  const invalidateSoon = (uris: readonly vscode.Uri[]) => {
    for (const u of uris) if (u.scheme === 'file') dirty.add(u.fsPath);
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => {
      const paths = dirty;
      dirty = new Set();
      paths.forEach((p) => tree.invalidate(p));
    }, DEBOUNCE_MS);
  };

  let watched = '';
  let watchers: vscode.Disposable[] = [];
  const onLoad = tree.onDidLoad((nodes) => {
    const dirs = [...new Set(nodes.map((n) => n.repo.commonDir))];
    if (dirs.join('\0') === watched) return;
    watched = dirs.join('\0');
    watchers.forEach((w) => w.dispose());
    watchers = dirs.map((dir) => {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), GIT_DIR_GLOB),
      );
      w.onDidCreate(refreshSoon);
      w.onDidChange(refreshSoon);
      w.onDidDelete(refreshSoon);
      return w;
    });
  });

  return vscode.Disposable.from(
    onLoad,
    { dispose: () => (watchers.forEach((w) => w.dispose()), clearTimeout(timer), clearTimeout(dirtyTimer)) },
    vscode.workspace.onDidSaveTextDocument((d) => invalidateSoon([d.uri])),
    vscode.workspace.onDidCreateFiles((e) => invalidateSoon(e.files)),
    vscode.workspace.onDidDeleteFiles((e) => invalidateSoon(e.files)),
    vscode.workspace.onDidRenameFiles((e) => invalidateSoon(e.files.flatMap((f) => [f.oldUri, f.newUri]))),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshSoon),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('treedeck')) return;
      resetGitCheck();
      refreshSoon();
    }),
  );
}
