import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';

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
    if (!setting)
        return '';

    let saved;
    try {
        saved = await lookup(provider, cancellable);
    } catch (error) {
        throw keyringError(error);
    }
    if (saved) {
        if (settings.get_string(setting))
            settings.set_string(setting, '');
        return saved;
    }

    const legacy = settings.get_string(setting).trim();
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
    if (!setting)
        return;

    const value = password.trim();
    try {
        if (value)
            await store(provider, value, cancellable);
        else
            await clear(provider, cancellable);
    } catch (error) {
        throw keyringError(error);
    }
    settings.set_string(setting, '');
}
