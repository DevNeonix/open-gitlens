/**
 * Assigns each commit a lane and computes the line segments to draw in its row.
 * Pure function: no vscode/git imports.
 *
 * Coordinates: x = lane index, y in {0 (row top), 0.5 (commit dot), 1 (row bottom)}.
 *
 * @param {{ sha: string, parents: string[] }[]} commits in log order (children before parents)
 * @returns {{ rows: { lane: number, segments: { x1: number, y1: number, x2: number, y2: number, color: number }[] }[], laneCount: number }}
 */
function layoutGraph(commits) {
    /** lanes[i] = sha that lane i is waiting for, or null when free */
    let lanes = [];
    const colors = [];
    let nextColor = 0;
    let laneCount = 0;

    const freeSlot = (slots) => {
        const index = slots.indexOf(null);
        return index === -1 ? slots.length : index;
    };

    const rows = commits.map(({ sha, parents }) => {
        const before = lanes.slice();
        const beforeColors = colors.slice();
        let lane = lanes.indexOf(sha);
        if (lane === -1) {
            lane = freeSlot(lanes);
            colors[lane] = nextColor++;
        }
        const color = colors[lane];
        const segments = [];

        // Lanes that were waiting for this commit converge into its dot.
        before.forEach((waiting, index) => {
            if (waiting === sha) {
                segments.push({ x1: index, y1: 0, x2: lane, y2: 0.5, color: beforeColors[index] });
            }
        });

        // Lanes that continue past this row.
        const next = before.slice();
        next[lane] = sha;
        next.forEach((waiting, index) => {
            if (waiting === sha) {
                next[index] = null;
            }
        });
        before.forEach((waiting, index) => {
            if (waiting !== null && waiting !== sha) {
                segments.push({ x1: index, y1: 0, x2: index, y2: 1, color: beforeColors[index] });
            }
        });

        // From the dot down to each parent.
        parents.forEach((parent, parentIndex) => {
            let target = next.indexOf(parent);
            if (target === -1) {
                target = parentIndex === 0 ? lane : freeSlot(next);
                next[target] = parent;
                colors[target] = parentIndex === 0 ? color : nextColor++;
            }
            segments.push({ x1: lane, y1: 0.5, x2: target, y2: 1, color: colors[target] });
        });

        lanes = next;
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
            lanes.pop();
        }
        laneCount = Math.max(laneCount, lane + 1, ...segments.map(s => Math.max(s.x1, s.x2) + 1));
        return { lane, color, segments };
    });

    return { rows, laneCount };
}

module.exports = { layoutGraph };
