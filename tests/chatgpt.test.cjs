const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync, writeFileSync, mkdtempSync, rmSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
const {tmpdir} = require('node:os');
const {pathToFileURL} = require('node:url');
const {resolve} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({TextEncoder, TextDecoder, Uint8Array, GLib: {
    base64_encode: value => Buffer.from(value).toString('base64'),
    base64_decode: value => new Uint8Array(Buffer.from(value, 'base64')),
    ChecksumType: {SHA256: 1},
    compute_checksum_for_data: (_type, bytes) => crypto.createHash('sha256').update(bytes).digest('hex'),
}});
vm.runInContext(readFileSync(resolve(__dirname, '../chatgptProtocol.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
    '\nglobalThis.protocol = {verifyIdToken, callbackResult, ResponsesStream, base64url, sha256, decode64, chatgptError, Utf8StreamDecoder};', context);
const {verifyIdToken, callbackResult, ResponsesStream, base64url, sha256, decode64} = context.protocol;
const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'test-key', use: 'sig', alg: 'RS256'};
const claims = {iss: 'https://auth.openai.com', aud: 'client-test', sub: 'user-test', exp: 2000, nonce: 'test-nonce'};
function jwt(overrides = {}, header = {}, key = privateKey) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({alg: 'RS256', kid: 'test-key', ...header})}.${encode({...claims, ...overrides})}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
const verify = (token, keys = [jwk]) => verifyIdToken(token, keys, 'client-test', 'test-nonce', 'user-test', 1000);

test('native protocol verifies independently signed RSA JWTs', () => {
    assert.equal(verify(jwt()).sub, 'user-test');
    assert.equal(verify(jwt({aud: ['client-test', 'other'], azp: 'client-test'})).sub, 'user-test');
});
for (const [field, value] of Object.entries({iss: 'https://evil.test', aud: 'other', sub: 'different', exp: 1000, nonce: 'wrong', nbf: 1061, azp: 'other'})) {
    test(`ID token rejects invalid ${field}`, () => assert.throws(() => verify(jwt({[field]: value}))));
}
test('ID token requires azp for multiple audiences', () => assert.throws(() => verify(jwt({aud: ['client-test', 'other']}))));
test('ID token rejects unsigned, confused algorithms and unsupported critical headers', () => {
    for (const header of [{alg: 'none'}, {alg: 'HS256'}, {crit: ['custom']}, {b64: false}, {kid: 'unknown'}])
        assert.throws(() => verify(jwt({}, header)));
});
test('ID token rejects payload and signature tampering', () => {
    const parts = jwt().split('.');
    parts[1] = Buffer.from(JSON.stringify({...claims, email: 'injected@example.test'})).toString('base64url');
    assert.throws(() => verify(parts.join('.')));
    const signature = Buffer.from(jwt().split('.')[2], 'base64url');
    signature[50] ^= 1;
    assert.throws(() => verify(jwt().split('.').slice(0, 2).join('.') + '.' + signature.toString('base64url')));
});
test('ID token rejects duplicate keys, weak keys and wrong key usage', () => {
    for (const keys of [[jwk, jwk], [{...jwk, use: 'enc'}], [{...jwk, key_ops: ['encrypt']}], [{...jwk, n: 'AQAB'}]])
        assert.throws(() => verify(jwt(), keys));
});
test('ID token rejects signatures from a different RSA key', () => {
    const other = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    assert.throws(() => verify(jwt({}, {}, other.privateKey)));
});
test('PKCE SHA256 matches the RFC 7636 vector', () => {
    assert.equal(base64url(sha256(new TextEncoder().encode('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))),
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('base64url rejects noncanonical encodings', () => {
    for (const value of ['A', 'YQ==', 'Y R', 'YR', '', null]) assert.throws(() => decode64(value));
});
test('registration callback requires state and an issued client ID', () => {
    assert.equal(callbackResult({state: 'state', code: 'code', client_id: 'issued'}, 'state').clientId, 'issued');
    for (const query of [{state: 'wrong', code: 'code', client_id: 'issued'}, {state: 'state', code: 'code'},
        {state: 'state', code: 'code', client_id: 'dynamic_agent_client'}, {state: 'state', error: 'access_denied'}])
        assert.throws(() => callbackResult(query, 'state'));
});
test('returning callback preserves its registered client identity', () => {
    assert.equal(callbackResult({state: 's', code: 'c'}, 's', 'saved').clientId, 'saved');
    assert.throws(() => callbackResult({state: 's', code: 'c', client_id: 'different'}, 's', 'saved'));
});
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const completed = text => event({type: 'response.completed', response: {status: 'completed', output: [
    {type: 'reasoning', summary: [{text: 'Do not return this'}]},
    {type: 'message', content: [{type: 'output_text', text}]},
]}});
test('SSE handles every chunk boundary and returns only completed output', () => {
    const input = ': keepalive\r\n\r\n' + event({type: 'response.output_text.delta', delta: 'partial'}) + completed('Grüße 🌍') + 'data: [DONE]\r\n\r\n';
    for (let boundary = 1; boundary < input.length; boundary++) {
        const parser = new ResponsesStream();
        parser.feed(input.slice(0, boundary)); parser.feed(input.slice(boundary));
        assert.equal(parser.finish(), 'Grüße 🌍');
    }
});
test('SSE refuses disconnected, failed, incomplete and empty responses', () => {
    for (const data of [event({type: 'response.output_text.delta', delta: 'partial'}), 'data: [DONE]\n\n',
        event({type: 'response.failed'}), event({type: 'response.incomplete'}), completed(''),
        completed('result').slice(0, -2), event({type: 'response.completed', response: {status: 'in_progress'}})]) {
        assert.throws(() => { const parser = new ResponsesStream(); parser.feed(data); parser.finish(); });
    }
});
test('SSE reports plan usage errors without leaking service details', () => {
    const parser = new ResponsesStream();
    assert.throws(() => parser.feed(event({type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'private'})),
        /Manage usage/);
});
test('SSE refuses oversized streams', () => assert.throws(() => new ResponsesStream().feed('x'.repeat(8 * 1024 * 1024 + 1)), /too large/));

function clientHarness() {
    let stored = {profiles: {saved: {client_id: 'saved', subject: 'user', email: 'user@example.test',
        access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 0, scopes: ['chatgpt.tokens.use.direct']}}};
    const writes = [];
    const requests = [];
    const timers = new Map();
    let nextTimer = 1;
    const settings = {get_string: key => key === 'chatgpt-thinking-effort' ? 'auto' : 'saved'};
    const bus = {
        call(...args) { args.at(-1)(this, {deep_unpack: () => [1]}); },
        call_finish: result => result,
    };
    const Cancellable = class {
        handlers = new Map();
        nextId = 1;
        cancel() {
            if (this.cancelled) return;
            this.cancelled = true;
            for (const callback of [...this.handlers.values()]) callback();
        }
        is_cancelled() { return !!this.cancelled; }
        set_error_if_cancelled() { if (this.cancelled) throw Error('Cancelled'); }
        connect(callback) {
            const id = this.nextId++;
            this.handlers.set(id, callback);
            if (this.cancelled) callback();
            return id;
        }
        disconnect(id) { assert.ok(this.handlers.delete(id)); }
    };
    const sandbox = vm.createContext({
        ...context.protocol, ISSUER: 'https://auth.openai.com', RESOURCE: 'https://api.openai.com/v1',
        TextEncoder, TextDecoder,
        Gio: {Cancellable, BusType: {SESSION: 0}, DBusCallFlags: {NONE: 0},
            bus_get: (_type, _cancel, done) => done(null, bus), bus_get_finish: result => result},
        GLib: {Variant: class {}, VariantType: class {}, get_monotonic_time: () => 0,
            timeout_add(_priority, _duration, callback) { const id = nextTimer++; timers.set(id, callback); return id; },
            Source: {remove: id => assert.ok(timers.delete(id))}},
        Soup: {Session: class { abort() {} }},
        Secret: {
            Schema: class {}, SchemaFlags: {NONE: 0}, SchemaAttributeType: {STRING: 0}, COLLECTION_DEFAULT: 'default',
            password_lookup: (_schema, _attrs, _cancel, done) => done(null, JSON.stringify(stored)),
            password_lookup_finish: result => result,
            password_store: (_schema, _attrs, _collection, _label, value, _cancel, done) => {
                stored = JSON.parse(value); writes.push(stored); done(null, true);
            },
            password_store_finish: result => result,
        },
    });
    vm.runInContext(readFileSync(resolve(__dirname, '../chatgpt.js'), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class ChatGPTClient', 'globalThis.ChatGPTClient = class ChatGPTClient'), sandbox);
    const client = new sandbox.ChatGPTClient(settings);
    client._json = async (...args) => {
        requests.push(args);
        return {token_type: 'Bearer', access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600};
    };
    return {client, settings, stored: () => stored, writes, requests, cancellable: new Cancellable(),
        timers, bus, wait: vm.runInContext('wait', sandbox)};
}
test('simultaneous requests refresh once and atomically persist rotated tokens', async () => {
    const h = clientHarness();
    const results = await Promise.all([h.client._access(h.cancellable), h.client._access(h.cancellable)]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.writes.length, 1);
    assert.ok(results.every(result => result.token === 'new-access'));
    assert.equal(h.stored().profiles.saved.refresh_token, 'rotated-refresh');
    assert.equal(h.requests[0][1].client_id, 'saved');
    assert.equal(h.requests[0][1].resource, 'https://api.openai.com/v1');
    assert.equal(h.requests[0][1].scope, undefined);
});
test('invalid refresh grants clear credentials while preserving account registration', async () => {
    const h = clientHarness();
    h.client._json = async () => { throw Object.assign(Error('Expired'), {oauthCode: 'invalid_grant'}); };
    await assert.rejects(h.client._access(h.cancellable), /Expired/);
    assert.equal(h.stored().profiles.saved.client_id, 'saved');
    assert.equal(h.stored().profiles.saved.subject, 'user');
    assert.equal(h.stored().profiles.saved.refresh_token, undefined);
});
test('transient refresh errors preserve the previous credentials', async () => {
    const h = clientHarness();
    h.client._json = async () => { throw Error('Offline'); };
    await assert.rejects(h.client._access(h.cancellable), /Offline/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.stored().profiles.saved.refresh_token, 'old-refresh');
});
test('sign-out clears local tokens even if remote revocation is unavailable', async () => {
    const h = clientHarness();
    h.client._json = async () => { throw Error('Offline'); };
    assert.equal((await h.client.signOut('saved')).revoked, false);
    assert.equal(h.stored().profiles.saved.access_token, undefined);
    assert.equal(h.stored().profiles.saved.refresh_token, undefined);
    assert.equal(h.stored().profiles.saved.client_id, 'saved');
});
test('account picker never exposes tokens', async () => {
    const h = clientHarness();
    const accounts = await h.client.accounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, 'saved');
    assert.doesNotMatch(JSON.stringify(accounts), /old-access|old-refresh/);
});
test('model list preserves service order and hides non-list models', async () => {
    const h = clientHarness();
    h.client._access = async () => ({id: 'saved', token: 'access'});
    h.client._json = async () => ({models: [{slug: 'z', display_name: 'Z', visibility: 'list'},
        {slug: 'hidden', visibility: 'hidden'}, {slug: 'a', visibility: 'list'}]});
    assert.equal(JSON.stringify(await h.client.models()), JSON.stringify([{id: 'z', name: 'Z'}, {id: 'a', name: 'a'}]));
    h.settings.get_string = () => 'changed';
    await assert.rejects(h.client.models(), /account changed/);
});
test('cancelled requests cannot read or update credentials', async () => {
    const h = clientHarness();
    h.cancellable.cancel();
    await assert.rejects(h.client._access(h.cancellable), /Cancelled/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
});

function streamingHarness(chunks, status = 200) {
    const h = clientHarness();
    h.client._access = async () => ({id: 'saved', token: 'access'});
    h.client._message = (url, body, token) => {
        h.requests.push({url, body, token});
        return {status_code: status};
    };
    let closed = false;
    const stream = {
        read_bytes_async(_size, _priority, cancellable, callback) {
            cancellable.set_error_if_cancelled();
            const data = new TextEncoder().encode(chunks.shift() ?? '');
            callback(this, {get_data: () => data, get_size: () => data.length});
        },
        read_bytes_finish: result => result,
        close_async(_priority, _cancel, callback) { closed = true; callback(this, true); },
        close_finish: result => result,
    };
    h.client.session.send_async = (_message, _priority, _cancellable, callback) => callback(h.client.session, stream);
    h.client.session.send_finish = result => result;
    return {...h, closed: () => closed};
}
test('ChatGPT inference sends only supported request fields and closes its stream', async () => {
    const h = streamingHarness([completed('Fixed text')]);
    assert.equal(await h.client.transform('Source text', 'Correct grammar', 'model'), 'Fixed text');
    assert.equal(h.closed(), true);
    assert.equal(h.requests[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(JSON.stringify(h.requests[0].body), JSON.stringify({model: 'model', instructions: 'Correct grammar',
        input: [{role: 'user', content: 'Source text'}], store: false, stream: true}));
});
test('ChatGPT inference closes a disconnected stream without returning partial text', async () => {
    const h = streamingHarness([event({type: 'response.output_text.delta', delta: 'partial'})]);
    await assert.rejects(h.client.transform('Source', 'Correct', 'model'), /Nothing was replaced/);
    assert.equal(h.closed(), true);
});
test('ChatGPT thinking effort applies independently of the action instructions', async () => {
    for (const effort of ['auto', 'low', 'medium', 'high']) {
        for (const instructions of ['Correct grammar', 'Rewrite', 'Answer a question', 'Custom prompt']) {
            const h = streamingHarness([completed('Result')]);
            h.settings.get_string = key => key === 'chatgpt-thinking-effort' ? effort : 'saved';
            assert.equal(await h.client.transform('Source', instructions, 'model'), 'Result');
            const body = h.requests[0].body;
            assert.equal(body.instructions, instructions);
            assert.equal(body.reasoning?.effort, effort === 'auto' ? undefined : effort);
            assert.equal(Object.hasOwn(body, 'reasoning'), effort !== 'auto');
            assert.equal(h.closed(), true);
        }
    }
});
test('unsupported thinking effort gives actionable feedback and closes the stream', async () => {
    for (const param of ['reasoning', 'reasoning.effort']) {
        const h = streamingHarness([JSON.stringify({error: {param, code: 'unsupported_value'}})], 400);
        h.settings.get_string = key => key === 'chatgpt-thinking-effort' ? 'high' : 'saved';
        await assert.rejects(h.client.transform('Source', 'Rewrite', 'model'), /Set Thinking effort to Auto/);
        assert.equal(h.closed(), true);
        assert.equal(h.requests.length, 1);
    }
});
test('ChatGPT inference translates HTTP usage errors and closes the stream', async () => {
    const h = streamingHarness([JSON.stringify({error: {code: 'subscription_sharing_usage_unavailable'}})], 400);
    await assert.rejects(h.client.transform('Source', 'Correct', 'model'), /Manage usage/);
    assert.equal(h.closed(), true);
});


test('real GJS verifies RSA signatures with GLib SHA256', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'plyph-native-jwt-'));
    try {
        const fixture = resolve(temporary, 'fixture.json');
        writeFileSync(fixture, JSON.stringify({token: jwt(), key: jwk}));
        const script = resolve(temporary, 'check.js');
        const moduleURL = pathToFileURL(resolve(__dirname, '../chatgptProtocol.js')).href;
        writeFileSync(script, `
import GLib from 'gi://GLib';
import {verifyIdToken, base64url, sha256} from ${JSON.stringify(moduleURL)};
const data = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[0])[1]));
const claims = verifyIdToken(data.token, [data.key], 'client-test', 'test-nonce', 'user-test', 1000);
if (claims.sub !== 'user-test') throw Error('Invalid verified subject');
if (base64url(sha256(new TextEncoder().encode('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))) !==
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM') throw Error('Invalid native PKCE');
let rejected = false;
try { verifyIdToken(data.token, [data.key], 'wrong-client', 'test-nonce', 'user-test', 1000); } catch { rejected = true; }
if (!rejected) throw Error('Wrong audience accepted');
print('passed');
`);
        assert.equal(execFileSync('gjs', ['-m', script, fixture], {encoding: 'utf8'}).trim(), 'passed');
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});


test('UTF-8 streaming preserves every byte split, including emoji and BOM characters', () => {
    const bytes = new TextEncoder().encode('Hello Grüße 日本語 🌍 \uFEFF done');
    for (let split = 0; split <= bytes.length; split++) {
        const decoder = new context.protocol.Utf8StreamDecoder();
        const result = decoder.decode(bytes.slice(0, split)) + decoder.decode(bytes.slice(split)) + decoder.finish();
        assert.equal(result, 'Hello Grüße 日本語 🌍 \uFEFF done');
    }
});

test('UTF-8 streaming rejects truncated or invalid byte sequences', () => {
    for (const bytes of [[0xf0, 0x9f], [0xc0, 0xaf], [0xff], [0xed, 0xa0, 0x80]]) {
        const decoder = new context.protocol.Utf8StreamDecoder();
        assert.throws(() => { decoder.decode(new Uint8Array(bytes)); decoder.finish(); });
    }
});

test('real GJS consumes a streamed response through the native client', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'plyph-native-stream-'));
    try {
        const script = resolve(temporary, 'check.js');
        const moduleURL = pathToFileURL(resolve(__dirname, '../chatgpt.js')).href;
        writeFileSync(script, `
import GLib from 'gi://GLib';
import {ChatGPTClient} from ${JSON.stringify(moduleURL)};
const client = new ChatGPTClient({get_string: () => 'test-account'});
client._access = async () => ({id: 'test-account', token: 'test-token'});
client._message = () => ({status_code: 200});
const data = new TextEncoder().encode(${JSON.stringify(event({type: 'response.output_item.done', output_index: 0, item: {type: 'message', content: [{type: 'output_text', text: 'Grüße 🌍 日本語'}]}}) + event({type: 'response.completed', response: {status: 'completed', output: []}}))});
let index = 0;
let closed = false;
const stream = {
    read_bytes_async(_size, _priority, _cancel, done) { done(this, new GLib.Bytes(data.slice(index, ++index))); },
    read_bytes_finish(result) { return result; },
    close_async(_priority, _cancel, done) { closed = true; done(this, true); },
    close_finish(result) { return result; },
};
client.session.abort();
client.session = {
    send_async(_message, _priority, _cancel, done) { done(this, stream); },
    send_finish(result) { return result; },
    abort() {},
};
try {
    const output = await client.transform('Source', 'Correct grammar', 'test-model');
    if (output !== 'Grüße 🌍 日本語' || !closed) throw Error('Streaming result or cleanup failed');
    print('passed');
} finally { client.destroy(); }
`);
        assert.equal(execFileSync('gjs', ['-m', script], {encoding: 'utf8'}).trim(), 'passed');
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});


const streamedItem = (text, index = 0) => event({type: 'response.output_item.done', output_index: index,
    item: {type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}});
const emptyCompletion = event({type: 'response.completed', response: {status: 'completed', output: []}});

test('SSE uses completed streamed items when the terminal event has an empty output array', () => {
    const parser = new ResponsesStream();
    parser.feed(event({type: 'response.output_text.delta', delta: 'partial'}));
    parser.feed(streamedItem('second', 1));
    parser.feed(streamedItem('first ', 0));
    parser.feed(streamedItem('first ', 0));
    parser.feed(emptyCompletion);
    assert.equal(parser.finish(), 'first second');
});

test('completed streamed items still require successful response completion', () => {
    for (const terminal of ['', 'data: [DONE]\n\n', event({type: 'response.failed'}), event({type: 'response.incomplete'})]) {
        const parser = new ResponsesStream();
        assert.throws(() => { parser.feed(streamedItem('Do not return')); parser.feed(terminal); parser.finish(); });
    }
});

test('terminal output takes precedence over streamed items without duplicating text', () => {
    const parser = new ResponsesStream();
    parser.feed(streamedItem('streamed'));
    parser.feed(completed('final'));
    assert.equal(parser.finish(), 'final');
});


test('cancelling a credential-lock wait removes its timer immediately', async () => {
    const h = clientHarness();
    const waiting = h.wait(100, h.cancellable);
    assert.equal(h.timers.size, 1);
    h.cancellable.cancel();
    assert.equal(h.timers.size, 0);
    await assert.rejects(waiting, /Cancelled/);
    assert.equal(h.cancellable.handlers.size, 0);
});

test('destroying a client during lock contention cancels work and disconnects external signals', async () => {
    const h = clientHarness();
    h.bus.call = function(...args) { args.at(-1)(this, {deep_unpack: () => [3]}); };
    const running = h.client._operation(cancel => h.client._access(cancel), h.cancellable);
    for (let i = 0; i < 30 && h.timers.size === 0; i++) await Promise.resolve();
    assert.equal(h.timers.size, 1);
    assert.equal(h.cancellable.handlers.size, 1);
    h.client.destroy();
    assert.equal(h.timers.size, 0);
    assert.equal(h.cancellable.handlers.size, 0);
    assert.equal(h.client.pending.size, 0);
    await assert.rejects(running, /Cancelled/);
    await assert.rejects(h.client.accounts(), /closed/);
    assert.equal(h.writes.length, 0);
});

test('real GJS removes the wait source synchronously on cancellation without deadlocking', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'plyph-native-cancel-'));
    try {
        const modulePath = resolve(temporary, 'client.js');
        const protocolURL = pathToFileURL(resolve(__dirname, '../chatgptProtocol.js')).href;
        writeFileSync(modulePath, readFileSync(resolve(__dirname, '../chatgpt.js'), 'utf8')
            .replace("'./chatgptProtocol.js'", JSON.stringify(protocolURL)) + '\nexport {wait};\n');
        const script = resolve(temporary, 'check.js');
        writeFileSync(script, `
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {wait} from './client.js';
const originalTimeout = GLib.timeout_add;
let sourceId;
GLib.timeout_add = (...args) => { sourceId = originalTimeout(...args); return sourceId; };
const cancellable = new Gio.Cancellable();
const waiting = wait(10000, cancellable);
if (!GLib.MainContext.default().find_source_by_id(sourceId)) throw Error('Missing wait source');
cancellable.cancel();
if (GLib.MainContext.default().find_source_by_id(sourceId)) throw Error('Source survived cancellation');
let rejected = false;
try { await waiting; } catch (error) { rejected = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED); }
if (!rejected) throw Error('Cancellation was not propagated');
print('passed');
`);
        assert.equal(execFileSync('gjs', ['-m', script], {encoding: 'utf8', timeout: 5000}).trim(), 'passed');
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});
