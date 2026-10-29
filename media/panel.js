// Worktrees panel UI. Receives PanelState snapshots from the extension (src/views/model.ts),
// renders them, and posts user actions back. Expanded rows and the query survive reloads via setState.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const expanded = new Set(saved.expanded || []);
  const collapsedRepos = new Set(saved.collapsedRepos || []);
  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const searchBox = q.parentElement;
  /** @type {any} */
  let state = null;

  q.value = saved.q || '';
  searchBox.classList.toggle('has-value', !!q.value);

  const save = () =>
    vscode.setState({ expanded: [...expanded], collapsedRepos: [...collapsedRepos], q: q.value });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const STATUS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', '!': 'Conflict' };
  const cls = (letter) => (letter === '!' ? 'C' : letter);
  const query = () => q.value.trim().toLowerCase();

  /** Escapes text and wraps the first match of the query in <mark>. */
  function hl(text) {
    const f = query();
    const i = f ? text.toLowerCase().indexOf(f) : -1;
    if (i < 0) return esc(text);
    return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + f.length))}</mark>${esc(text.slice(i + f.length))}`;
  }

  // First match wins: problems (missing, locked) outrank the kind of worktree.
  function kindIcon(w) {
    if (w.prunable !== undefined) return 'warning';
    if (w.locked !== undefined) return 'lock';
    if (w.bare) return 'database';
    if (w.main) return 'home';
    if (w.agent) return 'hubot';
    if (w.detached) return 'git-commit';
    return 'git-branch';
  }

  function tooltip(w) {
    return [
      `${w.main ? 'Main checkout' : 'Worktree'}${w.current ? ' (open in this window)' : ''}`,
      `Path: ${w.path}`,
      `Branch: ${w.branch || (w.bare ? '(bare repository)' : '(detached HEAD)')}`,
      w.head && `HEAD: ${w.head}`,
      w.locked !== undefined && `Locked: ${w.locked || '(no reason given)'}`,
      w.prunable !== undefined && `Missing: ${w.prunable || 'folder no longer exists'}`,
      w.changed !== undefined && `Changed files: ${w.changed}`,
      w.ahead !== undefined && `Upstream: ${w.ahead} ahead, ${w.behind} behind`,
      w.error && `Error: ${w.error}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const btn = (cmd, icon, title, extra = '') =>
    `<button class="icon-btn codicon codicon-${icon} ${extra}" data-cmd="${cmd}" title="${title}" aria-label="${title}"></button>`;

  function isOpen(w) {
    return expanded.has(w.key) || (w.matchedByFile && !!query());
  }

  function worktreeRows(w, depth) {
    const missing = w.prunable !== undefined;
    const canExpand = !w.bare && !missing && w.changed !== 0;
    const open = canExpand && isOpen(w);
    const loading = !w.bare && !missing && w.changed === undefined && !w.error;
    const ctx = JSON.stringify({
      webviewSection: 'worktree',
      worktreeKey: w.key,
      worktreeMain: w.main,
      worktreeCurrent: w.current,
      worktreeMissing: missing,
      preventDefaultContextMenuItems: true,
    });
    const classes = ['row', 'wt', `d${depth}`, w.current && 'current', missing && 'missing', w.locked !== undefined && 'locked', w.agent && 'agent']
      .filter(Boolean)
      .join(' ');
    const sync = [w.ahead ? `↑${w.ahead}` : '', w.behind ? `↓${w.behind}` : ''].filter(Boolean).join(' ');
    const meta = [
      w.current && '<span class="tag current">current</span>',
      w.agent && '<span class="tag">agent</span>',
      w.locked !== undefined && '<span class="tag">locked</span>',
      missing && '<span class="tag">missing</span>',
      w.error && `<span class="codicon codicon-error err" title="${esc(w.error)}"></span>`,
      sync && `<span class="sync">${sync}</span>`,
      w.changed ? `<span class="badge" title="${w.changed} changed file(s)">${w.changed}</span>` : '',
      loading && '<span class="codicon codicon-loading codicon-modifier-spin"></span>',
    ]
      .filter(Boolean)
      .join('');
    const actions = [
      !w.current && !missing && btn('treedeck.openWorktree', 'folder-opened', 'Open Worktree'),
      !w.current && !missing && btn('treedeck.openInNewWindow', 'empty-window', 'Open in New Window'),
      !w.main && !missing && btn('treedeck.compareWithBase', 'git-compare', 'Compare with Base Branch'),
      !w.main && !w.current && btn('treedeck.removeWorktree', 'trash', 'Remove Worktree…', 'danger'),
    ]
      .filter(Boolean)
      .join('');

    let html = `<div class="${classes}" role="treeitem" tabindex="-1" data-kind="wt" data-id="w:${esc(w.key)}" data-key="${esc(w.key)}"
      ${canExpand ? `aria-expanded="${open}"` : ''} title="${esc(tooltip(w))}" data-vscode-context="${esc(ctx)}">
      <span class="twistie codicon codicon-${canExpand ? (open ? 'chevron-down' : 'chevron-right') : 'blank'}"></span>
      <span class="kind codicon codicon-${kindIcon(w)}"></span>
      <span class="label">${hl(w.label)}</span>
      <span class="desc">${esc(w.short)}</span>
      <span class="meta">${meta}</span>
      <span class="actions">${actions}</span>
    </div>`;

    if (open && w.files) {
      for (const f of w.files) {
        const slash = f.path.lastIndexOf('/');
        const name = f.path.slice(slash + 1);
        const dir = slash >= 0 ? f.path.slice(0, slash) : '';
        const desc = [dir, f.orig && `← ${f.orig}`].filter(Boolean).join(' ');
        html += `<div class="row file d${depth + 1} s-${cls(f.letter)}" role="treeitem" tabindex="-1" data-kind="file"
          data-id="f:${esc(w.key)}:${esc(f.path)}" data-key="${esc(w.key)}" data-file="${esc(f.path)}"
          title="${esc(`${f.path} — ${STATUS[f.letter]}\nClick to open diff`)}">
          <span class="twistie codicon codicon-blank"></span>
          <span class="codicon codicon-file"></span>
          <span class="label">${hl(name)}</span>
          <span class="desc">${hl(desc)}</span>
          <span class="letter">${f.letter}</span>
        </div>`;
      }
      const more = w.matchedByFile ? 0 : w.changed - w.files.length;
      if (more > 0) html += `<div class="row more d${depth + 1}"><span class="twistie codicon codicon-blank"></span>…and ${more} more</div>`;
    }
    return html;
  }

  function repoRow(r, open) {
    return `<div class="row repo d0" role="treeitem" tabindex="-1" data-kind="repo" data-id="r:${esc(r.key)}"
      data-repo="${esc(r.key)}" aria-expanded="${open}" title="${esc(r.key)}">
      <span class="twistie codicon codicon-chevron-${open ? 'down' : 'right'}"></span>
      <span class="codicon codicon-repo"></span>
      <span class="label">${esc(r.name)}</span>
      <span class="desc">${r.worktrees.length}</span>
      <span class="actions">${btn('treedeck.createWorktree', 'add', 'Create Worktree…')}</span>
    </div>`;
  }

  function emptyState(s) {
    const msg = {
      loading: ['Loading worktrees…'],
      noFolder: ['No folder is open.', 'Open Folder', 'workbench.action.files.openFolder'],
      noRepo: ['No git repository found in this workspace.', 'Open Folder', 'workbench.action.files.openFolder'],
      noGit: ['Git was not found, or is older than 2.7.', 'Configure Git Path', ''],
    }[s];
    const [text, label, cmd] = msg || ['Something went wrong.'];
    return `<div class="empty">${esc(text)}${label ? `<button data-empty-cmd="${cmd}">${esc(label)}</button>` : ''}</div>`;
  }

  function render() {
    const focusedId = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id;
    if (!state || state.state !== 'ok') {
      list.innerHTML = emptyState(state ? state.state : 'loading');
      return;
    }
    let html = '';
    for (const r of state.repos) {
      let depth = 0;
      if (state.multiRepo) {
        const open = !collapsedRepos.has(r.key) || !!query();
        html += repoRow(r, open);
        depth = 1;
        if (!open) continue;
      }
      for (const w of r.worktrees) html += worktreeRows(w, depth);
    }
    list.innerHTML =
      html ||
      `<div class="empty">${q.value.trim() ? `No branch, path or changed file matches “${esc(q.value.trim())}”.` : 'No worktrees.'}</div>`;
    if (focusedId) {
      const el = list.querySelector(`[data-id="${CSS.escape(focusedId)}"]`);
      if (el) el.focus();
    }
  }

  function findWorktree(key) {
    for (const r of (state && state.repos) || []) for (const w of r.worktrees) if (w.key === key) return w;
  }

  function toggle(row) {
    if (row.dataset.kind === 'repo') {
      const k = row.dataset.repo;
      collapsedRepos.has(k) ? collapsedRepos.delete(k) : collapsedRepos.add(k);
    } else {
      if (!row.hasAttribute('aria-expanded')) return;
      const k = row.dataset.key;
      if (expanded.has(k)) expanded.delete(k);
      else {
        expanded.add(k);
        const w = findWorktree(k);
        if (w && !w.files) vscode.postMessage({ type: 'expand', key: k });
      }
    }
    save();
    render();
  }

  function activate(row) {
    if (row.dataset.kind === 'file') vscode.postMessage({ type: 'diff', key: row.dataset.key, file: row.dataset.file });
    else toggle(row);
  }

  // ---- events ----
  list.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const emptyBtn = target.closest('[data-empty-cmd]');
    if (emptyBtn) {
      const cmd = emptyBtn.getAttribute('data-empty-cmd');
      vscode.postMessage(cmd ? { type: 'command', command: cmd } : { type: 'gitSettings' });
      return;
    }
    const button = target.closest('[data-cmd]');
    const row = target.closest('.row[data-kind]');
    if (button && row) {
      vscode.postMessage({
        type: 'command',
        command: button.getAttribute('data-cmd'),
        worktreeKey: row.dataset.key,
        repoKey: row.dataset.repo,
      });
      return;
    }
    if (!row) return;
    row.focus();
    activate(row);
  });

  list.addEventListener('keydown', (e) => {
    const rows = [...list.querySelectorAll('.row[data-kind]')];
    const i = rows.indexOf(document.activeElement);
    const row = rows[i];
    const open = row && row.getAttribute('aria-expanded') === 'true';
    switch (e.key) {
      case 'ArrowDown':
        (rows[i + 1] || rows[i] || rows[0])?.focus();
        break;
      case 'ArrowUp':
        if (i <= 0) q.focus();
        else rows[i - 1].focus();
        break;
      case 'ArrowRight':
        if (row && row.hasAttribute('aria-expanded') && !open) toggle(row);
        break;
      case 'ArrowLeft':
        if (row && open) toggle(row);
        else if (row && row.dataset.kind === 'file')
          list.querySelector(`.wt[data-key="${CSS.escape(row.dataset.key)}"]`)?.focus();
        break;
      case 'Enter':
      case ' ':
        if (row) activate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  let searchTimer;
  function onQuery() {
    searchBox.classList.toggle('has-value', !!q.value);
    save();
    render(); // instant highlight; the host re-filters and sends a fresh snapshot
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', q: q.value }), 120);
  }
  q.addEventListener('input', onQuery);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) {
      q.value = '';
      onQuery();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      list.querySelector('.row[data-kind]')?.focus();
    } else return;
    e.preventDefault();
  });
  document.getElementById('clear').addEventListener('click', () => {
    q.value = '';
    onQuery();
    q.focus();
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      state = m.state;
      render();
    } else if (m.type === 'collapseAll') {
      expanded.clear();
      collapsedRepos.clear();
      save();
      render();
    } else if (m.type === 'focusSearch') {
      q.focus();
      q.select();
    }
  });

  render();
  if (q.value) vscode.postMessage({ type: 'search', q: q.value });
  vscode.postMessage({ type: 'ready' });
})();
