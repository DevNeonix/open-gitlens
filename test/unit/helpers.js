const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Isolates git from the developer's global config (signing keys, hooks, identity). */
function isolateGitEnv() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ogl-home-'));
    Object.assign(process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'author@example.com',
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'author@example.com',
    });
}

function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: process.env }).trim();
}

function write(root, file, content) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

/**
 * Creates a repo with: a file with 3 revisions, a rename, a non-ASCII file name,
 * a second author, a branch, a tag, a merge commit and a stash.
 */
function createFixtureRepo() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ogl-repo-'));
    const root = fs.realpathSync(parent);
    git(root, 'init', '-q', '-b', 'main');

    write(root, 'src/app.txt', 'one\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'feat: first version');

    write(root, 'src/app.txt', 'one\ntwo\n');
    write(root, 'src/café ñandú.txt', 'unicode\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'feat: add second line and unicode file');

    git(root, 'mv', 'src/app.txt', 'src/main.txt');
    git(root, 'commit', '-q', '-m', 'refactor: rename app to main');

    git(root, 'checkout', '-q', '-b', 'feature/login');
    write(root, 'src/login.txt', 'login\n');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Other Person', '-c', 'user.email=other@example.com', 'commit', '-q', '--author=Other Person <other@example.com>', '-m', 'feat: login page');
    git(root, 'tag', 'v1.0.0');

    git(root, 'checkout', '-q', 'main');
    write(root, 'src/main.txt', 'one\ntwo\nthree\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fix: add third line');
    git(root, 'merge', '-q', '--no-ff', 'feature/login', '-m', 'Merge feature/login');

    write(root, 'stashed.txt', 'stash me\n');
    git(root, 'add', 'stashed.txt');
    git(root, 'stash', 'push', '-q', '-m', 'wip: my stash');

    return root;
}

function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

module.exports = { isolateGitEnv, createFixtureRepo, git, write, removeDir };
