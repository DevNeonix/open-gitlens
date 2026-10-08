const vscode = require('vscode');

const git = require('./git');
const { fromNow } = require('./time');

const LENS_KINDS = new Set([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Module,
    vscode.SymbolKind.Namespace,
]);
const MAX_NAMES = 2;

function flatten(symbols, out = []) {
    for (const symbol of symbols) {
        if (LENS_KINDS.has(symbol.kind)) {
            out.push(symbol);
        }
        flatten(symbol.children ?? [], out);
    }
    return out;
}

function summarize(lines, startLine, endLine) {
    const commits = new Set();
    let latest;
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
        const commit = lines[i];
        if (!commit) {
            continue;
        }
        commits.add(commit);
        const date = commit.uncommitted ? new Date() : commit.date;
        if (!latest || date > latest.date) {
            latest = { commit, date };
        }
    }
    if (!latest) {
        return;
    }
    const authors = new Set([...commits].map(commit => (commit.uncommitted ? 'You' : commit.author)));
    const lead = latest.commit.uncommitted ? 'You, uncommitted' : `${latest.commit.author}, ${fromNow(latest.date)}`;
    const others = [...authors].filter(name => name !== (latest.commit.uncommitted ? 'You' : latest.commit.author));
    const extra = authors.size > 1
        ? ` | ${authors.size} authors (${others.slice(0, MAX_NAMES).join(', ')}${others.length > MAX_NAMES ? ', …' : ''})`
        : '';
    return `${lead}${extra}`;
}

class BlameCodeLensProvider {
    constructor() {
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this.emitter.event;
        this.cache = new Map();
    }

    refresh() {
        this.cache.clear();
        this.emitter.fire();
    }

    async provideCodeLenses(document) {
        if (document.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('openGitLens').get('codeLens.enabled', true)) {
            return [];
        }
        const key = `${document.uri}@${document.version}`;
        if (!this.cache.has(key)) {
            this.cache.set(key, this.compute(document));
            if (this.cache.size > 20) {
                this.cache.delete(this.cache.keys().next().value);
            }
        }
        return this.cache.get(key);
    }

    async compute(document) {
        let lines;
        try {
            lines = await git.blameFile(document.uri.fsPath, document.isDirty ? document.getText() : undefined);
        } catch {
            return [];
        }
        const symbols = flatten((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)) ?? []);
        const targets = [
            { range: new vscode.Range(0, 0, 0, 0), start: 0, end: document.lineCount - 1 },
            ...symbols.map(symbol => ({
                range: new vscode.Range(symbol.range.start.line, 0, symbol.range.start.line, 0),
                start: symbol.range.start.line,
                end: symbol.range.end.line,
            })),
        ];
        const seen = new Set();
        const lenses = [];
        for (const target of targets) {
            const title = summarize(lines, target.start, target.end);
            const id = `${target.start}:${target.end}`;
            if (title && !seen.has(id)) {
                seen.add(id);
                lenses.push(new vscode.CodeLens(target.range, {
                    title,
                    command: 'openGitLens.showRangeHistory',
                    arguments: [{ filePath: document.uri.fsPath, start: target.start + 1, end: target.end + 1 }],
                    tooltip: 'Show history of this range',
                }));
            }
        }
        return lenses;
    }
}

function register(context) {
    const provider = new BlameCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
        vscode.workspace.onDidSaveTextDocument(() => provider.refresh()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('openGitLens.codeLens')) {
                provider.refresh();
            }
        }),
    );
}

module.exports = { register };
