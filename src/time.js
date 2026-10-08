const vscode = require('vscode');

const TIME_UNITS = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

const relativeTime = new Intl.RelativeTimeFormat(vscode.env.language, { numeric: 'auto' });

function fromNow(date) {
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    for (const [unit, size] of TIME_UNITS) {
        if (Math.abs(seconds) >= size) {
            return relativeTime.format(Math.round(seconds / size), unit);
        }
    }
    return relativeTime.format(seconds, 'second');
}

module.exports = { fromNow };
