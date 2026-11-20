// Quote user terms before passing them to SQLite's FTS query parser.
export function lexicalTerms(query) {
    const words = query.match(/[^\s"]+/g) ?? [];
    return [...new Set(words.map((word) => word.toLowerCase()))].slice(0, 64)
        .map((word) => `"${word}"`).join(" OR ");
}

export function fuseRanks(lists) {
    const scores = new Map();
    for (const list of lists) list.forEach(({ rowid }, i) => scores.set(rowid, (scores.get(rowid) ?? 0) + 1 / (60 + i + 1)));
    return [...scores].sort((a, b) => b[1] - a[1]).map(([rowid, score]) => ({ rowid, score }));
}
