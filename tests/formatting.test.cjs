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
    const preferences = {plainText: true};
    const strings = {
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
        get_boolean(key) {
            if (key === 'prefer-plain-text') return preferences.plainText;
            if (key === 'debug-logging') return false;
            throw new Error(`Unexpected setting: ${key}`);
        },
    };
    const context = vm.createContext({
        console, TextDecoder,
        ChatGPTClient: class {
            async transform(text, instructions, model) {
                requests.push({model, messages: [{role: 'system', content: instructions}, {role: 'user', content: text}]});
                return response.text;
            }
            destroy() {}
        },
        getApiKey: async () => 'test-key',
        Gio: {Cancellable: class { cancel() {} }},
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
                        candidates: [{content: {parts: [{text}]}, finishReason: 'STOP'}],
                    };
                    return {get_data: () => new TextEncoder().encode(JSON.stringify(data))};
                }
                abort() {}
            },
        },
    });
    vm.runInContext(source, context);
    return {client: new context.AiClient(settings), preferences, strings, response, requests};
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
