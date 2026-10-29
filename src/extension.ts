import * as vscode from 'vscode';
import { registerCompareCommands } from './commands/compare';
import { registerManageCommands } from './commands/manage';
import { registerOpenCommands } from './commands/open';
import { registerViewCommands } from './commands/view';
import { BASE_SCHEME, baseProvider } from './diff/provider';
import { createStatusBar } from './statusBar';
import { WorktreeModel } from './views/model';
import { WorktreePanel } from './views/panel';
import { watchRepos } from './watch/watcher';

export function activate(ctx: vscode.ExtensionContext): void {
  const model = new WorktreeModel(ctx.globalState);
  const panel = new WorktreePanel(model, ctx.extensionUri);

  ctx.subscriptions.push(
    model,
    vscode.window.registerWebviewViewProvider(WorktreePanel.id, panel),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseProvider),
    ...registerViewCommands(model, panel),
    ...registerOpenCommands(model),
    ...registerManageCommands(model),
    ...registerCompareCommands(model),
    createStatusBar(model),
    watchRepos(model),
  );

  void model.repos(); // load the worktree list (no status) so the status bar fills in without opening the panel
}

export function deactivate(): void {}
