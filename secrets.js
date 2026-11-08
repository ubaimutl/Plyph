import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import {migrateProviders, readProviders, removeProvider, saveProvider, PROVIDER_PRESETS} from './providers.js';

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

function lookup(provider, cancellable = null) {
    const schema = createSecretSchema();
    return new Promise((resolve, reject) => {
        Secret.password_lookup(schema, {provider}, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function store(provider, password, cancellable = null) {
    const schema = createSecretSchema();
    return new Promise((resolve, reject) => {
        Secret.password_store(
            schema,
            {provider},
            Secret.COLLECTION_DEFAULT,
            `Plyph ${provider} ${provider === 'cloudflare' ? 'API token' : 'API key'}`,
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

export async function getApiKey(settings, provider, cancellable = null) {
    const setting = KEY_SETTINGS[provider];
    if (!setting && !provider.startsWith('custom:'))
        throw new Error('Unknown provider credential.');

    let saved;
    try {
        saved = await lookup(provider, cancellable);
    } catch (error) {
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
        const secret = await lookup(preset.id, cancellable);
        if (cancellable.is_cancelled())
            return;
        if (secret)
            configured.push(preset.id);
    }
    migrateProviders(settings, configured, true);
}

export async function deleteProvider(settings, id, cancellable) {
    const profile = readProviders(settings).find(item => item.id === id);
    if (!profile)
        throw new Error('This provider has already been removed.');
    removeProvider(settings, id);
    try {
        await setApiKey(settings, id, '', cancellable);
    } catch {
        try {
            if (!readProviders(settings).some(item => item.id === id))
                saveProvider(settings, profile);
        } catch {
            throw new Error('The provider was removed, but its saved key could not be cleaned up or its profile restored.');
        }
        throw new Error('The saved key could not be removed. The provider has been restored. Try again after unlocking Passwords and Keys.');
    }
}
