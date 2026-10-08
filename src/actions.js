const vscode = require('vscode');

const git = require('./git');
const { runAction, confirm } = require('./repo');

const BRANCH_NAME = /^(?!-)[^\s~^:?*[\\]+$/;

function askName(prompt, placeHolder) {
    return vscode.window.showInputBox({
        prompt,
        placeHolder,
        validateInput: value => (BRANCH_NAME.test(value) ? undefined : 'Invalid name'),
    });
}

const actions = {
    async checkout(root, ref) {
        return runAction(root, `checkout ${ref}`, ['checkout', ref]);
    },

    async checkoutCommit(root, sha, localBranches) {
        const detached = { label: '$(git-commit) Detached HEAD', description: sha.slice(0, 8) };
        const picked = localBranches.length === 0
            ? detached
            : await vscode.window.showQuickPick(
                [...localBranches.map(name => ({ label: `$(git-branch) ${name}`, ref: name })), detached],
                { placeHolder: 'Checkout' },
            );
        if (picked) {
            return actions.checkout(root, picked.ref ?? sha);
        }
    },

    async createBranch(root, startPoint) {
        const name = await askName(`New branch from ${startPoint.slice(0, 12)}`, 'feature/my-branch');
        if (name) {
            return runAction(root, `create branch ${name}`, ['switch', '-c', name, startPoint]);
        }
    },

    async deleteBranch(root, branch) {
        if (branch.remote) {
            const [remote, ...rest] = branch.name.split('/');
            if (await confirm(`Delete remote branch ${branch.name}? This pushes a deletion to ${remote}.`, 'Delete remote branch')) {
                return runAction(root, `delete ${branch.name}`, ['push', remote, '--delete', rest.join('/')]);
            }
            return;
        }
        if (await confirm(`Delete local branch ${branch.name}?`, 'Delete')) {
            const result = await runAction(root, `delete ${branch.name}`, ['branch', '-d', branch.name]);
            if (result === undefined && await confirm(`${branch.name} is not fully merged. Force delete?`, 'Force delete')) {
                return runAction(root, `force delete ${branch.name}`, ['branch', '-D', branch.name]);
            }
        }
    },

    async createTag(root, target) {
        const name = await askName(`New tag at ${target.slice(0, 12)}`, 'v1.0.0');
        if (name) {
            return runAction(root, `create tag ${name}`, ['tag', name, target]);
        }
    },

    async deleteTag(root, name) {
        if (await confirm(`Delete tag ${name}?`, 'Delete')) {
            return runAction(root, `delete tag ${name}`, ['tag', '-d', name]);
        }
    },

    cherryPick(root, sha) {
        return runAction(root, `cherry-pick ${sha.slice(0, 8)}`, ['cherry-pick', sha]);
    },

    revert(root, sha) {
        return runAction(root, `revert ${sha.slice(0, 8)}`, ['revert', '--no-edit', sha]);
    },

    async reset(root, sha) {
        const mode = await vscode.window.showQuickPick(
            [
                { label: 'Soft', description: 'Keep changes staged', mode: '--soft' },
                { label: 'Mixed', description: 'Keep changes unstaged', mode: '--mixed' },
                { label: 'Hard', description: 'Discard all changes', mode: '--hard' },
            ],
            { placeHolder: `Reset current branch to ${sha.slice(0, 8)}` },
        );
        if (!mode) {
            return;
        }
        if (mode.mode === '--hard' && !(await confirm(`Hard reset to ${sha.slice(0, 8)}? Uncommitted changes will be lost.`, 'Hard reset'))) {
            return;
        }
        return runAction(root, `reset ${mode.label.toLowerCase()} ${sha.slice(0, 8)}`, ['reset', mode.mode, sha]);
    },

    async stashPush(root) {
        const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
        if (message === undefined) {
            return;
        }
        const args = ['stash', 'push', '--include-untracked'];
        if (message) {
            args.push('-m', message);
        }
        return runAction(root, 'stash changes', args);
    },

    stashApply(root, ref) {
        return runAction(root, `apply ${ref}`, ['stash', 'apply', ref]);
    },

    stashPop(root, ref) {
        return runAction(root, `pop ${ref}`, ['stash', 'pop', ref]);
    },

    async stashDrop(root, ref) {
        if (await confirm(`Drop ${ref}? This cannot be undone.`, 'Drop')) {
            return runAction(root, `drop ${ref}`, ['stash', 'drop', ref]);
        }
    },

    fetch(root) {
        return runAction(root, 'fetch all', ['fetch', '--all', '--prune']);
    },

    async localBranchesAt(root, sha) {
        return (await git.listBranches(root)).filter(branch => !branch.remote && branch.sha === sha).map(branch => branch.name);
    },
};

module.exports = actions;
