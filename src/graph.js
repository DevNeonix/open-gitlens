const path = require('node:path');
const vscode = require('vscode');

const actions = require('./actions');
const git = require('./git');
const gitGraph = require('./gitGraph');
const { layoutGraph } = require('./graphLayout');
const { openCommitDiff, openRevisionsDiff } = require('./history');
const { getRoot, guarded, confirm, runAction, onDidChangeRepo, quickPick } = require('./repo');

const PAGE_SIZE = 500;
const RELOAD_DEBOUNCE_MS = 300;
const OPTIONS_KEY = 'openGitLens.graph.options';
const DEFAULT_OPTIONS = { scope: 'all', remotes: true, tags: true, stashes: true, hidden: [] };

function buildHtml(webview, extensionUri) {
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src https://www.gravatar.com https://avatars.githubusercontent.com data:;">
<link rel="stylesheet" href="${asset('graph.css')}">
</head>
<body>
<div id="header">
    <div class="group">
        <span id="repo" class="repo"></span>
        <button id="branch" class="pill" title="Switch branch"></button>
        <span id="sync" class="sync"></span>
        <button id="pull" title="Pull">Pull</button>
        <button id="push" title="Push">Push</button>
        <button id="fetch" title="Fetch all remotes">Fetch <span id="fetched"></span></button>
    </div>
    <div class="group right">
        <div id="searchbox">
            <input id="search" type="text" spellcheck="false" placeholder="Search commits (message: author: file: change: @me after: before:)">
            <button id="optCase" class="toggle" title="Match Case">Aa</button>
            <button id="optRegex" class="toggle" title="Use Regular Expression">.*</button>
            <span id="count"></span>
            <button id="prev" title="Previous match (Shift+F3)">↑</button>
            <button id="next" title="Next match (F3)">↓</button>
        </div>
        <button id="filter" title="Filter branches, tags and stashes">Filter ▾</button>
        <button id="minimapToggle" class="toggle" title="Toggle minimap">Minimap</button>
        <button id="gear" title="Columns and layout">⚙</button>
    </div>
</div>
<div id="minimap"><canvas></canvas></div>
<div id="main">
    <div id="left">
        <div id="colhdr"></div>
        <div id="list"></div>
    </div>
    <div id="details" class="empty">Select a commit to see its details.</div>
</div>
<div id="popover"></div>
<div id="menu"></div>
<script nonce="${nonce}" src="${asset('graph.js')}"></script>
</body>
</html>`;
}

function register(context) {
    let panel;
    let root;
    let loadId = 0;
    let reloadTimer;
    let headSha;
    let stashes = [];
    let lastSelected;
    const state = { limit: PAGE_SIZE, ...DEFAULT_OPTIONS, ...context.globalState.get(OPTIONS_KEY, {}) };

    const post = message => panel?.webview.postMessage(message);
    const options = () => ({ scope: state.scope, remotes: state.remotes, tags: state.tags, stashes: state.stashes, hidden: state.hidden, limit: state.limit });
    const persist = () => context.globalState.update(OPTIONS_KEY, { scope: state.scope, remotes: state.remotes, tags: state.tags, stashes: state.stashes, hidden: state.hidden });
    const avatarsEnabled = () => vscode.workspace.getConfiguration('openGitLens').get('graph.avatars', true);

    const load = async () => {
        const id = ++loadId;
        root = await getRoot();
        const [graph, branches, sync, stashList] = await Promise.all([
            gitGraph.loadGraph(root, options()),
            git.listBranches(root),
            gitGraph.getSyncInfo(root),
            git.listStashes(root).catch(() => []),
        ]);
        if (id !== loadId) {
            return;
        }
        headSha = graph.headSha;
        stashes = stashList;
        const { rows, laneCount } = layoutGraph(graph.commits);
        post({
            type: 'init',
            options: { scope: state.scope, remotes: state.remotes, tags: state.tags, stashes: state.stashes, hidden: state.hidden },
            avatars: avatarsEnabled(),
            hasMore: graph.hasMore,
            headSha,
            sync,
            laneCount,
            branches: branches.filter(branch => !branch.remote).map(branch => branch.name),
            commits: graph.commits.map((commit, index) => ({
                sha: commit.sha,
                type: commit.type,
                parents: commit.parents.length,
                author: commit.author,
                email: commit.email,
                avatar: commit.avatar,
                date: commit.date,
                refs: commit.refs,
                summary: commit.summary,
                lane: rows[index].lane,
                color: rows[index].color,
                segments: rows[index].segments,
            })),
        });
        gitGraph.commitStats(root, graph.commits.filter(commit => commit.type === 'commit').map(commit => commit.sha))
            .then(stats => id === loadId && post({ type: 'stats', stats }))
            .catch(() => undefined);
    };

    const sendDetails = async sha => {
        lastSelected = sha;
        if (sha === 'WIP') {
            post({ type: 'wipDetails', files: await gitGraph.getStatus(root) });
            return;
        }
        const [details, files] = await Promise.all([git.getCommitDetails(root, sha), git.commitFiles(root, sha)]);
        post({ type: 'details', details: { ...details, avatar: gitGraph.avatarKey(details.email) }, files, isHead: sha === headSha });
    };

    const stashRef = sha => stashes.find(stash => stash.sha === sha)?.ref;

    const commitActions = {
        checkout: async sha => actions.checkoutCommit(root, sha, await actions.localBranchesAt(root, sha)),
        branch: sha => actions.createBranch(root, sha),
        tag: sha => actions.createTag(root, sha),
        cherryPick: sha => actions.cherryPick(root, sha),
        revert: sha => actions.revert(root, sha),
        reset: sha => actions.reset(root, sha),
        undoCommit: async sha => {
            if (sha === headSha && await confirm('Undo the last commit? Its changes stay staged.', 'Undo commit')) {
                await runAction(root, 'undo commit', ['reset', '--soft', 'HEAD~1']);
            }
        },
        compareHead: sha => vscode.commands.executeCommand('openGitLens.compareWithRef', { root, ref: sha }),
        copySha: sha => vscode.commands.executeCommand('openGitLens.copySha', { sha }),
        openRemote: sha => vscode.commands.executeCommand('openGitLens.openCommitOnRemote', { filePath: path.join(root, 'x'), sha }),
        stashApply: sha => actions.stashApply(root, stashRef(sha)),
        stashPop: sha => actions.stashPop(root, stashRef(sha)),
        stashDrop: sha => actions.stashDrop(root, stashRef(sha)),
    };

    const refActions = {
        checkout: ({ type, name }) => (type === 'remote'
            ? runAction(root, `checkout ${name}`, ['switch', '--track', name])
            : actions.checkout(root, name)),
        compare: ({ name }) => vscode.commands.executeCommand('openGitLens.compareWithRef', { root, ref: name }),
        copyName: ({ name }) => vscode.env.clipboard.writeText(name),
        createFrom: ({ name }) => actions.createBranch(root, name),
        delete: ({ type, name }) => (type === 'tag'
            ? actions.deleteTag(root, name)
            : actions.deleteBranch(root, { name, remote: type === 'remote' })),
        merge: async ({ name }) => {
            if (await confirm(`Merge ${name} into the current branch?`, 'Merge')) {
                await runAction(root, `merge ${name}`, ['merge', name]);
            }
        },
        hide: ({ type, name }) => {
            const full = `refs/${type === 'remote' ? 'remotes' : type === 'tag' ? 'tags' : 'heads'}/${name}`;
            if (!state.hidden.includes(full)) {
                state.hidden = [...state.hidden, full];
                persist();
            }
            return load();
        },
    };

    const wipOps = {
        stage: files => runAction(root, 'stage', files ? ['add', '--', ...files] : ['add', '-A']),
        unstage: files => runAction(root, 'unstage', files ? ['restore', '--staged', '--', ...files] : ['reset', '-q']),
        async discard(files, entries) {
            const targets = entries.filter(entry => !files || files.includes(entry.file));
            if (targets.length === 0 || !(await confirm(`Discard changes in ${targets.length} file(s)? This cannot be undone.`, 'Discard'))) {
                return;
            }
            const untracked = targets.filter(entry => entry.untracked).map(entry => entry.file);
            const tracked = targets.filter(entry => !entry.untracked).map(entry => entry.file);
            if (tracked.length > 0) {
                await runAction(root, 'discard changes', ['checkout', 'HEAD', '--', ...tracked]);
            }
            if (untracked.length > 0) {
                await runAction(root, 'delete untracked files', ['clean', '-f', '--', ...untracked]);
            }
        },
    };

    const handleWip = async ({ op, files, message, amend }) => {
        const entries = await gitGraph.getStatus(root);
        if (op === 'commit') {
            if (!amend && !entries.some(entry => entry.staged)) {
                vscode.window.showWarningMessage('Open GitLens: nothing is staged. Stage some files first.');
                return;
            }
            const args = ['commit', ...(amend ? ['--amend'] : []), ...(message ? ['-m', message] : ['--no-edit'])];
            if (!amend && !message) {
                vscode.window.showWarningMessage('Open GitLens: write a commit message.');
                return;
            }
            await runAction(root, amend ? 'amend commit' : 'commit', args);
        } else {
            await wipOps[op](files, entries);
        }
        await sendDetails('WIP');
    };

    const openWipFile = async ({ file, oldFile, staged, x, y }) => {
        const title = `${path.basename(file)} (${staged ? 'staged' : 'working tree'})`;
        if (staged) {
            await openRevisionsDiff({ root, left: x === 'A' ? '' : 'HEAD', leftFile: oldFile ?? file, right: x === 'D' ? '' : ':0', rightFile: file, title });
        } else {
            await openRevisionsDiff({ root, left: x === '?' ? '' : ':0', leftFile: file, right: y === 'D' ? '' : undefined, rightFile: file, title });
        }
    };

    const switchBranch = async () => {
        const branches = (await git.listBranches(root)).filter(branch => !branch.remote);
        const picked = await quickPick(
            branches.map(branch => ({ label: `$(git-branch) ${branch.name}`, description: branch.current ? 'current' : branch.upstream, name: branch.name })),
            { placeHolder: 'Switch to branch' },
        );
        if (picked) {
            await actions.checkout(root, picked.name);
        }
    };

    const onMessage = message => guarded(async () => {
        switch (message.type) {
            case 'ready':
            case 'refresh':
                await load();
                break;
            case 'loadMore':
                state.limit += PAGE_SIZE;
                await load();
                break;
            case 'options':
                Object.assign(state, message.options, { limit: PAGE_SIZE });
                persist();
                await load();
                break;
            case 'fetch':
                await actions.fetch(root);
                break;
            case 'pull':
                await runAction(root, 'pull', ['pull']);
                break;
            case 'push': {
                const upstream = (await gitGraph.getSyncInfo(root)).upstream;
                await runAction(root, 'push', upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
                break;
            }
            case 'switchBranch':
                await switchBranch();
                break;
            case 'select':
                await sendDetails(message.sha);
                break;
            case 'openFile':
                await openCommitDiff({ root, sha: message.sha, file: message.file, oldFile: message.oldFile });
                break;
            case 'openOnDisk':
                await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, message.file)));
                break;
            case 'fileHistory':
                await vscode.commands.executeCommand('openGitLens.showFileHistoryOf', path.join(root, message.file));
                break;
            case 'action':
                await commitActions[message.action]?.(message.sha);
                break;
            case 'refAction':
                await refActions[message.action]?.(message.ref);
                break;
            case 'search': {
                const result = await gitGraph.searchCommits(root, options(), message.query, message.flags);
                post({ type: 'searchResults', query: message.query, ...(Array.isArray(result) ? { shas: [], shaPrefixes: [] } : result) });
                break;
            }
            case 'wip':
                await handleWip(message);
                break;
            case 'openWipFile':
                await openWipFile(message);
                break;
        }
    });

    const show = async (request = {}) => {
        if (request.scope) {
            state.scope = request.scope;
        }
        if (panel) {
            panel.reveal();
            await guarded(load);
        } else {
            panel = vscode.window.createWebviewPanel('openGitLens.graph', 'Commit Graph', vscode.ViewColumn.Active, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            });
            panel.iconPath = new vscode.ThemeIcon('git-merge');
            panel.webview.html = buildHtml(panel.webview, context.extensionUri);
            panel.webview.onDidReceiveMessage(onMessage);
            panel.onDidDispose(() => {
                panel = undefined;
            });
        }
        if (request.search !== undefined) {
            post({ type: 'setSearch', query: request.search });
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('openGitLens.showGraph', request => show(request)),
        onDidChangeRepo(() => {
            if (panel) {
                clearTimeout(reloadTimer);
                reloadTimer = setTimeout(() => guarded(async () => {
                    await load();
                    if (lastSelected === 'WIP') {
                        await sendDetails('WIP');
                    }
                }), RELOAD_DEBOUNCE_MS);
            }
        }),
        { dispose: () => clearTimeout(reloadTimer) },
    );
}

module.exports = { register };
