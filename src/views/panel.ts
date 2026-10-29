import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { openWorkingDiff } from '../diff/provider';
import { wtLabel, type WorktreeModel } from './model';

/** Commands the webview may trigger. Anything else it sends is ignored. */
const ALLOWED_COMMANDS = new Set([
  'treedeck.openWorktree',
  'treedeck.openInNewWindow',
  'treedeck.removeWorktree',
  'treedeck.createWorktree',
  'treedeck.compareWithBase',
  'workbench.action.files.openFolder',
]);

type Msg =
  | { type: 'ready' }
  | { type: 'search'; q: string }
  | { type: 'expand'; key: string }
  | { type: 'diff'; key: string; file: string }
  | { type: 'command'; command: string; worktreeKey?: string; repoKey?: string }
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
        case 'command':
          if (!ALLOWED_COMMANDS.has(m.command)) return;
          await vscode.commands.executeCommand(m.command, { worktreeKey: m.worktreeKey, repoKey: m.repoKey });
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
<div class="search">
  <span class="codicon codicon-search"></span>
  <input id="q" type="text" placeholder="Search branch, path or file" aria-label="Search worktrees" spellcheck="false">
  <button id="clear" class="icon-btn codicon codicon-close" title="Clear (Esc)" aria-label="Clear search"></button>
</div>
<div id="list" role="tree" aria-label="Worktrees"></div>
<script nonce="${nonce}" src="${uri('media', 'panel.js')}"></script>
</body></html>`;
  }
}
