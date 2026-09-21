const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');

function setup(values = {}) {
    const valuesByKey = {'provider': 'openai-compatible', 'openai-compatible-url': 'http://localhost:8000/v1/',
        'openai-compatible-model': 'local/model', ...values};
    const settings = {get_string: key => valuesByKey[key] ?? '', get_boolean: key => !!valuesByKey[key]};
    const requests = [];
    let lookups = 0;
    let key = 'secret';
    let reply = {choices: [{message: {content: 'Answer'}, finish_reason: 'stop'}]};
    let status = 200;
    let pending = [];
    let hold = false;
    class Cancellable {cancel() { this.cancelled = true; } is_cancelled() { return !!this.cancelled; }}
    class Session {
        send_and_read_async(message, _priority, cancellable, callback) {
            requests.push(message);
            const run = () => {
                message.status_code = status;
                callback(this, {cancellable, reply});
            };
            if (hold) pending.push(run); else queueMicrotask(run);
        }
        send_and_read_finish(result) {
            if (result.cancellable?.is_cancelled()) throw new Error('Request cancelled');
            return {get_data: () => new TextEncoder().encode(JSON.stringify(result.reply))};
        }
        abort() {}
    }
    const context = vm.createContext({TextDecoder, console,
        getApiKey: async () => { lookups++; return key; },
        Gio: {Cancellable},
        GLib: {Error: class extends Error {}, PRIORITY_DEFAULT: 0, Bytes: class {constructor(value) {this.value = value;}},
            UriFlags: {NONE: 0}, Uri: {parse: value => {
                const url = new URL(value);
                return {get_scheme: () => url.protocol.slice(0, -1), get_host: () => url.hostname,
                    get_userinfo: () => value.includes('@') ? url.username : null,
                    get_query: () => value.includes('?') ? url.search : null,
                    get_fragment: () => value.includes('#') ? url.hash : null};
            }}},
        Soup: {Session, Message: {new: (method, url) => ({method, url, headers: {},
            get request_headers() { return {append: (name, value) => {this.headers[name] = value;}}; },
            set_request_body_from_bytes(_type, bytes) { this.body = JSON.parse(bytes.value); },
        })}},
    });
    for (const file of ['models.js', 'ai.js']) {
        let source = readFileSync(`${__dirname}/../${file}`, 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
        if (file === 'ai.js') source += '\nglobalThis.AiClient = AiClient;';
        vm.runInContext(source, context);
    }
    return {settings, requests, context, valuesByKey, client: new context.AiClient(settings),
        lookups: () => lookups, setKey: value => {key = value;},
        respond: (data, code = 200) => {reply = data; status = code;},
        hold: () => {hold = true;}, flush: () => {pending.splice(0).forEach(run => run());}};
}

test('normalizes endpoint paths and validates base URLs before network access', () => {
    const env = setup();
    for (const base of ['http://host:8000/v1///', 'https://host/prefix/v1/', 'http://[::1]:8000/v1']) {
        env.valuesByKey['openai-compatible-url'] = base;
        assert.equal(env.context.compatibleEndpoint(env.settings, 'models'), `${base.replace(/\/+$/, '')}/models`);
    }
    for (const base of ['', 'ftp://host/v1', 'http://user:pass@host/v1', 'http://host/v1?', 'http://host/v1#', 'bad url']) {
        env.valuesByKey['openai-compatible-url'] = base;
        assert.throws(() => env.context.compatibleEndpoint(env.settings, 'models'), /valid HTTP/);
    }
});

test('unauthenticated prompt uses non-streaming chat without keyring access', async () => {
    const env = setup();
    assert.equal(await env.client.transform('Exact selection', 'prompt', '', {outputLimit: 420}), 'Answer');
    const request = env.requests[0];
    assert.equal(request.url, 'http://localhost:8000/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.body.messages[0].content, 'Exact selection');
    assert.equal(request.body.max_tokens, 420);
    assert.equal(request.body.stream, false);
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(env.lookups(), 0);
});

test('authentication requires a key and sends Bearer on both endpoints', async () => {
    const env = setup({'openai-compatible-auth': true});
    env.setKey('');
    await assert.rejects(env.client.transform('x', 'correct'), /Add an API key/);
    assert.equal(env.requests.length, 0);
    env.setKey('secret');
    await env.client.transform('x', 'correct');
    env.respond({data: [{id: 'any/custom-model'}, {id: 'any/custom-model'}, {id: null}]});
    const models = await env.context.fetchModels(env.settings, 'openai-compatible');
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'any/custom-model');
    assert.ok(env.requests.every(request => request.headers.Authorization === 'Bearer secret'));
});

test('manual model and action overrides work without discovery', async () => {
    const env = setup({provider: 'openai'});
    await env.client.transform('x', 'custom', 'Rewrite', {provider: 'openai-compatible', model: 'manual', outputLimit: 99});
    assert.equal(env.requests[0].body.model, 'manual');
    assert.match(env.requests[0].body.messages[1].content, /<text>/);
    assert.equal(env.requests[0].body.max_tokens, 99);
    env.valuesByKey['openai-compatible-model'] = '';
    await assert.rejects(env.client.transform('x', 'correct', '', {provider: 'openai-compatible'}), /Choose a model/);
});

test('errors, truncation and malformed responses never return partial output', async () => {
    const env = setup();
    for (const [status, match] of [[401, /API key/], [404, /endpoint or model/], [500, /unavailable/]]) {
        env.respond({choices: [{message: {content: 'Ignore error'}}]}, status);
        await assert.rejects(env.client.transform('x', 'correct'), match);
    }
    env.respond({choices: [{message: {content: 'Partial'}, finish_reason: 'length'}]});
    await assert.rejects(env.client.transform('x', 'correct'), /output limit/);
    env.respond({choices: [{message: {content: {invalid: true}}}]});
    await assert.rejects(env.client.transform('x', 'correct'), /unexpected response/);
    env.respond({});
    await assert.rejects(env.context.fetchModels(env.settings, 'openai-compatible'), /invalid model list/);
});

test('cancelled generation and obsolete model discovery are rejected', async () => {
    const env = setup();
    env.hold();
    const generation = env.client.transform('x', 'correct');
    await new Promise(setImmediate);
    env.client.cancel();
    env.flush();
    await assert.rejects(generation, /cancelled/);
    env.respond({data: [{id: 'old-server'}]});
    const discovery = env.context.fetchModels(env.settings, 'openai-compatible');
    await new Promise(setImmediate);
    env.context.abortModelRequests();
    env.flush();
    await assert.rejects(discovery, /cancelled/);
});

test('OpenAI and native Ollama keep their existing endpoints and payloads', async () => {
    const env = setup({'openai-model': 'gpt-test', 'ollama-model': 'qwen', 'ollama-url': 'http://localhost:11434'});
    await env.client.transform('x', 'correct', '', {provider: 'openai'});
    assert.equal(env.requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(env.requests[0].headers.Authorization, 'Bearer secret');
    env.respond({message: {content: 'Local'}});
    assert.equal(await env.client.transform('x', 'correct', '', {provider: 'ollama'}), 'Local');
    assert.equal(env.requests[1].url, 'http://localhost:11434/api/chat');
    assert.equal(env.requests[1].body.stream, false);
});

function preferences(env) {
    env.settings.set_string = (key, value) => {env.valuesByKey[key] = value;};
    env.context.ExtensionPreferences = class {};
    env.context.Gtk = {INVALID_LIST_POSITION: 0xffffffff, StringList: {new: values => values}};
    const source = readFileSync(`${__dirname}/../prefs.js`, 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('export default class PlyphPreferences', 'globalThis.PlyphPreferences = class PlyphPreferences');
    vm.runInContext(source, env.context);
    return new env.context.PlyphPreferences();
}

test('model cache is scoped to server settings and preserves manual selection on invalidation', () => {
    const env = setup();
    const prefs = preferences(env);
    prefs._cacheModels(env.settings, 'openai-compatible', [{id: 'cached', name: 'cached'}]);
    assert.equal(prefs._cachedModels(env.settings, 'openai-compatible').length, 1);
    env.valuesByKey['openai-compatible-url'] = 'http://another-server/v1';
    assert.equal(prefs._cachedModels(env.settings, 'openai-compatible').length, 0);
    prefs._modelRow = {};
    prefs._invalidateCompatibleModels(env.settings);
    assert.equal(env.settings.get_string('openai-compatible-model'), 'local/model');
    assert.equal(prefs._modelRow._modelIds[0], 'local/model');
    assert.match(prefs._modelRow.subtitle, /settings changed/);
    prefs._cacheModels(env.settings, 'openai-compatible', [{id: 'cached'}]);
    env.valuesByKey['openai-compatible-auth'] = true;
    assert.equal(prefs._cachedModels(env.settings, 'openai-compatible').length, 0);
});

test('refresh does not implicitly select a model or revive an invalidated result', async () => {
    const env = setup({'openai-compatible-model': ''});
    const prefs = preferences(env);
    const row = {};
    prefs._setModelOptions(row, env.settings, 'openai-compatible', [{id: 'first'}]);
    assert.equal(row.selected, 0);
    assert.equal(row._modelIds[0], '');
    assert.equal(row._modelIds[1], 'first');
    let complete;
    env.context.fetchModels = () => new Promise(resolve => {complete = resolve;});
    prefs._modelRow = row;
    const button = {sensitive: true};
    const request = prefs._refreshModels(env.settings, 'openai-compatible', row, button);
    prefs._invalidateCompatibleModels(env.settings);
    complete([{id: 'old-server'}]);
    await request;
    assert.equal(prefs._cachedModels(env.settings, 'openai-compatible').length, 0);
    assert.match(row.subtitle, /settings changed/);
    assert.equal(button.sensitive, true);
});
