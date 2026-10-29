import * as vscode from 'vscode';
import { wtLabel, type WorktreeModel } from './views/model';

/** `<repo> · <branch>` for the worktree open in this window; click → switch QuickPick. */
export function createStatusBar(tree: WorktreeModel): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.command = 'treedeck.switchWorktree';
  item.tooltip = 'TreeDeck: Switch Worktree';
  const sub = tree.onDidLoad((nodes) => {
    const cur = nodes.find((n) => n.current);
    if (!cur) return item.hide();
    item.text = `$(list-tree) ${cur.repo.name} · ${wtLabel(cur.wt)}`;
    item.show();
  });
  return vscode.Disposable.from(item, sub);
}
