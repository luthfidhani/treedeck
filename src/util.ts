import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitError } from './git/run';

export interface Config {
  defaultOpenBehavior: 'sameWindow' | 'newWindow';
  gitPath: string;
  baseBranch: string;
  newWorktreePathPattern: string;
  agentWorktreeGlobs: string[];
  'postCreate.copyFiles': string[];
  'postCreate.command': string;
  sortBy: 'currentFirst' | 'name' | 'recent';
}

export function cfg<K extends keyof Config>(key: K): Config[K] {
  return vscode.workspace.getConfiguration('treedeck').get(key) as Config[K];
}

/** Registers a command whose errors become a friendly notification instead of a stack trace. */
export function command(id: string, fn: (...args: never[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: never[]) => {
    try {
      await fn(...args);
    } catch (e) {
      const msg =
        e instanceof GitError ? e.message : `TreeDeck: ${e instanceof Error ? e.message : String(e)}`;
      void vscode.window.showErrorMessage(msg);
    }
  });
}

/**
 * Canonical form for comparing paths: resolves symlinks (e.g. macOS /tmp → /private/tmp),
 * normalizes git's `C:/x` forward slashes, and is case-insensitive on Windows.
 */
export function normPath(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    // missing path (prunable worktree): keep the resolved form
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
