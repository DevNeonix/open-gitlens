const path = require('node:path');
const vscode = require('vscode');

const annotations = require('./annotations');
const codelens = require('./codelens');
const compare = require('./compare');
const graph = require('./graph');
const git = require('./git');
const { blameLine, getUserName } = git;
const history = require('./history');
const revisions = require('./revisions');
const views = require('./views');
const { fromNow } = require('./time');

const DEBOUNCE_MS = 150;

function getConfig() {
    const config = vscode.workspace.getConfiguration('openGitLens');
    return {
        lineBlame: config.get('lineBlame.enabled', true),
        statusBar: config.get('statusBar.enabled', true),
    };
}

function commandLink(label, command, args) {
    return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([args]))})`;
}

function buildHover(blame, who, filePath) {
    const hover = new vscode.MarkdownString();
    hover.isTrusted = { enabledCommands: ['openGitLens.openCommitDiff', 'openGitLens.copySha', 'openGitLens.openCommitOnRemote', 'openGitLens.blamePreviousRevision'] };
    // appendText escapes commit data so it can't inject markdown/links
    hover.appendMarkdown('**');
    hover.appendText(who);
    hover.appendMarkdown('** ');
    if (blame.email) {
        hover.appendText(`<${blame.email}>`);
    }
    hover.appendMarkdown('\n\n');
    hover.appendText(`${fromNow(blame.date)} (${blame.date.toLocaleString(vscode.env.language)})`);
    hover.appendMarkdown('\n\n---\n\n');
    hover.appendText(blame.summary);
    hover.appendMarkdown('\n\n`');
    hover.appendText(blame.sha.slice(0, 8));
    hover.appendMarkdown('`');
    const args = { sha: blame.sha, filePath, line: blame.originalLine };
    hover.appendMarkdown(`\n\n${[
        commandLink('Changes', 'openGitLens.openCommitDiff', args),
        commandLink('Copy SHA', 'openGitLens.copySha', args),
        commandLink('Open on remote', 'openGitLens.openCommitOnRemote', args),
        commandLink('Blame previous', 'openGitLens.blamePreviousRevision', args),
    ].join(' &nbsp;|&nbsp; ')}`);
    return hover;
}

/** Path of the git executable VS Code itself uses (handles git outside PATH on Windows/macOS). */
async function resolveGitPath() {
    try {
        const extension = vscode.extensions.getExtension('vscode.git');
        const exports = await extension?.activate();
        return exports?.getAPI(1).git.path;
    } catch {
        return undefined;
    }
}

async function activate(context) {
    git.setGitPath(await resolveGitPath());

    const decoration = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 3em',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    let timer;
    let requestId = 0;

    const clear = (editor) => {
        editor?.setDecorations(decoration, []);
        statusBar.hide();
    };

    const update = async (editor) => {
        const id = ++requestId;
        const config = getConfig();
        if (
            !editor
            || editor.document.uri.scheme !== 'file'
            || editor.selections.length !== 1
            || (!config.lineBlame && !config.statusBar)
        ) {
            clear(editor);
            return;
        }

        const { document } = editor;
        const line = editor.selection.active.line;
        const filePath = document.uri.fsPath;

        try {
            const [blame, userName] = await Promise.all([
                blameLine(filePath, line + 1, document.isDirty ? document.getText() : undefined),
                getUserName(path.dirname(filePath)),
            ]);
            if (id !== requestId) {
                return;
            }

            const who = blame.uncommitted || blame.author === userName ? 'You' : blame.author;
            const text = blame.uncommitted
                ? 'You, uncommitted changes'
                : `${who}, ${fromNow(blame.date)} • ${blame.summary}`;

            if (config.lineBlame) {
                const end = document.lineAt(line).range.end;
                editor.setDecorations(decoration, [{
                    range: new vscode.Range(end, end),
                    hoverMessage: blame.uncommitted ? undefined : buildHover(blame, who, filePath),
                    renderOptions: { after: { contentText: text } },
                }]);
            } else {
                editor.setDecorations(decoration, []);
            }

            if (config.statusBar) {
                statusBar.text = blame.uncommitted ? '$(git-commit) You, uncommitted' : `$(git-commit) ${who}, ${fromNow(blame.date)}`;
                statusBar.tooltip = blame.uncommitted ? undefined : buildHover(blame, who, filePath);
                statusBar.show();
            } else {
                statusBar.hide();
            }
        } catch {
            // Untracked file, not a repo, or line out of range
            if (id === requestId) {
                clear(editor);
            }
        }
    };

    const scheduleUpdate = (editor) => {
        clearTimeout(timer);
        timer = setTimeout(() => update(editor), DEBOUNCE_MS);
    };

    context.subscriptions.push(
        decoration,
        statusBar,
        { dispose: () => clearTimeout(timer) },
        vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => scheduleUpdate(textEditor)),
        vscode.window.onDidChangeActiveTextEditor(editor => scheduleUpdate(editor)),
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
            const editor = vscode.window.activeTextEditor;
            if (editor?.document === document) {
                editor.setDecorations(decoration, []);
                scheduleUpdate(editor);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('openGitLens')) {
                scheduleUpdate(vscode.window.activeTextEditor);
            }
        }),
        vscode.commands.registerCommand('openGitLens.toggleLineBlame', async () => {
            const config = vscode.workspace.getConfiguration('openGitLens');
            await config.update('lineBlame.enabled', !config.get('lineBlame.enabled', true), vscode.ConfigurationTarget.Global);
        }),
    );

    history.register(context);
    annotations.register(context);
    compare.register(context);
    graph.register(context);
    views.register(context);
    codelens.register(context);
    revisions.register(context);
    scheduleUpdate(vscode.window.activeTextEditor);
}

function deactivate() { }

module.exports = { activate, deactivate };
