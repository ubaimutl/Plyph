export function readActions(settings) {
    const actions = JSON.parse(settings.get_string('custom-actions'));
    if (!Array.isArray(actions))
        return [];
    return actions
        .filter(action =>
            typeof action?.id === 'string' &&
            typeof action?.name === 'string' && action.name.trim() &&
            typeof action?.prompt === 'string' &&
            (action.prompt.trim() || action.inputMode === 'prompt'))
        .map(action => ({
            id: action.id,
            name: action.name,
            prompt: action.prompt,
            enabled: action.enabled !== false,
            provider: typeof action.provider === 'string' ? action.provider : '',
            model: typeof action.model === 'string' ? action.model : '',
            inputMode: action.inputMode === 'prompt' ? 'prompt' : 'transform',
            usePersonalPreferences: typeof action.usePersonalPreferences === 'boolean'
                ? action.usePersonalPreferences : true,
            inputLimit: Number.isSafeInteger(action.inputLimit) && action.inputLimit > 0
                ? action.inputLimit
                : 0,
            outputLimit: Number.isSafeInteger(action.outputLimit) && action.outputLimit > 0
                ? action.outputLimit
                : 0,
        }));
}

export function writeActions(settings, actions) {
    settings.set_string('custom-actions', JSON.stringify(actions));
}
