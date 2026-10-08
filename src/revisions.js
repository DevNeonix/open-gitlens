const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');
const { openRevisionsDiff, SCHEME } = require('./history');
const { guarded } = require('./repo');

const RECORD = '\x1e';

/** Identifies the file shown in the active editor, either on disk or at a revision. */
async function resolveActive() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('Open a file first.');
    }
    const { uri } = editor.document;
    if (uri.scheme === SCHEME) {
        const { root, rev } = JSON.parse(uri.query);
        return { root, rev, relativePath: uri.path.slice(1) };
    }
    if (uri.scheme === 'file') {
        const { root, relativePath } = await git.getRelativePath(uri.fsPath);
        return { root, rev: undefined, relativePath };
    }
    throw new Error('Open a file first.');
}

/** Commits touching the file at or before `rev`, newest first. */
async function touching(root, rev, relativePath, limit) {
    const output = await git.exec(root, ['log', '--follow', '-n', String(limit), '--name-only', `--format=${RECORD}%H`, rev ?? 'HEAD', '--', relativePath]);
    return output.split(RECORD).filter(Boolean).map(chunk => {
        const [sha, ...files] = chunk.split('\n');
        return { sha: sha.trim(), file: files.find(Boolean) ?? relativePath };
    });
}

const short = sha => sha.slice(0, 8);

async function diffWithPrevious() {
    const { root, rev, relativePath } = await resolveActive();
    const commits = await touching(root, rev, relativePath, 2);
    if (commits.length === 0) {
        vscode.window.showInformationMessage('Open Git Lens: this file has no history yet.');
        return;
    }
    const [current, previous] = commits;
    const name = path.basename(relativePath);
    if (!rev) {
        await openRevisionsDiff({ root, left: current.sha, leftFile: current.file, right: undefined, rightFile: relativePath, title: `${name} (${short(current.sha)} ↔ working tree)` });
    } else if (previous) {
        await openRevisionsDiff({ root, left: previous.sha, leftFile: previous.file, right: current.sha, rightFile: current.file, title: `${name} (${short(previous.sha)} ↔ ${short(current.sha)})` });
    } else {
        vscode.window.showInformationMessage('Open Git Lens: this is the first revision of the file.');
    }
}

async function diffWithNext() {
    const { root, rev, relativePath } = await resolveActive();
    if (!rev) {
        vscode.window.showInformationMessage('Open Git Lens: the working file has no next revision.');
        return;
    }
    const current = (await touching(root, rev, relativePath, 1))[0];
    const output = await git.exec(root, ['log', '--ancestry-path', '--format=%H', `${rev}..HEAD`, '--', relativePath]);
    const next = output.split('\n').filter(Boolean).pop();
    const name = path.basename(relativePath);
    if (next) {
        await openRevisionsDiff({ root, left: current?.sha ?? rev, leftFile: current?.file ?? relativePath, right: next, rightFile: relativePath, title: `${name} (${short(rev)} ↔ ${short(next)})` });
    } else {
        await openRevisionsDiff({ root, left: rev, leftFile: relativePath, right: undefined, rightFile: relativePath, title: `${name} (${short(rev)} ↔ working tree)` });
    }
}

async function diffWithWorking() {
    const { root, rev, relativePath } = await resolveActive();
    if (!rev) {
        vscode.window.showInformationMessage('Open Git Lens: you are already viewing the working file.');
        return;
    }
    await openRevisionsDiff({ root, left: rev, leftFile: relativePath, right: undefined, rightFile: relativePath, title: `${path.basename(relativePath)} (${short(rev)} ↔ working tree)` });
}

async function openWorkingFile() {
    const { root, rev, relativePath } = await resolveActive();
    if (rev) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, relativePath)));
    }
}

function register(context) {
    const cmd = (id, handler) => vscode.commands.registerCommand(id, () => guarded(handler));
    context.subscriptions.push(
        cmd('openGitLens.diffWithPrevious', diffWithPrevious),
        cmd('openGitLens.diffWithNext', diffWithNext),
        cmd('openGitLens.diffWithWorking', diffWithWorking),
        cmd('openGitLens.openWorkingFile', openWorkingFile),
        vscode.commands.registerCommand('openGitLens.toggleCodeLens', async () => {
            const config = vscode.workspace.getConfiguration('openGitLens');
            await config.update('codeLens.enabled', !config.get('codeLens.enabled', true), vscode.ConfigurationTarget.Global);
        }),
    );
}

module.exports = { register };
