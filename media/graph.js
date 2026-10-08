const vscode = acquireVsCodeApi();

const ROW_HEIGHT = 26;
const PALETTE = ['#4fc1ff', '#f14c4c', '#89d185', '#d7ba7d', '#c586c0', '#ce9178', '#4ec9b0', '#9cdcfe', '#b5cea8', '#dcdcaa'];
const COLUMNS = [
    { id: 'refs', label: 'Branch / Tag', resizable: true },
    { id: 'graph', label: 'Graph' },
    { id: 'message', label: 'Commit Message' },
    { id: 'author', label: 'Author', resizable: true },
    { id: 'date', label: 'Commit Date / Time', resizable: true },
    { id: 'sha', label: 'Sha', resizable: true },
    { id: 'changes', label: 'Changes', resizable: true },
];
const STATUS_LABEL = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' };
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
const PREFIX_PATTERN = /(^|\s)(message|author|file|change|commit|sha|after|before):|(^|\s)@me(\s|$)/i;

const defaults = {
    cols: { refs: true, graph: true, message: true, author: true, date: true, sha: true, changes: true },
    widths: { refs: 180, author: 150, date: 120, sha: 84, changes: 100 },
    compact: false,
    minimap: true,
    dimMerges: false,
    treeView: false,
};
const saved = vscode.getState() ?? {};
const ui = { ...defaults, ...saved.ui, cols: { ...defaults.cols, ...saved.ui?.cols }, widths: { ...defaults.widths, ...saved.ui?.widths } };
const persistUi = () => vscode.setState({ ui });

let data = { commits: [], laneCount: 1, options: { scope: 'all', remotes: true, tags: true, stashes: true, hidden: [] }, sync: {}, branches: [], avatars: true };
let stats = {};
let selected;
let wipMessage = '';
let search = { query: '', flags: { matchCase: false, regex: false }, shas: new Set(), prefixes: [], matches: [], cursor: -1 };

const $ = id => document.getElementById(id);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

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

function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    return node;
}

const post = message => vscode.postMessage(message);
const colorOf = index => PALETTE[index % PALETTE.length];
const laneWidth = () => (ui.compact ? 8 : 12);
const maxLanes = () => (ui.compact ? 10 : 20);
const graphWidth = () => Math.min(data.laneCount, maxLanes()) * laneWidth() + 12;

function hueFor(text) {
    let hash = 0;
    for (const char of text) {
        hash = (hash * 31 + char.charCodeAt(0)) % 360;
    }
    return hash;
}

function avatar(author, key, large) {
    const node = el('span', `avatar${large ? ' lg' : ''}`);
    node.style.background = `hsl(${hueFor(author || '?')} 45% 40%)`;
    node.textContent = (author || '?').trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
    if (data.avatars && key) {
        const [kind, value] = key.split(':');
        const img = el('img');
        img.loading = 'lazy';
        img.src = kind === 'gh' ? `https://avatars.githubusercontent.com/u/${value}?s=56&v=4` : `https://www.gravatar.com/avatar/${value}?s=56&d=404`;
        img.onerror = () => img.remove();
        node.append(img);
    }
    return node;
}

/* ---------- layout ---------- */

function columnTemplate() {
    return COLUMNS.filter(column => ui.cols[column.id]).map(column => {
        if (column.id === 'graph') {
            return `${graphWidth()}px`;
        }
        if (column.id === 'message') {
            return 'minmax(180px, 1fr)';
        }
        return `${ui.widths[column.id]}px`;
    }).join(' ');
}

function applyColumns() {
    const template = columnTemplate();
    document.documentElement.style.setProperty('--cols', template);
    document.body.classList.toggle('compact', ui.compact);
    const list = $('list');
    $('colhdr').style.paddingRight = `${list.offsetWidth - list.clientWidth}px`;
}

function renderHeaderRow() {
    const header = $('colhdr');
    header.replaceChildren(...COLUMNS.filter(column => ui.cols[column.id]).map(column => {
        const cell = el('div', 'hcell', column.label);
        if (column.resizable) {
            const grip = el('div', 'grip');
            grip.addEventListener('mousedown', event => startResize(event, column.id, grip));
            cell.append(grip);
        }
        return cell;
    }));
}

function startResize(event, id, grip) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = ui.widths[id];
    grip.classList.add('active');
    const onMove = move => {
        ui.widths[id] = Math.max(40, startWidth + move.clientX - startX);
        applyColumns();
    };
    const onUp = () => {
        grip.classList.remove('active');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        persistUi();
        renderMinimap();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

/* ---------- rows ---------- */

function renderGraphCell(commit) {
    const lw = laneWidth();
    const width = graphWidth();
    const svg = svgEl('svg', { width, height: ROW_HEIGHT, viewBox: `0 0 ${width} ${ROW_HEIGHT}` });
    const px = lane => Math.min(lane, maxLanes() - 1) * lw + lw / 2 + 6;
    for (const s of commit.segments) {
        const x1 = px(s.x1), y1 = s.y1 * ROW_HEIGHT, x2 = px(s.x2), y2 = s.y2 * ROW_HEIGHT;
        const stroke = colorOf(s.color);
        const dashed = commit.type === 'wip' ? { 'stroke-dasharray': '3 3' } : {};
        if (x1 === x2) {
            svg.append(svgEl('line', { x1, y1, x2, y2, stroke, 'stroke-width': 2, ...dashed }));
        } else {
            const mid = (y1 + y2) / 2;
            svg.append(svgEl('path', { d: `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`, stroke, fill: 'none', 'stroke-width': 2, ...dashed }));
        }
    }
    const cx = px(commit.lane), cy = ROW_HEIGHT / 2, color = colorOf(commit.color);
    if (commit.type === 'stash') {
        svg.append(svgEl('rect', { x: cx - 4, y: cy - 4, width: 8, height: 8, fill: 'var(--vscode-editor-background)', stroke: color, 'stroke-width': 2, transform: `rotate(45 ${cx} ${cy})` }));
    } else if (commit.type === 'wip') {
        svg.append(svgEl('circle', { cx, cy, r: 4.5, fill: 'var(--vscode-editor-background)', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '2 2' }));
    } else if (commit.parents > 1) {
        svg.append(svgEl('circle', { cx, cy, r: 3.5, fill: 'var(--vscode-editor-background)', stroke: color, 'stroke-width': 2 }));
    } else {
        svg.append(svgEl('circle', { cx, cy, r: 4.5, fill: color, stroke: color, 'stroke-width': 2 }));
    }
    return svg;
}

function chipFor(ref) {
    const type = ref.type === 'detached' ? 'head' : ref.type;
    const chip = el('span', `chip ${type}`, (type === 'head' ? '● ' : '') + ref.name);
    chip.title = ref.name;
    chip.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        showRefMenu(event, { type: ref.type === 'head' ? 'local' : ref.type, name: ref.name });
    });
    return chip;
}

function statsCell(commit) {
    const cell = el('div', 'c-changes');
    const value = stats[commit.sha];
    if (value) {
        cell.append(el('span', 'add', `+${value[0]}`), el('span', 'del', `−${value[1]}`));
    }
    return cell;
}

function renderRow(commit, index) {
    const row = el('div', `row ${commit.type}${commit.parents > 1 ? ' merge' : ''}`);
    row.dataset.index = index;
    for (const column of COLUMNS) {
        if (!ui.cols[column.id]) {
            continue;
        }
        if (column.id === 'refs') {
            const cell = el('div', 'c-refs');
            if (commit.type === 'stash') {
                cell.append(el('span', 'chip stash', 'stash'));
            }
            cell.append(...commit.refs.map(chipFor));
            row.append(cell);
        } else if (column.id === 'graph') {
            const cell = el('div', 'c-graph');
            cell.append(renderGraphCell(commit));
            row.append(cell);
        } else if (column.id === 'message') {
            const cell = el('div', 'c-message', commit.summary);
            cell.title = commit.summary;
            row.append(cell);
        } else if (column.id === 'author') {
            const cell = el('div', 'c-author');
            if (commit.type !== 'wip') {
                cell.append(avatar(commit.author, commit.avatar), el('span', 'name', commit.author));
            }
            cell.title = commit.author;
            row.append(cell);
        } else if (column.id === 'date') {
            const cell = el('div', 'c-date', commit.type === 'wip' ? '' : fromNow(commit.date));
            cell.title = new Date(commit.date).toLocaleString();
            row.append(cell);
        } else if (column.id === 'sha') {
            row.append(el('div', 'c-sha', commit.type === 'wip' ? '' : commit.sha.slice(0, 8)));
        } else if (column.id === 'changes') {
            row.append(statsCell(commit));
        }
    }
    return row;
}

function rowFor(index) {
    return $('list').querySelectorAll('.row')[index];
}

function render() {
    applyColumns();
    renderHeaderRow();
    const list = $('list');
    const scrollTop = list.scrollTop;
    list.replaceChildren(...data.commits.map(renderRow));
    if (data.hasMore) {
        const more = el('div');
        more.id = 'more';
        const button = el('button', 'primary', 'Load more commits');
        button.onclick = () => post({ type: 'loadMore' });
        more.append(button);
        list.append(more);
    }
    list.scrollTop = scrollTop;
    renderToolbar();
    applySearchClasses();
    if (selected) {
        markSelected(selected);
    }
    $('minimap').classList.toggle('hidden', !ui.minimap);
    $('minimapToggle').classList.toggle('on', ui.minimap);
    renderMinimap();
}

function renderToolbar() {
    const { sync } = data;
    $('repo').textContent = sync.repo ?? '';
    $('branch').textContent = `⎇ ${sync.branch ?? ''}`;
    $('sync').textContent = [sync.behind ? `↓${sync.behind}` : '', sync.ahead ? `↑${sync.ahead}` : ''].filter(Boolean).join(' ');
    $('fetched').textContent = sync.fetchedAt ? `(${fromNow(sync.fetchedAt)})` : '';
    $('pull').disabled = !sync.upstream;
}

/* ---------- selection ---------- */

function markSelected(sha) {
    selected = sha;
    $('list').querySelectorAll('.row').forEach((row, i) => row.classList.toggle('selected', data.commits[i]?.sha === sha));
}

function select(index, scroll) {
    const commit = data.commits[index];
    if (!commit) {
        return;
    }
    markSelected(commit.sha);
    if (scroll) {
        rowFor(index)?.scrollIntoView({ block: 'center' });
    }
    post({ type: 'select', sha: commit.sha });
}

function selectBySha(sha) {
    const index = data.commits.findIndex(commit => commit.sha === sha);
    if (index === -1) {
        post({ type: 'select', sha });
    } else {
        select(index, true);
    }
}

/* ---------- search ---------- */

let searchTimer;

function runSearch() {
    const query = $('search').value.trim();
    search.query = query;
    if (!query) {
        search = { ...search, shas: new Set(), prefixes: [], matches: [], cursor: -1 };
        applySearchClasses();
        return;
    }
    if (PREFIX_PATTERN.test(query)) {
        post({ type: 'search', query, flags: search.flags });
    } else {
        search = { ...search, shas: new Set(), prefixes: [], local: true };
        computeMatches();
    }
}

function localMatcher(query) {
    if (search.flags.regex) {
        try {
            const regex = new RegExp(query, search.flags.matchCase ? '' : 'i');
            return text => regex.test(text);
        } catch {
            return () => false;
        }
    }
    const needle = search.flags.matchCase ? query : query.toLowerCase();
    return text => (search.flags.matchCase ? text : text.toLowerCase()).includes(needle);
}

function computeMatches() {
    const query = search.query;
    const matches = [];
    if (query) {
        const test = search.local ? localMatcher(query) : undefined;
        data.commits.forEach((commit, index) => {
            if (commit.type === 'wip') {
                return;
            }
            const hit = search.local
                ? [commit.summary, commit.author, commit.email, commit.sha, ...commit.refs.map(ref => ref.name)].some(test)
                : search.shas.has(commit.sha) || search.prefixes.some(prefix => commit.sha.startsWith(prefix));
            if (hit) {
                matches.push(index);
            }
        });
    }
    search.matches = matches;
    search.cursor = -1;
    applySearchClasses();
    renderMinimap();
}

function applySearchClasses() {
    const active = Boolean(search.query);
    $('list').querySelectorAll('.row').forEach((row, i) => {
        const hit = search.matches.includes(i);
        row.classList.toggle('dim', active && !hit);
        row.classList.toggle('match', active && hit);
        row.classList.toggle('dimmerge', ui.dimMerges);
    });
    $('count').textContent = active ? `${search.cursor >= 0 ? `${search.cursor + 1} of ` : ''}${search.matches.length}` : '';
}

function stepMatch(direction, edge) {
    if (!search.matches.length) {
        return;
    }
    const last = search.matches.length - 1;
    search.cursor = edge ? (direction > 0 ? last : 0) : (search.cursor + direction + search.matches.length) % search.matches.length;
    select(search.matches[search.cursor], true);
    applySearchClasses();
}

/* ---------- minimap ---------- */

function renderMinimap() {
    if (!ui.minimap) {
        return;
    }
    const container = $('minimap');
    const canvas = container.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const dated = data.commits.filter(commit => commit.type !== 'wip');
    if (dated.length < 2) {
        return;
    }
    const tmax = dated[0].date;
    const tmin = dated[dated.length - 1].date;
    const span = Math.max(1, tmax - tmin);
    const xOf = date => ((tmax - date) / span) * (width - 2) + 1;

    const buckets = new Array(width).fill(0);
    dated.forEach(commit => { buckets[Math.min(width - 1, Math.floor(xOf(commit.date)))]++; });
    const peak = Math.max(1, ...buckets);
    ctx.fillStyle = 'rgba(128,128,128,.45)';
    buckets.forEach((count, x) => {
        const h = (count / peak) * (height - 14) + (count ? 2 : 0);
        ctx.fillRect(x, height / 2 - h / 2, 1, h);
    });

    const mark = (commit, color, top) => {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(xOf(commit.date)) - 1, top ? 0 : height - 5, 3, 5);
    };
    dated.forEach(commit => {
        if (commit.type === 'stash') {
            mark(commit, '#b180d7', false);
        }
        for (const ref of commit.refs) {
            if (ref.type === 'remote') { mark(commit, '#4fc1ff', true); }
            else if (ref.type === 'tag') { mark(commit, '#a0794f', true); }
            else if (ref.type === 'local' || ref.type === 'head') { mark(commit, '#3794ff', false); }
        }
    });
    const head = dated.find(commit => commit.sha === data.headSha);
    if (head) {
        ctx.fillStyle = '#89d185';
        ctx.fillRect(Math.round(xOf(head.date)), 0, 2, height);
    }
    ctx.fillStyle = '#ddc34c';
    search.matches.forEach(index => {
        const commit = data.commits[index];
        if (commit) {
            ctx.fillRect(Math.round(xOf(commit.date)), 0, 2, height);
        }
    });

    const list = $('list');
    const firstRow = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT));
    const lastRow = Math.min(data.commits.length - 1, Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT));
    const first = data.commits[firstRow], last = data.commits[lastRow];
    if (first && last) {
        const x1 = xOf(first.date), x2 = xOf(last.date);
        ctx.strokeStyle = 'rgba(255,255,255,.7)';
        ctx.fillStyle = 'rgba(255,255,255,.08)';
        ctx.fillRect(x1, 0, Math.max(3, x2 - x1), height);
        ctx.strokeRect(x1 + .5, .5, Math.max(3, x2 - x1) - 1, height - 1);
    }
    container.dataset.tmax = tmax;
    container.dataset.span = span;
}

$('minimap').addEventListener('click', event => {
    const container = $('minimap');
    const rect = container.getBoundingClientRect();
    const tmax = Number(container.dataset.tmax);
    const span = Number(container.dataset.span);
    const date = tmax - ((event.clientX - rect.left) / rect.width) * span;
    let best = 0;
    data.commits.forEach((commit, i) => {
        if (commit.type !== 'wip' && Math.abs(commit.date - date) < Math.abs(data.commits[best].date - date)) {
            best = i;
        }
    });
    $('list').scrollTop = Math.max(0, best * ROW_HEIGHT - $('list').clientHeight / 2);
});

let scrollFrame;
$('list').addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(renderMinimap);
});
window.addEventListener('resize', renderMinimap);

/* ---------- menus & popovers ---------- */

function placeFloating(node, x, y) {
    node.style.display = 'block';
    node.style.left = `${Math.max(4, Math.min(x, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(4, Math.min(y, window.innerHeight - node.offsetHeight - 8))}px`;
}

function closeFloating() {
    $('menu').style.display = 'none';
    $('popover').style.display = 'none';
}

function showMenu(event, entries) {
    const menu = $('menu');
    $('popover').style.display = 'none';
    menu.replaceChildren(...entries.map(entry => {
        if (!entry) {
            return el('hr');
        }
        const item = el('div', undefined, entry[0]);
        item.onclick = () => {
            closeFloating();
            entry[1]();
        };
        return item;
    }));
    placeFloating(menu, event.clientX, event.clientY);
}

function showPopover(anchor, build) {
    const popover = $('popover');
    $('menu').style.display = 'none';
    if (popover.style.display === 'block' && popover.dataset.anchor === anchor.id) {
        closeFloating();
        return;
    }
    popover.dataset.anchor = anchor.id;
    popover.replaceChildren(...build());
    const rect = anchor.getBoundingClientRect();
    placeFloating(popover, rect.left, rect.bottom + 2);
}

function checkbox(label, checked, onChange) {
    const row = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    row.append(input, document.createTextNode(label));
    return row;
}

function radio(name, label, checked, onChange) {
    const row = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.checked = checked;
    input.onchange = onChange;
    row.append(input, document.createTextNode(label));
    return row;
}

const sendOptions = patch => post({ type: 'options', options: { ...data.options, ...patch } });

function buildFilterPopover() {
    const { options } = data;
    const custom = !['all', 'head', 'smart'].includes(options.scope);
    const nodes = [
        el('div', 'title', 'Branches'),
        radio('scope', 'All Branches', options.scope === 'all', () => sendOptions({ scope: 'all' })),
        radio('scope', 'Current Branch', options.scope === 'head', () => sendOptions({ scope: 'head' })),
        radio('scope', 'Smart Branches', options.scope === 'smart', () => sendOptions({ scope: 'smart' })),
    ];
    if (custom) {
        nodes.push(radio('scope', options.scope, true, () => undefined));
    }
    nodes.push(
        el('hr'),
        el('div', 'title', 'Show'),
        checkbox('Remote branches', options.remotes, value => sendOptions({ remotes: value })),
        checkbox('Tags', options.tags, value => sendOptions({ tags: value })),
        checkbox('Stashes', options.stashes, value => sendOptions({ stashes: value })),
        el('hr'),
        checkbox('Dim merge commits', ui.dimMerges, value => { ui.dimMerges = value; persistUi(); applySearchClasses(); }),
    );
    if (options.hidden.length > 0) {
        nodes.push(el('hr'), el('div', 'title', 'Hidden refs'));
        for (const ref of options.hidden) {
            const line = el('div', 'hidden-ref');
            const show = el('button', undefined, 'Show');
            show.onclick = () => sendOptions({ hidden: options.hidden.filter(item => item !== ref) });
            line.append(el('span', undefined, ref.replace(/^refs\/(heads|remotes|tags)\//, '')), show);
            nodes.push(line);
        }
    }
    return nodes;
}

function buildColumnsPopover() {
    return [
        el('div', 'title', 'Columns'),
        ...COLUMNS.filter(column => column.id !== 'graph').map(column => checkbox(column.label, ui.cols[column.id], value => {
            ui.cols[column.id] = value;
            persistUi();
            render();
        })),
        el('hr'),
        el('div', 'title', 'Layout'),
        checkbox('Compact graph column', ui.compact, value => { ui.compact = value; persistUi(); render(); }),
        checkbox('Show changes as tree in details', ui.treeView, value => { ui.treeView = value; persistUi(); }),
    ];
}

function showCommitMenu(event, commit) {
    const sha = commit.sha;
    const act = action => () => post({ type: 'action', action, sha });
    if (commit.type === 'wip') {
        return;
    }
    if (commit.type === 'stash') {
        showMenu(event, [['Apply Stash', act('stashApply')], ['Pop Stash', act('stashPop')], ['Drop Stash…', act('stashDrop')], null, ['Copy SHA', act('copySha')]]);
        return;
    }
    showMenu(event, [
        ['Checkout…', act('checkout')],
        ['Create Branch Here…', act('branch')],
        ['Create Tag Here…', act('tag')],
        null,
        ['Cherry-pick', act('cherryPick')],
        ['Revert', act('revert')],
        ...(sha === data.headSha ? [['Undo Commit', act('undoCommit')]] : []),
        ['Reset Current Branch to Here…', act('reset')],
        null,
        ['Compare with Working Tree', act('compareHead')],
        ['Copy SHA', act('copySha')],
        ['Open on Remote', act('openRemote')],
    ]);
}

function showRefMenu(event, ref) {
    const act = action => () => post({ type: 'refAction', action, ref });
    showMenu(event, [
        ...(ref.type !== 'tag' ? [['Checkout', act('checkout')]] : []),
        ['Create Branch From…', act('createFrom')],
        ...(ref.type !== 'tag' ? [['Merge into Current Branch…', act('merge')]] : []),
        ['Compare with Working Tree', act('compare')],
        null,
        ['Hide from Graph', act('hide')],
        ['Copy Name', act('copyName')],
        null,
        [ref.type === 'tag' ? 'Delete Tag…' : ref.type === 'remote' ? 'Delete Remote Branch…' : 'Delete Branch…', act('delete')],
    ]);
}

/* ---------- details ---------- */

function fileRow(file, handlers) {
    const item = el('div', 'file');
    item.title = `${STATUS_LABEL[file.status] ?? file.status}: ${file.oldFile ? `${file.oldFile} → ` : ''}${file.file}`;
    const slash = file.file.lastIndexOf('/');
    const name = el('span', 'name');
    name.append(el('span', 'base', file.file.slice(slash + 1)));
    if (slash !== -1 && !handlers.hideDir) {
        name.append(el('span', 'dir', file.file.slice(0, slash)));
    }
    const status = handlers.untracked ? '?' : file.status;
    item.append(el('span', `st ${handlers.untracked ? 'untracked' : file.status}`, status), name);
    const buttons = el('span', 'fbtns');
    for (const [label, title, run] of handlers.buttons ?? []) {
        const button = el('button', undefined, label);
        button.title = title;
        button.onclick = event => { event.stopPropagation(); run(); };
        buttons.append(button);
    }
    item.append(buttons);
    item.onclick = handlers.open;
    return item;
}

function buildTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const file of files) {
        const parts = file.file.split('/');
        let node = root;
        for (const part of parts.slice(0, -1)) {
            if (!node.dirs.has(part)) {
                node.dirs.set(part, { dirs: new Map(), files: [] });
            }
            node = node.dirs.get(part);
        }
        node.files.push(file);
    }
    return root;
}

function renderTree(node, depth, makeFile, out) {
    for (const [dirName, dirNode] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        let name = dirName;
        let child = dirNode;
        while (child.files.length === 0 && child.dirs.size === 1) {
            const [[nextName, nextNode]] = child.dirs;
            name += `/${nextName}`;
            child = nextNode;
        }
        const dir = el('div', 'tree-dir', `▾ ${name}`);
        dir.style.paddingLeft = `${depth * 12 + 4}px`;
        const holder = el('div');
        dir.onclick = () => {
            const hidden = holder.style.display === 'none';
            holder.style.display = hidden ? '' : 'none';
            dir.textContent = `${hidden ? '▾' : '▸'} ${name}`;
        };
        const inner = [];
        renderTree(child, depth + 1, makeFile, inner);
        holder.append(...inner);
        out.push(dir, holder);
    }
    for (const file of node.files) {
        const row = makeFile(file, true);
        row.style.paddingLeft = `${depth * 12 + 4}px`;
        out.push(row);
    }
}

function renderFiles(files, makeFile) {
    if (!ui.treeView) {
        return files.map(file => makeFile(file, false));
    }
    const out = [];
    renderTree(buildTree(files), 0, makeFile, out);
    return out;
}

function actionButton(label, action, sha) {
    const button = el('button', undefined, label);
    button.onclick = () => post({ type: 'action', action, sha });
    return button;
}

function renderDetails({ details, files, isHead }) {
    const pane = $('details');
    pane.classList.remove('empty');
    const [subject, ...bodyLines] = details.message.split('\n');
    const nodes = [el('h3', 'subject', subject)];
    const body = bodyLines.join('\n').trim();
    if (body) {
        nodes.push(el('div', 'body', body));
    }
    const meta = el('div', 'meta');
    const who = el('div', 'who');
    who.append(el('div', undefined, details.author), el('div', 'when', `${new Date(details.date).toLocaleString()} (${fromNow(details.date)})`));
    meta.append(avatar(details.author, details.avatar, true), who);
    nodes.push(meta);

    const kv = el('div', 'kv');
    const sha = el('a', undefined, details.sha.slice(0, 12));
    sha.title = 'Copy SHA';
    sha.onclick = () => post({ type: 'action', action: 'copySha', sha: details.sha });
    kv.append(document.createTextNode('Commit: '), sha, el('br'), document.createTextNode(`${details.email}`));
    if (details.committer && details.committer !== details.author) {
        kv.append(el('br'), document.createTextNode(`Committed by ${details.committer}`));
    }
    const parents = el('div', 'parents');
    parents.append(document.createTextNode('Parents: '));
    details.parents.forEach((parent, i) => {
        const link = el('a', undefined, parent.slice(0, 8));
        link.onclick = () => selectBySha(parent);
        parents.append(i ? document.createTextNode(', ') : '', link);
    });
    kv.append(parents);
    nodes.push(kv);

    const actions = el('div', 'actions');
    actions.append(
        actionButton('Compare with working tree', 'compareHead', details.sha),
        actionButton('Open on remote', 'openRemote', details.sha),
        ...(isHead ? [actionButton('Undo commit', 'undoCommit', details.sha)] : []),
    );
    nodes.push(actions);

    const header = el('div', 'section');
    header.append(el('span', undefined, `${files.length} file${files.length === 1 ? '' : 's'} changed`));
    const toggle = el('button', undefined, ui.treeView ? 'List' : 'Tree');
    toggle.onclick = () => { ui.treeView = !ui.treeView; persistUi(); renderDetails({ details, files, isHead }); };
    header.append(toggle);
    nodes.push(header);

    nodes.push(...renderFiles(files, (file, hideDir) => fileRow(file, {
        hideDir,
        open: () => post({ type: 'openFile', sha: details.sha, file: file.file, oldFile: file.oldFile }),
        buttons: file.status === 'D' ? [] : [
            ['↗', 'Open file', () => post({ type: 'openOnDisk', file: file.file })],
            ['⏲', 'File history', () => post({ type: 'fileHistory', file: file.file })],
        ],
    })));
    pane.replaceChildren(...nodes);
}

function renderWipDetails({ files }) {
    const pane = $('details');
    pane.classList.remove('empty');
    const staged = files.filter(file => file.staged);
    const unstaged = files.filter(file => file.unstaged);
    const wip = (op, extra = {}) => post({ type: 'wip', op, ...extra });

    const section = (title, buttons) => {
        const header = el('div', 'section');
        header.append(el('span', undefined, title));
        const group = el('span', 'btns');
        for (const [label, run, tip] of buttons) {
            const button = el('button', undefined, label);
            button.title = tip;
            button.onclick = run;
            group.append(button);
        }
        header.append(group);
        return header;
    };
    const toFile = file => ({ ...file, status: file.untracked ? 'A' : (file.staged && file.x !== ' ' ? file.x : file.y) });

    const nodes = [el('h3', 'subject', 'Working Changes')];
    nodes.push(section(`Staged Changes (${staged.length})`, staged.length ? [['−', () => wip('unstage'), 'Unstage all']] : []));
    nodes.push(...renderFiles(staged.map(toFile), (file, hideDir) => fileRow(file, {
        hideDir,
        open: () => post({ type: 'openWipFile', file: file.file, oldFile: file.oldFile, staged: true, x: file.x, y: file.y }),
        buttons: [['−', 'Unstage', () => wip('unstage', { files: [file.file] })]],
    })));
    nodes.push(section(`Changes (${unstaged.length})`, unstaged.length ? [['+', () => wip('stage'), 'Stage all'], ['⟲', () => wip('discard'), 'Discard all']] : []));
    nodes.push(...renderFiles(unstaged.map(toFile), (file, hideDir) => fileRow(file, {
        hideDir,
        untracked: file.untracked,
        open: () => post({ type: 'openWipFile', file: file.file, oldFile: file.oldFile, staged: false, x: file.x, y: file.y }),
        buttons: [
            ['+', 'Stage', () => wip('stage', { files: [file.file] })],
            ['⟲', 'Discard', () => wip('discard', { files: [file.file] })],
            ['↗', 'Open file', () => post({ type: 'openOnDisk', file: file.file })],
        ],
    })));

    const box = el('div');
    box.id = 'commitbox';
    const textarea = el('textarea');
    textarea.placeholder = 'Commit message';
    textarea.value = wipMessage;
    textarea.oninput = () => { wipMessage = textarea.value; };
    const amend = el('input');
    amend.type = 'checkbox';
    const amendLabel = el('label');
    amendLabel.append(amend, document.createTextNode(' Amend last commit'));
    const commit = el('button', 'primary', `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}`);
    commit.disabled = staged.length === 0 && !amend.checked;
    amend.onchange = () => { commit.disabled = staged.length === 0 && !amend.checked; };
    commit.onclick = () => {
        post({ type: 'wip', op: 'commit', message: textarea.value.trim(), amend: amend.checked });
        wipMessage = '';
    };
    const row2 = el('div', 'row2');
    row2.append(amendLabel, commit);
    box.append(textarea, row2);
    nodes.push(box);
    pane.replaceChildren(...nodes);
}

/* ---------- wiring ---------- */

$('list').addEventListener('click', event => {
    const row = event.target.closest('.row');
    if (row) {
        select(Number(row.dataset.index), false);
    }
});
$('list').addEventListener('contextmenu', event => {
    const row = event.target.closest('.row');
    if (row) {
        event.preventDefault();
        const index = Number(row.dataset.index);
        select(index, false);
        showCommitMenu(event, data.commits[index]);
    }
});
$('colhdr').addEventListener('contextmenu', event => {
    event.preventDefault();
    showMenu(event, COLUMNS.filter(column => column.id !== 'graph').map(column => [`${ui.cols[column.id] ? '✓' : '   '} ${column.label}`, () => {
        ui.cols[column.id] = !ui.cols[column.id];
        persistUi();
        render();
    }]));
});
document.addEventListener('click', event => {
    if (!event.target.closest('#popover, #filter, #gear')) {
        closeFloating();
    }
});

document.addEventListener('keydown', event => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    if (event.key === 'F3' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g')) {
        event.preventDefault();
        stepMatch(event.shiftKey ? -1 : 1);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        $('search').focus();
        $('search').select();
    } else if (event.key === 'Escape') {
        closeFloating();
    } else if (!inInput && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const current = data.commits.findIndex(commit => commit.sha === selected);
        select(Math.max(0, Math.min(data.commits.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))), true);
    }
});

$('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
});
$('search').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        stepMatch(event.shiftKey ? -1 : 1);
    }
});
for (const [id, flag] of [['optCase', 'matchCase'], ['optRegex', 'regex']]) {
    $(id).addEventListener('click', () => {
        search.flags[flag] = !search.flags[flag];
        $(id).classList.toggle('on', search.flags[flag]);
        runSearch();
    });
}
$('prev').addEventListener('click', event => stepMatch(-1, event.shiftKey));
$('next').addEventListener('click', event => stepMatch(1, event.shiftKey));
$('filter').addEventListener('click', event => { event.stopPropagation(); showPopover($('filter'), buildFilterPopover); });
$('gear').addEventListener('click', event => { event.stopPropagation(); showPopover($('gear'), buildColumnsPopover); });
$('minimapToggle').addEventListener('click', () => { ui.minimap = !ui.minimap; persistUi(); render(); });
$('branch').addEventListener('click', () => post({ type: 'switchBranch' }));
$('fetch').addEventListener('click', () => post({ type: 'fetch' }));
$('pull').addEventListener('click', () => post({ type: 'pull' }));
$('push').addEventListener('click', () => post({ type: 'push' }));

window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'init') {
        data = message;
        stats = {};
        const popover = $('popover');
        render();
        if (popover.style.display === 'block') {
            popover.replaceChildren(...(popover.dataset.anchor === 'filter' ? buildFilterPopover() : buildColumnsPopover()));
        }
        if (search.query) {
            runSearch();
        }
    } else if (message.type === 'stats') {
        stats = message.stats;
        $('list').querySelectorAll('.row').forEach((row, i) => {
            const cell = row.querySelector('.c-changes');
            const commit = data.commits[i];
            if (cell && commit && stats[commit.sha]) {
                cell.replaceChildren(el('span', 'add', `+${stats[commit.sha][0]}`), el('span', 'del', `−${stats[commit.sha][1]}`));
            }
        });
    } else if (message.type === 'details') {
        renderDetails(message);
    } else if (message.type === 'wipDetails') {
        renderWipDetails(message);
    } else if (message.type === 'searchResults') {
        if (message.query === search.query) {
            search = { ...search, local: false, shas: new Set(message.shas), prefixes: message.shaPrefixes };
            computeMatches();
        }
    } else if (message.type === 'setSearch') {
        $('search').value = message.query;
        runSearch();
    }
});

render();
post({ type: 'ready' });
