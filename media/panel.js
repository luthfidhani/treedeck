// Worktrees panel UI. Receives PanelState snapshots from the extension (src/views/model.ts),
// renders them, and posts user actions back. Expanded rows and the query survive reloads via setState.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const expanded = new Set(saved.expanded || []);
  const collapsedRepos = new Set(saved.collapsedRepos || []);
  /** Which tab is showing: worktrees (folders on disk), branches (refs), or commits per branch. */
  let tab = saved.tab === 'commits' ? 'commits' : 'worktrees';
  /** Branches whose commit list is open, and commits whose file list is open (Commits tab). */
  const expandedCommitLists = new Set(saved.expandedCommitLists || []);
  const expandedCommits = new Set(saved.expandedCommits || []);
  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const searchBox = q.parentElement;
  const tabs = [...document.querySelectorAll('.tab')];
  const counts = {
    worktrees: document.getElementById('count-worktrees'),
    commits: document.getElementById('count-commits'),
  };
  /** @type {any} */
  let state = null;

  q.value = saved.q || '';
  searchBox.classList.toggle('has-value', !!q.value);

  const save = () =>
    vscode.setState({
      expanded: [...expanded],
      collapsedRepos: [...collapsedRepos],
      expandedCommitLists: [...expandedCommitLists],
      expandedCommits: [...expandedCommits],
      tab,
      q: q.value,
    });
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

  // Worktrees are folders, so they get folder-ish icons; branch rows keep the branch icon.
  // First match wins: problems (missing, locked) outrank the kind of worktree.
  // Each returns [icon, what hovering the icon says].
  function kindIcon(w) {
    if (w.prunable !== undefined) return ['warning', 'Missing: this folder no longer exists on disk'];
    if (w.locked !== undefined) return ['lock', 'Locked worktree: git will not remove or prune it'];
    if (w.bare) return ['database', 'Bare repository: it has no working files'];
    if (w.main) return ['home', 'Main checkout: the original clone folder'];
    if (w.agent) return ['hubot', 'Agent worktree: created by an AI coding agent'];
    return ['folder', 'Linked worktree: an extra folder of this repository'];
  }

  function syncTitle(ahead, behind, what) {
    return (
      [
        ahead ? `${ahead} commit${ahead === 1 ? '' : 's'} to push` : '',
        behind ? `${behind} commit${behind === 1 ? '' : 's'} to pull` : '',
      ]
        .filter(Boolean)
        .join(', ') + ` (compared with ${what})`
    );
  }

  /** "3d", "5mo" — short enough for the row, exact date lives in the tooltip. */
  function ago(unixSeconds) {
    if (!unixSeconds) return '';
    const s = Date.now() / 1000 - unixSeconds;
    const units = [
      [31536000, 'y'],
      [2592000, 'mo'],
      [604800, 'w'],
      [86400, 'd'],
      [3600, 'h'],
      [60, 'm'],
    ];
    for (const [secs, suffix] of units) if (s >= secs) return Math.floor(s / secs) + suffix;
    return 'now';
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

  /** Row icon with its own tooltip, so hovering the icon says what kind of row this is. */
  const kindSpan = (icon, title, extra = '') =>
    `<span class="kind codicon codicon-${icon} ${extra}" title="${esc(title)}"></span>`;

  /**
   * Who last committed on the branch (git stores no "branch creator").
   * GitHub's noreply addresses carry the username — `1234+octocat@users.noreply.github.com` — so
   * prefer that, then the plain local part of the address, then the name itself.
   */
  function userName(name, email) {
    if (!email) return name || '';
    const local = email.replace(/^<|>$/g, '').split('@')[0];
    return email.includes('users.noreply.github.com') ? local.replace(/^\d+\+/, '') : local || name;
  }

  function userSpan(name, email, when) {
    const who = userName(name, email);
    if (!who) return '';
    const title = `Last commit by ${name || who}${email ? ` <${email.replace(/^<|>$/g, '')}>` : ''}${
      when ? ` · ${when}` : ''
    }`;
    return `<span class="user" title="${esc(title)}">${esc(who)}</span>`;
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
    const classes = [
      'row',
      'wt',
      `d${depth}`,
      w.current && 'current',
      missing && 'missing',
      w.locked !== undefined && 'locked',
      w.agent && 'agent',
    ]
      .filter(Boolean)
      .join(' ');
    const sync = [w.ahead ? `↑${w.ahead}` : '', w.behind ? `↓${w.behind}` : ''].filter(Boolean).join(' ');
    const meta = [
      w.error && `<span class="codicon codicon-error err" title="${esc(w.error)}"></span>`,
      sync &&
        `<span class="sync" title="${esc(syncTitle(w.ahead, w.behind, 'its upstream'))}">${sync}</span>`,
      w.changed
        ? `<span class="badge" title="${w.changed} uncommitted or untracked file(s)">${w.changed}</span>`
        : '',
      loading &&
        '<span class="codicon codicon-loading codicon-modifier-spin" title="Checking status…"></span>',
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
      <span class="twistie codicon codicon-${
        canExpand ? (open ? 'chevron-down' : 'chevron-right') : 'blank'
      }"></span>
      ${kindSpan(kindIcon(w)[0], kindIcon(w)[1])}
      <span class="label">${hl(w.label)}</span>
      <span class="desc" title="Folder: ${esc(w.path)}">${esc(w.short)}</span>
      <span class="meta">${meta}</span>
      <span class="actions">${actions}</span>
    </div>`;

    if (open) html += fileRows(w, depth + 1, 'file', `data-key="${esc(w.key)}"`);
    return html;
  }

  /** Changed-file rows under a worktree (`file`) or a commit (`cfile`); `owner` carries files/changed. */
  function fileRows(owner, depth, kind, dataAttrs) {
    if (!owner.files) return '';
    let html = '';
    for (const f of owner.files) {
      const slash = f.path.lastIndexOf('/');
      const name = f.path.slice(slash + 1);
      const dir = slash >= 0 ? f.path.slice(0, slash) : '';
      const desc = [dir, f.orig && `← ${f.orig}`].filter(Boolean).join(' ');
      html += `<div class="row file d${depth} s-${cls(f.letter)}" role="treeitem" tabindex="-1" data-kind="${kind}"
        data-id="${kind}:${esc(owner.key || owner.name)}:${esc(f.path)}" ${dataAttrs} data-file="${esc(f.path)}"
        title="${esc(`${f.path} — ${STATUS[f.letter]}\nClick to open diff`)}">
        <span class="twistie codicon codicon-blank"></span>
        <span class="codicon codicon-file"></span>
        <span class="label">${hl(name)}</span>
        <span class="desc">${hl(desc)}</span>
        <span class="letter">${f.letter}</span>
      </div>`;
    }
    const more = owner.matchedByFile ? 0 : (owner.changed || 0) - owner.files.length;
    if (more > 0)
      html += `<div class="row more d${depth}"><span class="twistie codicon codicon-blank"></span>…and ${more} more</div>`;
    if (!owner.files.length)
      html += `<div class="row more d${depth}"><span class="twistie codicon codicon-blank"></span>${
        owner.base === '' ? 'No base branch to compare against.' : 'No changes.'
      }</div>`;
    return html;
  }

  /** One branch in the Commits tab: expand for the commits it added on top of the base branch. */
  function commitBranchRows(repoKey, b, depth) {
    const key = `${repoKey}\0${b.name}`;
    const open = expandedCommitLists.has(key);
    const ctx = JSON.stringify({
      webviewSection: 'branch',
      repoKey,
      branchName: b.name,
      branchCurrent: b.current,
      preventDefaultContextMenuItems: true,
    });
    const sync = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
    const meta = [
      b.error && `<span class="codicon codicon-error err" title="${esc(b.error)}"></span>`,
      sync &&
        `<span class="sync" title="${esc(syncTitle(b.ahead, b.behind, b.upstream || 'its upstream'))}">${sync}</span>`,
      b.commits
        ? `<span class="badge soft" title="${b.commits.length} commit(s) of its own">${b.commits.length}</span>`
        : '',
      userSpan(b.author, b.authorEmail, b.date ? new Date(b.date * 1000).toLocaleString() : ''),
      `<span class="when" title="${esc(
        b.date ? `Last commit ${new Date(b.date * 1000).toLocaleString()}` : 'No commit date',
      )}">${ago(b.date)}</span>`,
    ]
      .filter(Boolean)
      .join('');
    const actions = [
      `<button class="icon-btn codicon codicon-diff-multiple" data-preview="branch"
        title="Preview every change on this branch, compared with the base branch"
        aria-label="Preview branch changes"></button>`,
      b.current
        ? ''
        : b.worktreeKey
          ? btn('treedeck.openWorktree', 'folder-opened', 'Open the worktree that has this branch')
          : btn(
              'treedeck.checkoutBranch',
              'arrow-swap',
              b.remote
                ? 'Create a local branch tracking this remote branch and switch to it'
                : 'Switch this worktree to this branch (git checkout)',
            ),
    ]
      .filter(Boolean)
      .join('');
    const title = [
      `Branch: ${b.name}`,
      b.remote && 'Exists only on the remote; checking it out creates a local branch that tracks it',
      b.worktreeShort && `Worktree: ${b.worktreeShort}`,
      b.upstream && `Upstream: ${b.upstream}${b.gone ? ' (gone)' : ''}`,
      b.merged && 'Already merged into the base branch',
      b.gone && 'Its remote branch was deleted, usually right after a merge',
      'Expand for the commits it added on top of the base branch',
    ]
      .filter(Boolean)
      .join('\n');

    let html = `<div class="row branch d${depth} ${b.current ? 'current' : ''}" role="treeitem" tabindex="-1"
      data-kind="commits" data-id="cb:${esc(key)}" data-repo="${esc(repoKey)}" data-branch="${esc(b.name)}"
      ${b.worktreeKey ? `data-key="${esc(b.worktreeKey)}"` : ''} aria-expanded="${open}"
      title="${esc(title)}" data-vscode-context="${esc(ctx)}">
      <span class="twistie codicon codicon-${open ? 'chevron-down' : 'chevron-right'}"></span>
      ${kindSpan(
        b.current ? 'check' : b.remote ? 'cloud' : 'git-branch',
        b.current
          ? 'Checked out in this window'
          : b.remote
            ? 'Only on the remote so far — check it out to get a local branch (as fresh as your last git fetch)'
            : b.worktreeKey
              ? `Checked out in the worktree ${b.worktreeShort}; git allows a branch in only one worktree`
              : 'Local branch',
        b.worktreeKey && !b.current ? 'held' : '',
      )}
      <span class="label">${hl(b.label)}</span>
      <span class="desc" title="${esc(
        b.worktreeShort
          ? `Checked out in ${b.worktreeShort}`
          : b.remote
            ? `Remote branch ${b.name}`
            : b.upstream
              ? `Tracks ${b.upstream}`
              : 'No upstream',
      )}">${
        b.worktreeShort
          ? `<span class="codicon codicon-folder inline"></span>${esc(b.worktreeShort)}`
          : b.remote
            ? esc(b.name.slice(0, b.name.indexOf('/')))
            : ''
      }</span>
      <span class="meta">${meta}</span>
      <span class="actions">${actions}</span>
    </div>`;
    if (!open) return html;
    if (!b.commits)
      return (
        html +
        `<div class="row more d${depth + 1}"><span class="twistie codicon codicon-blank"></span>Loading commits…</div>`
      );
    if (!b.commits.length)
      return (
        html +
        `<div class="row more d${depth + 1}"><span class="twistie codicon codicon-blank"></span>No commits of its own.</div>`
      );
    for (const c of b.commits) html += commitRows(repoKey, c, depth + 1);
    return html;
  }

  function commitRows(repoKey, c, depth) {
    const open = expandedCommits.has(c.sha);
    const when = c.date ? new Date(c.date * 1000).toLocaleString() : '';
    let html = `<div class="row commit d${depth}" role="treeitem" tabindex="-1" data-kind="commit"
      data-id="c:${esc(c.sha)}" data-repo="${esc(repoKey)}" data-sha="${esc(c.sha)}" aria-expanded="${open}"
      title="${esc(`${c.short} ${c.subject}\n${c.author} <${c.authorEmail}>\n${when}`)}">
      <span class="twistie codicon codicon-${open ? 'chevron-down' : 'chevron-right'}"></span>
      <span class="kind codicon codicon-git-commit" title="Commit"></span>
      <span class="label">${hl(c.subject)}</span>
      <span class="desc sha">${esc(c.short)}</span>
      <span class="meta">${userSpan(c.author, c.authorEmail, when)}<span class="when">${ago(c.date)}</span></span>
      <span class="actions"><button class="icon-btn codicon codicon-diff-multiple" data-preview="commit"
        title="Preview everything this commit changed" aria-label="Preview commit changes"></button></span>
    </div>`;
    if (!open) return html;
    return (
      html +
      (c.files
        ? fileRows(
            { files: c.files, changed: c.files.length, key: c.sha, matchedByFile: false },
            depth + 1,
            'cfile',
            `data-repo="${esc(repoKey)}" data-sha="${esc(c.sha)}"`,
          )
        : `<div class="row more d${depth + 1}"><span class="twistie codicon codicon-blank"></span>Loading files…</div>`)
    );
  }

  function repoRow(r, open) {
    return `<div class="row repo" role="treeitem" tabindex="-1" data-kind="repo" data-id="r:${esc(r.key)}"
      data-repo="${esc(r.key)}" aria-expanded="${open}" title="${esc(r.key)}">
      <span class="twistie codicon codicon-chevron-${open ? 'down' : 'right'}"></span>
      <span class="codicon codicon-repo"></span>
      <span class="label">${esc(r.name)}</span>
      <span class="desc">${tab === 'worktrees' ? r.worktrees.length : r.branches.length}</span>
      <span class="actions">${btn('treedeck.createWorktree', 'add', 'Create Worktree…')}</span>
    </div>`;
  }

  /** Nothing to show in this tab: say why, and point at the other tab when the matches are there. */
  function emptyList(total) {
    const f = q.value.trim();
    const other = tab === 'worktrees' ? 'commits' : 'worktrees';
    if (f) {
      const hint =
        total[other] > 0
          ? `<button data-switch="${other}">Show ${total[other]} matching ${other}</button>`
          : '';
      return `<div class="empty">No ${tab} match “${esc(f)}”.${hint}</div>`;
    }
    return tab === 'worktrees'
      ? '<div class="empty">No worktrees yet. Use the + button above to add one for a branch.</div>'
      : '<div class="empty">No local branches.</div>';
  }

  function emptyState(s) {
    const msg = {
      loading: ['Loading worktrees…'],
      noFolder: ['No folder is open.', 'Open Folder', 'workbench.action.files.openFolder'],
      noRepo: [
        'No git repository found in this workspace.',
        'Open Folder',
        'workbench.action.files.openFolder',
      ],
      noGit: ['Git was not found, or is older than 2.7.', 'Configure Git Path', ''],
    }[s];
    const [text, label, cmd] = msg || ['Something went wrong.'];
    return `<div class="empty">${esc(text)}${label ? `<button data-empty-cmd="${cmd}">${esc(label)}</button>` : ''}</div>`;
  }

  function render() {
    const focusedId =
      document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id;
    if (!state || state.state !== 'ok') {
      list.innerHTML = emptyState(state ? state.state : 'loading');
      return;
    }
    const total = { worktrees: 0, commits: 0 };
    for (const r of state.repos) {
      total.worktrees += r.worktrees.length;
      total.commits += r.branches.length; // the Commits tab lists branches, then their commits
    }
    for (const t of tabs) {
      const name = t.dataset.tab;
      t.classList.toggle('active', name === tab);
      t.setAttribute('aria-selected', String(name === tab));
      counts[name].textContent = total[name] || '';
    }

    let html = '';
    for (const r of state.repos) {
      if (!(tab === 'worktrees' ? r.worktrees.length : r.branches.length)) continue;
      let depth = 0;
      if (state.multiRepo) {
        const open = !collapsedRepos.has(r.key) || !!query();
        html += repoRow(r, open);
        depth = 1;
        if (!open) continue;
      }
      if (tab === 'worktrees') for (const w of r.worktrees) html += worktreeRows(w, depth);
      else for (const b of r.branches) html += commitBranchRows(r.key, b, depth);
    }
    list.innerHTML = html || emptyList(total);
    if (focusedId) {
      const el = list.querySelector(`[data-id="${CSS.escape(focusedId)}"]`);
      if (el) el.focus();
    }
  }

  function findWorktree(key) {
    for (const r of (state && state.repos) || []) for (const w of r.worktrees) if (w.key === key) return w;
  }

  function findBranch(repoKey, name) {
    const r = ((state && state.repos) || []).find((x) => x.key === repoKey);
    return r && r.branches.find((b) => b.name === name);
  }

  function toggle(row) {
    const kind = row.dataset.kind;
    if (kind === 'repo') {
      const k = row.dataset.repo;
      collapsedRepos.has(k) ? collapsedRepos.delete(k) : collapsedRepos.add(k);
    } else if (kind === 'commits') {
      const k = `${row.dataset.repo}\0${row.dataset.branch}`;
      if (expandedCommitLists.has(k)) expandedCommitLists.delete(k);
      else {
        expandedCommitLists.add(k);
        const b = findBranch(row.dataset.repo, row.dataset.branch);
        if (b && !b.commits)
          vscode.postMessage({ type: 'expandCommits', repoKey: row.dataset.repo, name: row.dataset.branch });
      }
    } else if (kind === 'commit') {
      const sha = row.dataset.sha;
      if (expandedCommits.has(sha)) expandedCommits.delete(sha);
      else {
        expandedCommits.add(sha);
        vscode.postMessage({ type: 'expandCommit', repoKey: row.dataset.repo, sha });
      }
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
    const kind = row.dataset.kind;
    if (kind === 'file') vscode.postMessage({ type: 'diff', key: row.dataset.key, file: row.dataset.file });
    else if (kind === 'cfile')
      vscode.postMessage({
        type: 'commitDiff',
        repoKey: row.dataset.repo,
        sha: row.dataset.sha,
        file: row.dataset.file,
      });
    else toggle(row);
  }

  const placeholder = () =>
    tab === 'worktrees' ? 'Search worktrees and changed files' : 'Search branches and commits';

  function setTab(next) {
    if (next === tab) return;
    tab = next;
    q.placeholder = placeholder();
    save();
    render();
  }

  // ---- events ----
  for (const t of tabs) t.addEventListener('click', () => setTab(t.dataset.tab));

  list.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const switchTo = target.closest('[data-switch]');
    if (switchTo) return setTab(switchTo.getAttribute('data-switch'));
    const emptyBtn = target.closest('[data-empty-cmd]');
    if (emptyBtn) {
      const cmd = emptyBtn.getAttribute('data-empty-cmd');
      vscode.postMessage(cmd ? { type: 'command', command: cmd } : { type: 'gitSettings' });
      return;
    }
    const row = target.closest('.row[data-kind]');
    const preview = target.closest('[data-preview]');
    if (preview && row) {
      return vscode.postMessage(
        preview.getAttribute('data-preview') === 'branch'
          ? { type: 'previewBranch', repoKey: row.dataset.repo, name: row.dataset.branch }
          : {
              type: 'previewCommit',
              repoKey: row.dataset.repo,
              sha: row.dataset.sha,
              subject: row.querySelector('.label').textContent,
            },
      );
    }
    const button = target.closest('[data-cmd]');
    if (button && row) {
      vscode.postMessage({
        type: 'command',
        command: button.getAttribute('data-cmd'),
        worktreeKey: row.dataset.key,
        // A branch row carries the repo in data-repo; a worktree row inherits its repo from the model.
        repoKey: row.dataset.repo,
        branchName: row.dataset.branch,
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
        else if (row && row.dataset.kind === 'cfile')
          list.querySelector(`[data-id="${CSS.escape('c:' + row.dataset.sha)}"]`)?.focus();
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
      expandedCommitLists.clear();
      expandedCommits.clear();
      save();
      render();
    } else if (m.type === 'focusSearch') {
      q.focus();
      q.select();
    }
  });

  q.placeholder = placeholder();
  render();
  if (q.value) vscode.postMessage({ type: 'search', q: q.value });
  vscode.postMessage({ type: 'ready' });
})();
