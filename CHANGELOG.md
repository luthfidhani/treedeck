# Changelog

## 0.2.0 — 2026-10-29

- A Fetch button in the panel title runs `git fetch --all --prune`, so remote branches stay current. It is
  the only part of TreeDeck that uses the network, and only when pressed.

- The Branches tab is now the Commits tab: every local branch, expandable to the commits it added on top of
  the base branch, and each commit expandable to its files.
- Preview buttons open a multi-file diff: for a branch, everything it changes against the base branch; for a
  commit, everything that commit changed.
- A branch row's second button switches this worktree to it, or opens the worktree that already holds it.
- Branches that exist only on the remote are listed too, so a branch behind someone's pull request shows up
  before you check it out; checking one out creates a local branch that tracks it.

- Worktrees and Branches are now two tabs in the panel, with folder icons for worktrees and branch icons for
  branches, per-tab counts and search, and a jump to the other tab when the matches are there.
- Checkout a branch from the panel; a branch held by another worktree offers to open that worktree.
- Merged and deleted-upstream branches are called out in the row tooltip.
- Every icon, count and button explains itself on hover.
- Branches are listed flat: the one you are on first, then newest commit first.
- Each branch shows who last committed on it — their GitHub username when the commit email gives one — and
  how long ago.
- Status is carried by icons with hover explanations instead of text chips.
- Search also matches branch names.
- The watcher now notices branches being created, deleted or moved.

## 0.1.0

- Worktrees view: list, open (same/new window), copy path, reveal, current-worktree highlight.
- Changed files per worktree with git colors; click for HEAD ↔ working tree diff.
- Lazy change-count badges, ahead/behind upstream, auto refresh on git changes.
- Create / remove / prune worktrees; compare with base branch; compare two worktrees.
- Post-create setup (copy files, run command), agent worktree tagging, sort and filter.
- Status bar switcher. Multi-root and multi-repo support.
