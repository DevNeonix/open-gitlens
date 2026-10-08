const vscode = require('vscode');

const git = require('./git');
const { toRevisionUri, SCHEME } = require('./history');
const { guarded } = require('./repo');
const { fromNow } = require('./time');

const DEBOUNCE_MS = 400;
const GUTTER_WIDTH_CH = 28;
const MAX_AGE_DAYS = 365;

function hueFor(date) {
    const ageDays = (Date.now() - date.getTime()) / 86_400_000;
    const recency = 1 - Math.min(ageDays, MAX_AGE_DAYS) / MAX_AGE_DAYS;
    return Math.round(210 - recency * 190);
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isSupported(uri) {
    return uri.scheme === 'file' || uri.scheme === SCHEME;
}

function blameDocument(document) {
    const { uri } = document;
    if (uri.scheme === SCHEME) {
        const { root, rev } = JSON.parse(uri.query);
        return git.blameRevision(root, rev, uri.path.slice(1));
    }
    return git.blameFile(uri.fsPath, document.isDirty ? document.getText() : undefined);
}

function register(context) {
    const decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    const active = new Set();
    let timer;
    let requestId = 0;

    const render = async (editor) => {
        if (!editor || !active.has(editor.document.uri.toString())) {
            editor?.setDecorations(decoration, []);
            return;
        }
        const id = ++requestId;
        const { document } = editor;
        try {
            const lines = await blameDocument(document);
            if (id !== requestId) {
                return;
            }
            const options = lines.map((commit, index) => {
                const firstOfGroup = index === 0 || lines[index - 1] !== commit;
                const label = commit.uncommitted
                    ? 'Uncommitted'
                    : `${truncate(commit.author, 12)}, ${fromNow(commit.date)}`;
                const color = commit.uncommitted ? 'hsl(0 0% 50%)' : `hsl(${hueFor(commit.date)} 60% 50%)`;
                return {
                    range: new vscode.Range(index, 0, index, 0),
                    renderOptions: {
                        before: {
                            contentText: firstOfGroup ? truncate(label, GUTTER_WIDTH_CH) : '',
                            width: `${GUTTER_WIDTH_CH}ch`,
                            margin: '0 1.5em 0 0',
                            color: new vscode.ThemeColor('editorCodeLens.foreground'),
                            border: `solid ${color}`,
                            borderWidth: '0 0 0 3px',
                            textDecoration: 'none; display: inline-block; padding-left: 0.5em; box-sizing: border-box',
                        },
                    },
                    hoverMessage: commit.uncommitted ? undefined : `${commit.summary}\n\n${commit.sha.slice(0, 8)}`,
                };
            });
            editor.setDecorations(decoration, options);
        } catch {
            if (id === requestId) {
                editor.setDecorations(decoration, []);
            }
        }
    };

    const schedule = (editor) => {
        clearTimeout(timer);
        timer = setTimeout(() => render(editor), DEBOUNCE_MS);
    };

    context.subscriptions.push(
        decoration,
        { dispose: () => clearTimeout(timer) },
        vscode.commands.registerCommand('openGitLens.blamePreviousRevision', args => guarded(async () => {
            const { root, relativePath } = await git.getRelativePath(args.filePath);
            const parent = await git.getParentSha(root, args.sha);
            if (!parent) {
                vscode.window.showInformationMessage('Open GitLens: this commit has no previous revision.');
                return;
            }
            const document = await vscode.workspace.openTextDocument(toRevisionUri(root, parent, relativePath));
            const line = Math.max(0, Math.min((args.line ?? 1) - 1, document.lineCount - 1));
            const editor = await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(line, 0, line, 0) });
            editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
            active.add(document.uri.toString());
            render(editor);
        })),
        vscode.commands.registerCommand('openGitLens.toggleFileBlame', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isSupported(editor.document.uri)) {
                return;
            }
            const key = editor.document.uri.toString();
            if (active.has(key)) {
                active.delete(key);
            } else {
                active.add(key);
            }
            render(editor);
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => schedule(editor)),
        vscode.workspace.onDidSaveTextDocument(document => {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            if (editor) {
                schedule(editor);
            }
        }),
    );
}

module.exports = { register };
