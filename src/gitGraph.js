const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const git = require('./git');

const FIELD = '\x1f';
const RECORD = '\x1e';
const DEFAULT_BRANCH_CANDIDATES = ['develop', 'main', 'master'];
const SEARCH_LIMIT = 5000;

function avatarKey(email) {
    const noreply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/.exec(email ?? '');
    if (noreply) {
        return `gh:${noreply[1]}`;
    }
    return `gr:${crypto.createHash('md5').update((email ?? '').trim().toLowerCase()).digest('hex')}`;
}

async function tryGit(root, args) {
    try {
        return (await git.exec(root, args)).trim();
    } catch {
        return '';
    }
}

async function smartRefs(root) {
    const refs = new Set(['HEAD']);
    const upstream = await tryGit(root, ['rev-parse', '--abbrev-ref', '@{u}']);
    if (upstream) {
        refs.add(upstream);
    }
    const originHead = await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const candidates = originHead ? [originHead] : DEFAULT_BRANCH_CANDIDATES.flatMap(name => [`origin/${name}`, name]);
    for (const candidate of candidates) {
        if (await tryGit(root, ['rev-parse', '--verify', '--quiet', candidate])) {
            refs.add(candidate);
            break;
        }
    }
    return [...refs];
}

/** Translates the UI scope/filters into `git log` ref arguments. */
async function refArgs(root, { scope = 'all', remotes = true, tags = true, hidden = [] } = {}) {
    if (scope === 'head') {
        return ['HEAD'];
    }
    if (scope === 'smart') {
        return smartRefs(root);
    }
    if (scope !== 'all') {
        return [scope];
    }
    const exclude = kind => hidden.filter(ref => ref.startsWith(`refs/${kind}/`)).map(ref => `--exclude=${ref.slice(`refs/${kind}/`.length)}`);
    return [
        ...exclude('heads'), '--branches',
        ...(remotes ? [...exclude('remotes'), '--remotes'] : []),
        ...(tags ? [...exclude('tags'), '--tags'] : []),
        'HEAD',
    ];
}

async function getStatus(root) {
    const output = await git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = output.split('\0');
    const entries = [];
    for (let i = 0; i < parts.length;) {
        const entry = parts[i++];
        if (!entry) {
            continue;
        }
        const x = entry[0];
        const y = entry[1];
        const file = entry.slice(3);
        const oldFile = x === 'R' || x === 'C' ? parts[i++] : undefined;
        entries.push({
            file,
            oldFile,
            x,
            y,
            staged: x !== ' ' && x !== '?',
            unstaged: y !== ' ' || x === '?',
            untracked: x === '?',
        });
    }
    return entries;
}

async function listStashCommits(root) {
    const output = await git.exec(root, ['stash', 'list', `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%ct${FIELD}%gd${FIELD}%gs`]);
    return output.split('\n').filter(Boolean).map(line => {
        const [sha, parents, author, email, time, ref, message] = line.split(FIELD);
        return { sha, parents: parents.split(' ').slice(0, 1), author, email, date: Number(time) * 1000, ref, summary: message, refs: [], type: 'stash' };
    });
}

/**
 * Commits for the graph, enriched with avatars, stash rows and a Working Changes row.
 * @returns {Promise<{ commits: object[], hasMore: boolean, headSha: string, status: object[] }>}
 */
async function loadGraph(root, options) {
    const args = await refArgs(root, options);
    const [raw, status, headSha, stashes] = await Promise.all([
        git.getGraph(root, { limit: options.limit, refArgs: args }),
        getStatus(root).catch(() => []),
        tryGit(root, ['rev-parse', 'HEAD']),
        options.stashes === false ? [] : listStashCommits(root).catch(() => []),
    ]);
    const commits = raw.map(commit => ({ ...commit, type: 'commit' }));

    for (const stash of stashes) {
        const index = commits.findIndex(commit => commit.sha === stash.parents[0]);
        if (index !== -1) {
            commits.splice(index, 0, stash);
        }
    }
    if (status.length > 0 && commits.some(commit => commit.sha === headSha)) {
        const index = commits.findIndex(commit => commit.sha === headSha);
        commits.splice(Math.max(0, index - stashes.filter(stash => stash.parents[0] === headSha).length), 0, {
            sha: 'WIP',
            parents: [headSha],
            author: '',
            email: '',
            date: Date.now(),
            refs: [],
            summary: `Working Changes (${status.length} file${status.length === 1 ? '' : 's'})`,
            type: 'wip',
        });
    }
    for (const commit of commits) {
        commit.avatar = commit.type === 'wip' ? '' : avatarKey(commit.email);
    }
    return { commits, hasMore: raw.length === options.limit, headSha, status };
}

/** Additions/deletions per commit. Merge commits have no entry. */
async function commitStats(root, shas) {
    if (shas.length === 0) {
        return {};
    }
    const output = await git.exec(root, ['log', '--no-walk=unsorted', '--shortstat', `--format=${RECORD}%H`, ...shas]);
    const stats = {};
    for (const chunk of output.split(RECORD).filter(Boolean)) {
        const [sha, ...rest] = chunk.split('\n');
        const text = rest.join(' ');
        const add = /(\d+) insertion/.exec(text);
        const del = /(\d+) deletion/.exec(text);
        stats[sha.trim()] = [add ? Number(add[1]) : 0, del ? Number(del[1]) : 0];
    }
    return stats;
}

const TERM_PATTERN = /(?:(\w+|@me):)?(?:"([^"]*)"|(\S+))/g;
const PREFIXES = new Set(['message', 'author', 'file', 'change', 'commit', 'sha', 'after', 'before']);

/** Parses `author:john file:src/a.ts fix login @me` into structured terms. */
function parseQuery(query) {
    const terms = [];
    for (const match of query.matchAll(TERM_PATTERN)) {
        const [token, prefix, quoted, bare] = match;
        const value = quoted ?? bare;
        if (token === '@me') {
            terms.push({ key: 'author', value: '@me' });
        } else if (prefix && PREFIXES.has(prefix.toLowerCase())) {
            terms.push({ key: prefix.toLowerCase(), value });
        } else {
            terms.push({ key: 'message', value: token.replace(/^"|"$/g, '') });
        }
    }
    return terms;
}

/** Runs the server-side part of a graph search and returns matching SHAs. */
async function searchCommits(root, options, query, { matchCase = false, regex = false } = {}) {
    const terms = parseQuery(query);
    const args = ['log', '-n', String(SEARCH_LIMIT), '--format=%H'];
    const files = [];
    let serverFilter = false;

    for (const { key, value } of terms) {
        if (key === 'message') {
            args.push(`--grep=${value}`);
            serverFilter = true;
        } else if (key === 'author') {
            const author = value === '@me' ? (await tryGit(root, ['config', 'user.email'])) || (await tryGit(root, ['config', 'user.name'])) : value;
            args.push(`--author=${author}`);
            serverFilter = true;
        } else if (key === 'file') {
            files.push(`:(${matchCase ? '' : 'icase,'}glob)**/*${value}*`);
            serverFilter = true;
        } else if (key === 'change') {
            args.push(`-G${value}`);
            serverFilter = true;
        } else if (key === 'after') {
            args.push(`--since=${value}`);
            serverFilter = true;
        } else if (key === 'before') {
            args.push(`--until=${value}`);
            serverFilter = true;
        }
    }
    const shaTerms = terms.filter(term => term.key === 'commit' || term.key === 'sha').map(term => term.value.toLowerCase());
    if (!serverFilter && shaTerms.length === 0) {
        return [];
    }
    const matches = new Set();
    if (serverFilter) {
        if (!matchCase) {
            args.push('--regexp-ignore-case');
        }
        args.push(regex ? '--extended-regexp' : '--fixed-strings');
        args.push('--all-match');
        args.push(...(await refArgs(root, options)));
        if (files.length > 0) {
            args.push('--', ...files);
        }
        const output = await git.exec(root, args);
        output.split('\n').filter(Boolean).forEach(sha => matches.add(sha));
    }
    return { shas: [...matches], shaPrefixes: shaTerms };
}

async function getSyncInfo(root) {
    const [branch, upstream, counts] = await Promise.all([
        tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
        tryGit(root, ['rev-parse', '--abbrev-ref', '@{u}']),
        tryGit(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    ]);
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];
    let fetchedAt;
    try {
        const fetchHead = await tryGit(root, ['rev-parse', '--git-path', 'FETCH_HEAD']);
        fetchedAt = (await fs.stat(path.resolve(root, fetchHead))).mtimeMs;
    } catch {
        fetchedAt = undefined;
    }
    return { branch, upstream, ahead, behind, fetchedAt, repo: path.basename(root) };
}

/** Parses `git worktree list --porcelain`. */
async function listWorktrees(root) {
    const output = await git.exec(root, ['worktree', 'list', '--porcelain']);
    return output.split('\n\n').filter(Boolean).map(block => {
        const info = { path: '', branch: '', head: '', detached: false, bare: false, locked: false, prunable: false };
        for (const line of block.split('\n')) {
            const [key, ...rest] = line.split(' ');
            const value = rest.join(' ');
            if (key === 'worktree') {
                info.path = value;
            } else if (key === 'HEAD') {
                info.head = value;
            } else if (key === 'branch') {
                info.branch = value.replace('refs/heads/', '');
            } else if (key === 'detached') {
                info.detached = true;
            } else if (key === 'bare') {
                info.bare = true;
            } else if (key === 'locked') {
                info.locked = true;
            } else if (key === 'prunable') {
                info.prunable = true;
            }
        }
        return info;
    });
}

module.exports = {
    avatarKey,
    refArgs,
    getStatus,
    loadGraph,
    commitStats,
    parseQuery,
    searchCommits,
    getSyncInfo,
    listWorktrees,
};
