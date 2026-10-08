# Changelog

## 0.2.4

- The "Open GitLens" output channel now traces what each history command does (file found, commits found, selection, diff opened).
- Commands act on a visible file editor when the active editor is the Output panel or a webview.
- `Diagnose` no longer loses the active file when it opens the output panel.

## 0.2.3

- Fix: commands could appear to do nothing when `git` is a wrapper/proxy that leaves background processes holding the output pipe open. Git calls now complete when the process exits, with a configurable timeout (`openGitLens.gitTimeoutSeconds`).
- Quick picks stay open when launched from a context menu (`ignoreFocusOut`).
- Loading indicator while file/line history is computed.
- New commands: **Open GitLens: Diagnose** (environment and git health report) and **Show Log**.

## 0.2.2

- Cross-platform hardening (Windows, Linux, macOS): uses the git executable VS Code itself uses, English git messages, unescaped non-ASCII file names, no console window flashing on Windows, clear error when git is missing, robust worktree path comparison.
- Automated tests: unit tests for the git layer and end-to-end tests in a real VS Code, run in CI on Windows, Linux and macOS.

## 0.2.1

- Rename display name to "Open GitLens" and extension id to `open-gitlens`.

## 0.2.0

- Commit Graph: columns (branch/tag, graph, message, author with avatar, date, sha, changes), minimap, search with prefixes, filters, hide refs, details panel (list/tree).
- Working Changes row: stage, unstage, discard, commit, amend. Stash rows in the graph.
- Worktrees view: create, open in new window, remove.
- Revision navigation: previous / next / working file.
- Compare a file or the working tree with any branch, tag or commit.
- Git CodeLens, file blame gutter, line blame with hovers, file and range history.

## 0.1.0

- Initial version: line blame, status bar blame, file blame, file history.
