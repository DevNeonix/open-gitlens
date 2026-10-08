const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'devneonix.open-gitlens';
const SLOW = process.env.CI ? 2.5 : 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms * SLOW));
const results = [];
const MAIN_FILE = process.env.OGL_E2E_FILE || 'src/main.txt';
const OTHER_FILE = process.env.OGL_E2E_FILE2 || 'src/login.txt';

const STEP_TIMEOUT_MS = 45_000 * SLOW;

/** Runs one step; a hanging step becomes a named failure instead of blocking the whole run. */
async function step(name, action) {
    let timer;
    console.log(`STEP start: ${name}`);
    try {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await Promise.race([
            action(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`step timed out after ${STEP_TIMEOUT_MS / 1000}s (a quick pick probably stayed open)`)), STEP_TIMEOUT_MS); }),
        ]);
        results.push([name, 'ok']);
        console.log(`STEP ok   : ${name}`);
    } catch (error) {
        results.push([name, `${error.message}`.split('\n')[0]]);
        console.log(`STEP FAIL : ${name} -> ${error.message}`);
    } finally {
        clearTimeout(timer);
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    }
}

const workspaceRoot = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const fileUri = relative => vscode.Uri.file(path.join(workspaceRoot(), relative));
const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

async function openMainFile(line = 0) {
    const document = await vscode.workspace.openTextDocument(fileUri(MAIN_FILE));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    return editor;
}

function assertRevisionDiff(label) {
    const tab = activeTab();
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, `${label}: expected a diff editor, got ${tab?.input?.constructor?.name}`);
    assert.equal(tab.input.original.scheme, 'open-git-lens', `${label}: left side scheme`);
}

/** Runs a command that opens a quick pick, moves down `downs` times and accepts. */
async function drive(commandId, args = [], downsPerPick = [1]) {
    const done = vscode.commands.executeCommand(commandId, ...args);
    for (const downs of downsPerPick) {
        await sleep(1500);
        for (let i = 0; i < downs; i++) {
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
        }
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    await Promise.race([done, sleep(10_000)]);
    await sleep(800);
}

exports.run = async function run() {
    console.log('SUITE start');
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);

    await step('activates without errors', async () => {
        await extension.activate();
        assert.equal(extension.isActive, true);
    });

    await step('every command declared in package.json is registered', async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const missing = extension.packageJSON.contributes.commands.map(command => command.command).filter(id => !registered.has(id));
        assert.deepEqual(missing, [], `missing commands: ${missing.join(', ')}`);
    });

    await step('Compare File with Last Commit', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.compareFileWithPrevious', fileUri(MAIN_FILE));
        await sleep(800);
        assertRevisionDiff('compareFileWithPrevious');
    });

    await step('Open Changes with Previous Revision', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.diffWithPrevious');
        await sleep(800);
        assertRevisionDiff('diffWithPrevious');
    });

    await step('Compare File with Branch, Tag or Commit', async () => {
        await openMainFile();
        await drive('openGitLens.compareFileWithRef', [fileUri(MAIN_FILE)], [1]);
        assertRevisionDiff('compareFileWithRef');
    });

    await step('Compare File Between Two Revisions', async () => {
        await openMainFile();
        await drive('openGitLens.compareFileBetweenRefs', [fileUri(MAIN_FILE)], [1, 2]);
        const tab = activeTab();
        assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'expected a diff editor');
        assert.equal(tab.input.original.scheme, 'open-git-lens');
        assert.equal(tab.input.modified.scheme, 'open-git-lens');
    });

    await step('Open File at Revision', async () => {
        await openMainFile();
        await drive('openGitLens.openFileAtRevision', [fileUri(MAIN_FILE)], [2]);
        const editor = vscode.window.activeTextEditor;
        assert.equal(editor?.document.uri.scheme, 'open-git-lens');
        assert.ok(editor.document.getText().length > 0, 'revision content is empty');
    });

    const modifiedQuery = () => activeTab()?.input?.modified?.query;
    const historyState = () => vscode.commands.executeCommand('openGitLens._fileHistoryState');

    await step('Show File History fills the sidebar and opens the latest change on the right', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.showFileHistory');
        await sleep(2500);
        const state = await historyState();
        assert.ok(state.count >= 2, `expected several commits in the view, got ${state.count}`);
        assert.ok(state.file.endsWith(path.basename(MAIN_FILE)), state.file);
        assertRevisionDiff('showFileHistory');
    });

    await step('Selecting another commit in the history list changes the diff', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.showFileHistory');
        await sleep(2500);
        const first = modifiedQuery();
        assert.ok(first, 'no diff opened');
        const before = await historyState();
        await vscode.commands.executeCommand('openGitLens._fileHistorySelect', 1);
        await sleep(1500);
        const after = await historyState();
        assert.notEqual(modifiedQuery(), first, 'the diff did not change after selecting the next commit');
        assert.ok(after.selectionEvents > before.selectionEvents, 'selection was not registered');
        assert.notEqual(after.selected, before.selected);
    });

    await step('File History follows the active editor', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.showFileHistory');
        await sleep(2000);
        const other = await vscode.workspace.openTextDocument(fileUri(OTHER_FILE));
        await vscode.window.showTextDocument(other);
        await sleep(2500);
        const state = await historyState();
        assert.ok(state.file.endsWith(path.basename(OTHER_FILE)), `view still shows ${state.file}`);
    });

    await step('Pinned File History does not follow the active editor', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.showFileHistory');
        await sleep(1500);
        await vscode.commands.executeCommand('openGitLens.fileHistory.pin');
        const other = await vscode.workspace.openTextDocument(fileUri(OTHER_FILE));
        await vscode.window.showTextDocument(other);
        await sleep(1500);
        const state = await historyState();
        assert.ok(state.file.endsWith(path.basename(MAIN_FILE)), `pinned view moved to ${state.file}`);
        await vscode.commands.executeCommand('openGitLens.fileHistory.unpin');
    });

    await step('Show Line History fills the sidebar for the selected lines', async () => {
        await openMainFile(1);
        await vscode.commands.executeCommand('openGitLens.showLineHistory');
        await sleep(2500);
        const state = await historyState();
        assert.deepEqual(state.range, { start: 2, end: 2 });
        assert.ok(state.count >= 1, 'no commits for the line');
        assertRevisionDiff('showLineHistory');
    });

    await step('Blame Previous Revision opens the parent revision', async () => {
        await openMainFile();
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot(), encoding: 'utf8' }).trim();
        await vscode.commands.executeCommand('openGitLens.blamePreviousRevision', { filePath: fileUri(MAIN_FILE).fsPath, sha, line: 1 });
        await sleep(800);
        assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'open-git-lens');
    });

    await step('Toggle File Blame / Line Blame / CodeLens', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.toggleFileBlame');
        await sleep(500);
        await vscode.commands.executeCommand('openGitLens.toggleFileBlame');
        const config = () => vscode.workspace.getConfiguration('openGitLens');
        const before = config().get('lineBlame.enabled');
        await vscode.commands.executeCommand('openGitLens.toggleLineBlame');
        await sleep(300);
        assert.notEqual(config().get('lineBlame.enabled'), before, 'toggleLineBlame did not change the setting');
        const lens = config().get('codeLens.enabled');
        await vscode.commands.executeCommand('openGitLens.toggleCodeLens');
        await sleep(300);
        assert.notEqual(config().get('codeLens.enabled'), lens, 'toggleCodeLens did not change the setting');
    });

    await step('Show Commit Graph opens a webview', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.showGraph');
        await sleep(2500);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
        assert.ok(tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Commit Graph'), `tabs: ${tabs.map(tab => tab.label).join(', ')}`);
    });

    await step('Compare Working Tree with…', async () => {
        await openMainFile();
        await drive('openGitLens.compareWithRef', [], [1]);
    });

    await step('side bar views open', async () => {
        for (const view of ['branches', 'compare', 'worktrees', 'tags', 'stashes', 'contributors']) {
            await vscode.commands.executeCommand(`openGitLens.${view}.focus`);
        }
    });

    await step('Diagnose and Show Log run without errors', async () => {
        await openMainFile();
        await vscode.commands.executeCommand('openGitLens.diagnose');
        await vscode.commands.executeCommand('openGitLens.showLog');
    });

    await step('Sidebar: Show File History for a file clicked in the Explorer (no editor open)', async () => {
        await vscode.commands.executeCommand('openGitLens.showFileHistory', fileUri(MAIN_FILE));
        await sleep(2500);
        assertRevisionDiff('showFileHistory from explorer');
    });

    await step('Sidebar: Source Control resource context (resourceUri argument)', async () => {
        await vscode.commands.executeCommand('openGitLens.showFileHistory', { resourceUri: fileUri(MAIN_FILE) });
        await sleep(2500);
        assertRevisionDiff('showFileHistory from scm');
    });

    await step('Sidebar: Open Changes with Previous Revision for a clicked file', async () => {
        await vscode.commands.executeCommand('openGitLens.diffWithPrevious', fileUri(MAIN_FILE));
        await sleep(800);
        assertRevisionDiff('diffWithPrevious from explorer');
    });

    await step('Show File History (path) command used by the graph', async () => {
        await vscode.commands.executeCommand('openGitLens.showFileHistoryOf', fileUri(MAIN_FILE).fsPath);
        await sleep(2500);
        assertRevisionDiff('showFileHistoryOf');
    });

    fs.writeFileSync(process.env.OGL_E2E_RESULTS, JSON.stringify(results));
    const failures = results.filter(([, status]) => status !== 'ok');
    if (failures.length > 0) {
        throw new Error(`${failures.length} e2e step(s) failed`);
    }
};
