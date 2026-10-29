import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectBaseBranch, listBranches, statusOf, type Repo } from '../git/repo';
import { git, gitFull } from '../git/run';
import { cfg, command } from '../util';
import { wtLabel, type WorktreeModel } from '../views/model';
import { openWorktree, pickWorktree } from './open';

async function pickRepo(tree: WorktreeModel, arg?: unknown): Promise<Repo | undefined> {
  const known = tree.resolveRepo(arg);
  if (known) return known;
  const repos = (await tree.repos()).map((r) => r.repo);
  if (repos.length <= 1) {
    if (!repos.length)
      void vscode.window.showInformationMessage('TreeDeck: no git repository in this workspace.');
    return repos[0];
  }
  const pick = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repo.name, description: repo.commonDir, repo })),
    { placeHolder: 'Which repository?' },
  );
  return pick?.repo;
}

const withProgress = <T>(title: string, task: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

/** Main checkout folder, or for a bare repo the git dir itself; the anchor for `../` path patterns. */
const repoAnchor = (repo: Repo) =>
  repo.worktrees[0] && !repo.worktrees[0].bare ? repo.worktrees[0].path : repo.commonDir;

async function createWorktree(tree: WorktreeModel, arg?: unknown): Promise<void> {
  const repo = await pickRepo(tree, arg);
  if (!repo) return;
  const cwd = repo.cwd;
  const { local, remote } = await listBranches(cwd);
  const checkedOut = new Set(repo.worktrees.map((w) => w.branch));

  type Item = vscode.QuickPickItem & { ref?: string; remote?: boolean };
  const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items: Item[] = [
    { label: '$(add) Create new branch…', alwaysShow: true },
    sep('Local branches'),
    // git refuses to check out one branch in two worktrees, so hide those.
    ...local.filter((b) => !checkedOut.has(b)).map((b) => ({ label: b, ref: b })),
    sep('Remote branches'),
    ...remote.map((b) => ({ label: b, ref: b, remote: true })),
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Branch for the new worktree' });
  if (!picked) return;

  let branch: string;
  let addArgs: (dir: string) => string[];
  if (!picked.ref) {
    const name = await vscode.window.showInputBox({
      prompt: 'New branch name',
      validateInput: async (v) => {
        if (!v.trim()) return 'Enter a branch name';
        if (local.includes(v)) return 'Branch already exists';
        const ok = await git(['check-ref-format', '--branch', v], cwd).then(
          () => true,
          () => false,
        );
        return ok ? undefined : 'Not a valid branch name';
      },
    });
    if (!name) return;
    const def = await detectBaseBranch(cwd, cfg('baseBranch')).catch(() => '');
    const bases = [def, ...local, ...remote].filter((b, i, all) => b && all.indexOf(b) === i);
    const base = await vscode.window.showQuickPick(bases, { placeHolder: `Base for "${name}"` });
    if (!base) return;
    branch = name;
    addArgs = (dir) => ['worktree', 'add', '-b', name, dir, base];
  } else if (picked.remote) {
    // origin/foo → local tracking branch foo
    const ref = picked.ref;
    branch = ref.slice(ref.indexOf('/') + 1);
    if (local.includes(branch)) addArgs = (dir) => ['worktree', 'add', dir, branch];
    else addArgs = (dir) => ['worktree', 'add', '--track', '-b', branch, dir, ref];
  } else {
    branch = picked.ref;
    addArgs = (dir) => ['worktree', 'add', dir, branch];
  }

  const anchor = repoAnchor(repo);
  const suggested = path.resolve(
    anchor,
    cfg('newWorktreePathPattern')
      .replace(/\{repo\}/g, repo.name)
      .replace(/\{branch\}/g, branch.replace(/[\\/:*?"<>|\s]+/g, '-')),
  );
  const input = await vscode.window.showInputBox({
    prompt: 'Folder for the new worktree (relative paths are relative to the main checkout)',
    value: suggested,
    validateInput: (v) =>
      !v.trim()
        ? 'Enter a folder'
        : fs.existsSync(path.resolve(anchor, v))
          ? 'Folder already exists'
          : undefined,
  });
  if (!input) return;
  const dir = path.resolve(anchor, input);

  await withProgress(`Creating worktree ${branch}…`, () => git(addArgs(dir), cwd, 300_000));
  await postCreate(repo, dir, branch);
  tree.refresh();

  const choice = await vscode.window.showInformationMessage(
    `Created worktree "${branch}".`,
    'Open',
    'Open in New Window',
  );
  if (choice)
    await openWorktree({ path: dir, bare: false, detached: false, isMain: false }, choice !== 'Open');
}

/** Optional setup (off by default): copy untracked files like .env from the main checkout, run a command. */
async function postCreate(repo: Repo, dir: string, branch: string): Promise<void> {
  const src = repoAnchor(repo);
  const copied: string[] = [];
  for (const rel of cfg('postCreate.copyFiles')) {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, rel), { recursive: true, force: false });
    copied.push(rel);
  }
  if (copied.length) void vscode.window.setStatusBarMessage(`TreeDeck: copied ${copied.join(', ')}`, 4000);
  const cmd = cfg('postCreate.command').trim();
  if (cmd) {
    const term = vscode.window.createTerminal({ name: `TreeDeck: ${branch}`, cwd: dir });
    term.show();
    term.sendText(cmd);
  }
}

async function removeWorktree(tree: WorktreeModel, arg?: unknown): Promise<void> {
  const n =
    tree.resolve(arg) ??
    (await pickWorktree(tree, 'Remove which worktree?', (x) => !x.wt.isMain && !x.current));
  if (!n) return;
  const { wt, repo } = n;
  if (wt.isMain) throw new Error('The main checkout cannot be removed.');
  if (n.current) throw new Error('This worktree is open in this window. Switch to another worktree first.');

  if (wt.prunable !== undefined) {
    const ok = await vscode.window.showWarningMessage(
      `The folder of "${wtLabel(wt)}" is missing. Prune stale worktree entries?`,
      { modal: true, detail: wt.path },
      'Prune',
    );
    if (ok) await git(['worktree', 'prune'], repo.cwd);
    return tree.refresh();
  }

  const dirty = (await statusOf(wt.path)).length;
  const detail = [
    wt.path,
    wt.locked !== undefined && `🔒 Locked${wt.locked ? `: ${wt.locked}` : ''} — it will be unlocked first.`,
    dirty && `⚠️ ${dirty} uncommitted or untracked file(s) will be permanently LOST.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const action = dirty ? 'Force Remove' : 'Remove';
  const ok = await vscode.window.showWarningMessage(
    `Remove worktree "${wtLabel(wt)}"?`,
    { modal: true, detail },
    action,
  );
  if (ok !== action) return;

  await withProgress(`Removing worktree ${wtLabel(wt)}…`, async () => {
    if (wt.locked !== undefined) await git(['worktree', 'unlock', wt.path], repo.cwd);
    await git(['worktree', 'remove', ...(dirty ? ['--force'] : []), wt.path], repo.cwd, 120_000);
  });
  tree.refresh();
}

async function pruneWorktrees(tree: WorktreeModel, arg?: unknown): Promise<void> {
  const repo = await pickRepo(tree, arg);
  if (!repo) return;
  // `prune -v` reports on stderr.
  const { stderr } = await gitFull(['worktree', 'prune', '--dry-run', '-v'], repo.cwd);
  const preview = stderr.trim();
  if (!preview) {
    void vscode.window.showInformationMessage(`TreeDeck: nothing to prune in ${repo.name}.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Prune stale worktree entries in ${repo.name}?`,
    { modal: true, detail: preview },
    'Prune',
  );
  if (!ok) return;
  await git(['worktree', 'prune', '-v'], repo.cwd);
  tree.refresh();
}

export function registerManageCommands(tree: WorktreeModel): vscode.Disposable[] {
  return [
    command('treedeck.createWorktree', (arg?: unknown) => createWorktree(tree, arg)),
    command('treedeck.removeWorktree', (arg?: unknown) => removeWorktree(tree, arg)),
    command('treedeck.pruneWorktrees', (arg?: unknown) => pruneWorktrees(tree, arg)),
  ];
}
