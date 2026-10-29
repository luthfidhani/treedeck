import * as fs from 'fs';
import * as vscode from 'vscode';
import { openWorkingDiff } from '../diff/provider';
import type { FileChange, Worktree } from '../git/parse';
import { shortPath, wtLabel, type WorktreeModel, type WorktreeNode } from '../views/model';
import { cfg, command } from '../util';

/** Folder gone (prunable) → clear message instead of a failed open. */
function exists(wt: Worktree): boolean {
  if (fs.existsSync(wt.path)) return true;
  void vscode.window.showWarningMessage(
    `Worktree folder no longer exists: ${wt.path}. Run "TreeDeck: Prune Stale Worktrees" to clean it up.`,
  );
  return false;
}

export async function openWorktree(
  wt: Worktree,
  newWindow = cfg('defaultOpenBehavior') === 'newWindow',
): Promise<void> {
  if (!exists(wt)) return;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), {
    forceNewWindow: newWindow,
  });
}

/** QuickPick over every worktree of every repo; fuzzy matches branch and path. */
export async function pickWorktree(
  tree: WorktreeModel,
  placeHolder: string,
  filter: (n: WorktreeNode) => boolean = () => true,
): Promise<WorktreeNode | undefined> {
  await tree.repos();
  const multiRepo = new Set(tree.nodes.map((n) => n.repo.commonDir)).size > 1;
  const items = tree.nodes
    .filter((n) => !n.wt.bare && filter(n))
    .map((n) => ({
      label: `$(${n.current ? 'check' : 'git-branch'}) ${wtLabel(n.wt)}`,
      description: [multiRepo && n.repo.name, n.current && 'current', shortPath(n.wt, n.repo)]
        .filter(Boolean)
        .join(' · '),
      node: n,
    }));
  if (!items.length) {
    void vscode.window.showInformationMessage('TreeDeck: no worktrees found.');
    return;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.node;
}

export function registerOpenCommands(tree: WorktreeModel): vscode.Disposable[] {
  /** Commands get a node, `{ worktreeKey }` from the panel / its context menu, or nothing from the palette. */
  const withNode = async (arg: unknown, fn: (n: WorktreeNode) => unknown) => {
    const n = tree.resolve(arg) ?? (await pickWorktree(tree, 'Which worktree?'));
    if (n) await fn(n);
  };
  return [
    command('treedeck.openWorktree', (arg?: unknown) => withNode(arg, (n) => openWorktree(n.wt))),
    command('treedeck.openInNewWindow', (arg?: unknown) => withNode(arg, (n) => openWorktree(n.wt, true))),
    command('treedeck.copyPath', (arg?: unknown) =>
      withNode(arg, async (n) => {
        await vscode.env.clipboard.writeText(n.wt.path);
        void vscode.window.setStatusBarMessage(`Copied ${n.wt.path}`, 2000);
      }),
    ),
    command('treedeck.revealPath', (arg?: unknown) =>
      withNode(
        arg,
        (n) => exists(n.wt) && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(n.wt.path)),
      ),
    ),
    command('treedeck.switchWorktree', async () => {
      const n = await pickWorktree(tree, 'Switch to worktree (type to filter by branch or path)');
      if (n && !n.current) await openWorktree(n.wt);
    }),
    command('treedeck.openDiff', (cwd: string, head: string, change: FileChange, label: string) =>
      openWorkingDiff(cwd, head, change, label),
    ),
  ];
}
