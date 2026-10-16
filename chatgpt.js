import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

import {ISSUER, RESOURCE, SCOPES, base64url, sha256, verifyIdToken, callbackResult, chatgptError, ResponsesStream, Utf8StreamDecoder} from './chatgptProtocol.js';

let credentialQueue = Promise.resolve();

function callAsync(object, method, finish, args) {
    return new Promise((resolve, reject) => {
        object[method](...args, (source, result) => {
            try {
                resolve(source[finish](result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function secretSchema() {
    return new Secret.Schema('dev.ubai.Plyph.ChatGPT', Secret.SchemaFlags.NONE,
        {application: Secret.SchemaAttributeType.STRING});
}

async function readCredentials(cancellable) {
    const value = await new Promise((resolve, reject) => {
        Secret.password_lookup(secretSchema(), {application: 'Plyph'}, cancellable, (_source, result) => {
            try { resolve(Secret.password_lookup_finish(result)); } catch (error) { reject(error); }
        });
    });
    if (!value)
        return {profiles: {}};
    try {
        const record = JSON.parse(value);
        if (!record.profiles || typeof record.profiles !== 'object' || Array.isArray(record.profiles))
            throw new Error();
        return record;
    } catch {
        throw new Error('The saved ChatGPT connection is invalid. Remove the Plyph ChatGPT item in Passwords and Keys.');
    }
}

async function saveCredentials(record, cancellable) {
    await new Promise((resolve, reject) => {
        Secret.password_store(secretSchema(), {application: 'Plyph'}, Secret.COLLECTION_DEFAULT,
            'Plyph ChatGPT accounts', JSON.stringify(record), cancellable, (_source, result) => {
                try {
                    if (!Secret.password_store_finish(result))
                        throw new Error('Could not save the ChatGPT connection.');
                    resolve();
                } catch (error) { reject(error); }
            });
    });
}

function randomToken() {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        const bytes = stream.read_bytes(32, null).get_data();
        if (bytes.length !== 32)
            throw new Error('Could not generate sign-in security values.');
        return base64url(bytes);
    } finally {
        stream.close(null);
    }
}

function form(values) {
    return Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

async function wait(milliseconds, cancellable) {
    cancellable.set_error_if_cancelled();
    let timer = null;
    let signal = null;
    try {
        await new Promise((resolve, reject) => {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                timer = null;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            signal = cancellable.connect(() => {
                if (timer !== null) {
                    GLib.Source.remove(timer);
                    timer = null;
                }
                try { cancellable.set_error_if_cancelled(); } catch (error) { reject(error); }
            });
        });
    } finally {
        if (timer !== null)
            GLib.Source.remove(timer);
        if (signal)
            cancellable.disconnect(signal);
    }
}

async function credentialsLocked(cancellable, action) {
    const previous = credentialQueue;
    let release;
    credentialQueue = new Promise(resolve => { release = resolve; });
    await previous;
    let connection;
    let owned = false;
    const name = 'org.gnome.Shell.Extensions.Plyph.ChatGPTCredentials';
    try {
        cancellable?.set_error_if_cancelled();
        connection = await new Promise((resolve, reject) => {
            Gio.bus_get(Gio.BusType.SESSION, cancellable, (_source, result) => {
                try { resolve(Gio.bus_get_finish(result)); } catch (error) { reject(error); }
            });
        });
        const deadline = GLib.get_monotonic_time() + 45000000;
        while (!owned) {
            cancellable?.set_error_if_cancelled();
            const result = await callAsync(connection, 'call', 'call_finish', [
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
                new GLib.Variant('(su)', [name, 4]), new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE, 5000, cancellable,
            ]);
            const [code] = result.deep_unpack();
            owned = code === 1 || code === 4;
            if (!owned) {
                if (GLib.get_monotonic_time() > deadline)
                    throw new Error('Another ChatGPT connection update is in progress. Try again.');
                await wait(100, cancellable);
            }
        }
        return await action();
    } finally {
        try {
            if (owned)
                await callAsync(connection, 'call', 'call_finish', [
                    'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReleaseName',
                    new GLib.Variant('(s)', [name]), new GLib.VariantType('(u)'),
                    Gio.DBusCallFlags.NONE, 5000, null,
                ]);
        } finally {
            release();
        }
    }
}

export class ChatGPTClient {
    constructor(settings) {
        this.settings = settings;
        this.session = new Soup.Session({timeout: 90});
        this.pending = new Set();
        this.externalSignals = new Map();
        this.destroyed = false;
    }

    destroy() {
        this.destroyed = true;
        for (const [cancellable, {external, signal}] of this.externalSignals) {
            external.disconnect(signal);
            this.externalSignals.delete(cancellable);
        }
        for (const cancellable of this.pending)
            cancellable.cancel();
        this.pending.clear();
        this.session.abort();
    }

    async _operation(action, external = null) {
        if (this.destroyed)
            throw new Error('The ChatGPT connection was closed.');
        const cancellable = new Gio.Cancellable();
        this.pending.add(cancellable);
        const signal = external?.connect(() => cancellable.cancel());
        if (signal)
            this.externalSignals.set(cancellable, {external, signal});
        if (external?.is_cancelled())
            cancellable.cancel();
        try {
            return await action(cancellable);
        } finally {
            if (this.externalSignals.delete(cancellable))
                external.disconnect(signal);
            this.pending.delete(cancellable);
        }
    }

    _message(url, data = null, accessToken = null, encoded = false) {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        if (uri.get_scheme() !== 'https' || !['auth.openai.com', 'api.openai.com'].includes(uri.get_host()) ||
            uri.get_userinfo() || ![-1, 443].includes(uri.get_port()))
            throw new Error('Invalid ChatGPT service address.');
        const message = Soup.Message.new(data === null ? 'GET' : 'POST', url);
        message.set_flags(message.get_flags() | Soup.MessageFlags.NO_REDIRECT);
        if (accessToken)
            message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        if (data !== null)
            message.set_request_body_from_bytes(encoded ? 'application/x-www-form-urlencoded' : 'application/json',
                new GLib.Bytes(encoded ? form(data) : JSON.stringify(data)));
        return message;
    }

    async _json(url, data, cancellable, token = null, encoded = false) {
        const message = this._message(url, data, token, encoded);
        const bytes = await callAsync(this.session, 'send_and_read_async', 'send_and_read_finish',
            [message, GLib.PRIORITY_DEFAULT, cancellable]);
        let result = {};
        try {
            const text = new TextDecoder().decode(bytes.get_data());
            if (text.trim())
                result = JSON.parse(text);
        } catch {
            throw chatgptError(null, message.status_code);
        }
        if (message.status_code < 200 || message.status_code >= 300) {
            const code = typeof result.error === 'string' ? result.error : result.error?.code;
            const error = chatgptError(code, message.status_code);
            error.oauthCode = code;
            throw error;
        }
        return result;
    }

    async _validate(tokens, clientId, nonce, subject, cancellable) {
        const jwks = await this._json(`${ISSUER}/.well-known/jwks.json`, null, cancellable);
        return verifyIdToken(tokens.id_token, jwks.keys ?? [], clientId, nonce, subject);
    }

    _tokens(tokens, previous, identity = null) {
        const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : previous.scopes ?? [];
        if (tokens.token_type?.toLowerCase() !== 'bearer' || typeof tokens.access_token !== 'string' || !tokens.access_token ||
            !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
            (typeof (tokens.refresh_token ?? previous.refresh_token) !== 'string' || !(tokens.refresh_token ?? previous.refresh_token)))
            throw new Error('ChatGPT returned an incomplete connection. Please sign in again.');
        return {
            ...previous,
            subject: identity?.sub ?? previous.subject,
            email: identity?.email_verified === false ? '' : identity?.email ?? previous.email ?? '',
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token ?? previous.refresh_token,
            id_token: tokens.id_token ?? previous.id_token,
            expires_at: Date.now() / 1000 + tokens.expires_in,
            scopes,
        };
    }

    async accounts() {
        return this._operation(async cancellable => {
            const record = await readCredentials(cancellable);
            return Object.entries(record.profiles).map(([id, profile]) => ({
                id, label: `${profile.email || 'ChatGPT account'} · ${id.slice(-6)}`,
                connected: Boolean(profile.refresh_token),
                authorized: (profile.scopes ?? []).includes('chatgpt.tokens.use.direct'),
            }));
        });
    }

    async signIn(clientId = null, external = null) {
        return this._operation(async cancellable => {
            const prepared = await credentialsLocked(cancellable, async () => {
                const record = await readCredentials(cancellable);
                if (!record.host_id) {
                    record.host_id = `urn:uuid:${GLib.uuid_string_random()}`;
                    await saveCredentials(record, cancellable);
                }
                if (clientId && !record.profiles[clientId])
                    throw new Error('Select a saved ChatGPT account or add a new account.');
                return {host: record.host_id, previous: record.profiles[clientId]};
            });
            const state = randomToken();
            const nonce = randomToken();
            const verifier = randomToken();
            const server = new Soup.Server();
            server.listen(new Gio.InetSocketAddress({address: Gio.InetAddress.new_from_string('127.0.0.1'), port: 0}), 0);
            const port = server.get_uris()[0].get_port();
            const redirect = `http://127.0.0.1:${port}/auth/callback`;
            let timer = null;
            let cancelSignal = null;
            try {
                const callback = await new Promise((resolve, reject) => {
                    let finished = false;
                    const finish = (value, error = null) => {
                        if (finished) return;
                        finished = true;
                        if (timer !== null) {
                            GLib.Source.remove(timer);
                            timer = null;
                        }
                        if (error) reject(error); else resolve(value);
                    };
                    server.add_handler(null, (_server, message, path, query) => {
                        const valid = message.get_method() === 'GET' && path === '/auth/callback' &&
                            query?.state === state && message.get_request_headers().get_one('Host') === `127.0.0.1:${port}`;
                        message.get_response_headers().replace('Cache-Control', 'no-store');
                        message.get_response_headers().replace('Content-Security-Policy', "default-src 'none'");
                        message.set_status(valid ? 200 : 400, null);
                        message.set_response('text/plain; charset=utf-8', Soup.MemoryUse.COPY,
                            new TextEncoder().encode(valid ? 'Return to Plyph to finish connecting your ChatGPT account.' : 'Invalid sign-in callback.'));
                        if (!valid || finished) return;
                        try { finish(callbackResult(query, state, clientId)); } catch (error) { finish(null, error); }
                    });
                    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 180, () => {
                        timer = null;
                        finish(null, new Error('ChatGPT sign-in timed out. Try again.'));
                        return GLib.SOURCE_REMOVE;
                    });
                    cancelSignal = cancellable.connect(() => {
                        if (timer !== null) {
                            GLib.Source.remove(timer);
                            timer = null;
                        }
                        server.disconnect();
                        finish(null, new Error('ChatGPT sign-in cancelled.'));
                    });
                    if (cancellable.is_cancelled()) {
                        finish(null, new Error('ChatGPT sign-in cancelled.'));
                        return;
                    }
                    const params = {
                        client_id: clientId ?? 'dynamic_agent_client', ext_agent_host_id: prepared.host,
                        response_type: 'code', redirect_uri: redirect, scope: SCOPES, resource: RESOURCE,
                        state, nonce, code_challenge_method: 'S256',
                        code_challenge: base64url(sha256(new TextEncoder().encode(verifier))),
                    };
                    if (!clientId) params.agent_name_hint = 'Plyph';
                    else if (prepared.previous.email) params.login_hint = prepared.previous.email;
                    Gio.AppInfo.launch_default_for_uri_async(`${ISSUER}/api/accounts/authorize?${form(params)}`,
                        null, cancellable, (_source, result) => {
                            try { Gio.AppInfo.launch_default_for_uri_finish(result); } catch { finish(null, new Error('Could not open your browser.')); }
                        });
                });
                const tokens = await this._json(`${ISSUER}/api/accounts/oauth/token`, {
                    grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code,
                    code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE,
                }, cancellable, null, true);
                const identity = await this._validate(tokens, callback.clientId, nonce, prepared.previous?.subject ?? null, cancellable);
                const profile = this._tokens(tokens, {client_id: callback.clientId}, identity);
                await credentialsLocked(cancellable, async () => {
                    const record = await readCredentials(cancellable);
                    const existing = record.profiles[callback.clientId];
                    if (existing && existing.subject !== profile.subject)
                        throw new Error('The ChatGPT account identity changed. Add it as a new account.');
                    record.profiles[callback.clientId] = profile;
                    await saveCredentials(record, cancellable);
                });
                return {id: callback.clientId, authorized: profile.scopes.includes('chatgpt.tokens.use.direct')};
            } finally {
                server.disconnect();
                if (timer) GLib.Source.remove(timer);
                if (cancelSignal) cancellable.disconnect(cancelSignal);
            }
        }, external);
    }

    async _access(cancellable) {
        const id = this.settings.get_string('chatgpt-account-id');
        if (!id)
            throw new Error('Continue with ChatGPT in Plyph settings first.');
        return credentialsLocked(cancellable, async () => {
            const record = await readCredentials(cancellable);
            let profile = record.profiles[id];
            if (!profile?.refresh_token)
                throw new Error('Continue with ChatGPT in Plyph settings to reconnect.');
            if (!profile.scopes?.includes('chatgpt.tokens.use.direct'))
                throw new Error('ChatGPT plan access was not granted. Continue with ChatGPT and allow plan usage.');
            if (!profile.access_token || profile.expires_at < Date.now() / 1000 + 60) {
                try {
                    const tokens = await this._json(`${ISSUER}/api/accounts/oauth/token`, {
                        grant_type: 'refresh_token', client_id: id, refresh_token: profile.refresh_token, resource: RESOURCE,
                    }, cancellable, null, true);
                    const identity = tokens.id_token ? await this._validate(tokens, id, null, profile.subject, cancellable) : null;
                    profile = this._tokens(tokens, profile, identity);
                    record.profiles[id] = profile;
                    await saveCredentials(record, cancellable);
                } catch (error) {
                    if (error.oauthCode === 'invalid_grant') {
                        record.profiles[id] = {client_id: id, subject: profile.subject, email: profile.email};
                        await saveCredentials(record, cancellable);
                    }
                    throw error;
                }
            }
            if (!profile.scopes.includes('chatgpt.tokens.use.direct'))
                throw new Error('ChatGPT plan access is not enabled for this connection.');
            return {id, token: profile.access_token};
        });
    }

    async signOut(id, external = null) {
        return this._operation(cancellable => credentialsLocked(cancellable, async () => {
            const record = await readCredentials(cancellable);
            const profile = record.profiles[id];
            if (!profile) return {revoked: true};
            let revoked = !profile.refresh_token;
            if (profile.refresh_token) {
                try {
                    const discovery = await this._json(`${ISSUER}/.well-known/openid-configuration`, null, cancellable);
                    if (!discovery.revocation_endpoint?.startsWith(`${ISSUER}/`))
                        throw new Error('Invalid revocation endpoint.');
                    await this._json(discovery.revocation_endpoint, {
                        token: profile.refresh_token, token_type_hint: 'refresh_token', client_id: id,
                    }, cancellable, null, true);
                    revoked = true;
                } catch {
                    cancellable.set_error_if_cancelled();
                }
            }
            record.profiles[id] = {client_id: id, subject: profile.subject, email: profile.email};
            await saveCredentials(record, cancellable);
            return {revoked};
        }), external);
    }

    async models(external = null) {
        return this._operation(async cancellable => {
            const access = await this._access(cancellable);
            const data = await this._json(`${RESOURCE}/models`, null, cancellable, access.token);
            if (this.settings.get_string('chatgpt-account-id') !== access.id)
                throw new Error('The ChatGPT account changed. Refresh models again.');
            return (data.models ?? []).filter(model => model.visibility === 'list' && typeof model.slug === 'string')
                .map(model => ({id: model.slug, name: model.display_name ?? model.slug}));
        }, external);
    }

    async transform(text, instructions, model, external = null) {
        if (!model)
            throw new Error('Choose a ChatGPT model in Plyph settings first.');
        return this._operation(async cancellable => {
            const access = await this._access(cancellable);
            const message = this._message(`${RESOURCE}/responses`, {
                model, instructions, input: [{role: 'user', content: text}], store: false, stream: true,
            }, access.token);
            const stream = await callAsync(this.session, 'send_async', 'send_finish',
                [message, GLib.PRIORITY_DEFAULT, cancellable]);
            try {
                if (message.status_code < 200 || message.status_code >= 300) {
                    let body = '';
                    const decoder = new Utf8StreamDecoder();
                    while (body.length < 65536) {
                        const bytes = await callAsync(stream, 'read_bytes_async', 'read_bytes_finish',
                            [4096, GLib.PRIORITY_DEFAULT, cancellable]);
                        if (!bytes.get_size()) break;
                        body += decoder.decode(bytes.get_data());
                    }
                    let code;
                    try { code = JSON.parse(body).error?.code; } catch {}
                    throw chatgptError(code, message.status_code);
                }
                const parser = new ResponsesStream();
                const decoder = new Utf8StreamDecoder();
                while (true) {
                    const bytes = await callAsync(stream, 'read_bytes_async', 'read_bytes_finish',
                        [8192, GLib.PRIORITY_DEFAULT, cancellable]);
                    if (!bytes.get_size()) break;
                    parser.feed(decoder.decode(bytes.get_data()));
                }
                parser.feed(decoder.finish());
                cancellable.set_error_if_cancelled();
                if (this.settings.get_string('chatgpt-account-id') !== access.id)
                    throw new Error('The ChatGPT account changed. Run the action again.');
                return parser.finish();
            } finally {
                await callAsync(stream, 'close_async', 'close_finish', [GLib.PRIORITY_DEFAULT, null]);
            }
        }, external);
    }
}
