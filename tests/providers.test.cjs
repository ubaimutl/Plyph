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
    let collectionLocked = false;
    let unlockSucceeds = true;
    const cancelled = {value: false, is_cancelled() { return this.value; }};
    Object.assign(fixture.context, {
        Secret: {Schema: class {}, SchemaFlags: {NONE: 0},
            SearchFlags: {NONE: 0, ALL: 2, UNLOCK: 4, LOAD_SECRETS: 8},
            CollectionFlags: {NONE: 0},
            Collection: {
                for_alias(_service, _alias, _flags, _cancellable, callback) { callback(null, true); },
                for_alias_finish() { return {provider: 'default', get_locked: () => collectionLocked}; },
            },
            ServiceFlags: {OPEN_SESSION: 2},
            Service: {
                get(_flags, _cancellable, callback) { callback(null, true); },
                get_finish() { return {
                    unlock(items, _cancellable, callback) {
                        for (const item of items) operations.push(['unlock', item.provider]);
                        if (unlockSucceeds) collectionLocked = false;
                        callback(null, true);
                    },
                    unlock_finish() { return []; },
                }; },
            },
            Item: {
                load_secrets(_items, _cancellable, callback) { callback(null, true); },
                load_secrets_finish() { return true; },
            },
            SchemaAttributeType: {STRING: 0}, COLLECTION_DEFAULT: 'default',
            password_lookup(_schema, attributes, cancellable, callback) {
                operations.push(['lookup', attributes.provider]);
                callback(null, {id: attributes.provider, cancelled: cancellable?.is_cancelled()});
            },
            password_lookup_finish(result) {
                if (lookupError || result.cancelled) throw new Error('Keyring unavailable');
                return collectionLocked ? null : (keys.get(result.id) ?? null);
            },
            password_search(_schema, attributes, flags, cancellable, callback) {
                operations.push(['search', attributes.provider, flags]);
                if ((flags & 4) && keys.has(attributes.provider) && collectionLocked) {
                    operations.push(['unlock', attributes.provider]);
                    if (unlockSucceeds)
                        collectionLocked = false;
                }
                callback(null, {id: attributes.provider, cancelled: cancellable?.is_cancelled()});
            },
            password_search_finish(result) {
                if (lookupError || result.cancelled) throw new Error('Keyring unavailable');
                const val = keys.get(result.id);
                if (val === undefined) return [];
                return [{
                    provider: result.id,
                    get_locked: () => collectionLocked,
                    get_modified: () => 1,
                    get_secret: () => collectionLocked ? null : ({get_text: () => val}),
                    retrieve_secret: (_c, cb) => cb(null, true),
                    retrieve_secret_finish: () => collectionLocked ? null : ({get_text: () => val}),
                }];
            },
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
        }, GLib: {Error: class extends Error {
            constructor(_domain, code, message) { super(message); this.code = code; }
            matches(_domain, code) { return this.code === code; }
        }}, Gio: {IOErrorEnum: {CANCELLED: 1}},
    });
    vm.runInContext(readFileSync(resolve(root, 'secrets.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
        '\nObject.assign(globalThis, {migrateProviderSettings, deleteProvider, getApiKey, setApiKey, getProviderHeaders, setProviderHeaders, saveProviderConnection});', fixture.context);
    return {
        ...fixture, keys, operations, cancelled,
        failLookup: () => { lookupError = true; },
        failClear: () => { clearError = true; },
        setLocked: (locked, canUnlock = true) => { collectionLocked = locked; unlockSucceeds = canUnlock; },
    };
}

test('automatic migration discovers existing keyring credentials without copying or deleting secrets', async () => {
    const {context: c, settings: s, operations, cancelled} = secretsHarness();
    await c.migrateProviderSettings(s, cancelled);
    assert.ok(c.readProviders(s).some(p => p.id === 'openai'));
    assert.ok(operations.every(([type, , flags]) => type === 'search' && flags === c.Secret.SearchFlags.ALL));
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

test('migration discovers locked credentials without prompting and actions unlock only the matching key', async () => {
    const {context: c, settings: s, values, operations, cancelled, setLocked} = secretsHarness();
    setLocked(true, true);
    await c.migrateProviderSettings(s, cancelled);
    assert.equal(values['provider-migration-version'], 0);
    assert.ok(!operations.some(([type]) => type === 'unlock'));
    assert.ok(!operations.some(([type]) => type === 'unlock'));
    await assert.rejects(c.getApiKey(s, 'openai', null, false), /saved API key is locked/);
    assert.ok(!operations.some(([type]) => type === 'unlock'));
    assert.equal(await c.getApiKey(s, 'openai', null, true), 'saved-openai-key');
    assert.deepEqual(operations.filter(([type]) => type === 'unlock'), [['unlock', 'openai']]);
    setLocked(true, false);
    await assert.rejects(c.getApiKey(s, 'openai', null, true), /Unlock Passwords and Keys/);
});

test('an inconclusive search unlocks only the default collection before declaring a key missing', async () => {
    const {context: c, settings: s, operations, setLocked} = secretsHarness();
    setLocked(true, true);
    assert.equal(await c.getApiKey(s, 'custom:local-server', null, true), '');
    assert.deepEqual(operations.filter(([type]) => type === 'unlock'), [['unlock', 'default']]);
});

test('a newer locked key cannot be bypassed by an older unlocked duplicate', async () => {
    const {context: c, settings: s, setLocked} = secretsHarness();
    let isLocked = true;
    c.Secret.password_search = (_schema, _attrs, _flags, _cancel, callback) => callback(null, true);
    c.Secret.password_search_finish = () => [
        {get_locked: () => false, get_modified: () => 1, get_secret: () => ({get_text: () => 'old-key'})},
        {get_locked: () => isLocked, get_modified: () => 2,
            get_secret: () => isLocked ? null : ({get_text: () => 'current-key'})},
    ];
    c.Secret.Service.get_finish = () => ({
        unlock(_items, _cancel, callback) { callback(null, true); },
        unlock_finish() {},
    });
    await assert.rejects(c.getApiKey(s, 'openai', null, true), /saved API key is locked/);
    c.Secret.Service.get_finish = () => ({
        unlock(_items, _cancel, callback) { isLocked = false; callback(null, true); },
        unlock_finish() {},
    });
    assert.equal(await c.getApiKey(s, 'openai', null, true), 'current-key');
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
    const headerStore = new Map();
    fixture.context.getProviderHeaders = async profile => headerStore.get(profile.id) ?? {};
    fixture.settings.get_boolean = () => false;
    const ai = readFileSync(resolve(root, 'ai.js'), 'utf8').replace(/^import .*;\n/gm, '')
        .replace('export class AiClient', 'globalThis.AiClient = class AiClient');
    vm.runInContext(ai, fixture.context);
    const models = readFileSync(resolve(root, 'models.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => {${models}\nObject.assign(globalThis, {fetchModels, abortModelRequests});})();`, fixture.context);
    return {...fixture, requests, keyRequests, headerStore};
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

test('cloud preset providers reject missing API keys before sending network requests', async () => {
    const {context: c, settings: s, values, requests} = requestHarness();
    values['groq-model'] = 'llama-3.1-8b-instant';
    c.migrateProviders(s, ['groq'], true);
    let interactiveArg = null;
    c.getApiKey = async (_settings, _id, _cancellable, interactive) => {
        interactiveArg = interactive;
        return '';
    };
    const client = new c.AiClient(s);
    await assert.rejects(client.transform('Source', 'correct', null, {provider: 'groq'}), /Add a Groq API key/);
    assert.equal(interactiveArg, true);
    assert.equal(requests.length, 0);
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

test('legacy compatible connections get descriptive names without changing their IDs or custom names', () => {
    const {context: c, settings: s, values} = setup({'provider': 'openai-compatible'});
    c.migrateProviders(s, [], true);
    assert.equal(c.resolveProvider(s, 'openai-compatible').name, 'OpenAI-compatible (legacy)');
    const preset = c.PROVIDER_PRESETS.find(item => item.id === 'openai-compatible');
    assert.equal(preset.name, 'LM Studio (local)');
    assert.equal(preset.url, 'http://127.0.0.1:1234/v1');
    values['custom-providers'] = JSON.stringify([{id: 'openai-compatible', name: 'OpenAI-compatible',
        url: 'https://my-server.example/v1', model: 'saved-model', adapter: ''}]);
    assert.equal(c.resolveProvider(s, 'openai-compatible').name, 'OpenAI-compatible (legacy)');
    assert.equal(c.providerModel(s, 'openai-compatible'), 'saved-model');
    assert.equal(c.resolveProvider(s, 'openai-compatible').url, 'https://my-server.example/v1');
    assert.equal(JSON.parse(values['custom-providers'])[0].name, 'OpenAI-compatible');
    values['custom-providers'] = JSON.stringify([{id: 'openai-compatible', name: 'My account',
        url: 'https://my-server.example/v1', model: 'saved-model', adapter: ''}]);
    assert.equal(c.resolveProvider(s, 'openai-compatible').name, 'My account');
});

test('canceling a queued key lookup does not open another unlock prompt or poison later requests', async () => {
    const {context: c, settings: s} = secretsHarness();
    const originalSearch = c.Secret.password_search;
    let finish;
    let searches = 0;
    c.Secret.password_search = (_schema, attributes, _flags, _cancellable, callback) => {
        searches++;
        finish = () => callback(null, {id: attributes.provider});
    };
    const pending = c.getApiKey(s, 'openai', null, true);
    const canceled = {value: false, is_cancelled() { return this.value; }};
    const queued = c.getApiKey(s, 'openai', canceled, true);
    const rejected = assert.rejects(queued, /Request cancelled/);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(searches, 1);
    canceled.value = true;
    finish();
    assert.equal(await pending, 'saved-openai-key');
    await rejected;
    assert.equal(searches, 1);
    c.Secret.password_search = originalSearch;
    assert.equal(await c.getApiKey(s, 'openai', null, true), 'saved-openai-key');
});

test('an unavailable locked credential stops an action before any unauthenticated HTTP request', async () => {
    const {context: c, settings: s, requests} = requestHarness();
    c.migrateProviders(s, [], true);
    c.getApiKey = async () => { throw new Error('Your saved API key is locked. Unlock Passwords and Keys and try again.'); };
    const client = new c.AiClient(s);
    await assert.rejects(client.transform('Private', 'correct'), /saved API key is locked/);
    assert.equal(requests.length, 0);
    client.destroy();
});

test('a migrated cloud profile repointed to a local server can still run without an API key', async () => {
    const {context: c, settings: s, requests} = requestHarness();
    c.migrateProviders(s, [], true);
    const original = c.resolveProvider(s, 'groq');
    c.saveProvider(s, {...original, url: 'http://localhost:1234/v1'});
    c.getApiKey = async () => '';
    const client = new c.AiClient(s);
    await client.transform('Source', 'correct');
    assert.equal(requests[0].url, 'http://localhost:1234/v1/chat/completions');
    client.destroy();
});

test('an unlock search that hides locked results is checked against metadata before treating the key as missing', async () => {
    const {context: c, settings: s, setLocked} = secretsHarness();
    setLocked(true, false);
    const original = c.Secret.password_search;
    c.Secret.password_search = (schema, attributes, flags, cancellable, callback) => {
        if (flags & c.Secret.SearchFlags.UNLOCK)
            callback(null, {id: 'not-saved'});
        else
            original(schema, attributes, flags, cancellable, callback);
    };
    await assert.rejects(c.getApiKey(s, 'openai', null, true), /saved API key is locked/);
});

test('advanced controls are optional, persist through model changes, and validate before saving', () => {
    const {context: c, settings: s} = setup();
    c.migrateProviders(s, [], true);
    const original = c.resolveProvider(s, 'groq');
    assert.equal(original.advanced, undefined);
    const advanced = {temperature: 0, reasoningEffort: 'low', parameters: {top_p: 0.8, extra_body: {thinking: true}}};
    c.saveProvider(s, {...original, advanced});
    c.setProviderModel(s, original.id, 'new-model');
    assert.equal(JSON.stringify(c.resolveProvider(s, original.id).advanced), JSON.stringify(advanced));
    for (const value of [-1, 3, NaN, '0.5'])
        assert.throws(() => c.validateAdvanced({temperature: value}), /Temperature/);
    assert.throws(() => c.validateAdvanced({reasoningEffort: 'unknown'}), /reasoning effort/);
    for (const key of ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'tools', '__proto__'])
        assert.throws(() => c.validateAdvanced({parameters: JSON.parse(`{"${key}":true}`)}), /cannot be overridden/);
    assert.throws(() => c.validateAdvanced({parameters: []}), /JSON object/);
    assert.equal(JSON.stringify(c.applyProviderOptions({}, {model: 'original'})), '{"model":"original"}');
});

test('custom headers validate names and values, merge case-insensitively, and reject transport overrides', () => {
    const {context: c} = setup();
    const merged = c.mergeProviderHeaders({Authorization: 'Bearer original', 'X-Title': 'Plyph'}, {authorization: 'Custom token', 'X-Key': 'secret'});
    assert.equal(merged.authorization, 'Custom token');
    assert.equal(merged.Authorization, undefined);
    assert.equal(Object.keys(merged).filter(name => name.toLowerCase() === 'authorization').length, 1);
    for (const headers of [{'Bad name': 'value'}, {'X-Test': 'a\r\nb'}, {Host: 'other.example'}, {'Content-Length': '100'}, {'X-Test': 5}, {'X-Key': 'one', 'x-key': 'two'}])
        assert.throws(() => c.validateHeaders(headers));
});

test('advanced controls and secure headers reach inference and model fetching without crossing profiles', async () => {
    const {context: c, settings: s, requests, headerStore} = requestHarness();
    c.migrateProviders(s, [], true);
    const profile = {id: 'custom:advanced', name: 'Advanced', url: 'https://advanced.example/v1', model: 'default-model',
        hasCustomHeaders: true, advanced: {temperature: 0.25, reasoningEffort: 'medium', parameters: {top_p: 0.9}}};
    c.saveProvider(s, profile);
    headerStore.set(profile.id, {'X-API-Key': 'header-secret'});
    const client = new c.AiClient(s);
    await client.transform('Source', 'custom', 'Explain', {provider: profile.id, model: 'action-model', outputLimit: 4000});
    await c.fetchModels(s, profile.id, true);
    await client.transform('Source', 'correct');
    assert.equal(requests[0].body.temperature, 0.25);
    assert.equal(requests[0].body.reasoning_effort, 'medium');
    assert.equal(requests[0].body.top_p, 0.9);
    assert.equal(requests[0].body.model, 'action-model');
    assert.equal(requests[0].body.max_tokens, 4000);
    assert.equal(requests[0].headers['X-API-Key'], 'header-secret');
    assert.equal(requests[1].headers['X-API-Key'], 'header-secret');
    assert.equal(requests[2].headers['X-API-Key'], undefined);
    assert.equal(requests[2].body.temperature, undefined);
    client.destroy();
});

test('custom headers are stored separately in the keyring and survive rename and model updates', async () => {
    const {context: c, settings: s, values, keys, cancelled} = secretsHarness();
    c.migrateProviders(s, [], true);
    const profile = {id: 'custom:secure', name: 'Secure', url: 'https://secure.example/v1', model: 'm'};
    await c.saveProviderConnection(s, profile, {apiKey: 'api-secret', headers: {'X-Key': 'header-secret'}}, cancelled);
    const saved = c.resolveProvider(s, profile.id);
    assert.equal(saved.hasCustomHeaders, true);
    assert.equal((await c.getProviderHeaders(saved, cancelled, true))['X-Key'], 'header-secret');
    assert.doesNotMatch(values['custom-providers'], /api-secret|header-secret/);
    c.saveProvider(s, {...saved, name: 'Renamed'});
    c.setProviderModel(s, profile.id, 'new-model');
    assert.equal((await c.getProviderHeaders(c.resolveProvider(s, profile.id), cancelled, true))['X-Key'], 'header-secret');
    await c.deleteProvider(s, profile.id, cancelled);
    assert.equal(keys.has(profile.id), false);
    assert.equal(keys.has(`${profile.id}:headers`), false);
});

test('failed profile saves restore both the previous API key and custom headers', async () => {
    const {context: c, settings: s, cancelled} = secretsHarness();
    c.migrateProviders(s, [], true);
    const profile = {id: 'custom:rollback', name: 'Rollback', url: 'https://example.com/v1', model: 'old-model'};
    await c.saveProviderConnection(s, profile, {apiKey: 'old-key', headers: {'X-Key': 'old-header'}}, cancelled);
    const before = s.get_string('custom-providers');
    s.set_string = key => key !== 'custom-providers';
    await assert.rejects(c.saveProviderConnection(s, {...profile, model: 'new-model'},
        {apiKey: 'new-key', headers: {'X-Key': 'new-header'}}, cancelled), /could not be saved/);
    assert.equal(await c.getApiKey(s, profile.id), 'old-key');
    assert.equal((await c.getProviderHeaders(c.resolveProvider(s, profile.id), cancelled, true))['X-Key'], 'old-header');
    assert.equal(s.get_string('custom-providers'), before);
});

test('a failed header write restores the previous API key and leaves provider settings unchanged', async () => {
    const {context: c, settings: s, keys, cancelled} = secretsHarness();
    c.migrateProviders(s, [], true);
    const profile = {id: 'custom:failed-header', name: 'Header failure', url: 'https://example.com/v1', model: 'm'};
    await c.saveProviderConnection(s, profile, {apiKey: 'old-key', headers: {'X-Key': 'old-header'}}, cancelled);
    const before = s.get_string('custom-providers');
    const originalStore = c.Secret.password_store;
    c.Secret.password_store = (schema, attributes, collection, label, value, cancellable, callback) => {
        if (attributes.provider.endsWith(':headers') && value.includes('new-header'))
            throw new Error('Keyring write failed');
        originalStore(schema, attributes, collection, label, value, cancellable, callback);
    };
    await assert.rejects(c.saveProviderConnection(s, profile,
        {apiKey: 'new-key', headers: {'X-Key': 'new-header'}}, cancelled), /Keyring is unavailable/);
    assert.equal(keys.get(profile.id), 'old-key');
    assert.equal(JSON.parse(keys.get(`${profile.id}:headers`))['X-Key'], 'old-header');
    assert.equal(s.get_string('custom-providers'), before);
});

test('failed header deletion restores the API key, headers and profile', async () => {
    const {context: c, settings: s, keys, cancelled} = secretsHarness();
    c.migrateProviders(s, [], true);
    const profile = {id: 'custom:delete-headers', name: 'Delete failure', url: 'https://example.com/v1', model: 'm'};
    await c.saveProviderConnection(s, profile, {apiKey: 'api-key', headers: {'X-Key': 'header-key'}}, cancelled);
    const originalClear = c.Secret.password_clear;
    c.Secret.password_clear = (schema, attributes, cancellable, callback) => {
        if (attributes.provider.endsWith(':headers'))
            callback(null, false);
        else
            originalClear(schema, attributes, cancellable, callback);
    };
    await assert.rejects(c.deleteProvider(s, profile.id, cancelled), /provider has been restored/);
    assert.equal(c.resolveProvider(s, profile.id).hasCustomHeaders, true);
    assert.equal(keys.get(profile.id), 'api-key');
    assert.equal(JSON.parse(keys.get(`${profile.id}:headers`))['X-Key'], 'header-key');
});

test('locked custom headers are reported as locked headers rather than missing API keys', async () => {
    const {context: c, settings: s, cancelled, setLocked} = secretsHarness();
    const profile = {id: 'custom:locked-headers', name: 'Headers', url: 'https://example.com/v1', model: 'm'};
    await c.saveProviderConnection(s, profile, {apiKey: '', headers: {'X-Key': 'secret'}}, cancelled);
    setLocked(true, false);
    await assert.rejects(c.getProviderHeaders(c.resolveProvider(s, profile.id), cancelled, true), /custom headers are locked/);
});
