# Open GitLens

Free, local-only GitLens-style Git tooling for VS Code. Plain JS, no build step, uses the `git` CLI.

## Commit Graph (`Cmd+Alt+G G`)

- Columns: Branch/Tag, Graph, Commit Message, Author (avatar), Date, Sha, Changes (+/-). Drag to resize, right-click the header to hide, compact graph mode.
- Header: repo, current branch (click to switch), ahead/behind, Pull, Push, Fetch with last-fetched time.
- Working Changes row and stash rows inside the graph. Selecting Working Changes lets you stage, unstage, discard and commit (or amend).
- Search with prefixes: `message:` `author:` `file:` `change:` `commit:` `after:` `before:` `@me`. Options: match case, regex. `F3` / `Shift+F3` / `Enter` to move between matches.
- Filters: All / Current / Smart branches; show or hide remote branches, tags, stashes; dim merge commits; hide individual refs (right-click a branch/tag chip).
- Minimap with markers for HEAD, branches, tags, stashes and search results. Click to jump.
- Details panel: message, author, parents, changed files as list or tree, per-file diff, open file, file history.
- Context menus on commits (checkout, branch, tag, cherry-pick, revert, undo commit, reset, compare, open on remote), stashes (apply/pop/drop) and refs.

## Editor

| Feature | How |
|---|---|
| Line blame, status bar blame, hovers (Changes / Copy SHA / Open on remote / Blame previous) | automatic |
| File blame (age-colored gutter) | `Alt+B` |
| Git CodeLens (latest author, author count) | `Shift+Alt+B` to toggle |
| Compare file with branch, tag or commit; between two revisions; open file at revision | right click > Open GitLens, or `Cmd+Alt+G C` |
| Revision navigation: previous / next / working file | `Alt+,` / `Alt+.`, or the arrows in the diff title |
| File history in the side bar: arrow keys show each commit's changes on the right; line/range history | `Cmd+Alt+G H` |

## Side bar views

Branches, Compare, Worktrees (create, open in new window, remove), Tags, Stashes, Contributors.

## Not included (need a GitKraken account/cloud)

Launchpad, Cloud Patches, Code Suggest, and all AI features.

## Supported platforms

Windows, Linux and macOS. Needs `git` available to VS Code (it uses the same executable as the built-in Git extension, or the `git.path` setting). CI runs the unit tests and an end-to-end suite in a real VS Code on all three systems.

## Install

From the Marketplace: search for **Open GitLens**, or run `code --install-extension devneonix.open-gitlens`.

From a `.vsix`: `code --install-extension open-gitlens-<version>.vsix`.

## Develop

```bash
npm ci
npm test                # syntax check + unit tests (temporary git repos)
npm run test:e2e        # runs the commands in a real VS Code (downloads it once)
```

Run the extension from source: open this folder in VS Code and press `F5`.

Avatars come from Gravatar/GitHub. Disable with `openGitLens.graph.avatars: false`.

## Layout

- `src/git.js` git CLI wrapper (no `vscode` import, testable with plain node)
- `src/gitGraph.js` graph data: scopes, stashes, status, stats, search, worktrees
- `src/graphLayout.js` pure lane-assignment algorithm
- `src/graph.js` + `media/graph.{js,css}` Commit Graph webview
- `src/views.js` tree views, `src/compare.js` Compare, `src/revisions.js` revision navigation
- `test/unit` git-layer tests, `test/e2e` real VS Code tests
- `src/extension.js` line blame, `src/annotations.js` file blame, `src/history.js` history/diffs, `src/codelens.js`, `src/actions.js`
