import * as path from 'path';
import * as vscode from 'vscode';
import { openRefDiff } from '../diff/provider';
import { parseNameStatus, type NameStatus } from '../git/parse';
import { detectBaseBranch } from '../git/repo';
import { git } from '../git/run';
import { cfg, command } from '../util';
import { wtLabel, type WorktreeModel } from '../views/model';
import { pickWorktree } from './open';

const ICON: Record<string, string> = {
  A: 'diff-added',
  D: 'diff-removed',
  R: 'diff-renamed',
  C: 'diff-added',
};

/** File list that stays open while you arrow through it, opening each diff in a preview editor. */
function showFileList(title: string, files: NameStatus[], open: (f: NameStatus) => unknown): void {
  if (!files.length) {
    void vscode.window.showInformationMessage(`No differences: ${title}`);
    return;
  }
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { f: NameStatus }>();
  qp.title = `${title} — ${files.length} file${files.length === 1 ? '' : 's'}`;
  qp.placeholder = 'Select a file to open its diff (Esc to close)';
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  qp.items = files.map((f) => ({
    label: `$(${ICON[f.status] ?? 'diff-modified'}) ${path.posix.basename(f.path)}`,
    description: [path.posix.dirname(f.path), f.origPath && `← ${f.origPath}`]
      .filter((s) => s && s !== '.')
      .join(' '),
    f,
  }));
  qp.onDidAccept(() => qp.selectedItems[0] && open(qp.selectedItems[0].f));
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function nameStatus(cwd: string, range: string[]): Promise<NameStatus[]> {
  return parseNameStatus(await git(['diff', '--name-status', '-z', '-M', ...range], cwd, 60_000));
}

export function registerCompareCommands(tree: WorktreeModel): vscode.Disposable[] {
  return [
    command('treedeck.compareWithBase', async (arg?: unknown) => {
      const n =
        tree.resolve(arg) ??
        (await pickWorktree(tree, 'Compare which worktree with the base branch?', (x) => !!x.wt.head));
      if (!n?.wt.head) return;
      const cwd = n.wt.path;
      const base = await detectBaseBranch(cwd, cfg('baseBranch'));
      // Three-dot semantics: changes on this branch since it forked from base, i.e. merge-base ↔ HEAD.
      const mergeBase = (await git(['merge-base', base, n.wt.head], cwd)).trim();
      const files = await nameStatus(cwd, [`${base}...${n.wt.head}`]);
      const title = `${base}...${wtLabel(n.wt)}`;
      showFileList(title, files, (f) => openRefDiff(cwd, mergeBase, n!.wt.head!, f, title));
    }),

    command('treedeck.compareWorktrees', async () => {
      const a = await pickWorktree(tree, 'Compare worktree… (1/2)', (x) => !!x.wt.head);
      if (!a) return;
      const b = await pickWorktree(
        tree,
        `Compare ${wtLabel(a.wt)} with… (2/2)`,
        (x) => !!x.wt.head && x !== a && x.repo === a.repo,
      );
      if (!b) return;
      const cwd = a.repo.cwd; // commits are shared by all worktrees of a repo
      const title = `${wtLabel(a.wt)} ↔ ${wtLabel(b.wt)}`;
      const files = await nameStatus(cwd, [a.wt.head!, b.wt.head!]);
      showFileList(title, files, (f) => openRefDiff(cwd, a.wt.head!, b.wt.head!, f, title));
    }),
  ];
}
