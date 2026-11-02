const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(readFileSync(resolve(__dirname, '../markdown.js'), 'utf8').replace(/^export /gm, ''), context);
const render = context.markdownMarkup;

test('discussion renders headings, emphasis and lists without raw markers', () => {
    assert.equal(render('# Summary\n\n- **Personal context**: shared background\n- *Actions*: specific instructions\n\n1. Do the task.'),
        '<b>Summary</b>\n\n• <b>Personal context</b>: shared background\n• <i>Actions</i>: specific instructions\n\n1. Do the task.');
    assert.equal(render('***Important*** and ~~old~~'), '<b><i>Important</i></b> and <s>old</s>');
});

test('code remains literal, including XML characters and Markdown syntax', () => {
    assert.equal(render('Use `some_name` and ``a ` b``.'), 'Use <tt>some_name</tt> and <tt>a ` b</tt>.');
    assert.equal(render('```python\nif a < b:\n    print("**hello** & world")\n```'),
        '<tt>if a &lt; b:\n    print("**hello** &amp; world")</tt>');
    assert.equal(render('~~~\n__raw__\n~~~'), '<tt>__raw__</tt>');
    assert.equal(render('```\nunclosed <code>'), '<tt>unclosed &lt;code&gt;</tt>');
});

test('untrusted HTML and links cannot inject Pango markup or load resources', () => {
    assert.equal(render('<span foreground="red">Oops</span> & <img src=x>'),
        '&lt;span foreground="red"&gt;Oops&lt;/span&gt; &amp; &lt;img src=x&gt;');
    assert.equal(render('[Docs](https://example.com/?a=1&b=2)'), 'Docs (https://example.com/?a=1&amp;b=2)');
    assert.equal(render('![image](https://example.com/photo.png)'), 'image');
    assert.equal(render('[unsafe](javascript:alert)'), 'unsafe (javascript:alert)');
});

test('plain text, escaped markers and identifiers stay readable', () => {
    assert.equal(render('some_variable and /tmp/my_file.py\n\nHello 🌍'), 'some_variable and /tmp/my_file.py\n\nHello 🌍');
    assert.equal(render('\\*literal\\* and **unfinished'), '*literal* and **unfinished');
    assert.equal(render('> A quote\n\n---'), '│ A quote\n\n────────');
});
