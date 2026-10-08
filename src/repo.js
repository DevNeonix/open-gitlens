const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');

let channel;

function getOutput() {
    channel ??= vscode.window.createOutputChannel('Open GitLens');
    return channel;
}

/** Appends a timestamped line to the "Open GitLens" output channel. */
function log(message) {
    getOutput().appendLine(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
}

const changed = new vscode.EventEmitter();

/** Fires after any action that modifies the repo, so views can refresh. */
const onDidChangeRepo = changed.event;
const notifyChanged = () => changed.fire();

/** Repo root of the active file, falling back to the first workspace folder. */
async function getRoot() {
    const editor = vscode.window.activeTextEditor;
    const candidates = [];
    if (editor?.document.uri.scheme === 'file') {
        candidates.push(path.dirname(editor.document.uri.fsPath));
    }
    candidates.push(...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
    for (const cwd of candidates) {
        try {
            return await git.getRepoRoot(cwd);
        } catch {
            // not a repo, try next
        }
    }
    throw new Error('No git repository found.');
}

/** Runs a git command showing progress; reports errors; refreshes views. */
async function runAction(root, title, args) {
    try {
        const output = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Open GitLens: ${title}` },
            () => git.exec(root, args),
        );
        notifyChanged();
        return output;
    } catch (error) {
        notifyChanged();
        vscode.window.showErrorMessage(`Open GitLens: ${title} failed. ${error.message}`);
    }
}

async function guarded(action) {
    try {
        await action();
    } catch (error) {
        log(`ERROR ${error.stack ?? error.message}`);
        vscode.window.showErrorMessage(`Open GitLens: ${error.message}`);
    }
}

/** Quick pick that stays open when focus moves (e.g. when launched from a context menu). */
const quickPick = (items, options) => vscode.window.showQuickPick(items, { ignoreFocusOut: true, ...options });
const inputBox = options => vscode.window.showInputBox({ ignoreFocusOut: true, ...options });

/** Shows progress in the status bar while a slow task runs, so the user sees something is happening. */
const withLoading = (title, task) => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Open GitLens: ${title}` },
    task,
);

async function confirm(message, action) {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

/**
 * The editor to act on: the active one if it is a real file, otherwise any visible file editor.
 * The Output panel and webviews count as "active editors" and would otherwise hide the user's file.
 */
function fileEditor(schemes = ['file']) {
    const active = vscode.window.activeTextEditor;
    if (active && schemes.includes(active.document.uri.scheme)) {
        return active;
    }
    return vscode.window.visibleTextEditors.find(editor => schemes.includes(editor.document.uri.scheme));
}

/**
 * File URI from a command argument. VS Code passes the clicked resource from the Explorer and editor
 * title menus (a Uri) and from Source Control (an object with `resourceUri`).
 */
function uriFromArg(arg) {
    const candidate = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
    return candidate instanceof vscode.Uri && candidate.scheme === 'file' ? candidate : undefined;
}

module.exports = {
    uriFromArg,
    fileEditor, getRoot, runAction, guarded, confirm, onDidChangeRepo, notifyChanged, getOutput, log, quickPick, inputBox, withLoading };
