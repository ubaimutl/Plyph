import {_, ngettext, format} from './i18n.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {resolveProvider, providerModel, validateProvider, mergeProviderHeaders, applyProviderOptions} from './providers.js';
import {getApiKey, getProviderHeaders} from './secrets.js';
import {ChatGPTClient} from './chatgpt.js';

const PROVIDER_NAMES = {
    ollama: 'Ollama',
    chatgpt: 'ChatGPT Account',
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

const PLAIN_TEXT_GUIDANCE = 'Output formatting: Use plain text by default. ' +
    'Do not add Markdown formatting such as headings, emphasis, links, tables, or code fences ' +
    'unless the user request or action instructions explicitly ask for Markdown, ' +
    'or the source text being transformed already contains Markdown. ' +
    'When transforming existing Markdown, preserve its formatting unless asked to change it. ' +
    'An explicit request for another output format, such as code, JSON, or HTML, takes precedence; ' +
    'return that format directly without surrounding Markdown fences unless requested. ' +
    'Keep normal paragraph breaks and do not mention these formatting instructions.';

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
                        throw new Error(format(_('Invalid response (%s)'), message.status_code));
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

function providerError(result, provider, model, displayName = null) {
    const name = displayName ?? PROVIDER_NAMES[provider] ?? _('Provider');
    const providerDetail = result.data?.error?.message ?? result.data?.error;
    const detail = typeof providerDetail === 'string' ? providerDetail : '';
    if (result.status === 401 || result.status === 403)
        return new Error(provider === "cloudflare"
            ? _('Cloudflare rejected the API token or Account ID. Check them in Settings.')
            : format(_('%s rejected the API key. Check it in Settings.'), name));
    if (result.status === 404)
        return new Error(provider === "cloudflare"
            ? format(_('Cloudflare could not find the account or model “%s”.'), model)
            : format(_('%s could not find model “%s”.'), name, model));
    if (result.status === 408)
        return new Error(format(_('%s timed out. Try again.'), name));
    if (result.status === 429)
        return new Error(format(_('%s rate limit reached. Wait and try again.'), name));
    if (result.status >= 500)
        return new Error(format(_('%s is temporarily unavailable (%s).'), name, result.status));
    if (result.status >= 400)
        return new Error(detail || format(_('%s rejected the request (%s).'), name, result.status));
    return new Error(detail || format(_('%s returned an unexpected response.'), name));
}

function networkError(error) {
    if (!(error instanceof GLib.Error))
        return error;
    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return new Error(_('The request timed out. Try again.'));
    const offlineCodes = [
        Gio.IOErrorEnum.NETWORK_UNREACHABLE,
        Gio.IOErrorEnum.HOST_UNREACHABLE,
        Gio.IOErrorEnum.NOT_CONNECTED,
        Gio.IOErrorEnum.CONNECTION_REFUSED,
    ];
    if (offlineCodes.some(code => error.matches(Gio.IOErrorEnum, code)))
        return new Error(_('Could not connect. Check your internet connection or local server.'));
    return error;
}

function outputLimitError(thinkingTokens = 0) {
    if (tokenLimit(thinkingTokens)) {
        return new Error(format(ngettext(
            'Response reached this action’s output limit, and the model used %d token of it for thinking. Raise the limit or set it to Auto.',
            'Response reached this action’s output limit, and the model used %d tokens of it for thinking. Raise the limit or set it to Auto.',
            thinkingTokens), thinkingTokens));
    }
    return new Error(
        _('Response reached the output limit. Try a custom action with a higher output limit, or select less text.'));
}

function outputOrError(result, provider, model, inputMode, displayName = null) {
    if (result.data?.choices?.[0]?.finish_reason === 'length')
        throw outputLimitError();
    const output = result.data?.choices?.[0]?.message?.content?.trim();
    if (output)
        return cleanOutput(output, inputMode);
    throw providerError(result, provider, model, displayName);
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
        this._chatgpt?.destroy();
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
                format(_('Selected text is about %s tokens, above this action\'s %s-token input limit. Select less text or raise the limit.'), estimatedTokens, inputLimit));
        }
        const explicitOutputLimit = hasActionLimits ? tokenLimit(options.outputLimit) : 0;
        const outputLimit = explicitOutputLimit || (inputMode === 'prompt' ? 2000 : 0);
        this._cancellable = new Gio.Cancellable();
        const selectedProvider = options.provider || this._settings.get_string('provider');
        const info = resolveProvider(this._settings, selectedProvider);
        const provider = info.id;
        const model = options.model || providerModel(this._settings, provider);
        if (info.url !== undefined && !model.trim())
            throw new Error(format(_('Choose a model for “%s” in Settings before running an action.'), info.name));
        const promptKey = mode === 'rewrite'
            ? 'prompt-rewrite'
            : mode === 'prompt' ? 'prompt-run' : 'prompt-correct';
        const storedPrompt = this._settings.get_string(promptKey);
        let prompt = this._expandPrompt(customPrompt ?? storedPrompt, text);
        const usePersonalPreferences = options.usePersonalPreferences ?? (mode === 'custom'
            ? true : this._settings.get_boolean(`${mode}-use-personal-preferences`));
        const personalPreferences = usePersonalPreferences ? this._settings.get_string('personal-preferences').trim() : '';
        if (personalPreferences) {
            prompt = 'Personal context about the user: ' + JSON.stringify(personalPreferences) + '\n' +
                'Use this background only when relevant to the current task; ignore unrelated details. ' +
                'Explicit action instructions and user requests take priority. ' +
                'Preserve meaning, facts, code and required output formats.\n\nAction instructions:\n' + prompt;
        }
        if (this._settings.get_boolean('prefer-plain-text'))
            prompt = [prompt, PLAIN_TEXT_GUIDANCE].filter(part => part.trim()).join('\n\n');
        const loggedOutputLimit = provider === 'chatgpt'
            ? 'managed by ChatGPT'
            : provider === 'gemini' && !explicitOutputLimit ? 'model default' : maxTokens(text, outputLimit);
        debugLog(this._settings,
            `AI request: provider=${provider}, model=${model}, action=${mode}, ` +
            `input-tokens≈${estimatedTokens}, output-limit=${loggedOutputLimit}`);
        try {
            if (info.url !== undefined)
                return await this._compatible(info, text, prompt, model, inputMode, outputLimit);
            if (provider === 'chatgpt') {
                if (hasActionLimits && tokenLimit(options.outputLimit))
                    throw new Error(_('ChatGPT does not support output token limits. Set this action’s output limit to Auto.'));
                this._chatgpt ??= new ChatGPTClient(this._settings);
                const result = await this._chatgpt.transform(inputMode === 'prompt' ? text : payload(text),
                    prompt, model, this._cancellable);
                return cleanOutput(result, inputMode);
            }
            if (provider === 'ollama')
                return await this._ollama(text, prompt, model, inputMode, outputLimit);
            if (provider === 'cloudflare')
                return await this._cloudflare(text, prompt, model, inputMode, outputLimit);
            if (provider === 'gemini')
                return await this._gemini(text, prompt, model, inputMode, explicitOutputLimit);
            throw new Error(_('Unsupported provider connection.'));
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
        const value = await getApiKey(this._settings, provider, this._cancellable, true);
        if (!value)
            throw new Error(provider === "cloudflare"
                ? _('Add a Cloudflare Workers AI API token in Settings.')
                : format(_('Add a %s API key in Settings.'), PROVIDER_NAMES[provider]));
        return value;
    }

    async _cloudflare(text, prompt, model, inputMode, outputLimit) {
        const key = await this._required('cloudflare');
        const accountId = this._settings.get_string('cloudflare-account-id').trim();
        if (!accountId)
            throw new Error(_('Add your Cloudflare Account ID in Settings.'));
        const result = await requestJson(this._session,
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
            {Authorization: `Bearer ${key}`},
            openAiBody(model, prompt, text, inputMode, outputLimit), this._cancellable, this._settings);
        return outputOrError(result, 'cloudflare', model, inputMode);
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

    async _compatible(info, text, prompt, model, inputMode, outputLimit) {
        const profile = validateProvider({...info, model});
        const cancellable = this._cancellable;
        const session = this._session;
        const key = await getApiKey(this._settings, info.id, cancellable, true);
        if (this._cancellable !== cancellable || cancellable.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Request cancelled');
        const defaults = key ? {Authorization: `Bearer ${key}`} : {};
        const customHeaders = info.hasCustomHeaders ? await getProviderHeaders(info, cancellable, true) : {};
        if (this._cancellable !== cancellable || cancellable.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Request cancelled');
        if (!key && !Object.keys(customHeaders).length &&
            ['groq', 'bai', 'openrouter', 'cerebras', 'openai', 'vercel'].includes(info.adapter))
            throw new Error(format(_('Add a %s API key in Settings.'), info.name));
        if (info.adapter === 'openrouter')
            defaults['X-Title'] = 'Plyph';
        const body = openAiBody(model, prompt, text, inputMode, outputLimit, info.adapter === 'cerebras');
        if (info.adapter === 'groq' && model.startsWith('openai/gpt-oss-')) {
            body.reasoning_effort = 'low';
            body.include_reasoning = false;
        }
        applyProviderOptions(profile, body);
        const headers = mergeProviderHeaders(defaults, customHeaders);
        const result = await requestJson(session, `${profile.url}/chat/completions`,
            headers, body, cancellable, this._settings);
        return outputOrError(result, info.id, model, inputMode, info.name);
    }

    async _gemini(text, prompt, model, inputMode, explicitOutputLimit) {
        const key = await this._required('gemini');
        const encodedModel = encodeURIComponent(model);
        const body = {
            contents: [{
                role: 'user',
                parts: [{text: inputMode === 'prompt' ? text : payload(text)}],
            }],
        };
        if (explicitOutputLimit)
            body.generationConfig = {maxOutputTokens: explicitOutputLimit};
        if (prompt.trim())
            body.systemInstruction = {parts: [{text: prompt}]};
        const result = await requestJson(this._session,
            `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent?key=${encodeURIComponent(key)}`,
            {}, body, this._cancellable, this._settings);
        if (result.data?.candidates?.[0]?.finishReason === 'MAX_TOKENS')
            throw outputLimitError(explicitOutputLimit ? result.data?.usageMetadata?.thoughtsTokenCount : 0);
        const output = result.data?.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim();
        if (output)
            return cleanOutput(output, inputMode);
        throw providerError(result, 'gemini', model);
    }

}
