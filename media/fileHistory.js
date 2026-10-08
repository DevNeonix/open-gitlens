const vscode = acquireVsCodeApi();

const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
const ARROW_DEBOUNCE_MS = 90;
const PAGE_STEP = 8;

const $ = id => document.getElementById(id);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

let state = { commits: [], hasMore: false, avatars: true };
let selectedSha;
let arrowTimer;

function fromNow(ms) {
    const seconds = Math.round((ms - Date.now()) / 1000);
    for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size) {
            return rtf.format(Math.round(seconds / size), unit);
        }
    }
    return rtf.format(seconds, 'second');
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function hueFor(text) {
    let hash = 0;
    for (const char of text) {
        hash = (hash * 31 + char.charCodeAt(0)) % 360;
    }
    return hash;
}

function avatar(author, key) {
    const node = el('span', 'avatar');
    node.style.background = `hsl(${hueFor(author || '?')} 45% 40%)`;
    node.textContent = (author || '?').trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
    if (state.avatars && key) {
        const [kind, value] = key.split(':');
        const img = el('img');
        img.loading = 'lazy';
        img.src = kind === 'gh' ? `https://avatars.githubusercontent.com/u/${value}?s=44&v=4` : `https://www.gravatar.com/avatar/${value}?s=44&d=404`;
        img.onerror = () => img.remove();
        node.append(img);
    }
    return node;
}

const indexOfSelected = () => state.commits.findIndex(commit => commit.sha === selectedSha);

function renderItem(commit) {
    const item = el('div', `item${commit.sha === selectedSha ? ' selected' : ''}`);
    item.dataset.sha = commit.sha;
    const text = el('div', 'text');
    const summary = el('div', 'summary', commit.summary);
    summary.title = commit.summary;
    const meta = el('div', 'meta');
    meta.append(document.createTextNode(`${commit.author}, ${fromNow(commit.date)} · `), el('span', 'sha', commit.sha.slice(0, 8)));
    text.append(summary, meta);
    item.append(avatar(commit.author, commit.avatar), text);
    return item;
}

function render() {
    const list = $('list');
    const hasCommits = state.commits.length > 0;
    $('empty').style.display = !hasCommits && !state.error ? 'block' : 'none';
    $('error').style.display = state.error ? 'block' : 'none';
    $('error').textContent = state.error ?? '';
    list.style.display = hasCommits ? 'block' : 'none';
    if (!state.file) {
        $('emptyText').textContent = 'Open a file to see its history here. Select a commit to see its changes on the right.';
        $('showHistory').style.display = 'inline-block';
    } else {
        $('emptyText').textContent = 'No history yet. The file may be new or untracked.';
        $('showHistory').style.display = 'none';
    }
    list.replaceChildren(...state.commits.map(renderItem));
    if (state.hasMore) {
        const more = el('div');
        more.id = 'more';
        const button = el('button', 'link', 'Load more commits…');
        button.onclick = () => vscode.postMessage({ type: 'loadMore' });
        more.append(button);
        list.append(more);
    }
}

function markSelected(scroll) {
    $('list').querySelectorAll('.item').forEach(item => item.classList.toggle('selected', item.dataset.sha === selectedSha));
    if (scroll) {
        $('list').querySelector('.item.selected')?.scrollIntoView({ block: 'nearest' });
    }
}

/** Selects a commit; the extension opens its diff on the right without taking focus from the list. */
function select(sha, { immediate = true, focusEditor = false } = {}) {
    selectedSha = sha;
    markSelected(true);
    clearTimeout(arrowTimer);
    const send = () => vscode.postMessage({ type: 'select', sha, focusEditor });
    if (immediate) {
        send();
    } else {
        arrowTimer = setTimeout(send, ARROW_DEBOUNCE_MS);
    }
}

function move(delta) {
    const commits = state.commits;
    if (!commits.length) {
        return;
    }
    const current = indexOfSelected();
    const next = Math.max(0, Math.min(commits.length - 1, (current === -1 ? (delta > 0 ? -1 : commits.length) : current) + delta));
    select(commits[next].sha, { immediate: false });
}

function showMenu(event, sha) {
    const menu = $('menu');
    const act = action => () => { menu.style.display = 'none'; vscode.postMessage({ type: 'action', action, sha }); };
    menu.replaceChildren(...[
        ['Compare with Working File', 'compareWithWorking'],
        ['Open File at This Revision', 'openAtRevision'],
        null,
        ['Show in Commit Graph', 'showInGraph'],
        ['Open Commit on Remote', 'openOnRemote'],
        ['Copy SHA', 'copySha'],
    ].map(entry => {
        if (!entry) {
            return el('hr');
        }
        const item = el('div', undefined, entry[0]);
        item.onclick = act(entry[1]);
        return item;
    }));
    menu.style.display = 'block';
    menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 6))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 6))}px`;
}

$('list').addEventListener('click', event => {
    const item = event.target.closest('.item');
    if (item) {
        $('list').focus();
        select(item.dataset.sha);
    }
});
$('list').addEventListener('dblclick', event => {
    const item = event.target.closest('.item');
    if (item) {
        select(item.dataset.sha, { focusEditor: true });
    }
});
$('list').addEventListener('contextmenu', event => {
    const item = event.target.closest('.item');
    if (item) {
        event.preventDefault();
        select(item.dataset.sha);
        showMenu(event, item.dataset.sha);
    }
});
document.addEventListener('click', event => {
    if (!event.target.closest('#menu')) {
        $('menu').style.display = 'none';
    }
});
$('list').addEventListener('keydown', event => {
    const handlers = {
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        PageDown: () => move(PAGE_STEP),
        PageUp: () => move(-PAGE_STEP),
        Home: () => state.commits[0] && select(state.commits[0].sha, { immediate: false }),
        End: () => state.commits.length && select(state.commits[state.commits.length - 1].sha, { immediate: false }),
        Enter: () => selectedSha && select(selectedSha, { focusEditor: true }),
        Escape: () => { $('menu').style.display = 'none'; },
    };
    const handler = handlers[event.key];
    if (handler) {
        event.preventDefault();
        handler();
    }
});
$('showHistory').addEventListener('click', () => vscode.postMessage({ type: 'showHistory' }));

window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'state') {
        const keepFocus = document.activeElement === $('list');
        state = message;
        if (message.selectedSha) {
            selectedSha = message.selectedSha;
        } else if (!state.commits.some(commit => commit.sha === selectedSha)) {
            selectedSha = undefined;
        }
        render();
        if (keepFocus) {
            $('list').focus();
        }
        markSelected(false);
    } else if (message.type === 'focus') {
        $('list').focus();
    }
});

vscode.postMessage({ type: 'ready' });
