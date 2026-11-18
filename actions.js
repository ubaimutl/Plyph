export const ACTION_ICONS = [
    'system-run-symbolic', 'edit-find-symbolic', 'document-edit-symbolic',
    'tools-check-spelling-symbolic', 'dialog-question-symbolic', 'web-browser-symbolic',
    'accessories-text-editor-symbolic', 'utilities-terminal-symbolic', 'starred-symbolic',
    'view-list-symbolic', 'mail-message-new-symbolic',
    'edit-find-replace-symbolic', 'edit-copy-symbolic', 'document-new-symbolic',
    'format-text-bold-symbolic', 'format-text-italic-symbolic', 'format-text-underline-symbolic',
    'format-justify-left-symbolic', 'view-list-bullet-symbolic', 'view-list-ordered-symbolic',
    'media-view-subtitles-symbolic', 'document-send-symbolic', 'document-save-symbolic',
    'view-refresh-symbolic', 'view-pin-symbolic', 'go-jump-symbolic',
];

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
            icon: ACTION_ICONS.includes(action.icon) ? action.icon : ACTION_ICONS[0],
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
