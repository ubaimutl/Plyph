function tokens(text) {
    return text.match(/[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu) ?? [];
}

export function diffText(original, result) {
    const before = tokens(original);
    const after = tokens(result);
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
        start++;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--;
        endAfter--;
    }
    const parts = [];
    const append = (type, text) => {
        if (!text) return;
        if (parts.at(-1)?.type === type)
            parts.at(-1).text += text;
        else
            parts.push({type, text});
    };
    append('equal', before.slice(0, start).join(''));
    const rows = endBefore - start;
    const columns = endAfter - start;
    if ((rows + 1) * (columns + 1) > 1000000) {
        append('removed', before.slice(start, endBefore).join(''));
        append('added', after.slice(start, endAfter).join(''));
    } else {
        const stride = columns + 1;
        const lengths = new Uint32Array((rows + 1) * stride);
        for (let i = rows - 1; i >= 0; i--) {
            for (let j = columns - 1; j >= 0; j--) {
                lengths[i * stride + j] = before[start + i] === after[start + j]
                    ? lengths[(i + 1) * stride + j + 1] + 1
                    : Math.max(lengths[(i + 1) * stride + j], lengths[i * stride + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < rows || j < columns) {
            if (i < rows && j < columns && before[start + i] === after[start + j]) {
                append('equal', before[start + i++]);
                j++;
            } else if (i < rows && (j === columns || lengths[(i + 1) * stride + j] >= lengths[i * stride + j + 1])) {
                append('removed', before[start + i++]);
            } else {
                append('added', after[start + j++]);
            }
        }
    }
    append('equal', before.slice(endBefore).join(''));
    return parts;
}

export function diffMarkup(original, result) {
    return diffText(original, result).map(({type, text}) => {
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (type === 'added')
            return `<span foreground="#b9f6ca" background="#19452b" underline="single">${escaped}</span>`;
        if (type === 'removed')
            return `<span foreground="#ffcdd2" background="#58252b" strikethrough="true">${escaped}</span>`;
        return escaped;
    }).join('');
}
