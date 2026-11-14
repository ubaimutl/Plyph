const {loadProviders} = require('./helpers/modules.cjs');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../ai.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export class AiClient', 'globalThis.AiClient = class AiClient');
const providers = ['ollama', 'cloudflare', 'bai', 'groq', 'gemini', 'openrouter',
    'cerebras', 'openai', 'openai-compatible', 'vercel', 'chatgpt'];

function setup(provider = 'groq') {
    const requests = [];
    const logs = [];
    const preferences = {plainText: true, debugLogging: false};
    const strings = {
        'custom-providers': '[]',
        provider, [`${provider}-model`]: 'test-model',
        'cloudflare-account-id': 'test-account',
        'ollama-url': 'http://localhost:11434',
        'openai-compatible-url': 'http://localhost:1234/v1',
        'prompt-correct': 'Correct the text.', 'prompt-rewrite': 'Rewrite the text.',
        'prompt-run': 'Follow the user request.',
        'variable-language': 'German', 'variable-tone': 'friendly', 'variable-style': 'concise',
    };
    const response = {text: 'Result'};
    const settings = {
        get_string: key => strings[key] ?? '',
        get_int: () => 0,
        get_boolean(key) {
            if (key === 'prefer-plain-text') return preferences.plainText;
            if (key === 'debug-logging') return preferences.debugLogging;
            if (key.endsWith('-use-personal-preferences')) return strings[key] ?? true;
            throw new Error(`Unexpected setting: ${key}`);
        },
    };
    const context = vm.createContext({
        console: {...console, debug: message => logs.push(message)},
        TextDecoder,
        ChatGPTClient: class {
            async transform(text, instructions, model) {
                requests.push({model, messages: [{role: 'system', content: instructions}, {role: 'user', content: text}]});
                return response.text;
            }
            destroy() {}
        },
        getApiKey: async () => 'test-key',
        Gio: {Cancellable: class { cancel() {} is_cancelled() { return false; } }},
        GLib: {Error: class extends Error {}, PRIORITY_DEFAULT: 0, Bytes: class { constructor(value) { this.value = value; } }},
        Soup: {
            Message: {new: (_method, url) => ({
                url, status_code: 200,
                request_headers: {append() {}},
                set_request_body_from_bytes(_type, bytes) { this.body = JSON.parse(bytes.value); },
            })},
            Session: class {
                send_and_read_async(message, _priority, _cancellable, callback) {
                    requests.push(message.body);
                    callback(this, {});
                }
                send_and_read_finish() {
                    const text = response.text;
                    const data = {
                        choices: [{message: {content: text}, finish_reason: 'stop'}],
                        message: {content: text},
                        candidates: [{content: {parts: [{text}]}, finishReason: response.finishReason ?? 'STOP'}],
                        usageMetadata: response.usageMetadata,
                    };
                    return {get_data: () => new TextEncoder().encode(JSON.stringify(data))};
                }
                abort() {}
            },
        },
    });
    loadProviders(context, resolve(__dirname, '..'));
    vm.runInContext(source, context);
    return {client: new context.AiClient(settings), preferences, strings, response, requests, logs};
}

function guidance(body) {
    return body.systemInstruction?.parts[0].text ?? body.messages?.find(item => item.role === 'system')?.content ?? '';
}

function userText(body) {
    return body.contents?.[0].parts[0].text ?? body.messages.find(item => item.role === 'user').content;
}

for (const provider of providers) {
    test(`${provider}: plain text guidance reaches the real request and honors the live toggle`, async () => {
        const {client, preferences, requests} = setup(provider);
        const selection = 'Please correct this sentence.';
        await client.transform(selection, 'correct');
        const enabled = guidance(requests[0]);
        assert.ok(enabled.startsWith('Correct the text.\n\n'));
        assert.match(enabled, /Use plain text by default/);
        assert.match(enabled, /request or action instructions explicitly ask for Markdown/);
        assert.match(enabled, /source text being transformed already contains Markdown/);
        assert.match(enabled, /preserve its formatting unless asked to change it/);
        assert.match(enabled, /code, JSON, or HTML.*takes precedence/);
        assert.equal(userText(requests[0]), `Transform only the text inside the tags.\nReturn only the transformed text.\n<text>\n${selection}\n</text>`);
        preferences.plainText = false;
        await client.transform(selection, 'correct');
        assert.equal(guidance(requests[1]), 'Correct the text.');
        preferences.plainText = true;
        await client.transform(selection, 'correct');
        assert.equal(guidance(requests[2]), enabled, 'Guidance must not accumulate between requests');
        client.destroy();
    });

    test(`${provider}: existing Markdown and code fences survive response cleanup`, async () => {
        const {client, response, requests} = setup(provider);
        for (const markdown of ['```\nexample\n```', '```text\nexample\n```', '```js\nconst a = 1;\n```', '# Title\n\n**Bold** and [link](https://example.com)']) {
            response.text = `<text>\n${markdown}\n</text>`;
            assert.equal(await client.transform(markdown, 'rewrite'), markdown);
            assert.ok(userText(requests.at(-1)).includes(markdown), 'Source formatting must remain intact');
        }
        client.destroy();
    });
}

for (const [mode, inputMode] of [['correct', 'transform'], ['rewrite', 'transform'],
    ['custom', 'transform'], ['custom', 'prompt'], ['prompt', 'prompt'], ['ask', 'prompt']]) {
    test(`${mode}/${inputMode}: shared guidance preserves explicit instructions and prompt variables`, async () => {
        const {client, requests, response} = setup();
        const request = 'Return a Markdown table in German.';
        const custom = 'Use ${language}; ${tone}; ${style}. Return Markdown.';
        response.text = '| Name | Value |\n| --- | --- |\n| A | 1 |';
        assert.equal(await client.transform(request, mode, custom, {inputMode}), response.text);
        assert.ok(guidance(requests[0]).startsWith('Use German; friendly; concise. Return Markdown.\n\n'));
        assert.match(guidance(requests[0]), /explicitly ask for Markdown/);
        if (inputMode === 'prompt') assert.equal(userText(requests[0]), request);
        else assert.ok(userText(requests[0]).includes(`<text>\n${request}\n</text>`));
        client.destroy();
    });
}

test('empty custom guidance still gets the rule, and stays empty when disabled', async () => {
    const {client, requests, preferences} = setup();
    await client.transform('Hello', 'custom', '', {inputMode: 'prompt'});
    assert.ok(guidance(requests[0]).startsWith('Output formatting:'));
    preferences.plainText = false;
    await client.transform('Hello', 'custom', '', {inputMode: 'prompt'});
    assert.equal(guidance(requests[1]), '');
    assert.equal(requests[1].messages.length, 1);
    client.destroy();
});

test('provider override gets the rule and preserves requested structured output', async () => {
    const {client, requests, response, preferences} = setup();
    for (const plainText of [true, false]) {
        preferences.plainText = plainText;
        response.text = '{"ok":true}';
        assert.equal(await client.transform('Return JSON.', 'prompt', null, {
            provider: 'gemini', model: 'override-model',
        }), '{"ok":true}');
        assert.equal(userText(requests.at(-1)), 'Return JSON.');
        assert.equal(guidance(requests.at(-1)).includes('Use plain text by default'), plainText);
    }
    client.destroy();
});


test('ChatGPT accepts Auto limits and rejects explicit unsupported output limits before requesting', async () => {
    const {client, requests} = setup('chatgpt');
    await client.transform('Hello', 'prompt', null, {outputLimit: 0});
    assert.equal(requests.length, 1);
    await assert.rejects(client.transform('Hello', 'custom', null, {outputLimit: 1000}), /Auto/);
    assert.equal(requests.length, 1);
    client.destroy();
});

for (const provider of providers) {
    test(`${provider}: personalization is optional, respects action opt-out and keeps source intact`, async () => {
        const {client, strings, preferences, requests} = setup(provider);
        preferences.plainText = false;
        await client.transform('Source text', 'correct');
        assert.equal(guidance(requests.at(-1)), 'Correct the text.', 'Empty preferences preserve existing requests');
        strings['personal-preferences'] = 'I use Linux and Python. Keep ${selection} literal.';
        await client.transform('Source text', 'correct');
        assert.ok(guidance(requests.at(-1)).includes(strings['personal-preferences']));
        assert.match(guidance(requests.at(-1)), /Explicit action instructions and user requests take priority/);
        assert.match(guidance(requests.at(-1)), /Preserve meaning, facts, code and required output formats/);
        assert.ok(guidance(requests.at(-1)).endsWith('Action instructions:\nCorrect the text.'));
        const source = userText(requests.at(-1));
        assert.ok(source.includes('Source text'));
        assert.ok(!source.includes('I use Linux'));
        assert.match(guidance(requests.at(-1)), /ignore unrelated details/);
        assert.doesNotMatch(guidance(requests.at(-1)), /writing preferences|relevant to prose/);
        await client.transform('Source text', 'correct', null, {usePersonalPreferences: false});
        assert.equal(guidance(requests.at(-1)), 'Correct the text.');
        strings['personal-preferences'] = '   ';
        await client.transform('Source text', 'rewrite');
        assert.equal(guidance(requests.at(-1)), 'Rewrite the text.');
        client.destroy();
    });
}

for (const provider of providers) {
    test(`${provider}: personal context applies to every action mode by default and opt-outs win`, async () => {
        const {client, strings, requests, preferences} = setup(provider);
        strings['personal-preferences'] = 'I use Linux and Python.';
        preferences.plainText = false;
        for (const [mode, inputMode] of [['correct', 'transform'], ['rewrite', 'transform'],
            ['ask', 'prompt'], ['prompt', 'prompt'], ['custom', 'transform'], ['custom', 'prompt']]) {
            await client.transform('Return JSON', mode, 'Return only JSON.', {inputMode});
            assert.match(guidance(requests.at(-1)), /I use Linux and Python/);
            assert.ok(guidance(requests.at(-1)).endsWith('Return only JSON.'));
            await client.transform('Return JSON', mode, 'Return only JSON.', {inputMode, usePersonalPreferences: false});
            assert.equal(guidance(requests.at(-1)), 'Return only JSON.');
            if (mode !== 'custom') {
                strings[`${mode}-use-personal-preferences`] = false;
                await client.transform('Return JSON', mode, 'Return only JSON.', {inputMode});
                assert.equal(guidance(requests.at(-1)), 'Return only JSON.');
            }
        }
        client.destroy();
    });
}

test('legacy custom actions keep working and personalization opt-outs survive saving', () => {
    const context = vm.createContext({});
    vm.runInContext(readFileSync(resolve(__dirname, '../actions.js'), 'utf8').replace(/^export /gm, ''), context);
    let stored = JSON.stringify([
        {id: 'writing', name: 'Writing', prompt: 'Rewrite'},
        {id: 'code', name: 'Code', prompt: 'Fix code', usePersonalPreferences: false},
        {id: 'prompt', name: 'Prompt', prompt: '', inputMode: 'prompt'},
    ]);
    const settings = {get_string: () => stored, set_string: (_key, value) => { stored = value; }};
    const actions = context.readActions(settings);
    assert.deepEqual(Array.from(actions, item => item.usePersonalPreferences), [true, false, true]);
    context.writeActions(settings, actions);
    assert.deepEqual(Array.from(context.readActions(settings), item => item.usePersonalPreferences), [true, false, true]);
});

const geminiAutoCases = [
    ['correct', {}],
    ['rewrite', {}],
    ['custom', {inputMode: 'transform'}],
    ['custom', {inputMode: 'prompt'}],
    ['custom', {inputMode: 'transform', outputLimit: 'auto'}],
    ['custom', {inputMode: 'transform', outputLimit: -1}],
    ['prompt', {outputLimit: 0}],
    ['ask', {inputMode: 'prompt'}],
];

for (const [mode, options] of geminiAutoCases) {
    test(`gemini ${mode} ${JSON.stringify(options)}: Auto leaves the output limit to the model`, async () => {
        const {client, requests} = setup('gemini');
        for (const selection of ['a'.repeat(300), 'a'.repeat(1758), 'ა'.repeat(4000)]) {
            await client.transform(selection, mode, null, options);
            assert.equal(requests.at(-1).generationConfig, undefined);
        }
        client.destroy();
    });
}

test('gemini: an explicit output limit is sent unchanged, including 2000 in prompt mode', async () => {
    const {client, requests} = setup('gemini');
    for (const [mode, options, expected] of [
        ['custom', {inputMode: 'transform', outputLimit: 4000}, 4000],
        ['custom', {inputMode: 'prompt', outputLimit: 2000}, 2000],
        ['prompt', {outputLimit: 4000}, 4000],
        ['prompt', {outputLimit: 2000}, 2000],
    ]) {
        await client.transform('a'.repeat(300), mode, null, options);
        assert.equal(requests.at(-1).generationConfig.maxOutputTokens, expected);
        assert.equal(Object.keys(requests.at(-1).generationConfig).length, 1);
    }
    client.destroy();
});

test('other providers keep their automatic output limit', async () => {
    for (const provider of ['groq', 'cloudflare']) {
        const {client, requests} = setup(provider);
        await client.transform('a'.repeat(300), 'rewrite');
        assert.equal(requests.at(-1).max_tokens, 1000);
        await client.transform('a'.repeat(8000), 'rewrite');
        assert.equal(requests.at(-1).max_tokens, 2000);
        await client.transform('a'.repeat(300), 'ask', null, {inputMode: 'prompt'});
        assert.equal(requests.at(-1).max_tokens, 2000);
        client.destroy();
    }
    const {client, requests} = setup('ollama');
    await client.transform('a'.repeat(300), 'rewrite');
    assert.equal(requests.at(-1).options, undefined);
    await client.transform('a'.repeat(300), 'ask', null, {inputMode: 'prompt'});
    assert.equal(requests.at(-1).options.num_predict, 2000);
    client.destroy();
});

test('the automatic limit follows the provider an action resolves to', async () => {
    const groqActive = setup('groq');
    await groqActive.client.transform('a'.repeat(300), 'custom', null,
        {provider: 'gemini', model: 'override-model'});
    assert.equal(groqActive.requests.at(-1).generationConfig, undefined);
    groqActive.client.destroy();
    const geminiActive = setup('gemini');
    await geminiActive.client.transform('a'.repeat(300), 'custom', null,
        {provider: 'groq', model: 'override-model'});
    assert.equal(geminiActive.requests.at(-1).max_tokens, 1000);
    geminiActive.client.destroy();
});

test('diagnostics report the output limit that is actually sent', async () => {
    const requestLine = logs => logs.filter(line => line.includes('AI request:')).at(-1);
    const gemini = setup('gemini');
    gemini.preferences.debugLogging = true;
    await gemini.client.transform('a'.repeat(300), 'rewrite');
    assert.match(requestLine(gemini.logs), /output-limit=model default$/);
    await gemini.client.transform('a'.repeat(300), 'ask', null, {inputMode: 'prompt'});
    assert.match(requestLine(gemini.logs), /output-limit=model default$/);
    await gemini.client.transform('a'.repeat(300), 'custom', null, {outputLimit: 4000});
    assert.match(requestLine(gemini.logs), /output-limit=4000$/);
    gemini.client.destroy();
    const groq = setup('groq');
    groq.preferences.debugLogging = true;
    await groq.client.transform('a'.repeat(300), 'rewrite');
    assert.match(requestLine(groq.logs), /output-limit=1000$/);
    groq.client.destroy();
});

test('gemini: an explicit limit spent on thinking says so', async () => {
    const {client, response} = setup('gemini');
    response.finishReason = 'MAX_TOKENS';
    response.usageMetadata = {thoughtsTokenCount: 959, candidatesTokenCount: 37};
    await assert.rejects(client.transform('a'.repeat(300), 'custom', null, {outputLimit: 1000}),
        /^Error: Response reached this action’s output limit, and the model used 959 tokens of it for thinking\. Raise the limit or set it to Auto\.$/);
    client.destroy();
});

test('gemini: every other output limit failure keeps the existing message', async () => {
    const existing = /Response reached the output limit\. Try a custom action with a higher output limit, or select less text\.$/;
    for (const [usageMetadata, options] of [
        [undefined, {outputLimit: 1000}],
        [{candidatesTokenCount: 1000}, {outputLimit: 1000}],
        [{thoughtsTokenCount: 0, candidatesTokenCount: 1000}, {outputLimit: 1000}],
        [{thoughtsTokenCount: 4585, candidatesTokenCount: 60951}, {}],
    ]) {
        const {client, response} = setup('gemini');
        response.finishReason = 'MAX_TOKENS';
        response.usageMetadata = usageMetadata;
        await assert.rejects(client.transform('a'.repeat(300), 'custom', null, options), existing);
        client.destroy();
    }
});
