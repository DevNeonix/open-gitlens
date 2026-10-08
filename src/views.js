const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const actions = require('./actions');
const git = require('./git');
const gitGraph = require('./gitGraph');
const { openCommitDiff } = require('./history');
const { getRoot, guarded, confirm, onDidChangeRepo, runAction } = require('./repo');
const { fromNow } = require('./time');

class RepoTreeProvider {
    /** @param {(root: string) => Promise<vscode.TreeItem[]>} loadRoots @param {(item: vscode.TreeItem) => Promise<vscode.TreeItem[]>} [loadChildren] */
    constructor(loadRoots, loadChildren) {
        this.loadRoots = loadRoots;
        this.loadChildren = loadChildren;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }

    refresh() {
        this.emitter.fire();
    }

    getTreeItem(item) {
        return item;
    }

    async getChildren(item) {
        try {
            if (item) {
                return (await this.loadChildren?.(item)) ?? [];
            }
            return await this.loadRoots(await getRoot());
        } catch {
            return [];
        }
    }
}

function makeItem(label, data, options = {}) {
    const item = new vscode.TreeItem(label, options.collapsible ?? vscode.TreeItemCollapsibleState.None);
    item.data = data;
    item.description = options.description;
    item.tooltip = options.tooltip;
    item.iconPath = options.icon && new vscode.ThemeIcon(options.icon, options.color && new vscode.ThemeColor(options.color));
    item.contextValue = options.contextValue;
    item.command = options.command;
    return item;
}

function trackToArrows(track) {
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    return [ahead && `↑${ahead[1]}`, behind && `↓${behind[1]}`].filter(Boolean).join(' ');
}

function showInGraph(options) {
    return { command: 'openGitLens.showGraph', title: 'Show in Graph', arguments: [options] };
}

function branchItem(root, branch) {
    const description = [branch.current && 'current', trackToArrows(branch.track), branch.upstream && !branch.remote ? `→ ${branch.upstream}` : ''].filter(Boolean).join('  ');
    const kind = branch.remote ? 'remote' : branch.current ? 'current' : 'local';
    return makeItem(branch.name, { root, ...branch }, {
        icon: branch.current ? 'check' : 'git-branch',
        color: branch.current ? 'charts.green' : undefined,
        description,
        tooltip: `${branch.summary}\n${new Date(branch.date).toLocaleString()} (${fromNow(new Date(branch.date))})`,
        contextValue: `branch.${kind}`,
        command: showInGraph({ scope: branch.name }),
    });
}

async function branchRoots(root) {
    const branches = await git.listBranches(root);
    const remotes = new Set(branches.filter(branch => branch.remote).map(branch => branch.name.split('/')[0]));
    return [
        ...branches.filter(branch => !branch.remote).map(branch => branchItem(root, branch)),
        ...[...remotes].map(remote => makeItem(remote, { root, kind: 'remote', remote }, {
            collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            icon: 'cloud',
            contextValue: 'remote',
        })),
    ];
}

async function branchChildren(item) {
    if (item.data.kind !== 'remote') {
        return [];
    }
    const { root, remote } = item.data;
    return (await git.listBranches(root))
        .filter(branch => branch.remote && branch.name.startsWith(`${remote}/`))
        .map(branch => branchItem(root, branch));
}

async function tagRoots(root) {
    return (await git.listTags(root)).map(tag => makeItem(tag.name, { root, ...tag }, {
        icon: 'tag',
        description: `${tag.summary} · ${fromNow(new Date(tag.date))}`.replace(/^ · /, ''),
        tooltip: `${tag.name}\n${tag.sha}`,
        contextValue: 'tag',
        command: showInGraph({ scope: tag.name }),
    }));
}

async function stashRoots(root) {
    return (await git.listStashes(root)).map(stash => makeItem(stash.message, { root, ...stash }, {
        icon: 'archive',
        description: `${stash.ref} · ${fromNow(new Date(stash.date))}`,
        contextValue: 'stash',
        command: { command: 'openGitLens.stash.show', title: 'Show Stash', arguments: [{ data: { root, ...stash } }] },
    }));
}

async function contributorRoots(root) {
    return (await git.listContributors(root)).map(person => makeItem(person.name, { root, ...person }, {
        icon: 'person',
        description: `${person.commits} commits`,
        tooltip: person.email,
        command: showInGraph({ search: person.name }),
    }));
}

const BRANCH_NAME = /^(?!-)[^\s~^:?*[\\]+$/;

async function worktreeRoots(root) {
    const worktrees = await gitGraph.listWorktrees(root);
    return worktrees.map((worktree, index) => {
        const current = path.resolve(worktree.path) === path.resolve(root);
        const label = worktree.branch || (worktree.bare ? '(bare)' : worktree.detached ? `(detached ${worktree.head.slice(0, 8)})` : path.basename(worktree.path));
        const flags = [index === 0 && 'main', worktree.locked && 'locked', worktree.prunable && 'prunable'].filter(Boolean).join(', ');
        const kind = current ? 'current' : index === 0 ? 'main' : 'linked';
        return makeItem(label, { root, main: index === 0, ...worktree }, {
            icon: current ? 'home' : 'repo',
            color: current ? 'charts.green' : undefined,
            description: `${worktree.path.replace(os.homedir(), '~')}${flags ? `  (${flags})` : ''}`,
            tooltip: `${worktree.path}\n${worktree.head}`,
            contextValue: `worktree.${kind}`,
        });
    });
}

async function createWorktree() {
    const root = await getRoot();
    const branches = (await git.listBranches(root)).filter(branch => !branch.remote);
    const worktrees = await gitGraph.listWorktrees(root);
    const taken = new Set(worktrees.map(worktree => worktree.branch));
    const picked = await vscode.window.showQuickPick(
        [
            { label: '$(add) Create new branch…', create: true },
            ...branches.filter(branch => !taken.has(branch.name)).map(branch => ({ label: `$(git-branch) ${branch.name}`, branch: branch.name })),
        ],
        { placeHolder: 'Create worktree for…' },
    );
    if (!picked) {
        return;
    }
    let branch = picked.branch;
    if (picked.create) {
        branch = await vscode.window.showInputBox({
            prompt: 'New branch name',
            validateInput: value => (BRANCH_NAME.test(value) ? undefined : 'Invalid branch name'),
        });
        if (!branch) {
            return;
        }
    }
    const mainRoot = worktrees[0]?.path ?? root;
    const suggested = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}.worktrees`, branch.replace(/[/\\]/g, '-'));
    const target = await vscode.window.showInputBox({ prompt: 'Worktree folder', value: suggested });
    if (!target) {
        return;
    }
    const args = picked.create ? ['worktree', 'add', '-b', branch, target] : ['worktree', 'add', target, branch];
    if (await runAction(root, `create worktree ${branch}`, args) !== undefined) {
        const open = await vscode.window.showInformationMessage(`Worktree created at ${target}`, 'Open in New Window');
        if (open) {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
        }
    }
}

async function removeWorktree(worktree) {
    if (worktree.main) {
        vscode.window.showWarningMessage('Open Git Lens: the main worktree cannot be removed.');
        return;
    }
    if (!(await confirm(`Remove worktree ${worktree.path}?`, 'Remove'))) {
        return;
    }
    const result = await runAction(worktree.root, `remove worktree ${path.basename(worktree.path)}`, ['worktree', 'remove', worktree.path]);
    if (result === undefined && await confirm('It has uncommitted changes or is locked. Force remove?', 'Force remove')) {
        await runAction(worktree.root, 'force remove worktree', ['worktree', 'remove', '--force', worktree.path]);
    }
}

async function showStash({ data }) {
    const files = await git.commitFiles(data.root, data.sha);
    if (files.length === 0) {
        vscode.window.showInformationMessage('Open Git Lens: this stash has no tracked file changes.');
        return;
    }
    const picked = await vscode.window.showQuickPick(
        files.map(file => ({ label: file.file, description: file.status, file })),
        { placeHolder: `${data.ref}: ${data.message}` },
    );
    if (picked) {
        await openCommitDiff({ root: data.root, sha: data.sha, file: picked.file.file, oldFile: picked.file.oldFile });
    }
}

const itemCommand = (handler) => (item) => guarded(() => handler(item.data));

function register(context) {
    const providers = {
        branches: new RepoTreeProvider(branchRoots, branchChildren),
        tags: new RepoTreeProvider(tagRoots),
        stashes: new RepoTreeProvider(stashRoots),
        contributors: new RepoTreeProvider(contributorRoots),
        worktrees: new RepoTreeProvider(worktreeRoots),
    };
    const refreshAll = () => Object.values(providers).forEach(provider => provider.refresh());

    const cmd = (id, handler) => vscode.commands.registerCommand(id, handler);

    context.subscriptions.push(
        ...Object.entries(providers).map(([name, provider]) => vscode.window.createTreeView(`openGitLens.${name}`, { treeDataProvider: provider })),
        onDidChangeRepo(refreshAll),
        vscode.window.onDidChangeWindowState(state => state.focused && refreshAll()),
        cmd('openGitLens.refresh', refreshAll),
        cmd('openGitLens.fetch', () => guarded(async () => actions.fetch(await getRoot()))),
        cmd('openGitLens.stash.push', () => guarded(async () => actions.stashPush(await getRoot()))),

        cmd('openGitLens.branch.checkout', itemCommand(branch => (branch.remote
            ? runAction(branch.root, `checkout ${branch.name}`, ['switch', '--track', branch.name])
            : actions.checkout(branch.root, branch.name)))),
        cmd('openGitLens.branch.createFrom', itemCommand(branch => actions.createBranch(branch.root, branch.name))),
        cmd('openGitLens.branch.delete', itemCommand(branch => actions.deleteBranch(branch.root, branch))),
        cmd('openGitLens.branch.compare', itemCommand(branch => vscode.commands.executeCommand('openGitLens.compareWithRef', { root: branch.root, ref: branch.name }))),
        cmd('openGitLens.branch.merge', itemCommand(async branch => {
            if (await confirm(`Merge ${branch.name} into the current branch?`, 'Merge')) {
                await runAction(branch.root, `merge ${branch.name}`, ['merge', branch.name]);
            }
        })),
        cmd('openGitLens.branch.copyName', itemCommand(branch => vscode.env.clipboard.writeText(branch.name))),

        cmd('openGitLens.tag.checkout', itemCommand(tag => actions.checkout(tag.root, tag.name))),
        cmd('openGitLens.tag.delete', itemCommand(tag => actions.deleteTag(tag.root, tag.name))),
        cmd('openGitLens.tag.compare', itemCommand(tag => vscode.commands.executeCommand('openGitLens.compareWithRef', { root: tag.root, ref: tag.name }))),
        cmd('openGitLens.tag.copyName', itemCommand(tag => vscode.env.clipboard.writeText(tag.name))),

        cmd('openGitLens.worktree.create', () => guarded(createWorktree)),
        cmd('openGitLens.worktree.open', itemCommand(worktree => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), { forceNewWindow: true }))),
        cmd('openGitLens.worktree.openHere', itemCommand(worktree => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), { forceNewWindow: false }))),
        cmd('openGitLens.worktree.remove', itemCommand(removeWorktree)),
        cmd('openGitLens.worktree.copyPath', itemCommand(worktree => vscode.env.clipboard.writeText(worktree.path))),
        cmd('openGitLens.worktree.graph', itemCommand(worktree => vscode.commands.executeCommand('openGitLens.showGraph', { scope: worktree.branch || 'all' }))),

        cmd('openGitLens.stash.show', item => guarded(() => showStash(item))),
        cmd('openGitLens.stash.apply', itemCommand(stash => actions.stashApply(stash.root, stash.ref))),
        cmd('openGitLens.stash.pop', itemCommand(stash => actions.stashPop(stash.root, stash.ref))),
        cmd('openGitLens.stash.drop', itemCommand(stash => actions.stashDrop(stash.root, stash.ref))),
    );
}

module.exports = { register };
