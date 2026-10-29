import * as vscode from 'vscode';
import { command } from '../util';
import type { WorktreeModel } from '../views/model';
import type { WorktreePanel } from '../views/panel';

export function registerViewCommands(model: WorktreeModel, panel: WorktreePanel): vscode.Disposable[] {
  return [
    command('treedeck.refresh', () => model.refresh()),
    command('treedeck.collapseAll', () => panel.collapseAll()),
    command('treedeck.filter', async () => {
      await vscode.commands.executeCommand('treedeck.worktrees.focus');
      panel.focusSearch();
    }),
  ];
}
