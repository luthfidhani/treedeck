import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { openChanges, openRefDiff, openWorkingDiff } from '../diff/provider';
import { wtLabel, type WorktreeModel } from './model';

/** Commands the webview may trigger. Anything else it sends is ignored. */
const ALLOWED_COMMANDS = new Set([
  'treedeck.openWorktree',
  'treedeck.openInNewWindow',
  'treedeck.removeWorktree',
  'treedeck.createWorktree',
  'treedeck.compareWithBase',
  'treedeck.checkoutBranch',
  'workbench.action.files.openFolder',
]);

type Msg =
  | { type: 'ready' }
  | { type: 'search'; q: string }
  | { type: 'expand'; key: string }
  | { type: 'diff'; key: string; file: string }
  | { type: 'expandBranch'; repoKey: string; name: string }
  | { type: 'expandCommits'; repoKey: string; name: string }
  | { type: 'expandCommit'; repoKey: string; sha: string }
  | { type: 'commitDiff'; repoKey: string; sha: string; file: string }
  | { type: 'previewBranch'; repoKey: string; name: string }
  | { type: 'previewCommit'; repoKey: string; sha: string; subject: string }
  | { type: 'command'; command: string; worktreeKey?: string; repoKey?: string; branchName?: string }
  | { type: 'gitSettings' };

/**
 * The Worktrees panel: a webview so the search box and the list share one section
 * (TreeViews can't host an input). Rendering lives in media/panel.js; this side only
 * ships PanelState snapshots and turns messages into commands.
 */
export class WorktreePanel implements vscode.WebviewViewProvider {
  static readonly id = 'treedeck.worktrees';
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly model: WorktreeModel,
    private readonly extUri: vscode.Uri,
  ) {
    model.onDidChange(() => this.post());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extUri, 'media'),
        vscode.Uri.joinPath(this.extUri, 'dist'),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: Msg) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.post());
    view.onDidDispose(() => (this.view = undefined));
    void this.model.repos();
  }

  collapseAll(): void {
    void this.view?.webview.postMessage({ type: 'collapseAll' });
  }

  focusSearch(): void {
    void this.view?.webview.postMessage({ type: 'focusSearch' });
  }

  /** Coalesces bursts (the status queue fires per worktree) into one render. */
  private post(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.view?.visible)
        void this.view.webview.postMessage({ type: 'state', state: this.model.snapshot() });
    }, 50);
  }

  private async onMessage(m: Msg): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          return this.post();
        case 'search':
          return this.model.setFilter(m.q);
        case 'expand':
          return this.model.expand(m.key);
        case 'gitSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'treedeck.gitPath');
          return;
        case 'diff': {
          const n = this.model.resolve({ worktreeKey: m.key });
          const change = n && this.model.changeFor(m.key, m.file);
          if (n && change) await openWorkingDiff(n.wt.path, n.wt.head ?? 'HEAD', change, wtLabel(n.wt));
          return;
        }
        case 'expandBranch':
          return void (await this.model.expandBranch(m.repoKey, m.name));
        case 'expandCommits':
          return void (await this.model.expandCommits(m.repoKey, m.name));
        case 'expandCommit':
          return void (await this.model.expandCommit(m.repoKey, m.sha));
        case 'previewBranch': {
          const c = await this.model.branchChanges(m.repoKey, m.name);
          if (c) await openChanges(`${m.name} (vs ${c.base})`, c.cwd, c.mergeBase, m.name, c.files);
          return;
        }
        case 'previewCommit': {
          const c = await this.model.commitChanges(m.repoKey, m.sha);
          if (c) await openChanges(`${c.short} ${m.subject}`, c.cwd, `${m.sha}^`, m.sha, c.files);
          return;
        }
        case 'commitDiff': {
          const t = this.model.commitDiffTarget(m.repoKey, m.sha, m.file);
          // A commit is shown against its first parent, the way `git show` does it.
          if (t) await openRefDiff(t.cwd, `${m.sha}^`, m.sha, t.entry, `${t.short} ${t.entry.path}`);
          return;
        }
        case 'command':
          if (!ALLOWED_COMMANDS.has(m.command)) return;
          await vscode.commands.executeCommand(m.command, {
            worktreeKey: m.worktreeKey,
            repoKey: m.repoKey,
            branchName: m.branchName,
          });
          return;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`TreeDeck: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, ...p));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('dist', 'codicon.css')}">
<link rel="stylesheet" href="${uri('media', 'panel.css')}">
</head><body>
<div class="tabs" role="tablist">
  <button class="tab active" id="tab-worktrees" role="tab" aria-selected="true" data-tab="worktrees"
    title="Worktrees: the folders of this repository that are checked out on disk">
    <span class="codicon codicon-folder-library"></span><span>Worktrees</span><span class="count" id="count-worktrees"></span>
  </button>
  <button class="tab" id="tab-commits" role="tab" aria-selected="false" data-tab="commits"
    title="Branches: every local branch plus the ones that exist only on the remote, each expandable to the commits it added on top of the base branch">
    <span class="codicon codicon-git-branch"></span><span>Branches</span><span class="count" id="count-commits"></span>
  </button>
</div>
<div class="search">
  <span class="codicon codicon-search"></span>
  <input id="q" type="text" aria-label="Search" spellcheck="false">
  <button id="clear" class="icon-btn codicon codicon-close" title="Clear (Esc)" aria-label="Clear search"></button>
</div>
<div id="list" role="tree" aria-label="Worktrees"></div>
<script nonce="${nonce}" src="${uri('media', 'panel.js')}"></script>
</body></html>`;
  }
}
