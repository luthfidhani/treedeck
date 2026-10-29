import * as path from 'path';
import * as vscode from 'vscode';
import { statusLetter, type FileChange, type NameStatus } from '../git/parse';
import { git } from '../git/run';

export const BASE_SCHEME = 'treedeck-base';

interface BaseQuery {
  cwd: string;
  /** Commit-ish; '' means "empty document" (added/deleted side). */
  ref: string;
  /** Repo-relative path with forward slashes. */
  path: string;
}

/** URI path is the real file path so the editor picks the right language; the query says what to `git show`. */
export function baseUri(cwd: string, ref: string, relPath: string): vscode.Uri {
  const query: BaseQuery = { cwd, ref, path: relPath };
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: vscode.Uri.file(path.join(cwd, relPath)).path,
    query: JSON.stringify(query),
  });
}

export const baseProvider: vscode.TextDocumentContentProvider = {
  async provideTextDocumentContent(uri) {
    const q = JSON.parse(uri.query) as BaseQuery;
    if (!q.ref) return '';
    try {
      // `<ref>:<path>` is resolved relative to the repo root, which matches status/diff output paths.
      return await git(['show', `${q.ref}:${q.path}`], q.cwd);
    } catch {
      return ''; // path doesn't exist at that ref
    }
  },
};

/** HEAD (as the worktree's commit SHA) ↔ working tree, inside one worktree. */
export async function openWorkingDiff(
  cwd: string,
  head: string,
  change: FileChange,
  label: string,
): Promise<void> {
  const letter = statusLetter(change);
  const isNew = letter === 'U' || (letter === 'A' && !change.origPath);
  const left = baseUri(cwd, isNew ? '' : head, change.origPath ?? change.path);
  const right = letter === 'D' ? baseUri(cwd, '', change.path) : vscode.Uri.file(path.join(cwd, change.path));
  const what = isNew ? 'new' : letter === 'D' ? 'deleted' : 'HEAD ↔ Working Tree';
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${path.basename(change.path)} (${what}) · ${label}`,
  );
}

/** Commit ↔ commit for one entry of `diff --name-status`. preserveFocus keeps the file QuickPick usable. */
export async function openRefDiff(
  cwd: string,
  leftRef: string,
  rightRef: string,
  f: NameStatus,
  title: string,
): Promise<void> {
  const left = baseUri(cwd, f.status === 'A' ? '' : leftRef, f.origPath ?? f.path);
  const right = baseUri(cwd, f.status === 'D' ? '' : rightRef, f.path);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(f.path)} (${title})`, {
    preview: true,
    preserveFocus: true,
  });
}
