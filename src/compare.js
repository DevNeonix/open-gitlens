const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');
const { openRevisionsDiff, toRevisionUri } = require('./history');
const { fileEditor, getRoot, guarded, inputBox, quickPick, uriFromArg } = require('./repo');
const { fromNow } = require('./time');

const STATUS_ICONS = {
    A: ['diff-added', 'gitDecoration.addedResourceForeground'],
    M: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
    D: ['diff-removed', 'gitDecoration.deletedResourceForeground'],
    R: ['diff-renamed', 'gitDecoration.renamedResourceForeground'],
    C: ['diff-added', 'gitDecoration.addedResourceForeground'],
};

class CompareProvider {
    constructor() {
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.state = undefined;
    }

    set(state) {
        this.state = state;
        this.emitter.fire();
    }

    getTreeItem(item) {
        return item;
    }

    getChildren() {
        if (!this.state) {
            return [];
        }
        const { root, ref, files, ahead, behind } = this.state;
        const header = new vscode.TreeItem(`${ref}  ↔  Working tree`);
        header.description = `${behind} behind, ${ahead} ahead`;
        header.iconPath = new vscode.ThemeIcon('git-compare');
        header.tooltip = `${files.length} changed file(s)`;

        const fileItems = files.map(({ status, file, oldFile }) => {
            const item = new vscode.TreeItem(path.basename(file));
            const [icon, color] = STATUS_ICONS[status] ?? STATUS_ICONS.M;
            item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
            item.description = oldFile ? `${oldFile} → ${path.dirname(file)}` : path.dirname(file) === '.' ? '' : path.dirname(file);
            item.tooltip = `${status} ${file}`;
            item.command = {
                command: 'openGitLens.openRevisionsDiff',
                title: 'Open Diff',
                arguments: [{
                    root,
                    left: ref,
                    leftFile: oldFile ?? file,
                    right: status === 'D' ? '' : undefined,
                    rightFile: file,
                    title: `${path.basename(file)} (${ref} ↔ working tree)`,
                }],
            };
            return item;
        });
        return [header, ...fileItems];
    }
}

const FILE_HISTORY_LIMIT = 50;

/**
 * Quick pick of branches, tags and (optionally) the commits that touched a file.
 * Returns a ref name/SHA, or undefined if cancelled.
 */
async function pickRef(root, { placeHolder = 'Compare working tree with…', filePath } = {}) {
    const [branches, tags, commits] = await Promise.all([
        git.listBranches(root),
        git.listTags(root),
        filePath ? git.fileHistory(filePath, FILE_HISTORY_LIMIT).catch(() => []) : [],
    ]);
    const items = [
        { label: '$(edit) Enter a commit SHA or ref…', manual: true },
        ...(commits.length > 0 ? [
            { label: 'File history', kind: vscode.QuickPickItemKind.Separator },
            ...commits.map(commit => ({
                label: `$(git-commit) ${commit.summary}`,
                description: `${commit.author}, ${fromNow(commit.date)}`,
                detail: commit.sha.slice(0, 8),
                ref: commit.sha,
            })),
        ] : []),
        { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
        ...branches.map(branch => ({ label: `$(git-branch) ${branch.name}`, ref: branch.name })),
        { label: 'Tags', kind: vscode.QuickPickItemKind.Separator },
        ...tags.map(tag => ({ label: `$(tag) ${tag.name}`, ref: tag.name })),
    ];
    const picked = await quickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    if (!picked) {
        return;
    }
    return picked.manual ? inputBox({ prompt: 'Commit SHA, branch or tag' }) : picked.ref;
}

/** File from an explorer/editor context menu argument, or the active editor. */
function targetFile(arg) {
    const uri = uriFromArg(arg) ?? fileEditor()?.document.uri;
    if (!uri) {
        throw new Error('Open a file first.');
    }
    return uri.fsPath;
}

async function resolveFile(arg) {
    const filePath = targetFile(arg);
    const { root, relativePath } = await git.getRelativePath(filePath);
    return { filePath, root, relativePath };
}

async function verifyRef(root, ref) {
    try {
        await git.exec(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    } catch {
        throw new Error(`"${ref}" is not a valid branch, tag or commit.`);
    }
}

async function compareFileWithRef(arg) {
    const { filePath, root, relativePath } = await resolveFile(arg);
    const ref = await pickRef(root, { placeHolder: `Compare ${path.basename(filePath)} with…`, filePath });
    if (!ref) {
        return;
    }
    await verifyRef(root, ref);
    await openRevisionsDiff({
        root,
        left: ref,
        leftFile: relativePath,
        right: undefined,
        rightFile: relativePath,
        title: `${path.basename(filePath)} (${ref.slice(0, 12)} ↔ working tree)`,
    });
}

async function compareFileWithPrevious(arg) {
    const { filePath, root, relativePath } = await resolveFile(arg);
    const [latest] = await git.fileHistory(filePath, 1);
    if (!latest) {
        vscode.window.showInformationMessage('Open GitLens: this file has no history yet.');
        return;
    }
    await openRevisionsDiff({
        root,
        left: latest.sha,
        leftFile: latest.file ?? relativePath,
        right: undefined,
        rightFile: relativePath,
        title: `${path.basename(filePath)} (last commit ${latest.sha.slice(0, 8)} ↔ working tree)`,
    });
}

async function compareFileBetweenRefs(arg) {
    const { filePath, root, relativePath } = await resolveFile(arg);
    const name = path.basename(filePath);
    const left = await pickRef(root, { placeHolder: `${name}: pick the first revision (left)`, filePath });
    if (!left) {
        return;
    }
    const right = await pickRef(root, { placeHolder: `${name}: pick the second revision (right)`, filePath });
    if (!right) {
        return;
    }
    await Promise.all([verifyRef(root, left), verifyRef(root, right)]);
    await openRevisionsDiff({
        root,
        left,
        leftFile: relativePath,
        right,
        rightFile: relativePath,
        title: `${name} (${left.slice(0, 12)} ↔ ${right.slice(0, 12)})`,
    });
}

async function openFileAtRevision(arg) {
    const { filePath, root, relativePath } = await resolveFile(arg);
    const ref = await pickRef(root, { placeHolder: `Open ${path.basename(filePath)} at…`, filePath });
    if (!ref) {
        return;
    }
    await verifyRef(root, ref);
    const sha = (await git.exec(root, ['rev-parse', `${ref}^{commit}`])).trim();
    const document = await vscode.workspace.openTextDocument(toRevisionUri(root, sha, relativePath));
    await vscode.window.showTextDocument(document, { preview: true });
}

function register(context) {
    const provider = new CompareProvider();

    const compareWith = async (root, ref) => {
        const [files, counts] = await Promise.all([git.diffToWorkingTree(root, ref), git.aheadBehind(root, ref)]);
        provider.set({ root, ref, files, ...counts });
        await vscode.commands.executeCommand('openGitLens.compare.focus');
    };

    context.subscriptions.push(
        vscode.window.createTreeView('openGitLens.compare', { treeDataProvider: provider }),
        vscode.commands.registerCommand('openGitLens.openRevisionsDiff', args => guarded(() => openRevisionsDiff(args))),
        vscode.commands.registerCommand('openGitLens.compareFileWithRef', arg => guarded(() => compareFileWithRef(arg))),
        vscode.commands.registerCommand('openGitLens.compareFileWithPrevious', arg => guarded(() => compareFileWithPrevious(arg))),
        vscode.commands.registerCommand('openGitLens.compareFileBetweenRefs', arg => guarded(() => compareFileBetweenRefs(arg))),
        vscode.commands.registerCommand('openGitLens.openFileAtRevision', arg => guarded(() => openFileAtRevision(arg))),
        vscode.commands.registerCommand('openGitLens.compareWithRef', arg => guarded(async () => {
            const root = arg?.root ?? await getRoot();
            const ref = arg?.ref ?? await pickRef(root);
            if (ref) {
                await compareWith(root, ref);
            }
        })),
    );

    return { compareWith };
}

module.exports = { register };
