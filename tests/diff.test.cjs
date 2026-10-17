const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(readFileSync(resolve(__dirname, '../diff.js'), 'utf8').replace(/^export /gm, '') +
    '\nglobalThis.diff = {diffText, diffMarkup};', context);
const {diffText, diffMarkup} = context.diff;

for (const [name, before, after] of [
    ['unchanged', 'Hello world.', 'Hello world.'],
    ['replacement', 'The cat sleeps.', 'The dog sleeps.'],
    ['insertion', '', 'New text'],
    ['deletion', 'Old text', ''],
    ['whitespace', 'one\r\ntwo  three\t', 'one\ntwo three\t\n'],
    ['unicode', 'Grüße 👩🏽‍💻 日本語 e\u0301', 'Grüße 🌍 日本語 é'],
    ['repeated words', 'one two one two', 'two one two one'],
    ['large rewrite', 'old '.repeat(2000), 'new '.repeat(2000)],
]) {
    test(`diff preserves exact source and result for ${name}`, () => {
        const parts = diffText(before, after);
        assert.equal(parts.filter(part => part.type !== 'added').map(part => part.text).join(''), before);
        assert.equal(parts.filter(part => part.type !== 'removed').map(part => part.text).join(''), after);
    });
}

test('word diff isolates the changed word and preserves surrounding text', () => {
    assert.equal(JSON.stringify(diffText('The cat sleeps.', 'The dog sleeps.')), JSON.stringify([
        {type: 'equal', text: 'The '}, {type: 'removed', text: 'cat'},
        {type: 'added', text: 'dog'}, {type: 'equal', text: ' sleeps.'},
    ]));
});

test('diff escapes user markup and distinguishes changes without color alone', () => {
    const markup = diffMarkup('<b>&old</b>', '<b>&new</b>');
    assert.ok(!markup.includes('<b>'));
    assert.match(markup, /&lt;b&gt;&amp;/);
    assert.match(markup, /strikethrough="true">old/);
    assert.match(markup, /underline="single">new/);
});
