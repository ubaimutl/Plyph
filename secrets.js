import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import {migrateProviders, readProviders, removeProvider, saveProvider, validateProvider, validateHeaders, PROVIDER_PRESETS} from './providers.js';

const KEY_SETTINGS = {
    cloudflare: 'cloudflare-api-key',
    bai: 'bai-api-key',
    groq: 'groq-api-key',
    gemini: 'gemini-api-key',
    openrouter: 'openrouter-api-key',
    cerebras: 'cerebras-api-key',
    openai: 'openai-api-key',
    'openai-compatible': 'openai-compatible-api-key',
    vercel: 'vercel-api-key',
};

function createSecretSchema() {
    return new Secret.Schema(
        'dev.ubai.Plyph.ApiKey',
        Secret.SchemaFlags.NONE,
        {provider: Secret.SchemaAttributeType.STRING});
}

function searchItems(provider, flags, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_search(
            createSecretSchema(),
            {provider},
            flags,
            cancellable,
            (_source, result) => {
                try {
                    resolve(Secret.password_search_finish(result) ?? []);
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

function openSecretService(cancellable) {
    return new Promise((resolve, reject) => {
        Secret.Service.get(Secret.ServiceFlags.OPEN_SESSION, cancellable, (_source, result) => {
            try { resolve(Secret.Service.get_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function unlockItems(service, items, cancellable) {
    return new Promise((resolve, reject) => {
        service.unlock(items, cancellable, (_source, result) => {
            try { resolve(service.unlock_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function defaultCollection(service, cancellable) {
    return new Promise((resolve, reject) => {
        Secret.Collection.for_alias(service, Secret.COLLECTION_DEFAULT, Secret.CollectionFlags.NONE,
            cancellable, (_source, result) => {
                try { resolve(Secret.Collection.for_alias_finish(result)); } catch (error) { reject(error); }
            });
    });
}

function loadSecrets(items, cancellable) {
    return new Promise((resolve, reject) => {
        Secret.Item.load_secrets(items, cancellable, (_source, result) => {
            try { resolve(Secret.Item.load_secrets_finish(result)); } catch (error) { reject(error); }
        });
    });
}

let interactiveLookupQueue = Promise.resolve();

function lockedKeyringError(provider) {
    const credential = provider.endsWith(':headers') ? 'custom headers are' : 'API key is';
    return new Error(`Your saved ${credential} locked. Unlock Passwords and Keys and try again.`);
}

async function lookupInteractive(provider, cancellable = null) {
    const previous = interactiveLookupQueue;
    let release;
    interactiveLookupQueue = new Promise(resolve => { release = resolve; });
    try {
        await previous;
        if (cancellable?.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Request cancelled');
        let items = await searchItems(provider, Secret.SearchFlags.ALL, cancellable);
        const service = await openSecretService(cancellable);
        if (!items.length) {
            const collection = await defaultCollection(service, cancellable);
            if (collection?.get_locked()) {
                await unlockItems(service, [collection], cancellable);
                if (collection.get_locked())
                    throw lockedKeyringError(provider);
                items = await searchItems(provider, Secret.SearchFlags.ALL, cancellable);
            }
            if (!items.length)
                return '';
        }
        const locked = items.filter(item => item.get_locked());
        if (locked.length) {
            await unlockItems(service, locked, cancellable);
            if (locked.some(item => item.get_locked()))
                throw lockedKeyringError(provider);
        }
        await loadSecrets(items, cancellable);
        const ordered = [...items].sort((a, b) => b.get_modified() - a.get_modified());
        for (const item of ordered) {
            if (item.get_locked())
                throw lockedKeyringError(provider);
            const password = item.get_secret()?.get_text();
            if (typeof password === 'string' && password.trim())
                return password;
        }
        throw lockedKeyringError(provider);
    } finally {
        release();
    }
}

async function lookupSaved(provider, cancellable = null) {
    const items = await searchItems(provider,
        Secret.SearchFlags.ALL | Secret.SearchFlags.LOAD_SECRETS, cancellable);
    for (const item of items) {
        const value = item.get_secret?.();
        const password = value?.get_text();
        if (password !== null && password !== undefined)
            return password;
    }
    if (items.length)
        throw lockedKeyringError(provider);
    const service = await openSecretService(cancellable);
    const collection = await defaultCollection(service, cancellable);
    if (collection?.get_locked())
        throw lockedKeyringError(provider);
    return '';
}

function store(provider, password, cancellable = null, label = null) {
    const schema = createSecretSchema();
    return new Promise((resolve, reject) => {
        Secret.password_store(
            schema,
            {provider},
            Secret.COLLECTION_DEFAULT,
            label ?? `Plyph ${provider} ${provider === 'cloudflare' ? 'API token' : 'API key'}`,
            password,
            cancellable,
            (_source, result) => {
                try {
                    resolve(Secret.password_store_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function clear(provider, cancellable = null) {
    const schema = createSecretSchema();
    return new Promise((resolve, reject) => {
        Secret.password_clear(schema, {provider}, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_clear_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function keyringError(error) {
    if (error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return error;
    return new Error('GNOME Keyring is unavailable. Start the Secret Service and try again.');
}

export async function getApiKey(settings, provider, cancellable = null, interactive = false) {
    const setting = KEY_SETTINGS[provider];
    if (!setting && !provider.startsWith('custom:'))
        throw new Error('Unknown provider credential.');

    let saved;
    try {
        saved = interactive
            ? await lookupInteractive(provider, cancellable)
            : await lookupSaved(provider, cancellable);
    } catch (error) {
        if (error instanceof Error && !(error instanceof GLib.Error))
            throw error;
        throw keyringError(error);
    }
    if (saved) {
        if (setting && settings.get_string(setting))
            settings.set_string(setting, '');
        return saved;
    }

    const legacy = setting ? settings.get_string(setting).trim() : '';
    if (!legacy)
        return '';
    if (!interactive)
        return legacy;

    try {
        await store(provider, legacy, cancellable);
    } catch (error) {
        throw keyringError(error);
    }
    settings.set_string(setting, '');
    return legacy;
}

export async function setApiKey(settings, provider, password, cancellable = null) {
    const setting = KEY_SETTINGS[provider];
    if (!setting && !provider.startsWith('custom:'))
        throw new Error('Unknown provider credential.');

    const value = password.trim();
    try {
        if (value)
            await store(provider, value, cancellable);
        else
            await clear(provider, cancellable);
    } catch (error) {
        throw keyringError(error);
    }
    if (setting)
        settings.set_string(setting, '');
}

export async function migrateProviderSettings(settings, cancellable) {
    migrateProviders(settings);
    if (settings.get_int('provider-migration-version') >= 1)
        return;

    const configured = [];
    for (const preset of PROVIDER_PRESETS) {
        const items = await searchItems(preset.id, Secret.SearchFlags.ALL, cancellable);
        if (cancellable.is_cancelled())
            return;
        if (items.length)
            configured.push(preset.id);
    }
    const service = await openSecretService(cancellable);
    const collection = await defaultCollection(service, cancellable);
    if (collection?.get_locked())
        return;
    migrateProviders(settings, configured, true);
}

export async function getProviderHeaders(profile, cancellable = null, interactive = false) {
    if (!profile.hasCustomHeaders)
        return {};
    const id = `${profile.id}:headers`;
    const saved = interactive ? await lookupInteractive(id, cancellable) : await lookupSaved(id, cancellable);
    if (!saved)
        throw new Error('Saved custom headers are missing. Open this provider in Settings and save them again.');
    let headers;
    try {
        headers = JSON.parse(saved);
    } catch {
        throw new Error('Saved custom headers could not be read. Open this provider in Settings.');
    }
    return validateHeaders(headers);
}

export async function setProviderHeaders(id, headers, cancellable = null) {
    const value = validateHeaders(headers);
    try {
        if (Object.keys(value).length)
            await store(`${id}:headers`, JSON.stringify(value), cancellable, 'Plyph custom provider headers');
        else
            await clear(`${id}:headers`, cancellable);
    } catch (error) {
        throw keyringError(error);
    }
}

export async function saveProviderConnection(settings, profile, credentials, cancellable) {
    const headers = validateHeaders(credentials.headers);
    const candidate = validateProvider({...profile,
        hasCustomHeaders: Object.keys(headers).length ? true : undefined}, false);
    const previous = readProviders(settings).find(item => item.id === profile.id);
    const oldKey = previous ? await getApiKey(settings, profile.id, cancellable, true) : '';
    const oldHeaders = previous ? await getProviderHeaders(previous, cancellable, true) : {};
    const keyChanged = oldKey !== credentials.apiKey.trim();
    const headersChanged = JSON.stringify(oldHeaders) !== JSON.stringify(headers);
    let keyAttempted = false;
    let headersAttempted = false;
    try {
        if (keyChanged) {
            keyAttempted = true;
            await setApiKey(settings, profile.id, credentials.apiKey, cancellable);
        }
        if (headersChanged) {
            headersAttempted = true;
            await setProviderHeaders(profile.id, headers, cancellable);
        }
        if (cancellable?.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Request cancelled');
        saveProvider(settings, candidate);
    } catch (error) {
        let restored = true;
        if (keyAttempted) {
            try { await setApiKey(settings, profile.id, oldKey); } catch { restored = false; }
        }
        if (headersAttempted) {
            try { await setProviderHeaders(profile.id, oldHeaders); } catch { restored = false; }
        }
        if (!restored)
            throw new Error('The provider could not be saved and some credentials could not be restored. Check this connection in Settings.');
        throw error;
    }
}

export async function deleteProvider(settings, id, cancellable) {
    const profile = readProviders(settings).find(item => item.id === id);
    if (!profile)
        throw new Error('This provider has already been removed.');
    const oldKey = await getApiKey(settings, id, cancellable, true);
    const oldHeaders = await getProviderHeaders(profile, cancellable, true);
    removeProvider(settings, id);
    try {
        await setApiKey(settings, id, '', cancellable);
        if (profile.hasCustomHeaders)
            await setProviderHeaders(id, {}, cancellable);
    } catch {
        try {
            if (oldKey)
                await setApiKey(settings, id, oldKey);
            if (profile.hasCustomHeaders)
                await setProviderHeaders(id, oldHeaders);
            if (!readProviders(settings).some(item => item.id === id))
                saveProvider(settings, profile);
        } catch {
            throw new Error('The provider was removed, but its credentials could not be cleaned up or its profile restored.');
        }
        throw new Error('The saved credentials could not be removed. The provider has been restored. Try again after unlocking Passwords and Keys.');
    }
}
