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

async function step(name, action) {
    try {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await action();
        results.push([name, 'ok']);
    } catch (error) {
        results.push([name, `${error.message}`.split('\n')[0]]);
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
    await done;
    await sleep(800);
}

exports.run = async function run() {
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

    await step('Show File History opens a commit diff', async () => {
        await openMainFile();
        await drive('openGitLens.showFileHistory', [], [0]);
        assertRevisionDiff('showFileHistory');
    });

    await step('Show Line History opens a commit diff', async () => {
        await openMainFile(1);
        await drive('openGitLens.showLineHistory', [], [0]);
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

    await step('Show File History (path) command used by the graph', async () => {
        await drive('openGitLens.showFileHistoryOf', [fileUri(MAIN_FILE).fsPath], [0]);
        assertRevisionDiff('showFileHistoryOf');
    });

    fs.writeFileSync(process.env.OGL_E2E_RESULTS, JSON.stringify(results));
    const failures = results.filter(([, status]) => status !== 'ok');
    if (failures.length > 0) {
        throw new Error(`${failures.length} e2e step(s) failed`);
    }
};
