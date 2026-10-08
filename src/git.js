const { spawn } = require('node:child_process');
const path = require('node:path');

const UNCOMMITTED_SHA = '0'.repeat(40);

const userNames = new Map();

let gitPath = 'git';

/** Lets the host (VS Code) tell us which git executable to use; important when git is not on PATH. */
function setGitPath(value) {
    gitPath = value || 'git';
}

/** English messages (we parse some output), no credential prompts that would hang the extension. */
function gitEnv() {
    return { ...process.env, LANGUAGE: 'en', LC_MESSAGES: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

function runGit(args, cwd, input) {
    return new Promise((resolve, reject) => {
        // quotepath=off: keep non-ASCII file names readable instead of octal-escaped
        const child = spawn(gitPath, ['-c', 'core.quotepath=off', ...args], { cwd, env: gitEnv(), windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            reject(error.code === 'ENOENT'
                ? new Error(`git was not found ("${gitPath}"). Install git or set the "git.path" setting.`)
                : error);
        });
        child.on('close', code => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr.trim() || `git exited with code ${code}`));
            }
        });
        child.stdin.on('error', () => { /* git may exit before reading stdin */ });
        child.stdin.end(input);
    });
}

function parsePorcelain(output) {
    const [header, ...rest] = output.split('\n');
    const [sha, originalLine] = header.split(' ');
    const fields = {};
    for (const line of rest) {
        if (line.startsWith('\t')) {
            break;
        }
        const separator = line.indexOf(' ');
        if (separator === -1) {
            fields[line] = '';
        } else {
            fields[line.slice(0, separator)] = line.slice(separator + 1);
        }
    }
    return {
        sha,
        uncommitted: sha === UNCOMMITTED_SHA,
        originalLine: Number(originalLine),
        author: fields.author ?? '',
        email: (fields['author-mail'] ?? '').replace(/[<>]/g, ''),
        date: new Date(Number(fields['author-time']) * 1000),
        summary: fields.summary ?? '',
    };
}

/**
 * @param {string} filePath absolute path
 * @param {number} line 1-based line number
 * @param {string | undefined} contents current buffer text when the document is dirty
 */
async function blameLine(filePath, line, contents) {
    const args = ['blame', '--porcelain', '-L', `${line},${line}`];
    if (contents !== undefined) {
        args.push('--contents', '-');
    }
    args.push('--', path.basename(filePath));
    const output = await runGit(args, path.dirname(filePath), contents);
    return parsePorcelain(output);
}

function getUserName(cwd) {
    if (!userNames.has(cwd)) {
        userNames.set(cwd, runGit(['config', 'user.name'], cwd).then(name => name.trim(), () => ''));
    }
    return userNames.get(cwd);
}

function parseFileBlame(output) {
    const commits = new Map();
    const lines = [];
    let current;
    for (const raw of output.split('\n')) {
        if (raw.startsWith('\t')) {
            lines.push(current);
            continue;
        }
        const match = /^([0-9a-f]{40}) \d+ \d+/.exec(raw);
        if (match) {
            if (!commits.has(match[1])) {
                commits.set(match[1], { sha: match[1], uncommitted: match[1] === UNCOMMITTED_SHA, fields: {} });
            }
            current = commits.get(match[1]);
            continue;
        }
        const separator = raw.indexOf(' ');
        if (current && separator !== -1) {
            current.fields[raw.slice(0, separator)] = raw.slice(separator + 1);
        }
    }

    for (const commit of commits.values()) {
        const { fields } = commit;
        commit.author = fields.author ?? '';
        commit.email = (fields['author-mail'] ?? '').replace(/[<>]/g, '');
        commit.date = new Date(Number(fields['author-time']) * 1000);
        commit.summary = fields.summary ?? '';
        delete commit.fields;
    }
    return lines;
}

/**
 * Blame for the whole file. Returns one entry per line (index = line - 1).
 * @param {string} filePath absolute path
 * @param {string | undefined} contents current buffer text when the document is dirty
 */
async function blameFile(filePath, contents) {
    const args = ['blame', '--porcelain'];
    if (contents !== undefined) {
        args.push('--contents', '-');
    }
    args.push('--', path.basename(filePath));
    return parseFileBlame(await runGit(args, path.dirname(filePath), contents));
}

/** Blame of a file as it was at a given revision. */
async function blameRevision(root, rev, relativePath) {
    return parseFileBlame(await runGit(['blame', '--porcelain', rev, '--', relativePath], root));
}

const RECORD = '\x1e';
const FIELD = '\x1f';
const LOG_FORMAT = `${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s`;

function parseLog(output) {
    return output.split(RECORD).filter(Boolean).map(chunk => {
        const [header, ...files] = chunk.split('\n');
        const [sha, author, email, time, summary] = header.split(FIELD);
        return {
            sha,
            author,
            email,
            date: new Date(Number(time) * 1000),
            summary,
            file: files.find(Boolean),
        };
    });
}

/** Commits that touched a file (following renames). `file` is the path at that commit. */
async function fileHistory(filePath, limit = 200) {
    const output = await runGit(
        ['log', '--follow', '-n', String(limit), '--name-only', `--format=${LOG_FORMAT}`, '--', path.basename(filePath)],
        path.dirname(filePath),
    );
    return parseLog(output);
}

/** Commits that touched a line range of a file. */
async function lineHistory(filePath, startLine, endLine, limit = 100) {
    const output = await runGit(
        ['log', '-L', `${startLine},${endLine}:${path.basename(filePath)}`, '--no-patch', '-n', String(limit), `--format=${LOG_FORMAT}`],
        path.dirname(filePath),
    );
    return parseLog(output);
}

async function getRepoRoot(cwd) {
    return (await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();
}

/** File content at a revision, or '' if it does not exist there. */
async function showFile(root, rev, relativePath) {
    try {
        return await runGit(['show', `${rev}:${relativePath}`], root);
    } catch {
        return '';
    }
}

async function getParentSha(root, sha) {
    try {
        return (await runGit(['rev-parse', `${sha}^`], root)).trim();
    } catch {
        return undefined;
    }
}

/**
 * Path of the file relative to the repo root.
 * Asks git for the directory prefix instead of subtracting paths, which breaks with
 * Windows 8.3 short names, symlinks (/tmp vs /private/tmp) and drive-letter casing.
 */
async function getRelativePath(filePath) {
    const directory = path.dirname(filePath);
    const [root, prefix] = await Promise.all([
        getRepoRoot(directory),
        runGit(['rev-parse', '--show-prefix'], directory),
    ]);
    return { root, relativePath: `${prefix.trim()}${path.basename(filePath)}` };
}

/** Web URL of a commit for GitHub/GitLab/Bitbucket-style remotes. */
async function getCommitUrl(cwd, sha) {
    const remote = (await runGit(['remote', 'get-url', 'origin'], cwd)).trim();
    const match = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote);
    if (!match) {
        throw new Error(`Unsupported remote: ${remote}`);
    }
    const [, host, repo] = match;
    return host.includes('bitbucket') ? `https://${host}/${repo}/commits/${sha}` : `https://${host}/${repo}/commit/${sha}`;
}

function parseRefs(decoration) {
    return decoration
        .split(', ')
        .filter(Boolean)
        .map(ref => {
            if (ref.startsWith('HEAD -> ')) {
                return { type: 'head', name: ref.slice(8) };
            }
            if (ref === 'HEAD') {
                return { type: 'detached', name: 'HEAD' };
            }
            if (ref.startsWith('tag: ')) {
                return { type: 'tag', name: ref.slice(5) };
            }
            return { type: ref.includes('/') ? 'remote' : 'local', name: ref };
        });
}

/**
 * Commits for the graph, in topological/date order.
 * @param {string} cwd
 * @param {{ limit?: number, scope?: string }} options scope: 'all' | 'head' | any ref name
 */
async function getGraph(cwd, { limit = 500, scope = 'all', refArgs } = {}) {
    const args = ['log', '--date-order', '-n', String(limit), `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%D${FIELD}%s`];
    if (refArgs) {
        args.push(...refArgs);
    } else if (scope === 'all') {
        args.push('--exclude=refs/stash', '--exclude=refs/notes/*', '--all');
    } else {
        args.push(scope === 'head' ? 'HEAD' : scope);
    }
    const output = await runGit(args, cwd);
    return output.split(RECORD).filter(Boolean).map(chunk => {
        const [sha, parents, author, email, time, refs, summary] = chunk.replace(/\n$/, '').split(FIELD);
        return {
            sha,
            parents: parents ? parents.split(' ') : [],
            author,
            email,
            date: Number(time) * 1000,
            refs: parseRefs(refs),
            summary,
        };
    });
}

async function getCommitDetails(cwd, sha) {
    const output = await runGit(['show', '-s', `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%cn${FIELD}%B`, sha], cwd);
    const [full, parents, author, email, time, committer, ...body] = output.split(FIELD);
    return {
        sha: full,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(time) * 1000,
        committer,
        message: body.join(FIELD).trim(),
    };
}

function parseNameStatus(output) {
    const parts = output.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < parts.length;) {
        const status = parts[i++];
        if (status.startsWith('R') || status.startsWith('C')) {
            files.push({ status: status[0], oldFile: parts[i++], file: parts[i++] });
        } else {
            files.push({ status: status[0], file: parts[i++] });
        }
    }
    return files;
}

/** Files changed by a commit (against its first parent). */
async function commitFiles(root, sha) {
    const parent = await getParentSha(root, sha);
    const output = parent
        ? await runGit(['diff', '-M', '--name-status', '-z', parent, sha], root)
        : await runGit(['diff-tree', '-r', '-M', '--name-status', '-z', '--root', '--no-commit-id', sha], root);
    return parseNameStatus(output);
}

/** Files that differ between a ref and the working tree. */
async function diffToWorkingTree(root, ref) {
    return parseNameStatus(await runGit(['diff', '-M', '--name-status', '-z', ref], root));
}

/** Files that differ between two revisions. */
async function diffRevisions(root, left, right) {
    return parseNameStatus(await runGit(['diff', '-M', '--name-status', '-z', left, right], root));
}

async function aheadBehind(root, ref) {
    const [behind, ahead] = (await runGit(['rev-list', '--left-right', '--count', `${ref}...HEAD`], root)).trim().split(/\s+/).map(Number);
    return { ahead, behind };
}

async function currentBranch(root) {
    return (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim();
}

async function listBranches(root) {
    const format = ['%(refname:short)', '%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(committerdate:unix)', '%(subject)'].join(FIELD);
    const output = await runGit(['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'], root);
    return output.split('\n').filter(Boolean).map(line => {
        const [name, fullName, sha, upstream, track, head, time, summary] = line.split(FIELD);
        return {
            name,
            fullName,
            sha,
            upstream,
            track,
            current: head === '*',
            remote: fullName.startsWith('refs/remotes/'),
            date: Number(time) * 1000,
            summary,
        };
    }).filter(branch => !branch.fullName.endsWith('/HEAD'));
}

async function listTags(root) {
    const format = ['%(refname:short)', '%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)', '%(creatordate:unix)', '%(subject)'].join(FIELD);
    const output = await runGit(['for-each-ref', `--format=${format}`, '--sort=-creatordate', 'refs/tags'], root);
    return output.split('\n').filter(Boolean).map(line => {
        const [name, sha, time, summary] = line.split(FIELD);
        return { name, sha, date: Number(time) * 1000, summary };
    });
}

async function listStashes(root) {
    const output = await runGit(['stash', 'list', `--format=%gd${FIELD}%H${FIELD}%ct${FIELD}%gs`], root);
    return output.split('\n').filter(Boolean).map(line => {
        const [ref, sha, time, message] = line.split(FIELD);
        return { ref, sha, date: Number(time) * 1000, message };
    });
}

async function listContributors(root) {
    const output = await runGit(['shortlog', '-sne', 'HEAD'], root);
    return output.split('\n').filter(Boolean).map(line => {
        const match = /^\s*(\d+)\t(.+?) <(.*)>$/.exec(line);
        return match ? { commits: Number(match[1]), name: match[2], email: match[3] } : undefined;
    }).filter(Boolean);
}

/** Runs an arbitrary git command (for actions like checkout, cherry-pick, stash). */
function exec(cwd, args) {
    return runGit(args, cwd);
}

module.exports = {
    exec,
    setGitPath,
    getGraph,
    getCommitDetails,
    commitFiles,
    diffToWorkingTree,
    diffRevisions,
    aheadBehind,
    currentBranch,
    listBranches,
    listTags,
    listStashes,
    listContributors,
    UNCOMMITTED_SHA,
    blameLine,
    blameFile,
    blameRevision,
    fileHistory,
    lineHistory,
    getUserName,
    getRepoRoot,
    getRelativePath,
    getParentSha,
    getCommitUrl,
    showFile,
};
