const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');
const { guarded, log } = require('./repo');

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
async function openRevisionsDiff({ root, left, leftFile, right, rightFile, title, options }) {
    const rightUri = right === undefined ? vscode.Uri.file(path.join(root, rightFile)) : toRevisionUri(root, right, rightFile);
    await vscode.commands.executeCommand('vscode.diff', toRevisionUri(root, left, leftFile), rightUri, title, options);
}

/**
 * Opens the diff of a commit against its parent for a file.
 * If the commit renamed the file, the left side uses the old name.
 */
async function openCommitDiff({ filePath, root, sha, file, oldFile, options }) {
    log(`opening diff of ${sha.slice(0, 8)} for ${file ?? filePath}`);
    const resolved = root ? { root, relativePath: file } : await git.getRelativePath(filePath);
    const target = file ?? resolved.relativePath;
    const parent = await git.getParentSha(resolved.root, sha);
    let previousName = oldFile;
    if (!previousName && parent) {
        const changed = await git.commitFiles(resolved.root, sha).catch(() => []);
        previousName = changed.find(entry => entry.file === target)?.oldFile;
    }
    await openRevisionsDiff({
        root: resolved.root,
        left: parent,
        leftFile: previousName ?? target,
        right: sha,
        rightFile: target,
        title: `${path.basename(target)} (${sha.slice(0, 8)})`,
        options,
    });
}

function register(context) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
        vscode.commands.registerCommand('openGitLens.openCommitDiff', args => guarded(() => openCommitDiff(args))),
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
