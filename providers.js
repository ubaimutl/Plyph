import {readActions} from './actions.js';

export const BUILTIN_PROVIDERS = [
    {id: 'ollama', name: 'Ollama (local)'},
    {id: 'chatgpt', name: 'ChatGPT Account'},
    {id: 'cloudflare', name: 'Cloudflare Workers AI'},
    {id: 'gemini', name: 'Gemini'},
];

export const PROVIDER_PRESETS = [
    {id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1', adapter: 'groq'},
    {id: 'bai', name: 'B.AI', url: 'https://api.b.ai/v1', adapter: 'bai'},
    {id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', adapter: 'openrouter'},
    {id: 'cerebras', name: 'Cerebras', url: 'https://api.cerebras.ai/v1', adapter: 'cerebras'},
    {id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', adapter: 'openai'},
    {id: 'openai-compatible', name: 'OpenAI-compatible', url: 'http://127.0.0.1:1234/v1', adapter: ''},
    {id: 'vercel', name: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/v1', adapter: 'vercel'},
];

export function providerAdapter(profile) {
    const preset = PROVIDER_PRESETS.find(item => item.adapter && item.adapter === profile.adapter);
    if (!preset)
        return '';
    const endpoint = url => url.trim().replace(/\/+$/, '')
        .replace(/^(https?):\/\/([^/]+)/i, (_match, scheme, authority) => {
            const protocol = scheme.toLowerCase();
            const host = authority.toLowerCase().replace(protocol === 'https' ? /:443$/ : /:80$/, '');
            return `${protocol}://${host}`;
        });
    return endpoint(profile.url) === endpoint(preset.url) ? preset.adapter : '';
}

export function readProviders(settings) {
    let profiles;
    try {
        profiles = JSON.parse(settings.get_string('custom-providers'));
    } catch {
        throw new Error('Saved providers could not be read. Your settings have been kept.');
    }
    if (!Array.isArray(profiles))
        throw new Error('Saved providers have an invalid format. Your settings have been kept.');
    const ids = new Set(BUILTIN_PROVIDERS.map(item => item.id));
    return profiles.map(profile => {
        if (!profile || typeof profile.id !== 'string' || ids.has(profile.id) ||
            ![profile.name, profile.url, profile.model].every(value => typeof value === 'string') ||
            !(profile.id.startsWith('custom:') || PROVIDER_PRESETS.some(item => item.id === profile.id)))
            throw new Error('A saved provider is invalid. Your settings have been kept.');
        ids.add(profile.id);
        return {id: profile.id, name: profile.name, url: profile.url, model: profile.model,
            adapter: providerAdapter(profile)};
    });
}

export function validateProvider(profile, requireModel = true) {
    if (!profile.name.trim())
        throw new Error('Enter a provider name.');
    const url = profile.url.trim().replace(/\/+$/, '');
    const address = url.match(/^https?:\/\/(\[[0-9a-f:.]+\]|[^\s/:?#@]+)(?::([0-9]+))?(?:\/[^\s?#]*)?$/i);
    if (!address || (address[2] && (Number(address[2]) < 1 || Number(address[2]) > 65535)))
        throw new Error('Enter an HTTP or HTTPS base URL without credentials, a query, or a fragment.');
    if (requireModel && !profile.model.trim())
        throw new Error('Enter a default model.');
    return {...profile, name: profile.name.trim(), url, model: profile.model.trim(),
        adapter: providerAdapter({...profile, url})};
}

export function legacyProfile(settings, preset) {
    return {...preset, url: preset.id === 'openai-compatible'
        ? settings.get_string('openai-compatible-url') : preset.url,
    model: settings.get_string(`${preset.id}-model`)};
}

export function migrateProviders(settings, credentialIds = [], complete = false) {
    if (settings.get_int('provider-migration-version') >= 1)
        return;
    const profiles = readProviders(settings);
    const referenced = new Set([settings.get_string('provider'),
        settings.get_string('prompt-run-provider'), ...readActions(settings).map(action => action.provider),
        ...credentialIds]);
    for (const preset of PROVIDER_PRESETS) {
        const configured = ['model', 'api-key', ...(preset.id === 'openai-compatible' ? ['url'] : [])]
            .some(suffix => settings.get_user_value(`${preset.id}-${suffix}`) !== null);
        if ((referenced.has(preset.id) || configured) && !profiles.some(item => item.id === preset.id))
            profiles.push(legacyProfile(settings, preset));
    }
    if (JSON.stringify(profiles) !== settings.get_string('custom-providers') &&
        settings.set_string('custom-providers', JSON.stringify(profiles)) === false)
        throw new Error('Providers could not be saved. Your previous settings have been kept.');
    if (complete && settings.set_int('provider-migration-version', 1) === false)
        throw new Error('Provider migration could not be marked complete. It will retry next time.');
}

export function listProviders(settings) {
    const profiles = readProviders(settings);
    return [...BUILTIN_PROVIDERS, ...profiles];
}

export function providerLabels(providers) {
    return providers.map(profile => {
        const duplicates = providers.filter(item => item.name === profile.name);
        if (duplicates.length === 1)
            return profile.name;
        const label = `${profile.name} — ${profile.url ?? profile.id}`;
        const sameEndpoint = duplicates.filter(item => item.url === profile.url);
        if (sameEndpoint.length === 1)
            return label;
        let length = 8;
        while (sameEndpoint.some(item => item.id !== profile.id &&
            item.id.slice(-length) === profile.id.slice(-length)))
            length++;
        return `${profile.name} · ${profile.id.slice(-length)} — ${profile.url ?? profile.id}`;
    });
}

export function resolveProvider(settings, id) {
    let info = listProviders(settings).find(item => item.id === id);
    if (!info && settings.get_int('provider-migration-version') < 1) {
        const preset = PROVIDER_PRESETS.find(item => item.id === id);
        if (preset)
            info = legacyProfile(settings, preset);
    }
    if (!info)
        throw new Error('The selected provider no longer exists. Choose a provider in Settings or edit this action.');
    return info;
}

export function providerModel(settings, id) {
    const info = resolveProvider(settings, id);
    return info.url !== undefined ? info.model : settings.get_string(`${id}-model`);
}

export function saveProvider(settings, profile) {
    const value = validateProvider(profile, false);
    const profiles = readProviders(settings);
    const index = profiles.findIndex(item => item.id === value.id);
    if (index >= 0)
        profiles[index] = value;
    else
        profiles.push(value);
    if (settings.set_string('custom-providers', JSON.stringify(profiles)) === false)
        throw new Error('Providers could not be saved.');
}

export function setProviderModel(settings, id, model) {
    const profile = resolveProvider(settings, id);
    if (profile.url !== undefined)
        saveProvider(settings, {...profile, model});
    else
        settings.set_string(`${id}-model`, model);
}

export function providerReferences(settings, id) {
    const references = [];
    if (settings.get_string('provider') === id)
        references.push('Active provider');
    if (settings.get_string('prompt-run-provider') === id)
        references.push('Run selected prompt');
    for (const action of readActions(settings)) {
        if (action.provider === id)
            references.push(action.name);
    }
    return references;
}

export function removeProvider(settings, id) {
    const references = providerReferences(settings, id);
    if (references.length)
        throw new Error(`Choose another provider first for: ${references.join(', ')}.`);
    if (settings.set_string('custom-providers', JSON.stringify(readProviders(settings).filter(item => item.id !== id))) === false)
        throw new Error('The provider could not be removed.');
}
