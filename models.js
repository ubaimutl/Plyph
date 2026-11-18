import {_, format} from './i18n.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {resolveProvider, validateProvider, mergeProviderHeaders} from './providers.js';
import {getApiKey, getProviderHeaders} from './secrets.js';
import {ChatGPTClient} from './chatgpt.js';

const activeSessions = new Set();
const activeKeyRequests = new Set();
const activeChatGPTClients = new Set();
let requestGeneration = 0;

export function abortModelRequests() {
    requestGeneration++;
    for (const session of activeSessions)
        session.abort();
    activeSessions.clear();
    for (const cancellable of activeKeyRequests)
        cancellable.cancel();
    activeKeyRequests.clear();
    for (const client of activeChatGPTClients)
        client.destroy();
    activeChatGPTClients.clear();
}

function requestError(status, provider, detail) {
    if (status === 401 || status === 403)
        return new Error(provider === "Cloudflare Workers AI"
            ? _('Cloudflare rejected the API token or Account ID. Check them and try again.')
            : format(_('%s rejected the API key. Check it and try again.'), provider));
    if (status === 404)
        return new Error(format(_('%s model list is unavailable.'), provider));
    if (status === 408)
        return new Error(format(_('%s timed out. Try again.'), provider));
    if (status === 429)
        return new Error(format(_('%s rate limit reached. Wait and try again.'), provider));
    if (status >= 500)
        return new Error(format(_('%s is temporarily unavailable (%s).'), provider, status));
    return new Error(detail || format(_('%s rejected the request (%s).'), provider, status));
}

function getJson(url, headers = {}, provider = _('Provider')) {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({timeout: 20});
        const message = Soup.Message.new('GET', url);
        activeSessions.add(session);
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                let data = {};
                try {
                    data = JSON.parse(text);
                } catch {
                    if (message.status_code < 400)
                        throw new Error(format(_('Invalid response (%s)'), message.status_code));
                }
                if (message.status_code < 200 || message.status_code >= 300) {
                    const providerDetail = data?.error?.message ?? data?.error;
                    const detail = typeof providerDetail === 'string' ? providerDetail : '';
                    throw requestError(message.status_code, provider, detail);
                }
                resolve(data);
            } catch (error) {
                if (error instanceof GLib.Error &&
                    error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
                    reject(new Error(format(_('%s timed out. Try again.'), provider)));
                else if (error instanceof GLib.Error && [
                    Gio.IOErrorEnum.NETWORK_UNREACHABLE,
                    Gio.IOErrorEnum.HOST_UNREACHABLE,
                    Gio.IOErrorEnum.NOT_CONNECTED,
                    Gio.IOErrorEnum.CONNECTION_REFUSED,
                ].some(code => error.matches(Gio.IOErrorEnum, code)))
                    reject(new Error(format(_('Could not connect to %s.'), provider)));
                else
                    reject(error);
            } finally {
                activeSessions.delete(session);
                session.abort();
            }
        });
    });
}

async function modelKey(settings, provider, interactive = false) {
    const cancellable = new Gio.Cancellable();
    activeKeyRequests.add(cancellable);
    try {
        return await getApiKey(settings, provider, cancellable, interactive);
    } finally {
        activeKeyRequests.delete(cancellable);
    }
}

async function modelCredentials(settings, profile, interactive) {
    const cancellable = new Gio.Cancellable();
    activeKeyRequests.add(cancellable);
    try {
        const key = await getApiKey(settings, profile.id, cancellable, interactive);
        const headers = profile.hasCustomHeaders ? await getProviderHeaders(profile, cancellable, interactive) : {};
        return {key, headers};
    } finally {
        activeKeyRequests.delete(cancellable);
    }
}

async function requiredKey(settings, provider, interactive = false) {
    const value = await modelKey(settings, provider, interactive);
    if (!value)
        throw new Error(provider === "cloudflare"
            ? _('Add a Cloudflare Workers AI API token first.')
            : format(_('Add a %s API key first.'), resolveProvider(settings, provider).name));
    return value;
}

function uniqueModels(models) {
    const seen = new Set();
    return models
        .filter(model => model.id && !seen.has(model.id) && seen.add(model.id))
        .map(model => ({id: model.id, name: model.name ?? model.id}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchModels(settings, provider, interactive = false) {
    const info = resolveProvider(settings, provider);
    const generation = requestGeneration;
    const ensureCurrent = () => {
        if (generation !== requestGeneration)
            throw new Error(_('Request cancelled'));
    };
    if (provider === 'chatgpt') {
        const client = new ChatGPTClient(settings);
        activeChatGPTClients.add(client);
        try {
            const models = await client.models();
            ensureCurrent();
            return models;
        } finally {
            activeChatGPTClients.delete(client);
            client.destroy();
        }
    }
    let data;
    let models;
    if (provider === 'ollama') {
        const baseUrl = settings.get_string('ollama-url').replace(/\/$/, '');
        data = await getJson(`${baseUrl}/api/tags`, {}, 'Ollama');
        models = (data.models ?? []).map(model => ({id: model.model ?? model.name, name: model.name}));
    } else if (provider === 'cloudflare') {
        const key = await requiredKey(settings, 'cloudflare', interactive);
        const accountId = settings.get_string('cloudflare-account-id').trim();
        if (!accountId)
            throw new Error(_('Add your Cloudflare Account ID first.'));
        ensureCurrent();
        data = await getJson(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=${encodeURIComponent('Text Generation')}&hide_experimental=true&per_page=100`,
            {Authorization: `Bearer ${key}`}, 'Cloudflare Workers AI');
        models = (Array.isArray(data.result) ? data.result : []).map(model => ({
            id: model.name ?? model.id,
            name: model.name ?? model.id,
        }));
    } else if (provider === 'gemini') {
        const key = await requiredKey(settings, 'gemini', interactive);
        ensureCurrent();
        data = await getJson(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
            {}, 'Gemini');
        models = (data.models ?? [])
            .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
            .map(model => ({id: model.name.replace(/^models\//, ''), name: model.displayName}));
    } else {
        const profile = validateProvider(info, false);
        const credentials = await modelCredentials(settings, info, interactive);
        ensureCurrent();
        const suffix = info.adapter === 'openrouter' ? '/models?output_modalities=text' : '/models';
        const headers = mergeProviderHeaders(credentials.key ? {Authorization: `Bearer ${credentials.key}`} : {}, credentials.headers);
        data = await getJson(`${profile.url}${suffix}`, headers, info.name);
        models = (data.data ?? [])
            .filter(model => info.adapter !== 'bai' ||
                !model.supported_endpoint_types || model.supported_endpoint_types.includes('openai'))
            .filter(model => model.type ? model.type === 'language' : true)
            .map(model => ({id: model.id, name: model.name ?? model.id}));
        if (info.adapter === 'openai') {
            models = models.filter(model => /^(gpt-|o\d)/.test(model.id) &&
                !/(audio|image|realtime|search|transcribe|tts)/.test(model.id));
        } else if (info.adapter === 'groq') {
            models = models.filter(model => !/(guard|whisper|tts)/i.test(model.id));
        }
    }
    ensureCurrent();
    return uniqueModels(models);
}
