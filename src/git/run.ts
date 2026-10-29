import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { parseGitVersion } from './parse';

/** Error with a user-facing message; raw stderr kept for debugging. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
    readonly notInstalled = false,
  ) {
    super(message);
  }
}

const gitPath = () => vscode.workspace.getConfiguration('treedeck').get<string>('gitPath') || 'git';

/** Runs git, resolves stdout. See {@link gitFull}. */
export function git(args: string[], cwd: string, timeoutMs = 15_000): Promise<string> {
  return gitFull(args, cwd, timeoutMs).then((r) => r.stdout);
}

/**
 * Runs git with an argv array (never a shell string, so paths can't inject commands).
 * Resolves both streams (some commands, e.g. `worktree prune -v`, report on stderr);
 * rejects with GitError carrying the first stderr line.
 */
export function gitFull(
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath(),
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // OPTIONAL_LOCKS=0: background `status` must not grab index.lock and race the user's own git.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        const sub = args.find((a) => !a.startsWith('-')) ?? '';
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new GitError('Git not found. Install git or set "treedeck.gitPath".', stderr, true));
        }
        if (err.killed)
          return reject(new GitError(`git ${sub} timed out after ${timeoutMs / 1000}s.`, stderr));
        const line = stderr.split('\n').find((l) => l.trim()) ?? err.message;
        reject(new GitError(`git ${sub} failed: ${line.replace(/^(fatal|error): /, '').trim()}`, stderr));
      },
    );
  });
}

let versionCheck: Promise<void> | undefined;

/** `worktree list --porcelain` exists since git 2.7. Cached; reset when gitPath changes. */
export function ensureGit(): Promise<void> {
  versionCheck ??= git(['--version'], process.cwd()).then((out) => {
    const v = parseGitVersion(out);
    if (!v || v[0] < 2 || (v[0] === 2 && v[1] < 7)) {
      throw new GitError(`TreeDeck needs git 2.7 or newer (found: ${out.trim()}).`, '', true);
    }
  });
  versionCheck.catch(() => (versionCheck = undefined)); // retry next time (user may install git)
  return versionCheck;
}

export function resetGitCheck(): void {
  versionCheck = undefined;
}
