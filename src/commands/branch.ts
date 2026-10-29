import * as path from 'path';
import * as vscode from 'vscode';
import { checkoutBranch, checkoutRemoteBranch, fetchAll, withoutRemote, type Repo } from '../git/repo';
import { command } from '../util';
import type { WorktreeModel } from '../views/model';
import { openWorktree } from './open';

interface BranchArg {
  repoKey?: string;
  branchName?: string;
}

/**
 * Checks the branch out in the worktree open in this window (or the main checkout).
 * git refuses a branch that another worktree already holds, so offer to open that worktree instead.
 */
async function checkout(model: WorktreeModel, arg?: unknown): Promise<void> {
  const { repoKey, branchName } = (arg ?? {}) as BranchArg;
  if (!repoKey || !branchName) return;
  const target = model.checkoutTarget(repoKey, branchName);
  if (!target) return;

  if (target.takenBy) {
    const open = await vscode.window.showWarningMessage(
      `"${branchName}" is already checked out in another worktree.`,
      { modal: true, detail: target.takenBy.wt.path },
      'Open That Worktree',
    );
    if (open) await openWorktree(target.takenBy.wt);
    return;
  }

  // A remote-only branch needs a local branch first; `-b … --track` makes one that follows it.
  const local = target.remote ? withoutRemote(branchName) : branchName;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking out ${local}…` },
    () =>
      target.remote ? checkoutRemoteBranch(target.cwd, branchName) : checkoutBranch(target.cwd, branchName),
  );
  void vscode.window.setStatusBarMessage(`TreeDeck: ${path.basename(target.cwd)} is now on ${local}`, 3000);
  model.refresh();
}

/** Brings the remote branch list up to date. The only thing in TreeDeck that uses the network. */
async function fetch(model: WorktreeModel, arg?: unknown): Promise<void> {
  const repos = (await model.repos()).map((r) => r.repo);
  const one = model.resolveRepo(arg);
  const targets: Repo[] = one ? [one] : repos;
  if (!targets.length) return;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Fetching ${targets.map((r) => r.name).join(', ')}…`,
    },
    () => Promise.all(targets.map((r) => fetchAll(r.cwd))),
  );
  model.refresh();
}

export function registerBranchCommands(model: WorktreeModel): vscode.Disposable[] {
  return [
    command('treedeck.checkoutBranch', (arg?: unknown) => checkout(model, arg)),
    command('treedeck.fetch', (arg?: unknown) => fetch(model, arg)),
  ];
}
