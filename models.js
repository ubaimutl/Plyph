import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {getApiKey} from './secrets.js';

export function compatibleEndpoint(settings, endpoint) {
    const base = settings.get_string('openai-compatible-url').trim().replace(/\/+$/, '');
    try {
        const uri = GLib.Uri.parse(base, GLib.UriFlags.NONE);
        if (!/^https?:\/\//i.test(base) || /\s/.test(base) ||
            !['http', 'https'].includes(uri.get_scheme()?.toLowerCase()) ||
            !uri.get_host() || uri.get_userinfo() !== null ||
            uri.get_query() !== null || uri.get_fragment() !== null)
            throw new Error('Invalid URL');
    } catch {
        throw new Error('Enter a valid HTTP or HTTPS base URL including /v1, without credentials, query parameters or a fragment.');
    }
    return `${base}/${endpoint}`;
}

export async function compatibleHeaders(settings, cancellable = null) {
    if (!settings.get_boolean('openai-compatible-auth'))
        return {};
    const key = await getApiKey(settings, 'openai-compatible', cancellable);
    if (!key)
        throw new Error('Add an API key or disable authentication for the local server in Settings.');
    return {Authorization: `Bearer ${key}`};
}

export const PROVIDERS = [
    {id: 'ollama', name: 'Ollama (local)', key: null},
    {id: 'openai-compatible', name: 'OpenAI-compatible (local)', key: 'openai-compatible-api-key'},
    {id: 'groq', name: 'Groq', key: 'groq-api-key'},
    {id: 'cloudflare', name: 'Cloudflare Workers AI', key: 'cloudflare-api-key'},
    {id: 'bai', name: 'B.AI', key: 'bai-api-key'},
    {id: 'gemini', name: 'Gemini', key: 'gemini-api-key'},
    {id: 'openrouter', name: 'OpenRouter', key: 'openrouter-api-key'},
    {id: 'cerebras', name: 'Cerebras', key: 'cerebras-api-key'},
    {id: 'openai', name: 'OpenAI', key: 'openai-api-key'},
    {id: 'vercel', name: 'Vercel AI Gateway', key: 'vercel-api-key'},
];

const activeSessions = new Set();
let requestGeneration = 0;

export function abortModelRequests() {
    requestGeneration++;
    for (const session of activeSessions)
        session.abort();
    activeSessions.clear();
}

function requestError(status, provider, detail) {
    if (status === 401 || status === 403)
        return new Error(provider === 'Cloudflare Workers AI'
            ? 'Cloudflare rejected the API token or Account ID. Check them and try again.'
            : `${provider} rejected the API key. Check it and try again.`);
    if (status === 404)
        return new Error(`${provider} model list is unavailable.`);
    if (status === 408)
        return new Error(`${provider} timed out. Try again.`);
    if (status === 429)
        return new Error(`${provider} rate limit reached. Wait and try again.`);
    if (status >= 500)
        return new Error(`${provider} is temporarily unavailable (${status}).`);
    return new Error(detail || `${provider} rejected the request (${status}).`);
}

function getJson(url, headers = {}, provider = 'Provider') {
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
                        throw new Error(`Invalid response (${message.status_code})`);
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
                    reject(new Error(`${provider} timed out. Try again.`));
                else if (error instanceof GLib.Error && [
                    Gio.IOErrorEnum.NETWORK_UNREACHABLE,
                    Gio.IOErrorEnum.HOST_UNREACHABLE,
                    Gio.IOErrorEnum.NOT_CONNECTED,
                    Gio.IOErrorEnum.CONNECTION_REFUSED,
                ].some(code => error.matches(Gio.IOErrorEnum, code)))
                    reject(new Error(`Could not connect to ${provider}.`));
                else
                    reject(error);
            } finally {
                activeSessions.delete(session);
                session.abort();
            }
        });
    });
}

async function requiredKey(settings, provider) {
    const value = await getApiKey(settings, provider);
    if (!value)
        throw new Error(provider === 'cloudflare'
            ? 'Add a Cloudflare Workers AI API token first.'
            : `Add a ${PROVIDERS.find(item => item.id === provider)?.name} API key first.`);
    return value;
}

function uniqueModels(models) {
    const seen = new Set();
    return models
        .filter(model => model.id && !seen.has(model.id) && seen.add(model.id))
        .map(model => ({id: model.id, name: model.name ?? model.id}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchModels(settings, provider) {
    const generation = requestGeneration;
    const ensureCurrent = () => {
        if (generation !== requestGeneration)
            throw new Error('Request cancelled');
    };
    let data;
    let models;
    if (provider === 'openai-compatible') {
        const url = compatibleEndpoint(settings, 'models');
        const headers = await compatibleHeaders(settings);
        ensureCurrent();
        data = await getJson(url, headers, 'OpenAI-compatible (local)');
        ensureCurrent();
        if (!Array.isArray(data?.data))
            throw new Error('The server returned an invalid model list. Enter a custom model ID instead.');
        models = data.data.filter(model => typeof model?.id === 'string' && model.id.trim())
            .map(model => ({id: model.id, name: model.id}));
    } else if (provider === 'ollama') {
        const baseUrl = settings.get_string('ollama-url').replace(/\/$/, '');
        data = await getJson(`${baseUrl}/api/tags`, {}, 'Ollama');
        models = (data.models ?? []).map(model => ({id: model.model ?? model.name, name: model.name}));
    } else if (provider === 'cloudflare') {
        const key = await requiredKey(settings, 'cloudflare');
        const accountId = settings.get_string('cloudflare-account-id').trim();
        if (!accountId)
            throw new Error('Add your Cloudflare Account ID first.');
        ensureCurrent();
        data = await getJson(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=${encodeURIComponent('Text Generation')}&hide_experimental=true&per_page=100`,
            {Authorization: `Bearer ${key}`}, 'Cloudflare Workers AI');
        models = (Array.isArray(data.result) ? data.result : []).map(model => ({
            id: model.name ?? model.id,
            name: model.name ?? model.id,
        }));
    } else if (provider === 'gemini') {
        const key = await requiredKey(settings, 'gemini');
        ensureCurrent();
        data = await getJson(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
            {}, 'Gemini');
        models = (data.models ?? [])
            .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
            .map(model => ({id: model.name.replace(/^models\//, ''), name: model.displayName}));
    } else {
        const info = PROVIDERS.find(item => item.id === provider);
        const key = provider === 'vercel'
            ? await requiredKey(settings, 'vercel')
            : info?.key ? await requiredKey(settings, provider) : '';
        ensureCurrent();
        const endpoints = {
            groq: 'https://api.groq.com/openai/v1/models',
            bai: 'https://api.b.ai/v1/models',
            openrouter: 'https://openrouter.ai/api/v1/models?output_modalities=text',
            cerebras: 'https://api.cerebras.ai/v1/models',
            openai: 'https://api.openai.com/v1/models',
            vercel: 'https://ai-gateway.vercel.sh/v1/models',
        };
        data = await getJson(endpoints[provider], key ? {Authorization: `Bearer ${key}`} : {}, info.name);
        models = (data.data ?? [])
            .filter(model => provider !== 'bai' ||
                !model.supported_endpoint_types || model.supported_endpoint_types.includes('openai'))
            .filter(model => model.type ? model.type === 'language' : true)
            .map(model => ({id: model.id, name: model.name ?? model.id}));
        if (provider === 'openai') {
            models = models.filter(model => /^(gpt-|o\d)/.test(model.id) &&
                !/(audio|image|realtime|search|transcribe|tts)/.test(model.id));
        } else if (provider === 'groq') {
            models = models.filter(model => !/(guard|whisper|tts)/i.test(model.id));
        }
    }
    ensureCurrent();
    return uniqueModels(models);
}
