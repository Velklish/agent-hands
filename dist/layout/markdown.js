import path from 'node:path';
import { readFileSync } from 'node:fs';
const FENCE_BLOCK = /^ {0,3}((`|~)\2{2,})[^\n]*$[\s\S]*?^ {0,3}\1\2*[^\n]*$/gm;
function blankFences(text) {
    return text.replace(FENCE_BLOCK, (m) => m.replace(/[^\n]/g, ' '));
}
const CODE_SPAN = /(`+)(?:(?!\1)[^\n])+\1/g;
function blankSpans(text) {
    return text.replace(CODE_SPAN, (m) => m.replace(/[^\n]/g, ' '));
}
const INLINE_LINK = /\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const REF_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/;
function refDefinitions(text) {
    const out = [];
    let canStart = true;
    for (const line of text.split('\n')) {
        const m = canStart ? REF_DEFINITION.exec(line) : null;
        if (m)
            out.push(m[1] ?? m[2]);
        canStart = Boolean(m) || !line.trim();
    }
    return out;
}
export function relativeLinks(file) {
    const text = blankSpans(blankFences(readFileSync(file, 'utf8')));
    const hrefs = [...text.matchAll(INLINE_LINK)].map((m) => m[1] ?? m[2]);
    hrefs.push(...refDefinitions(text));
    return hrefs.filter((href) => href && !/^(https?:|mailto:|#)/.test(href));
}
export function brokenLinks(file, shipped) {
    return relativeLinks(file).filter(href => !shipped.has(path.resolve(path.dirname(file), href.split('#')[0])));
}
