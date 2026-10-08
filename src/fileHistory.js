const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');
const { avatarKey } = require('./gitGraph');
const { openCommitDiff, openRevisionsDiff, toRevisionUri } = require('./history');
const { fileEditor, guarded, log, onDidChangeRepo, uriFromArg, withLoading } = require('./repo');

const VIEW_ID = 'openGitLens.fileHistory';
const PAGE_SIZE = 100;
const FOLLOW_DEBOUNCE_MS = 250;
const PIN_CONTEXT = 'openGitLens.fileHistoryPinned';
const KEEP_FOCUS = { preserveFocus: true, preview: true };
const TAKE_FOCUS = { preserveFocus: false, preview: false };

function buildHtml(webview, extensionUri) {
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src https://www.gravatar.com https://avatars.githubusercontent.com data:;">
<link rel="stylesheet" href="${asset('fileHistory.css')}">
</head>
<body>
<div id="error"></div>
<div id="empty"><div id="emptyText"></div><button id="showHistory">Show File History</button></div>
<div id="list" tabindex="0"></div>
<div id="menu"></div>
<script nonce="${nonce}" src="${asset('fileHistory.js')}"></script>
</body>
</html>`;
}

class FileHistoryView {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this.webviewView = undefined;
        this.target = undefined;
        this.commits = [];
        this.limit = PAGE_SIZE;
        this.hasMore = false;
        this.error = undefined;
        this.loadId = 0;
        this.selectedSha = undefined;
        this.pinned = false;
        this.selectionEvents = 0;
        this.handlers = {};
    }

    get visible() {
        return Boolean(this.webviewView?.visible);
    }

    resolveWebviewView(webviewView) {
        this.webviewView = webviewView;
        const { webview } = webviewView;
        webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
        webview.html = buildHtml(webview, this.extensionUri);
        webview.onDidReceiveMessage(message => this.handlers.onMessage?.(message));
        webviewView.onDidChangeVisibility(() => this.handlers.onVisibility?.(webviewView.visible));
        webviewView.onDidDispose(() => {
            this.webviewView = undefined;
        });
        this.updateHeader();
    }

    setTarget(target) {
        this.target = target;
        this.limit = PAGE_SIZE;
        this.selectedSha = undefined;
    }

    updateHeader() {
        if (!this.webviewView || !this.target) {
            return;
        }
        const name = path.basename(this.target.filePath);
        this.webviewView.description = this.target.range ? `${name}:${this.target.range.start}-${this.target.range.end}` : name;
    }

    post(message) {
        return this.webviewView?.webview.postMessage(message);
    }

    pushState() {
        this.updateHeader();
        this.post({
            type: 'state',
            file: this.target?.filePath,
            error: this.error,
            hasMore: this.hasMore,
            avatars: vscode.workspace.getConfiguration('openGitLens').get('graph.avatars', true),
            selectedSha: this.selectedSha,
            commits: this.commits.map(commit => ({
                sha: commit.sha,
                summary: commit.summary,
                author: commit.author,
                avatar: avatarKey(commit.email),
                date: commit.date.getTime(),
            })),
        });
    }

    /** Loads commits for the current target and refreshes the view. */
    async load() {
        const id = ++this.loadId;
        const { target } = this;
        let commits = [];
        this.error = undefined;
        if (target) {
            try {
                commits = target.range
                    ? await git.lineHistory(target.filePath, target.range.start, target.range.end, this.limit)
                    : await git.fileHistory(target.filePath, this.limit);
            } catch (error) {
                this.error = error.message;
                log(`file history failed: ${error.message}`);
            }
        }
        if (id !== this.loadId) {
            return;
        }
        this.commits = commits;
        this.hasMore = commits.length === this.limit;
        log(`file history: ${commits.length} commit(s) for ${target?.filePath ?? '(no file)'}`);
        this.pushState();
    }
}

function register(context) {
    const view = new FileHistoryView(context.extensionUri);
    let followTimer;

    const setPinned = value => {
        view.pinned = value;
        return vscode.commands.executeCommand('setContext', PIN_CONTEXT, value);
    };

    const commitBySha = sha => view.commits.find(commit => commit.sha === sha);

    const openCommit = (commit, options) => {
        if (!commit || !view.target) {
            return undefined;
        }
        return openCommitDiff({ filePath: view.target.filePath, sha: commit.sha, file: commit.file, options });
    };

    /** Marks a commit as selected and shows its diff on the right. */
    const selectCommit = async (sha, options = KEEP_FOCUS) => {
        const commit = commitBySha(sha);
        if (!commit) {
            return;
        }
        view.selectedSha = sha;
        view.selectionEvents++;
        log(`selected ${sha.slice(0, 8)}`);
        await openCommit(commit, options);
    };

    const show = async (target, { select }) => {
        view.setTarget(target);
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        await withLoading('loading history…', () => view.load());
        if (select && view.commits.length > 0) {
            view.selectedSha = view.commits[0].sha;
            view.pushState();
            await selectCommit(view.commits[0].sha);
            view.post({ type: 'focus' });
        }
    };

    const withCommit = handler => async sha => {
        const commit = commitBySha(sha);
        if (commit && view.target) {
            await handler(commit);
        }
    };

    const actions = {
        compareWithWorking: withCommit(async commit => {
            const { root, relativePath } = await git.getRelativePath(view.target.filePath);
            await openRevisionsDiff({
                root,
                left: commit.sha,
                leftFile: commit.file ?? relativePath,
                right: undefined,
                rightFile: relativePath,
                title: `${path.basename(relativePath)} (${commit.sha.slice(0, 8)} ↔ working tree)`,
            });
        }),
        openAtRevision: withCommit(async commit => {
            const { root, relativePath } = await git.getRelativePath(view.target.filePath);
            const document = await vscode.workspace.openTextDocument(toRevisionUri(root, commit.sha, commit.file ?? relativePath));
            await vscode.window.showTextDocument(document, { preview: true });
        }),
        copySha: withCommit(commit => vscode.commands.executeCommand('openGitLens.copySha', { sha: commit.sha })),
        openOnRemote: withCommit(commit => vscode.commands.executeCommand('openGitLens.openCommitOnRemote', { filePath: view.target.filePath, sha: commit.sha })),
        showInGraph: withCommit(commit => vscode.commands.executeCommand('openGitLens.showGraph', { search: commit.sha.slice(0, 8) })),
    };

    view.handlers.onMessage = message => guarded(async () => {
        switch (message.type) {
            case 'ready':
                if (!view.target) {
                    const editor = fileEditor();
                    if (editor) {
                        view.setTarget({ filePath: editor.document.uri.fsPath });
                        await view.load();
                        break;
                    }
                }
                view.pushState();
                break;
            case 'select':
                await selectCommit(message.sha, message.focusEditor ? TAKE_FOCUS : KEEP_FOCUS);
                break;
            case 'loadMore':
                view.limit += PAGE_SIZE;
                await withLoading('loading history…', () => view.load());
                break;
            case 'action':
                await actions[message.action]?.(message.sha);
                break;
            case 'showHistory':
                await vscode.commands.executeCommand('openGitLens.showFileHistory');
                break;
        }
    });

    view.handlers.onVisibility = visible => {
        const editor = fileEditor();
        if (visible && !view.target && editor) {
            view.setTarget({ filePath: editor.document.uri.fsPath });
            guarded(() => view.load());
        }
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),

        vscode.commands.registerCommand('openGitLens.showFileHistory', arg => guarded(async () => {
            const clicked = uriFromArg(arg);
            const filePath = clicked?.fsPath ?? fileEditor()?.document.uri.fsPath;
            log(`command: Show File History (${clicked ? 'clicked file' : 'active editor'}) ${filePath ?? ''}`);
            if (!filePath) {
                vscode.window.showInformationMessage('Open GitLens: open a file first.');
                return;
            }
            await setPinned(false);
            await show({ filePath }, { select: true });
        })),
        vscode.commands.registerCommand('openGitLens.showFileHistoryOf', filePath => guarded(async () => {
            await setPinned(false);
            await show({ filePath }, { select: true });
        })),
        vscode.commands.registerCommand('openGitLens.showRangeHistory', ({ filePath, start, end }) => guarded(async () => {
            log(`range history ${filePath} lines ${start}-${end}`);
            await setPinned(true);
            await show({ filePath, range: { start, end } }, { select: true });
        })),
        vscode.commands.registerCommand('openGitLens.showLineHistory', () => guarded(async () => {
            const editor = fileEditor();
            log(`command: Show Line History ${editor?.document.uri.fsPath ?? ''}`);
            if (!editor) {
                vscode.window.showInformationMessage('Open GitLens: open a file first.');
                return;
            }
            const { start, end } = editor.selection;
            // A selection that ends at column 0 of the next line does not include that line.
            const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
            await vscode.commands.executeCommand('openGitLens.showRangeHistory', {
                filePath: editor.document.uri.fsPath,
                start: start.line + 1,
                end: lastLine + 1,
            });
        })),

        vscode.commands.registerCommand('openGitLens.fileHistory.refresh', () => guarded(() => withLoading('loading history…', () => view.load()))),
        vscode.commands.registerCommand('openGitLens.fileHistory.pin', () => setPinned(true)),
        vscode.commands.registerCommand('openGitLens.fileHistory.unpin', () => setPinned(false)),

        // Read-only state and a selection hook used by the end-to-end tests.
        vscode.commands.registerCommand('openGitLens._fileHistoryState', () => ({
            file: view.target?.filePath,
            range: view.target?.range,
            count: view.commits.length,
            pinned: view.pinned,
            selectionEvents: view.selectionEvents,
            selected: view.selectedSha?.slice(0, 8),
        })),
        vscode.commands.registerCommand('openGitLens._fileHistorySelect', index => guarded(async () => {
            const commit = view.commits[index];
            if (commit) {
                view.selectedSha = commit.sha;
                view.pushState();
                await selectCommit(commit.sha);
            }
        })),

        // Follow the active file while the view is visible and not pinned.
        vscode.window.onDidChangeActiveTextEditor(editor => {
            clearTimeout(followTimer);
            followTimer = setTimeout(() => {
                const filePath = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;
                if (!view.pinned && view.visible && filePath && filePath !== view.target?.filePath) {
                    view.setTarget({ filePath });
                    guarded(() => view.load());
                }
            }, FOLLOW_DEBOUNCE_MS);
        }),
        onDidChangeRepo(() => {
            if (view.visible && view.target) {
                guarded(() => view.load());
            }
        }),
        { dispose: () => clearTimeout(followTimer) },
    );
    setPinned(false);
}

module.exports = { register };
