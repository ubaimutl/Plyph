import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {getApiKey} from './secrets.js';

const PROVIDER_NAMES = {
    ollama: 'Ollama',
    cloudflare: 'Cloudflare Workers AI',
    bai: 'B.AI',
    groq: 'Groq',
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
    cerebras: 'Cerebras',
    openai: 'OpenAI',
    'openai-compatible': 'OpenAI-compatible',
    vercel: 'Vercel AI Gateway',
};

function payload(text) {
    return `Transform only the text inside the tags.\nReturn only the transformed text.\n<text>\n${text}\n</text>`;
}

function messages(prompt, text, inputMode) {
    const items = [];
    if (prompt.trim())
        items.push({role: 'system', content: prompt});
    items.push({
        role: 'user',
        content: inputMode === 'prompt' ? text : payload(text),
    });
    return items;
}

function tokenLimit(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

function maxTokens(text, outputLimit = 0) {
    return tokenLimit(outputLimit) ||
        Math.min(2000, Math.max(1000, estimateTokens(text) + 180));
}

function cleanOutput(text, inputMode = 'transform') {
    let output = text.trim();
    if (inputMode === 'prompt')
        return output;
    const tagged = output.match(/^<text>\s*([\s\S]*?)\s*<\/text>$/i);
    if (tagged)
        output = tagged[1].trim();
    const fenced = output.match(/^```(?:text)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fenced)
        output = fenced[1].trim();
    return output;
}

function debugEndpoint(url) {
    try {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const port = uri.get_port();
        return `${uri.get_scheme()}://${uri.get_host()}${port >= 0 ? `:${port}` : ''}${uri.get_path()}`;
    } catch {
        return 'invalid endpoint';
    }
}

function debugLog(settings, message) {
    if (settings?.get_boolean('debug-logging'))
        console.debug(`[Plyph] ${message}`);
}

function requestJson(session, url, headers, body, cancellable, settings = null) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('POST', url);
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(JSON.stringify(body)));
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
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
                debugLog(settings,
                    `AI response: status=${message.status_code}, endpoint=${debugEndpoint(url)}`);
                resolve({status: message.status_code, data});
            } catch (error) {
                reject(error);
            }
        });
    });
}

function openAiBody(model, prompt, text, inputMode, outputLimit = 0, cerebras = false) {
    const body = {
        model,
        messages: messages(prompt, text, inputMode),
    };
    body[cerebras ? 'max_completion_tokens' : 'max_tokens'] = maxTokens(text, outputLimit);
    return body;
}

function providerError(result, provider, model) {
    const name = PROVIDER_NAMES[provider] ?? 'Provider';
    const providerDetail = result.data?.error?.message ?? result.data?.error;
    const detail = typeof providerDetail === 'string' ? providerDetail : '';
    if (result.status === 401 || result.status === 403)
        return new Error(provider === 'cloudflare'
            ? 'Cloudflare rejected the API token or Account ID. Check them in Settings.'
            : `${name} rejected the API key. Check it in Settings.`);
    if (result.status === 404)
        return new Error(provider === 'cloudflare'
            ? `Cloudflare could not find the account or model “${model}”.`
            : `${name} could not find model “${model}”.`);
    if (result.status === 408)
        return new Error(`${name} timed out. Try again.`);
    if (result.status === 429)
        return new Error(`${name} rate limit reached. Wait and try again.`);
    if (result.status >= 500)
        return new Error(`${name} is temporarily unavailable (${result.status}).`);
    if (result.status >= 400)
        return new Error(detail || `${name} rejected the request (${result.status}).`);
    return new Error(detail || `${name} returned an unexpected response.`);
}

function networkError(error) {
    if (!(error instanceof GLib.Error))
        return error;
    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return new Error('The request timed out. Try again.');
    const offlineCodes = [
        Gio.IOErrorEnum.NETWORK_UNREACHABLE,
        Gio.IOErrorEnum.HOST_UNREACHABLE,
        Gio.IOErrorEnum.NOT_CONNECTED,
        Gio.IOErrorEnum.CONNECTION_REFUSED,
    ];
    if (offlineCodes.some(code => error.matches(Gio.IOErrorEnum, code)))
        return new Error('Could not connect. Check your internet connection or local server.');
    return error;
}

function outputLimitError() {
    return new Error(
        'Response reached the output limit. Try a custom action with a higher output limit, or select less text.');
}

function outputOrError(result, provider, model, inputMode) {
    if (result.data?.choices?.[0]?.finish_reason === 'length')
        throw outputLimitError();
    const output = result.data?.choices?.[0]?.message?.content?.trim();
    if (output)
        return cleanOutput(output, inputMode);
    throw providerError(result, provider, model);
}

async function optionalApiKey(settings, provider, cancellable = null) {
    try {
        return await getApiKey(settings, provider, cancellable);
    } catch (error) {
        if (error instanceof GLib.Error &&
            error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw error;
        return settings.get_string(`${provider}-api-key`).trim();
    }
}

export class AiClient {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({timeout: 45});
        this._cancellable = null;
    }

    cancel() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    destroy() {
        this.cancel();
        this._session.abort();
        this._session = null;
        this._settings = null;
    }

    async transform(text, mode, customPrompt = null, options = {}) {
        this.cancel();
        const inputMode = mode === 'prompt' || options.inputMode === 'prompt'
            ? 'prompt'
            : 'transform';
        const hasActionLimits = mode === 'custom' || mode === 'prompt';
        const inputLimit = hasActionLimits ? tokenLimit(options.inputLimit) : 0;
        const estimatedTokens = estimateTokens(text);
        if (inputLimit && estimatedTokens > inputLimit) {
            throw new Error(
                `Selected text is about ${estimatedTokens} tokens, above this action's ` +
                `${inputLimit}-token input limit. Select less text or raise the limit.`);
        }
        let outputLimit = hasActionLimits ? tokenLimit(options.outputLimit) : 0;
        if (inputMode === 'prompt' && !outputLimit)
            outputLimit = 2000;
        this._cancellable = new Gio.Cancellable();
        const selectedProvider = options.provider || this._settings.get_string('provider');
        const provider = PROVIDER_NAMES[selectedProvider] ? selectedProvider : 'groq';
        const model = options.model || this._settings.get_string(`${provider}-model`);
        const promptKey = mode === 'rewrite'
            ? 'prompt-rewrite'
            : mode === 'prompt' ? 'prompt-run' : 'prompt-correct';
        const storedPrompt = this._settings.get_string(promptKey);
        const prompt = this._expandPrompt(customPrompt ?? storedPrompt, text);
        debugLog(this._settings,
            `AI request: provider=${provider}, model=${model}, action=${mode}, ` +
            `input-tokens≈${estimatedTokens}, output-limit=${maxTokens(text, outputLimit)}`);
        try {
            if (provider === 'ollama')
                return await this._ollama(text, prompt, model, inputMode, outputLimit);
            if (provider === 'cloudflare')
                return await this._cloudflare(text, prompt, model, inputMode, outputLimit);
            if (provider === 'bai')
                return await this._bai(text, prompt, model, inputMode, outputLimit);
            if (provider === 'openai')
                return await this._openAi(text, prompt, model, inputMode, outputLimit);
            if (provider === 'openai-compatible')
                return await this._openAiCompatible(text, prompt, model, inputMode, outputLimit);
            if (provider === 'gemini')
                return await this._gemini(text, prompt, model, inputMode, outputLimit);
            if (provider === 'openrouter')
                return await this._openRouter(text, prompt, model, inputMode, outputLimit);
            if (provider === 'vercel')
                return await this._vercel(text, prompt, model, inputMode, outputLimit);
            if (provider === 'cerebras')
                return await this._cerebras(text, prompt, model, inputMode, outputLimit);
            return await this._groq(text, prompt, model, inputMode, outputLimit);
        } catch (error) {
            const normalizedError = networkError(error);
            debugLog(this._settings,
                `AI request failed: provider=${provider}, model=${model}, ` +
                `error=${normalizedError.name ?? 'Error'}`);
            throw normalizedError;
        }
    }

    _expandPrompt(prompt, text) {
        const values = {
            selection: text,
            language: this._settings.get_string('variable-language'),
            tone: this._settings.get_string('variable-tone'),
            style: this._settings.get_string('variable-style'),
        };
        return prompt.replace(/\$\{(selection|language|tone|style)\}/g,
            (_match, name) => values[name]);
    }

    async _required(provider) {
        const value = await getApiKey(this._settings, provider, this._cancellable);
        if (!value)
            throw new Error(provider === 'cloudflare'
                ? 'Add a Cloudflare Workers AI API token in Settings.'
                : `Add a ${PROVIDER_NAMES[provider]} API key in Settings.`);
        return value;
    }

    async _groq(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('groq');
        const body = openAiBody(model, prompt, text, inputMode, outputLimit);
        if (model.startsWith('openai/gpt-oss-')) {
            body.reasoning_effort = 'low';
            body.include_reasoning = false;
        }
        const result = await requestJson(this._session,
            'https://api.groq.com/openai/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            body, this._cancellable, this._settings);
        return outputOrError(result, 'groq', model, inputMode);
    }

    async _cloudflare(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('cloudflare');
        const accountId = this._settings.get_string('cloudflare-account-id').trim();
        if (!accountId)
            throw new Error('Add your Cloudflare Account ID in Settings.');
        const result = await requestJson(this._session,
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
            {Authorization: `Bearer ${key}`},
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'cloudflare', model, inputMode);
    }

    async _bai(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('bai');
        const result = await requestJson(this._session,
            'https://api.b.ai/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'bai', model, inputMode);
    }

    async _ollama(text, prompt, model, inputMode, outputLimit) {
        const baseUrl = this._settings.get_string('ollama-url').replace(/\/$/, '');
        const body = {
            model,
            messages: messages(prompt, text, inputMode),
            stream: false,
        };
        if (outputLimit)
            body.options = {num_predict: outputLimit};
        const result = await requestJson(this._session,
            `${baseUrl}/api/chat`, {}, body, this._cancellable, this._settings);
        if (result.data?.done_reason === 'length')
            throw outputLimitError();
        const output = result.data?.message?.content?.trim();
        if (output)
            return cleanOutput(output, inputMode);
        throw providerError(result, 'ollama', model);
    }

    async _openAi(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('openai');
        const result = await requestJson(this._session,
            'https://api.openai.com/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'openai', model, inputMode);
    }

    async _openAiCompatible(text, prompt, model, inputMode, outputLimit) {
        const baseUrl = this._settings.get_string('openai-compatible-url').replace(/\/$/, '');
        const key = await optionalApiKey(this._settings, 'openai-compatible', this._cancellable);
        const headers = key ? {Authorization: `Bearer ${key}`} : {};
        const result = await requestJson(this._session,
            `${baseUrl}/chat/completions`,
            headers,
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'openai-compatible', model, inputMode);
    }

    async _gemini(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('gemini');
        const encodedModel = encodeURIComponent(model);
        const body = {
            contents: [{
                role: 'user',
                parts: [{text: inputMode === 'prompt' ? text : payload(text)}],
            }],
            generationConfig: {maxOutputTokens: maxTokens(text, outputLimit)},
        };
        if (prompt.trim())
            body.systemInstruction = {parts: [{text: prompt}]};
        const result = await requestJson(this._session,
            `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent?key=${encodeURIComponent(key)}`,
            {}, body, this._cancellable, this._settings);
        if (result.data?.candidates?.[0]?.finishReason === 'MAX_TOKENS')
            throw outputLimitError();
        const output = result.data?.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim();
        if (output)
            return cleanOutput(output, inputMode);
        throw providerError(result, 'gemini', model);
    }

    async _openRouter(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('openrouter');
        const result = await requestJson(this._session,
            'https://openrouter.ai/api/v1/chat/completions',
            {Authorization: `Bearer ${key}`, 'X-Title': 'Plyph'},
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'openrouter', model, inputMode);
    }

    async _vercel(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('vercel');
        const result = await requestJson(this._session,
            'https://ai-gateway.vercel.sh/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'vercel', model, inputMode);
    }

    async _cerebras(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('cerebras');
        const result = await requestJson(this._session,
            'https://api.cerebras.ai/v1/chat/completions',
            {Authorization: `Bearer ${key}`},
            openAiBody(model, prompt, text, inputMode, outputLimit, true), this._cancellable, this._settings);
        return outputOrError(result, 'cerebras', model, inputMode);
    }
}
