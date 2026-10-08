const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { createFixtureRepo, git, isolateGitEnv, removeDir, write } = require('./helpers');

isolateGitEnv();
const lib = require('../../src/git');
const gg = require('../../src/gitGraph');
const { layoutGraph } = require('../../src/graphLayout');

describe('git layer', () => {
    let root;
    before(() => { root = createFixtureRepo(); });
    after(() => removeDir(root));

    it('resolves the repo root and a relative path with forward slashes', async () => {
        const file = path.join(root, 'src', 'main.txt');
        const resolved = await lib.getRelativePath(file);
        assert.equal(resolved.relativePath, 'src/main.txt');
        assert.equal(path.resolve(resolved.root), path.resolve(root));
    });

    it('resolves relative paths even when the file path is spelled differently (symlinks)', { skip: process.platform === 'win32' }, async () => {
        const link = `${root}-link`;
        fs.symlinkSync(root, link, 'dir');
        try {
            const resolved = await lib.getRelativePath(path.join(link, 'src', 'main.txt'));
            assert.equal(resolved.relativePath, 'src/main.txt');
        } finally {
            fs.unlinkSync(link);
        }
    });

    it('follows renames in file history', async () => {
        const history = await lib.fileHistory(path.join(root, 'src', 'main.txt'));
        assert.deepEqual(history.map(commit => commit.summary), ['fix: add third line', 'refactor: rename app to main', 'feat: add second line and unicode file', 'feat: first version']);
        assert.equal(history[2].file, 'src/app.txt');
    });

    it('returns non-ASCII file names unescaped', async () => {
        const [head] = (await lib.getGraph(root, { limit: 10, scope: 'all' })).filter(commit => commit.summary.startsWith('feat: add second'));
        const files = await lib.commitFiles(root, head.sha);
        assert.ok(files.some(file => file.file === 'src/café ñandú.txt'), JSON.stringify(files));
        const history = await lib.fileHistory(path.join(root, 'src', 'café ñandú.txt'));
        assert.equal(history[0].file, 'src/café ñandú.txt');
    });

    it('detects renames in commit files', async () => {
        const [rename] = (await lib.getGraph(root, { limit: 10, scope: 'all' })).filter(commit => commit.summary.startsWith('refactor'));
        const files = await lib.commitFiles(root, rename.sha);
        assert.deepEqual(files.map(file => [file.status, file.oldFile, file.file]), [['R', 'src/app.txt', 'src/main.txt']]);
    });

    it('blames a whole file and a single line', async () => {
        const file = path.join(root, 'src', 'main.txt');
        const lines = await lib.blameFile(file);
        assert.equal(lines.length, 3);
        assert.equal(lines[2].summary, 'fix: add third line');
        const one = await lib.blameLine(file, 1);
        assert.equal(one.author, 'Test Author');
        assert.equal(one.uncommitted, false);
    });

    it('blames uncommitted buffer contents', async () => {
        const file = path.join(root, 'src', 'main.txt');
        const lines = await lib.blameFile(file, 'one\ntwo\nthree\nunsaved\n');
        assert.equal(lines.length, 4);
        assert.equal(lines[3].uncommitted, true);
    });

    it('lists branches, tags, stashes and contributors', async () => {
        const branches = await lib.listBranches(root);
        assert.deepEqual(branches.map(branch => branch.name).sort(), ['feature/login', 'main']);
        assert.equal(branches.find(branch => branch.current).name, 'main');
        assert.deepEqual((await lib.listTags(root)).map(tag => tag.name), ['v1.0.0']);
        const stashes = await lib.listStashes(root);
        assert.equal(stashes.length, 1);
        assert.equal(stashes[0].ref, 'stash@{0}');
        const contributors = await lib.listContributors(root);
        assert.deepEqual(contributors.map(person => person.name).sort(), ['Other Person', 'Test Author']);
    });

    it('computes additions/deletions with English parsing regardless of locale', async () => {
        const commits = await lib.getGraph(root, { limit: 10, scope: 'all' });
        const third = commits.find(commit => commit.summary === 'fix: add third line');
        const stats = await gg.commitStats(root, [third.sha]);
        assert.deepEqual(stats[third.sha], [1, 0]);
    });

    it('loads the graph with refs, a stash row and a Working Changes row', async () => {
        write(root, 'dirty.txt', 'dirty\n');
        const graph = await gg.loadGraph(root, { limit: 50, scope: 'all', remotes: true, tags: true, stashes: true, hidden: [] });
        assert.equal(graph.commits[0].type, 'wip');
        assert.ok(graph.commits.some(commit => commit.type === 'stash' && commit.summary.includes('my stash')));
        const merge = graph.commits.find(commit => commit.summary === 'Merge feature/login');
        assert.equal(merge.parents.length, 2);
        assert.ok(merge.refs.some(ref => ref.type === 'head' && ref.name === 'main'));
        assert.ok(graph.commits.some(commit => commit.refs.some(ref => ref.type === 'tag' && ref.name === 'v1.0.0')));
        fs.rmSync(path.join(root, 'dirty.txt'));
    });

    it('lays out the graph with consistent lanes', async () => {
        const commits = await lib.getGraph(root, { limit: 50, scope: 'all' });
        const { rows, laneCount } = layoutGraph(commits);
        assert.equal(rows.length, commits.length);
        assert.ok(laneCount >= 2);
        for (let i = 1; i < rows.length; i++) {
            const bottoms = new Set(rows[i - 1].segments.filter(s => s.y2 === 1).map(s => s.x2));
            for (const s of rows[i].segments.filter(segment => segment.y1 === 0)) {
                assert.ok(bottoms.has(s.x1), `row ${i}: dangling lane ${s.x1}`);
            }
        }
    });

    it('respects scope and hidden refs', async () => {
        const all = await gg.loadGraph(root, { limit: 50, scope: 'all', hidden: [], stashes: false });
        const hidden = await gg.loadGraph(root, { limit: 50, scope: 'all', hidden: ['refs/heads/feature/login'], stashes: false });
        const head = await gg.loadGraph(root, { limit: 50, scope: 'head', stashes: false });
        assert.ok(all.commits.length >= hidden.commits.length);
        assert.ok(head.commits.length > 0);
        const smart = await gg.refArgs(root, { scope: 'smart' });
        assert.ok(smart.includes('HEAD'));
    });

    it('searches by message, author, file and change', async () => {
        const options = { limit: 50, scope: 'all', remotes: true, tags: true, hidden: [] };
        const count = async query => (await gg.searchCommits(root, options, query)).shas.length;
        assert.equal(await count('login'), 2);
        assert.equal(await count('author:Other'), 1);
        assert.equal(await count('file:login.txt'), 1);
        assert.equal(await count('change:unicode'), 1);
        assert.equal(await count('login author:Other'), 1);
        assert.equal(await count('nothing-matches-this'), 0);
    });

    it('parses search queries', () => {
        assert.deepEqual(gg.parseQuery('author:"Marc F" file:src/a.ts fix @me'), [
            { key: 'author', value: 'Marc F' },
            { key: 'file', value: 'src/a.ts' },
            { key: 'message', value: 'fix' },
            { key: 'author', value: '@me' },
        ]);
    });

    it('builds avatar keys for GitHub noreply and gravatar emails', () => {
        assert.equal(gg.avatarKey('123+someone@users.noreply.github.com'), 'gh:123');
        assert.match(gg.avatarKey('A@B.com'), /^gr:[0-9a-f]{32}$/);
        assert.equal(gg.avatarKey('a@b.com'), gg.avatarKey(' A@B.com '));
    });

    it('reports status for staged, unstaged and untracked files', async () => {
        write(root, 'new-file.txt', 'x\n');
        write(root, 'src/main.txt', 'changed\n');
        git(root, 'add', 'new-file.txt');
        const status = await gg.getStatus(root);
        const byFile = Object.fromEntries(status.map(entry => [entry.file, entry]));
        assert.equal(byFile['new-file.txt'].staged, true);
        assert.equal(byFile['src/main.txt'].unstaged, true);
        git(root, 'reset', '-q', '--hard');
        git(root, 'clean', '-fdq');
    });

    it('lists, creates and removes worktrees', async () => {
        const target = path.join(path.dirname(root), `${path.basename(root)}-wt`);
        await lib.exec(root, ['worktree', 'add', '-b', 'wt-branch', target]);
        const worktrees = await gg.listWorktrees(root);
        assert.equal(worktrees.length, 2);
        assert.ok(worktrees.some(worktree => worktree.branch === 'wt-branch'));
        await lib.exec(root, ['worktree', 'remove', target]);
        assert.equal((await gg.listWorktrees(root)).length, 1);
    });

    it('builds a commit URL for common remote formats', async () => {
        git(root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git');
        assert.equal(await lib.getCommitUrl(root, 'abc'), 'https://github.com/owner/repo/commit/abc');
        git(root, 'remote', 'set-url', 'origin', 'https://github.com/owner/repo.git');
        assert.equal(await lib.getCommitUrl(root, 'abc'), 'https://github.com/owner/repo/commit/abc');
        git(root, 'remote', 'set-url', 'origin', 'https://user@bitbucket.org/owner/repo.git');
        assert.equal(await lib.getCommitUrl(root, 'abc'), 'https://bitbucket.org/owner/repo/commits/abc');
    });

    it('reports a clear error when git is missing', async () => {
        lib.setGitPath('definitely-not-a-git-binary');
        await assert.rejects(() => lib.exec(root, ['status']), /git was not found/);
        lib.setGitPath(undefined);
        assert.ok(await lib.exec(root, ['status']) !== undefined);
    });
});
