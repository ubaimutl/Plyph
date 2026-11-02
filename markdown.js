function escape(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text, depth = 0) {
    if (depth > 6)
        return escape(text);
    let result = '';
    for (let index = 0; index < text.length;) {
        if (text[index] === '\\' && /[\\`*_{}\[\]()#+.!>~-]/.test(text[index + 1] ?? '')) {
            result += escape(text[index + 1]);
            index += 2;
            continue;
        }
        if (text[index] === '`') {
            let length = 1;
            while (text[index + length] === '`') length++;
            const marker = '`'.repeat(length);
            const end = text.indexOf(marker, index + length);
            if (end !== -1) {
                result += `<tt>${escape(text.slice(index + length, end))}</tt>`;
                index = end + length;
                continue;
            }
        }
        const link = (text[index] === '[' || text.startsWith('![', index))
            ? text.slice(index).match(/^(!?)\[([^\]\n]+)\]\(([^\s)]+)\)/) : null;
        if (link) {
            const [, image, label, target] = link;
            result += image ? escape(label) : `${inline(label, depth + 1)} (${escape(target)})`;
            index += link[0].length;
            continue;
        }
        const marker = ['***', '___', '**', '__', '~~', '*', '_'].find(value => text.startsWith(value, index));
        if (marker && !(marker.includes('_') && /[\p{L}\p{N}]/u.test(text[index - 1] ?? ''))) {
            const end = text.indexOf(marker, index + marker.length);
            if (end > index + marker.length) {
                const tags = marker.length === 3 ? ['<b><i>', '</i></b>']
                    : marker === '~~' ? ['<s>', '</s>']
                    : marker.length === 2 ? ['<b>', '</b>'] : ['<i>', '</i>'];
                result += tags[0] + inline(text.slice(index + marker.length, end), depth + 1) + tags[1];
                index = end + marker.length;
                continue;
            }
        }
        result += escape(text[index++]);
    }
    return result;
}

export function markdownMarkup(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fence = line.match(/^ {0,3}(`{3,}|~{3,})[^\n]*$/);
        if (fence) {
            const code = [];
            const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
            while (++index < lines.length && !closing.test(lines[index]))
                code.push(lines[index]);
            output.push(`<tt>${escape(code.join('\n'))}</tt>`);
            continue;
        }
        const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/);
        if (heading) {
            output.push(`<b>${inline(heading[1])}</b>`);
            continue;
        }
        const bullet = line.match(/^(\s*)[-+*]\s+(.+)$/);
        if (bullet) {
            output.push(`${bullet[1]}• ${inline(bullet[2])}`);
            continue;
        }
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            output.push('────────');
            continue;
        }
        output.push(inline(line.replace(/^ {0,3}>\s?/, '│ ')));
    }
    return output.join('\n');
}
