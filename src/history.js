const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');
const { fileEditor, guarded, log, quickPick, uriFromArg, withLoading } = require('./repo');
const { fromNow } = require('./time');

const SCHEME = 'open-git-lens';

function toRevisionUri(root, rev, relativePath) {
    return vscode.Uri.from({
        scheme: SCHEME,
        path: `/${relativePath}`,
        query: JSON.stringify({ root, rev }),
    });
}

const contentProvider = {
    async provideTextDocumentContent(uri) {
        const { root, rev } = JSON.parse(uri.query);
        return rev ? git.showFile(root, rev, uri.path.slice(1)) : '';
    },
};

/**
 * Opens a diff between two revisions of a file. `right: undefined` means the working-tree file; `''` means empty (deleted).
 */
async function openRevisionsDiff({ root, left, leftFile, right, rightFile, title }) {
    const rightUri = right === undefined ? vscode.Uri.file(path.join(root, rightFile)) : toRevisionUri(root, right, rightFile);
    await vscode.commands.executeCommand('vscode.diff', toRevisionUri(root, left, leftFile), rightUri, title);
}

/** Opens the diff of a commit against its parent for a file. */
async function openCommitDiff({ filePath, root, sha, file, oldFile }) {
    log(`opening diff of ${sha.slice(0, 8)} for ${file ?? filePath}`);
    const resolved = root ? { root, relativePath: file } : await git.getRelativePath(filePath);
    const target = file ?? resolved.relativePath;
    const parent = await git.getParentSha(resolved.root, sha);
    await openRevisionsDiff({
        root: resolved.root,
        left: parent,
        leftFile: oldFile ?? target,
        right: sha,
        rightFile: target,
        title: `${path.basename(target)} (${sha.slice(0, 8)})`,
    });
}

async function pickCommit(commits, placeHolder, filePath) {
    log(`${placeHolder}: ${commits.length} commit(s) found`);
    if (commits.length === 0) {
        vscode.window.showInformationMessage('Open GitLens: no history found.');
        return;
    }
    const picked = await quickPick(
        commits.map(commit => ({
            label: commit.summary,
            description: `${commit.author}, ${fromNow(commit.date)}`,
            detail: commit.sha.slice(0, 8),
            commit,
        })),
        { placeHolder, matchOnDescription: true, matchOnDetail: true },
    );
    log(picked ? `picked ${picked.commit.sha.slice(0, 8)}` : 'quick pick closed without choosing');
    if (picked) {
        await openCommitDiff({ filePath, sha: picked.commit.sha, file: picked.commit.file });
    }
}

function activeFile() {
    const editor = fileEditor();
    if (!editor) {
        log('no file editor available (active editor is not a file and none is visible)');
        vscode.window.showInformationMessage('Open GitLens: open a file first.');
        return;
    }
    return editor;
}

function register(context) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
        vscode.commands.registerCommand('openGitLens.openCommitDiff', args => guarded(() => openCommitDiff(args))),
        vscode.commands.registerCommand('openGitLens.showFileHistory', arg => guarded(async () => {
            const clicked = uriFromArg(arg);
            log(`command: Show File History (${clicked ? 'clicked file' : 'active editor'})`);
            const filePath = clicked?.fsPath ?? activeFile()?.document.uri.fsPath;
            if (!filePath) {
                return;
            }
            await pickCommit(await withLoading('loading file history…', () => git.fileHistory(filePath)), `History of ${path.basename(filePath)}`, filePath);
        })),
        vscode.commands.registerCommand('openGitLens.showRangeHistory', ({ filePath, start, end }) => guarded(async () => {
            log(`range history ${filePath} lines ${start}-${end}`);
            await pickCommit(await withLoading('loading line history…', () => git.lineHistory(filePath, start, end)), `History of lines ${start}-${end}`, filePath);
        })),
        vscode.commands.registerCommand('openGitLens.showFileHistoryOf', filePath => guarded(async () => {
            await pickCommit(await withLoading('loading file history…', () => git.fileHistory(filePath)), `History of ${path.basename(filePath)}`, filePath);
        })),
        vscode.commands.registerCommand('openGitLens.showLineHistory', () => guarded(async () => {
            log('command: Show Line History');
            const editor = activeFile();
            if (!editor) {
                return;
            }
            const { start, end } = editor.selection;
            await vscode.commands.executeCommand('openGitLens.showRangeHistory', {
                filePath: editor.document.uri.fsPath,
                start: start.line + 1,
                end: end.line + 1,
            });
        })),
        vscode.commands.registerCommand('openGitLens.copySha', async ({ sha }) => {
            await vscode.env.clipboard.writeText(sha);
            vscode.window.setStatusBarMessage(`Copied ${sha.slice(0, 8)}`, 2000);
        }),
        vscode.commands.registerCommand('openGitLens.openCommitOnRemote', ({ filePath, sha }) => guarded(async () => {
            await vscode.env.openExternal(vscode.Uri.parse(await git.getCommitUrl(path.dirname(filePath), sha)));
        })),
    );
}

module.exports = { register, openCommitDiff, openRevisionsDiff, toRevisionUri, SCHEME };
