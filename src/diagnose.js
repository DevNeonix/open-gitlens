const path = require('node:path');
const vscode = require('vscode');

const git = require('./git');
const { fileEditor, getOutput, guarded, log } = require('./repo');

const SAMPLE_LIMIT = 5;

async function timed(label, task) {
    const started = Date.now();
    try {
        const output = await task();
        const lines = String(output).trim().split('\n').filter(Boolean);
        log(`  OK    ${Date.now() - started}ms  ${label}${lines.length ? `  ->  ${lines[0].slice(0, 100)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}` : ''}`);
    } catch (error) {
        log(`  FAIL  ${Date.now() - started}ms  ${label}  ->  ${error.message}`);
    }
}

/** Writes an environment and git health report for the active file to the output channel. */
async function diagnose() {
    const editor = fileEditor();
    const output = getOutput();
    output.show(true);
    const extension = vscode.extensions.getExtension('devneonix.open-gitlens');
    log('=== Open GitLens diagnostics ===');
    log(`platform: ${process.platform} ${process.arch} | VS Code ${vscode.version} | extension ${extension?.packageJSON.version}`);
    log(`git executable used: ${git.getGitPath()}  (setting git.path = ${JSON.stringify(vscode.workspace.getConfiguration('git').get('path'))})`);
    log(`PATH (first entries): ${(process.env.PATH ?? '').split(path.delimiter).slice(0, 4).join('  |  ')}`);

    const finder = process.platform === 'win32' ? 'where' : 'which';
    await timed(`${finder} git`, () => git.runProcess(finder, ['git'], { env: process.env, timeout: 10_000, label: `${finder} git` }));
    await timed('git --version', () => git.exec(process.cwd(), ['--version']));

    if (!editor) {
        log('Open a file from your repository and run this command again to test file history.');
        return;
    }
    const filePath = editor.document.uri.fsPath;
    const directory = path.dirname(filePath);
    const name = path.basename(filePath);
    log(`active file: ${filePath}`);
    await timed('rev-parse --show-toplevel', () => git.exec(directory, ['rev-parse', '--show-toplevel']));
    await timed('rev-parse --show-prefix', () => git.exec(directory, ['rev-parse', '--show-prefix']));
    await timed(`log --follow -n ${SAMPLE_LIMIT} -- ${name}`, () => git.exec(directory, ['log', '--follow', '-n', String(SAMPLE_LIMIT), '--format=%h %s', '--', name]));
    await timed(`log -L 1,3:${name}`, () => git.exec(directory, ['log', '-L', `1,3:${name}`, '--no-patch', '-n', String(SAMPLE_LIMIT), '--format=%h %s']));
    await timed(`blame ${name}`, () => git.exec(directory, ['blame', '--porcelain', '-L', '1,1', '--', name]));
    log('=== end of diagnostics ===');
}

function register(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('openGitLens.diagnose', () => guarded(diagnose)),
        vscode.commands.registerCommand('openGitLens.showLog', () => getOutput().show(true)),
    );
}

module.exports = { register };
