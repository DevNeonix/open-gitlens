const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const { createFixtureRepo, isolateGitEnv, removeDir } = require('../unit/helpers');

async function main() {
    // OGL_E2E_WORKSPACE lets you run the same checks against a real repository (read-only checks).
    const customWorkspace = process.env.OGL_E2E_WORKSPACE;
    if (!customWorkspace) {
        isolateGitEnv();
    }
    const repo = customWorkspace || createFixtureRepo();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ogl-vscode-'));
    const resultsFile = path.join(scratch, 'results.json');
    process.env.OGL_E2E_RESULTS = resultsFile;

    const launchArgs = [
        repo,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        '--user-data-dir', path.join(scratch, 'user-data'),
        '--extensions-dir', path.join(scratch, 'extensions'),
    ];
    if (process.platform === 'linux') {
        launchArgs.push('--no-sandbox', '--disable-gpu');
    }

    let failed = false;
    try {
        await runTests({
            extensionDevelopmentPath: path.resolve(__dirname, '../..'),
            extensionTestsPath: path.resolve(__dirname, 'suite.js'),
            vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
            version: process.env.VSCODE_VERSION || 'stable',
            launchArgs,
        });
    } catch (error) {
        failed = true;
        console.error(`VS Code run failed: ${error.message}`);
    }

    if (fs.existsSync(resultsFile)) {
        const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        console.log('\n=== Open GitLens e2e (real VS Code) ===');
        for (const [name, status] of results) {
            console.log(`${status === 'ok' ? 'PASS' : 'FAIL'}  ${name}${status === 'ok' ? '' : `\n      ${status}`}`);
        }
        failed = failed || results.some(([, status]) => status !== 'ok');
    } else {
        console.error('No results file was written: the suite did not run.');
        failed = true;
    }
    removeDir(scratch);
    if (!customWorkspace) {
        removeDir(repo);
    }
    process.exit(failed ? 1 : 0);
}

main();
