const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const {loadProviders} = require('./helpers/modules.cjs');
const root = resolve(__dirname, '..');

function setup(overrides = {}, user = []) {
    const values = {provider: 'groq', 'custom-actions': '[]', 'custom-providers': '[]',
        'provider-migration-version': 0, 'openai-compatible-url': 'http://localhost:1234/v1',
        ...Object.fromEntries(['groq', 'bai', 'openrouter', 'cerebras', 'openai', 'vercel', 'openai-compatible']
            .map(id => [`${id}-model`, `${id}-saved-model`])), ...overrides};
    const settings = {
        get_string: key => values[key] ?? '', get_int: key => values[key] ?? 0,
        get_user_value: key => user.includes(key) ? values[key] : null,
        set_string: (key, value) => { values[key] = value; },
        set_int: (key, value) => { values[key] = value; },
    };
    const context = vm.createContext({});
    loadProviders(context, root);
    return {context, settings, values};
}

test('migration imports selected, referenced, configured and keyring-only profiles without rewriting old settings', () => {
    const action = {id: 'summary', name: 'Summary', prompt: 'Summarize', provider: 'cerebras', model: 'action-model'};
    const {context: c, settings: s, values} = setup({'custom-actions': JSON.stringify([action]),
        'prompt-run-provider': 'openrouter', 'openai-compatible-url': 'https://private.example/custom/api'},
    ['openai-compatible-url', 'bai-model']);
    const before = {...values};
    c.migrateProviders(s, ['openai', 'vercel'], true);
    const profiles = c.readProviders(s);
    assert.deepEqual(Array.from(profiles, p => p.id).sort(), ['groq', 'openrouter', 'cerebras', 'openai-compatible', 'bai', 'openai', 'vercel'].sort());
    assert.equal(profiles.find(p => p.id === 'openai-compatible').url, 'https://private.example/custom/api');
    for (const [key, value] of Object.entries(before)) {
        if (!['custom-providers', 'provider-migration-version'].includes(key))
            assert.equal(values[key], value, key);
    }
    assert.equal(c.providerModel(s, 'cerebras'), 'cerebras-saved-model');
    assert.equal(JSON.parse(values['custom-actions'])[0].model, 'action-model');
});

test('migration retries merge without duplicates or overwriting edits, then never resurrect deleted profiles', () => {
    const {context: c, settings: s, values} = setup();
    c.migrateProviders(s);
    c.saveProvider(s, {...c.resolveProvider(s, 'groq'), name: 'My Groq', model: 'edited-model'});
    c.migrateProviders(s, ['vercel'], true);
    c.migrateProviders(s, ['vercel'], true);
    assert.equal(c.readProviders(s).length, 2);
    assert.equal(c.resolveProvider(s, 'groq').name, 'My Groq');
    c.removeProvider(s, 'vercel');
    c.migrateProviders(s, ['vercel'], true);
    assert.equal(c.readProviders(s).length, 1);
    assert.equal(values['provider-migration-version'], 1);
});

test('missing provider fails explicitly after migration, and deletion names all references', () => {
    const {context: c, settings: s, values} = setup({'prompt-run-provider': 'groq',
        'custom-actions': JSON.stringify([{id: 'a', name: 'My action', prompt: 'Explain', provider: 'groq'}])});
    c.migrateProviders(s, [], true);
    assert.throws(() => c.removeProvider(s, 'groq'), /Active provider, Run selected prompt, My action/);
    values['custom-providers'] = '[]';
    assert.throws(() => c.resolveProvider(s, 'groq'), /no longer exists/);
    assert.throws(() => c.providerModel(s, 'custom:deleted'), /no longer exists/);
});

test('two independent profiles retain their endpoints and models through rename and model changes', () => {
    const {context: c, settings: s} = setup();
    c.migrateProviders(s, [], true);
    for (const suffix of ['first', 'second'])
        c.saveProvider(s, {id: `custom:${suffix}`, name: suffix, url: `https://${suffix}.example/v1/`, model: suffix});
    c.setProviderModel(s, 'custom:first', 'new-model');
    c.saveProvider(s, {...c.resolveProvider(s, 'custom:first'), name: 'Renamed'});
    assert.equal(c.resolveProvider(s, 'custom:first').url, 'https://first.example/v1');
    assert.equal(c.providerModel(s, 'custom:first'), 'new-model');
    assert.equal(c.providerModel(s, 'custom:second'), 'second');
});

test('invalid settings are preserved rather than overwritten by migration', () => {
    for (const invalid of ['broken', '{}', '[{"id":"ollama"}]']) {
        const {context: c, settings: s, values} = setup({'custom-providers': invalid});
        assert.throws(() => c.migrateProviders(s, [], true), /kept/);
        assert.equal(values['custom-providers'], invalid);
        assert.equal(values['provider-migration-version'], 0);
    }
});

test('profile validation rejects unsafe URLs and accepts local or custom base paths', () => {
    const {context: c} = setup();
    for (const url of ['file:///tmp/key', 'https://user:password@example.com/v1', 'https://example.com?q=key', 'https://example.com/#secret', 'https://example.com/a b'])
        assert.throws(() => c.validateProvider({name: 'Test', model: 'm', url}), /URL/);
    for (const url of ['http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1', 'https://example.com/custom/api'])
        assert.equal(c.validateProvider({name: 'Test', model: 'm', url}).url, url);
});

function secretsHarness() {
    const fixture = setup();
    const keys = new Map([['openai', 'saved-openai-key']]);
    const operations = [];
    let lookupError = null;
    let clearError = false;
    const cancelled = {value: false, is_cancelled() { return this.value; }};
    Object.assign(fixture.context, {
        Secret: {Schema: class {}, SchemaFlags: {NONE: 0}, SchemaAttributeType: {STRING: 0}, COLLECTION_DEFAULT: 'default',
            password_lookup(_schema, attributes, cancellable, callback) {
                operations.push(['lookup', attributes.provider]);
                callback(null, {id: attributes.provider, cancelled: cancellable?.is_cancelled()});
            },
            password_lookup_finish(result) { if (lookupError || result.cancelled) throw new Error('Keyring unavailable'); return keys.get(result.id) ?? null; },
            password_store(_schema, attributes, _collection, _label, value, _cancellable, callback) {
                keys.set(attributes.provider, value); operations.push(['store', attributes.provider]); callback(null, true);
            },
            password_store_finish: result => result,
            password_clear(_schema, attributes, _cancellable, callback) {
                operations.push(['clear', attributes.provider]);
                if (!clearError) keys.delete(attributes.provider);
                callback(null, !clearError);
            },
            password_clear_finish(result) { if (!result) throw new Error('Keyring unavailable'); return result; },
        }, GLib: {Error: class extends Error {}}, Gio: {IOErrorEnum: {CANCELLED: 1}},
    });
    vm.runInContext(readFileSync(resolve(root, 'secrets.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
        '\nObject.assign(globalThis, {migrateProviderSettings, deleteProvider, getApiKey, setApiKey});', fixture.context);
    return {...fixture, keys, operations, cancelled, failLookup: () => { lookupError = true; }, failClear: () => { clearError = true; }};
}

test('automatic migration discovers existing keyring credentials without copying or deleting secrets', async () => {
    const {context: c, settings: s, operations, cancelled} = secretsHarness();
    await c.migrateProviderSettings(s, cancelled);
    assert.ok(c.readProviders(s).some(p => p.id === 'openai'));
    assert.ok(operations.every(([type]) => type === 'lookup'));
    assert.equal(await c.getApiKey(s, 'openai'), 'saved-openai-key');
});

test('keyring failure leaves migration retryable and cancellation does not mark completion', async () => {
    for (const cancel of [false, true]) {
        const {context: c, settings: s, values, cancelled, failLookup} = secretsHarness();
        if (cancel) cancelled.value = true;
        else failLookup();
        await assert.rejects(c.migrateProviderSettings(s, cancelled), /Keyring/);
        assert.equal(values['provider-migration-version'], 0);
        assert.equal(c.resolveProvider(s, 'openai').id, 'openai');
    }
});

test('custom profile secrets are isolated from settings and from other profiles', async () => {
    const {context: c, settings: s, values} = secretsHarness();
    await c.setApiKey(s, 'custom:a', 'first-key');
    await c.setApiKey(s, 'custom:b', 'second-key');
    assert.equal(await c.getApiKey(s, 'custom:a'), 'first-key');
    assert.equal(await c.getApiKey(s, 'custom:b'), 'second-key');
    await c.setApiKey(s, 'custom:a', '');
    assert.equal(await c.getApiKey(s, 'custom:a'), '');
    assert.equal(await c.getApiKey(s, 'custom:b'), 'second-key');
    assert.doesNotMatch(JSON.stringify(values), /first-key|second-key/);
});

test('duplicate provider names keep separate credentials, models and action references', async () => {
    const {context: c, settings: s, values} = secretsHarness();
    c.migrateProviders(s, [], true);
    for (const suffix of ['first', 'second']) {
        c.saveProvider(s, {id: `custom:${suffix}`, name: 'Same provider',
            url: `https://${suffix}.example/v1`, model: `${suffix}-model`});
        await c.setApiKey(s, `custom:${suffix}`, `${suffix}-key`);
    }
    values['custom-actions'] = JSON.stringify([
        {id: 'one', name: 'First action', prompt: 'Explain', provider: 'custom:first'},
        {id: 'two', name: 'Second action', prompt: 'Summarize', provider: 'custom:second'},
    ]);
    assert.equal(c.readProviders(s).filter(p => p.name === 'Same provider').length, 2);
    for (const suffix of ['first', 'second']) {
        assert.equal(await c.getApiKey(s, `custom:${suffix}`), `${suffix}-key`);
        assert.equal(c.providerModel(s, `custom:${suffix}`), `${suffix}-model`);
        assert.equal(c.resolveProvider(s, `custom:${suffix}`).url, `https://${suffix}.example/v1`);
    }
    assert.deepEqual(Array.from(c.providerReferences(s, 'custom:first')), ['First action']);
    assert.deepEqual(Array.from(c.providerReferences(s, 'custom:second')), ['Second action']);
    c.saveProvider(s, {...c.resolveProvider(s, 'custom:first'), name: 'Renamed provider'});
    assert.equal(c.resolveProvider(s, 'custom:second').name, 'Same provider');
    assert.throws(() => c.removeProvider(s, 'custom:first'), /First action/);
    assert.equal(await c.getApiKey(s, 'custom:second'), 'second-key');
});

function requestHarness() {
    const fixture = setup();
    const requests = [];
    const keyRequests = [];
    Object.assign(fixture.context, {
        TextDecoder,
        Gio: {Cancellable: class { cancelled = false; cancel() { this.cancelled = true; } is_cancelled() { return this.cancelled; } }},
        GLib: {Error: class extends Error {}, PRIORITY_DEFAULT: 0, Bytes: class { constructor(value) { this.value = value; } }},
        getApiKey: async (_settings, id) => { keyRequests.push(id); return `key-${id}`; },
        Soup: {Message: {new: (_method, url) => ({url, headers: {}, status_code: 200,
            get request_headers() { return {append: (name, value) => { this.headers[name] = value; }}; },
            set_request_body_from_bytes(_type, bytes) { this.body = JSON.parse(bytes.value); }})},
        Session: class {
            abort() {}
            send_and_read_async(message, _priority, _cancellable, callback) { requests.push(message); callback(this, {}); }
            send_and_read_finish() { return {get_data: () => new TextEncoder().encode(JSON.stringify({
                choices: [{message: {content: 'Reply'}}], data: [{id: 'server-model'}],
            }))}; }
        }},
    });
    fixture.settings.get_boolean = () => false;
    const ai = readFileSync(resolve(root, 'ai.js'), 'utf8').replace(/^import .*;\n/gm, '')
        .replace('export class AiClient', 'globalThis.AiClient = class AiClient');
    vm.runInContext(ai, fixture.context);
    const models = readFileSync(resolve(root, 'models.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => {${models}\nObject.assign(globalThis, {fetchModels, abortModelRequests});})();`, fixture.context);
    return {...fixture, requests, keyRequests};
}

test('requests and model lists resolve each saved endpoint and key without cross-profile leakage', async () => {
    const {context: c, settings: s, values, requests, keyRequests} = requestHarness();
    c.migrateProviders(s, [], true);
    for (const id of ['a', 'b'])
        c.saveProvider(s, {id: `custom:${id}`, name: id, url: `https://${id}.example/custom`, model: `${id}-model`});
    values.provider = 'custom:a';
    const client = new c.AiClient(s);
    await client.transform('Source', 'correct');
    await client.transform('Source', 'custom', 'Summarize', {provider: 'custom:b', model: 'override-model'});
    await c.fetchModels(s, 'custom:b');
    assert.deepEqual(requests.map(r => r.url), ['https://a.example/custom/chat/completions',
        'https://b.example/custom/chat/completions', 'https://b.example/custom/models']);
    assert.equal(requests[0].body.model, 'a-model');
    assert.equal(requests[1].body.model, 'override-model');
    assert.deepEqual(keyRequests, ['custom:a', 'custom:b', 'custom:b']);
    assert.equal(requests[0].headers.Authorization, 'Bearer key-custom:a');
    assert.equal(requests[1].headers.Authorization, 'Bearer key-custom:b');
    const count = requests.length;
    await assert.rejects(client.transform('Private', 'correct', null, {provider: 'custom:missing'}), /no longer exists/);
    assert.equal(requests.length, count);
    client.destroy();
});

test('migration preserves Groq reasoning options, OpenRouter headers and Cerebras token fields', async () => {
    const {context: c, settings: s, values, requests} = requestHarness();
    values['groq-model'] = 'openai/gpt-oss-20b';
    c.migrateProviders(s, ['openrouter', 'cerebras'], true);
    const client = new c.AiClient(s);
    for (const provider of ['groq', 'openrouter', 'cerebras'])
        await client.transform('Source', 'correct', null, {provider});
    assert.equal(requests[0].body.reasoning_effort, 'low');
    assert.equal(requests[0].body.include_reasoning, false);
    assert.equal(requests[1].headers['X-Title'], 'Plyph');
    assert.ok(requests[2].body.max_completion_tokens > 0);
    assert.equal(requests[2].body.max_tokens, undefined);
    client.destroy();
});

test('cancellation while loading a key prevents a stale request from being sent', async () => {
    const {context: c, settings: s, requests} = requestHarness();
    c.migrateProviders(s, [], true);
    let finishKey;
    c.getApiKey = () => new Promise(resolve => { finishKey = resolve; });
    const client = new c.AiClient(s);
    const request = client.transform('Private', 'correct');
    client.cancel();
    finishKey('key');
    await assert.rejects(request);
    assert.equal(requests.length, 0);
    client.destroy();
});

test('connections without a model can be saved and queried for models, but cannot run without a model choice', async () => {
    const {context: c, settings: s, requests, keyRequests} = requestHarness();
    c.migrateProviders(s, [], true);
    c.saveProvider(s, {id: 'custom:empty', name: 'Empty model', url: 'http://localhost:1234/v1', model: ''});
    const client = new c.AiClient(s);
    await assert.rejects(client.transform('Private', 'correct', null, {provider: 'custom:empty'}), /Choose a model/);
    assert.equal(requests.length, 0);
    assert.equal(keyRequests.length, 0);
    const models = await c.fetchModels(s, 'custom:empty');
    assert.equal(models[0].id, 'server-model');
    await client.transform('Source', 'custom', 'Explain', {provider: 'custom:empty', model: 'override'});
    assert.equal(requests.at(-1).body.model, 'override');
    c.setProviderModel(s, 'custom:empty', models[0].id);
    await client.transform('Source', 'correct', null, {provider: 'custom:empty'});
    assert.equal(requests.at(-1).body.model, 'server-model');
    client.destroy();
});

test('duplicate-name labels distinguish different URLs and identical endpoints with colliding short IDs', () => {
    const {context: c} = setup();
    const profiles = [
        {id: 'custom:alpha-00000000', name: 'Same', url: 'https://one.example/v1'},
        {id: 'custom:beta-00000000', name: 'Same', url: 'https://one.example/v1'},
        {id: 'custom:third', name: 'Same', url: 'https://two.example/v1'},
        {id: 'custom:unique', name: 'Unique', url: 'https://one.example/v1'},
    ];
    const labels = Array.from(c.providerLabels(profiles));
    assert.equal(new Set(labels).size, profiles.length);
    assert.match(labels[0], /^Same · .+ — https:\/\/one.example\/v1$/);
    assert.match(labels[2], /https:\/\/two.example\/v1/);
    assert.equal(labels[3], 'Unique');
});

test('failed settings deletion leaves the existing credential untouched', async () => {
    const {context: c, settings: s, keys, operations, cancelled} = secretsHarness();
    c.migrateProviders(s, ['openai'], true);
    s.set_string = () => false;
    await assert.rejects(c.deleteProvider(s, 'openai', cancelled), /could not be removed/);
    assert.ok(c.readProviders(s).some(p => p.id === 'openai'));
    assert.equal(keys.get('openai'), 'saved-openai-key');
    assert.ok(!operations.some(([type]) => type === 'clear'));
});

test('failed credential cleanup restores the removed profile with its original configuration', async () => {
    const {context: c, settings: s, keys, cancelled, failClear} = secretsHarness();
    c.migrateProviders(s, ['openai'], true);
    const before = JSON.stringify(c.resolveProvider(s, 'openai'));
    failClear();
    await assert.rejects(c.deleteProvider(s, 'openai', cancelled), /provider has been restored/);
    assert.equal(JSON.stringify(c.resolveProvider(s, 'openai')), before);
    assert.equal(keys.get('openai'), 'saved-openai-key');
});

test('successful deletion removes the profile before clearing its key and preserves other credentials', async () => {
    const {context: c, settings: s, keys, cancelled} = secretsHarness();
    c.migrateProviders(s, ['openai'], true);
    keys.set('custom:other', 'other-key');
    c.Secret.password_clear = (_schema, attributes, _cancellable, callback) => {
        assert.ok(!c.readProviders(s).some(p => p.id === attributes.provider));
        keys.delete(attributes.provider);
        callback(null, true);
    };
    await c.deleteProvider(s, 'openai', cancelled);
    assert.ok(!c.readProviders(s).some(p => p.id === 'openai'));
    assert.equal(keys.has('openai'), false);
    assert.equal(keys.get('custom:other'), 'other-key');
});

test('preset adapters match only the original base endpoint and ignore harmless URL normalization', () => {
    const {context: c, settings: s} = setup();
    c.migrateProviders(s, [], true);
    for (const preset of c.PROVIDER_PRESETS.filter(item => item.adapter)) {
        const profile = {...preset, id: `custom:${preset.id}`, model: 'test-model'};
        c.saveProvider(s, profile);
        assert.equal(c.resolveProvider(s, profile.id).adapter, preset.adapter);
        const equivalent = preset.url.replace('https://', 'HTTPS://')
            .replace(/^HTTPS:\/\/([^/]+)/, (_match, host) => `HTTPS://${host.toUpperCase()}:443`) + '/';
        c.saveProvider(s, {...profile, url: equivalent});
        assert.equal(c.resolveProvider(s, profile.id).adapter, preset.adapter);
        for (const url of ['https://other.example/v1', `${preset.url}/other`,
            preset.url.replace('https://', 'http://'),
            preset.url.replace(/^(https:\/\/[^/]+)/, '$1.evil.example')]) {
            c.saveProvider(s, {...profile, url});
            assert.equal(c.resolveProvider(s, profile.id).adapter, '');
            assert.equal(JSON.parse(s.get_string('custom-providers')).find(item => item.id === profile.id).adapter, '');
        }
    }
    assert.equal(c.providerAdapter({url: 'https://api.groq.com/openai/v1', adapter: ''}), '');
});

test('old profiles with an unrelated endpoint cannot retain preset headers, parameters or model filters', async () => {
    for (const adapter of ['groq', 'openrouter', 'cerebras', 'openai', 'bai']) {
        const {context: c, settings: s, values, requests} = requestHarness();
        values['provider-migration-version'] = 1;
        const profile = {id: adapter, name: adapter, adapter,
            url: 'http://localhost:4321/v1', model: 'openai/gpt-oss-20b'};
        values['custom-providers'] = JSON.stringify([profile]);
        const before = values['custom-providers'];
        assert.equal(c.resolveProvider(s, adapter).adapter, '');
        const client = new c.AiClient(s);
        await client.transform('Source', 'correct', null, {provider: adapter});
        const models = await c.fetchModels(s, adapter);
        assert.equal(requests[0].headers['X-Title'], undefined);
        assert.equal(requests[0].body.reasoning_effort, undefined);
        assert.equal(requests[0].body.include_reasoning, undefined);
        assert.equal(requests[0].body.max_completion_tokens, undefined);
        assert.ok(requests[0].body.max_tokens > 0);
        assert.equal(requests[1].url, 'http://localhost:4321/v1/models');
        assert.equal(models[0].id, 'server-model');
        assert.equal(values['custom-providers'], before, 'Runtime resolution must not rewrite user settings');
        client.destroy();
    }
});
