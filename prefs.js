import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {readActions, writeActions} from './actions.js';
import {abortModelRequests, fetchModels, PROVIDERS} from './models.js';
import {getApiKey, setApiKey} from './secrets.js';

const INPUT_LIMIT_VALUES = [0, 2000, 4000, 8000, 16000, 32000];
const INPUT_LIMIT_LABELS = ['Auto', '2K', '4K', '8K', '16K', '32K', 'Custom'];
const OUTPUT_LIMIT_VALUES = [0, 1000, 2000, 4000, 8000, 16000];
const OUTPUT_LIMIT_LABELS = ['Auto', '1K', '2K', '4K', '8K', '16K', 'Custom'];
const PROVIDER_FREE_USAGE = {
    cloudflare: 'Free tier includes 10,000 Neurons per day.',
    bai: 'DeepSeek V4 Flash is currently free. Availability and limits may change.',
    groq: 'Free plan available. Limits vary by model and account.',
    cerebras: 'Free plan available. Limits vary by model and account.',
    vercel: 'Free accounts receive $5 of AI Gateway credit every 30 days after the first request.',
};

function entry(group, settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function formatTokenLimit(value) {
    if (!value)
        return 'Auto';
    return value % 1000 === 0 ? `${value / 1000}K` : String(value);
}

function promptPreview(prompt, maximum = 140) {
    const compact = prompt.replace(/\s+/g, ' ').trim();
    const characters = Array.from(compact);
    if (characters.length <= maximum)
        return compact;
    return `${characters.slice(0, maximum).join('').trimEnd()}…`;
}

function tokenLimitControl(title, subtitle, values, labels, currentValue) {
    const value = Number.isSafeInteger(currentValue) && currentValue > 0
        ? currentValue
        : 0;
    const presetIndex = values.indexOf(value);
    const customIndex = values.length;
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(labels),
        selected: presetIndex >= 0 ? presetIndex : customIndex,
    });
    const custom = new Adw.EntryRow({
        title: `Custom ${title.toLowerCase()}`,
        text: value ? String(value) : '',
        input_purpose: Gtk.InputPurpose.DIGITS,
        visible: row.selected === customIndex,
    });
    row.connect('notify::selected', () => {
        custom.visible = row.selected === customIndex;
    });
    custom.connect('notify::text', () => custom.remove_css_class('error'));

    return {
        row,
        custom,
        value() {
            if (row.selected < values.length)
                return values[row.selected];
            const text = custom.text.trim();
            const parsed = /^\d+$/.test(text) ? Number(text) : 0;
            if (!Number.isSafeInteger(parsed) || parsed <= 0) {
                custom.add_css_class('error');
                custom.grab_focus();
                return null;
            }
            return parsed;
        },
    };
}

function bindTokenLimit(settings, key, control, values) {
    control.row.connect('notify::selected', () => {
        if (control.row.selected < values.length)
            settings.set_int64(key, values[control.row.selected]);
    });
    const saveCustom = () => {
        if (control.row.selected !== values.length)
            return;
        const value = control.value();
        if (value !== null)
            settings.set_int64(key, value);
    };
    control.custom.show_apply_button = true;
    control.custom.connect('apply', saveCustom);
    control.custom.connect('entry-activated', saveCustom);
}

export default class PlyphPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._keyCancellable = new Gio.Cancellable();
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const actionsPage = new Adw.PreferencesPage({
            title: 'Actions',
            icon_name: 'emblem-system-symbolic',
        });
        const promptsPage = new Adw.PreferencesPage({
            title: 'Prompts',
            icon_name: 'document-edit-symbolic',
        });

        const providerGroup = new Adw.PreferencesGroup({title: 'Provider'});
        const model = Gtk.StringList.new(PROVIDERS.map(item => item.name));
        const provider = new Adw.ComboRow({title: 'Active provider', model});
        provider.selected = Math.max(0, PROVIDERS.findIndex(item => item.id === settings.get_string('provider')));
        providerGroup.add(provider);
        generalPage.add(providerGroup);

        this._providerSettings = new Adw.PreferencesGroup({title: 'Provider settings'});
        this._providerRows = [];
        this._renderProviderSettings(settings);
        generalPage.add(this._providerSettings);
        provider.connect('notify::selected', () => {
            const selected = PROVIDERS[provider.selected];
            if (!selected)
                return;
            settings.set_string('provider', selected.id);
            this._renderProviderSettings(settings);
        });

        const runPrompt = new Adw.PreferencesGroup({
            title: 'Run selected prompt',
            description: 'Selected text is sent directly as the user instruction.',
        });
        const runProviderIds = ['', ...PROVIDERS.map(item => item.id)];
        const runProvider = new Adw.ComboRow({
            title: 'Provider override',
            model: Gtk.StringList.new([
                'Use active provider',
                ...PROVIDERS.map(item => item.name),
            ]),
        });
        runProvider.selected = Math.max(0,
            runProviderIds.indexOf(settings.get_string('prompt-run-provider')));
        const runModel = new Adw.EntryRow({
            title: 'Model override (optional)',
            text: settings.get_string('prompt-run-model'),
            sensitive: runProvider.selected > 0,
        });
        settings.bind('prompt-run-model', runModel, 'text', Gio.SettingsBindFlags.DEFAULT);
        runProvider.connect('notify::selected', () => {
            settings.set_string('prompt-run-provider',
                runProviderIds[runProvider.selected] ?? '');
            runModel.sensitive = runProvider.selected > 0;
        });
        const runInputLimit = tokenLimitControl(
            'Input limit',
            'Stops before sending when the selected prompt is over this estimate.',
            INPUT_LIMIT_VALUES,
            INPUT_LIMIT_LABELS,
            settings.get_int64('prompt-run-input-limit'));
        bindTokenLimit(settings, 'prompt-run-input-limit', runInputLimit, INPUT_LIMIT_VALUES);
        const runOutputLimit = tokenLimitControl(
            'Output limit',
            'Auto allows responses up to 2000 tokens.',
            OUTPUT_LIMIT_VALUES,
            OUTPUT_LIMIT_LABELS,
            settings.get_int64('prompt-run-output-limit'));
        bindTokenLimit(settings, 'prompt-run-output-limit', runOutputLimit, OUTPUT_LIMIT_VALUES);
        runPrompt.add(runProvider);
        runPrompt.add(runModel);
        runPrompt.add(runInputLimit.row);
        runPrompt.add(runInputLimit.custom);
        runPrompt.add(runOutputLimit.row);
        runPrompt.add(runOutputLimit.custom);
        actionsPage.add(runPrompt);

        this._quickActionsGroup = new Adw.PreferencesGroup({
            title: 'Toolbar Quick Actions',
            description: 'Select which actions appear in the floating toolbar.',
        });
        actionsPage.add(this._quickActionsGroup);

        const actions = new Adw.PreferencesGroup({
            title: 'Custom actions',
            description: 'Create actions for the panel menu. Use the Open actions shortcut for quick access.',
        });
        this._actionsGroup = actions;
        this._actionRows = [];
        this._renderActions(settings);
        actionsPage.add(actions);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click an action, then press the shortcut you want.',
        });
        this._shortcutRow(shortcuts, settings, 'ask-shortcut', 'Ask');
        this._shortcutRow(shortcuts, settings, 'correct-shortcut', 'Correct');
        this._shortcutRow(shortcuts, settings, 'rewrite-shortcut', 'Rewrite');
        this._shortcutRow(shortcuts, settings, 'actions-shortcut', 'Open actions');
        const palettePositions = ['disabled', 'monitor-center', 'near-pointer'];
        const actionPalette = new Adw.ComboRow({
            title: 'Action palette',
            subtitle: 'Choose where the Open actions shortcut displays actions.',
            model: Gtk.StringList.new(['Off', 'Active monitor center', 'Near pointer']),
        });
        actionPalette.selected = Math.max(0,
            palettePositions.indexOf(settings.get_string('action-palette-position')));
        actionPalette.connect('notify::selected', () => {
            settings.set_string('action-palette-position',
                palettePositions[actionPalette.selected] ?? 'disabled');
        });
        shortcuts.add(actionPalette);
        generalPage.add(shortcuts);

        const capture = new Adw.PreferencesGroup({
            title: 'Selection capture',
            description:
                'GNOME normally reads the PRIMARY selection. Some apps—especially ' +
                'Firefox on Wayland—do not update it reliably. For listed apps, ' +
                'Plyph sends Ctrl+C and reads the regular clipboard instead. ' +
                'This changes the clipboard. Avoid adding terminals unless Ctrl+C ' +
                'copies text there.',
        });
        entry(capture, settings, 'explicit-copy-apps', 'Compatibility apps');

        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});

        const showFloating = new Adw.SwitchRow({
            title: 'Show floating action button when selecting text',
            subtitle: 'An alternative to keyboard shortcuts.',
        });
        settings.bind('show-floating-button', showFloating, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(showFloating);

        const preview = new Adw.SwitchRow({
            title: 'Preview before replacing',
            subtitle: 'Confirm, copy, or cancel the generated result.',
        });
        settings.bind('preview-results', preview, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(preview);
        const clipboardFallback = new Adw.SwitchRow({
            title: 'Use clipboard when no text is selected',
            subtitle: 'Allow actions to use previously copied text.',
        });
        settings.bind('clipboard-fallback', clipboardFallback, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(clipboardFallback);
        const pointerFeedback = new Adw.SwitchRow({
            title: 'Show feedback near pointer',
            subtitle: 'Show progress, success, and errors inline via the floating toolbar.',
        });
        settings.bind('pointer-feedback', pointerFeedback, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(pointerFeedback);
        generalPage.add(behavior);
        generalPage.add(capture);

        const exclusion = new Adw.PreferencesGroup({
            title: 'Floating Button Exclusions',
            description: 'Comma-separated list of application IDs or WM_CLASS names where the floating button will be hidden.',
        });
        entry(exclusion, settings, 'excluded-apps', 'Excluded apps');
        generalPage.add(exclusion);

        const prompts = new Adw.PreferencesGroup({title: 'Built-in prompts'});
        entry(prompts, settings, 'prompt-correct', 'Correction prompt');
        entry(prompts, settings, 'prompt-rewrite', 'Rewrite prompt');
        entry(prompts, settings, 'prompt-run', 'Run-prompt system guidance');
        promptsPage.add(prompts);

        const variables = new Adw.PreferencesGroup({
            title: 'Prompt variables',
            description: 'Available as ${language}, ${tone}, ${style}, and ${selection}.',
        });
        entry(variables, settings, 'variable-language', 'Language');
        entry(variables, settings, 'variable-tone', 'Tone');
        entry(variables, settings, 'variable-style', 'Style');
        promptsPage.add(variables);

        window.connect('close-request', () => {
            abortModelRequests();
            this._keyCancellable.cancel();
            this._keyCancellable = null;
            this._providerSettings = null;
            this._providerRows = null;
            this._modelRow = null;
            this._actionsGroup = null;
            this._actionRows = null;
            return false;
        });
        window.add(generalPage);
        window.add(actionsPage);
        window.add(promptsPage);
    }

    _renderProviderSettings(settings) {
        abortModelRequests();
        for (const row of this._providerRows)
            this._providerSettings.remove(row);
        this._providerRows = [];

        let provider = settings.get_string('provider');
        const info = PROVIDERS.find(item => item.id === provider) ?? PROVIDERS[0];
        provider = info.id;
        this._providerSettings.title = info.name;
        this._providerSettings.description = provider === 'ollama'
            ? 'Runs on your configured local server.'
            : provider === 'cloudflare'
                ? 'API tokens are stored securely in Passwords and Keys.'
                : 'API keys are stored securely in Passwords and Keys.';
        if (provider === 'ollama')
            this._providerRows.push(entry(this._providerSettings, settings, 'ollama-url', 'Address'));
        else if (provider === 'cloudflare') {
            this._providerRows.push(entry(
                this._providerSettings, settings, 'cloudflare-account-id', 'Account ID'));
            this._providerRows.push(this._secretEntry(settings, provider, 'API token'));
        } else {
            this._providerRows.push(this._secretEntry(settings, provider));
        }

        const freeUsage = PROVIDER_FREE_USAGE[provider];
        if (freeUsage) {
            const freeUsageRow = new Adw.ActionRow({
                title: 'Free usage',
                subtitle: freeUsage,
            });
            freeUsageRow.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
            this._providerSettings.add(freeUsageRow);
            this._providerRows.push(freeUsageRow);
        }

        const modelRow = new Adw.ComboRow({title: 'Model', enable_search: true});
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh models',
            valign: Gtk.Align.CENTER,
        });
        refresh.add_css_class('flat');
        const custom = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: 'Enter a custom model',
            valign: Gtk.Align.CENTER,
        });
        custom.add_css_class('flat');
        modelRow.add_suffix(refresh);
        modelRow.add_suffix(custom);
        this._providerSettings.add(modelRow);
        this._providerRows.push(modelRow);
        this._modelRow = modelRow;

        const usageRow = new Adw.ActionRow({
            title: 'Model usage and cost',
            subtitle: 'Larger models may use provider allowances faster or incur charges, depending on your account.',
        });
        usageRow.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
        this._providerSettings.add(usageRow);
        this._providerRows.push(usageRow);

        const cached = this._cachedModels(settings, provider);
        this._setModelOptions(modelRow, settings, provider, cached);
        modelRow.connect('notify::selected', () => {
            if (modelRow._updating)
                return;
            const id = modelRow._modelIds?.[modelRow.selected];
            if (id)
                settings.set_string(`${provider}-model`, id);
        });
        refresh.connect('clicked', () => this._refreshModels(settings, provider, modelRow, refresh));
        custom.connect('clicked', () => this._customModel(settings, provider, modelRow));
    }

    _secretEntry(settings, provider, title = 'API key') {
        const credential = provider === 'cloudflare' ? 'API token' : 'API key';
        const row = new Adw.PasswordEntryRow({
            title,
            show_apply_button: true,
        });
        const status = new Gtk.Image({
            icon_name: 'content-loading-symbolic',
            tooltip_text: 'Loading from Passwords and Keys…',
        });
        row.add_suffix(status);
        row.sensitive = false;
        this._providerSettings.add(row);

        getApiKey(settings, provider, this._keyCancellable).then(key => {
            if (row.get_parent()) {
                row.text = key;
                row.sensitive = true;
                status.icon_name = key ? 'emblem-ok-symbolic' : 'dialog-password-symbolic';
                status.tooltip_text = key
                    ? 'Stored securely in Passwords and Keys'
                    : `No ${credential} saved`;
            }
        }).catch(error => {
            if (row.get_parent()) {
                row.sensitive = true;
                status.icon_name = 'dialog-error-symbolic';
                status.tooltip_text = error.message ?? String(error);
            }
        });

        const save = async () => {
            row.sensitive = false;
            status.icon_name = 'content-loading-symbolic';
            status.tooltip_text = 'Saving…';
            try {
                await setApiKey(settings, provider, row.text, this._keyCancellable);
                if (row.get_parent()) {
                    status.icon_name = row.text.trim() ? 'emblem-ok-symbolic' : 'dialog-password-symbolic';
                    status.tooltip_text = row.text.trim()
                        ? 'Stored securely in Passwords and Keys'
                        : `${credential} removed`;
                }
            } catch (error) {
                if (row.get_parent()) {
                    status.icon_name = 'dialog-error-symbolic';
                    status.tooltip_text = error.message ?? String(error);
                }
            } finally {
                if (row.get_parent())
                    row.sensitive = true;
            }
        };
        row.connect('apply', save);
        row.connect('entry-activated', save);
        return row;
    }

    _cachedModels(settings, provider) {
        try {
            const cache = JSON.parse(settings.get_string('model-cache'));
            return Array.isArray(cache[provider]) ? cache[provider] : [];
        } catch {
            return [];
        }
    }

    _cacheModels(settings, provider, models) {
        let cache = {};
        try {
            const parsed = JSON.parse(settings.get_string('model-cache'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                cache = parsed;
        } catch {
            // Replace an invalid cache.
        }
        cache[provider] = models;
        settings.set_string('model-cache', JSON.stringify(cache));
    }

    _setModelOptions(row, settings, provider, models) {
        const current = settings.get_string(`${provider}-model`);
        const options = [...models];
        if (current && !options.some(model => model.id === current))
            options.unshift({id: current, name: current});
        row._modelIds = options.map(model => model.id);
        row._updating = true;
        row.model = Gtk.StringList.new(options.map(model =>
            model.name && model.name !== model.id ? `${model.name} — ${model.id}` : model.id));
        row.selected = Math.max(0, row._modelIds.indexOf(current));
        row._updating = false;
    }

    async _refreshModels(settings, provider, row, button) {
        button.sensitive = false;
        row.subtitle = 'Loading…';
        try {
            const models = await fetchModels(settings, provider);
            if (this._modelRow !== row)
                return;
            this._cacheModels(settings, provider, models);
            this._setModelOptions(row, settings, provider, models);
            row.subtitle = `${models.length} available`;
        } catch (error) {
            if (this._modelRow === row)
                row.subtitle = error.message ?? String(error);
        } finally {
            if (this._modelRow === row)
                button.sensitive = true;
        }
    }

    _customModel(settings, provider, modelRow) {
        const field = new Adw.EntryRow({
            title: 'Model ID',
            text: settings.get_string(`${provider}-model`),
            show_apply_button: true,
        });
        const group = new Adw.PreferencesGroup();
        group.add(field);
        const page = new Adw.PreferencesPage();
        page.add(group);
        const dialog = new Adw.Window({
            title: 'Custom model',
            modal: true,
            destroy_with_parent: true,
            transient_for: this._providerSettings.get_root(),
            default_width: 480,
            default_height: 160,
            content: page,
        });
        const save = () => {
            const id = field.text.trim();
            if (!id)
                return;
            settings.set_string(`${provider}-model`, id);
            this._setModelOptions(modelRow, settings, provider, this._cachedModels(settings, provider));
            dialog.close();
        };
        field.connect('entry-activated', save);
        field.connect('apply', save);
        dialog.present();
    }

    _renderActions(settings) {
        for (const row of this._actionRows)
            this._actionsGroup.remove(row);
        this._actionRows = [];

        const storedActions = readActions(settings);
        storedActions.forEach((action, index) => {
            const provider = PROVIDERS.find(item => item.id === action.provider);
            const override = provider
                ? `${provider.name}${action.model ? ` — ${action.model}` : ''}`
                : 'Uses active provider and model';
            const limits = action.inputLimit || action.outputLimit
                ? `Limits: input ${formatTokenLimit(action.inputLimit)}, ` +
                    `output ${formatTokenLimit(action.outputLimit)}`
                : '';
            const mode = action.inputMode === 'prompt'
                ? 'Uses selected text as the prompt'
                : '';
            const row = new Adw.ActionRow({
                title: action.name,
                subtitle: [override, mode, limits, promptPreview(action.prompt)]
                    .filter(Boolean).join('\n'),
                subtitle_lines: 4,
                use_markup: false,
            });
            const visible = new Gtk.Switch({
                active: action.enabled,
                tooltip_text: 'Show in panel menu',
                valign: Gtk.Align.CENTER,
            });
            visible.connect('notify::active', () => {
                const actions = readActions(settings);
                const current = actions.find(item => item.id === action.id);
                if (current) {
                    current.enabled = visible.active;
                    writeActions(settings, actions);
                }
            });
            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                tooltip_text: 'Move up',
                sensitive: index > 0,
                valign: Gtk.Align.CENTER,
            });
            up.add_css_class('flat');
            up.connect('clicked', () => this._moveAction(settings, action.id, -1));
            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: 'Move down',
                sensitive: index < storedActions.length - 1,
                valign: Gtk.Align.CENTER,
            });
            down.add_css_class('flat');
            down.connect('clicked', () => this._moveAction(settings, action.id, 1));
            const edit = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                tooltip_text: 'Edit action',
                valign: Gtk.Align.CENTER,
            });
            edit.add_css_class('flat');
            edit.connect('clicked', () => this._editAction(settings, action));
            row.add_suffix(visible);
            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(edit);
            this._actionsGroup.add(row);
            this._actionRows.push(row);
        });

        const add = new Adw.ActionRow({title: 'Add action', activatable: true});
        add.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.connect('activated', () => this._editAction(settings));
        this._actionsGroup.add(add);
        this._actionRows.push(add);

        this._renderQuickActions(settings);
    }

    _renderQuickActions(settings) {
        if (this._quickActionRows) {
            for (const row of this._quickActionRows) {
                this._quickActionsGroup.remove(row);
            }
        }
        this._quickActionRows = [];

        const customActions = readActions(settings);
        const allActions = [
            { id: 'ask', name: 'Ask' },
            { id: 'correct', name: 'Correct selected text' },
            { id: 'rewrite', name: 'Rewrite selected text' },
            { id: 'prompt', name: 'Run selected prompt' },
            ...customActions.map(a => ({ id: a.id, name: a.name }))
        ];

        let quickActionIds = [];
        try {
            quickActionIds = JSON.parse(settings.get_string('quick-actions') || '[]');
            if (Array.isArray(quickActionIds) && quickActionIds.length > 4) {
                quickActionIds = quickActionIds.slice(0, 4);
            }
        } catch (e) {}

        if (!Array.isArray(quickActionIds) || quickActionIds.length === 0) {
            quickActionIds = ['ask', 'correct', 'rewrite'];
        }

        const saveQuickActions = (newIds) => {
            settings.set_string('quick-actions', JSON.stringify(newIds));
            this._renderQuickActions(settings);
        };

        const moveAction = (index, offset) => {
            const target = index + offset;
            if (index < 0 || target < 0 || target >= quickActionIds.length) return;
            const newIds = [...quickActionIds];
            [newIds[index], newIds[target]] = [newIds[target], newIds[index]];
            saveQuickActions(newIds);
        };

        for (let i = 0; i < quickActionIds.length; i++) {
            const id = quickActionIds[i];
            const action = allActions.find(a => a.id === id);
            if (!action) continue;

            const row = new Adw.ActionRow({ title: action.name });

            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Move up',
                sensitive: i > 0,
            });
            up.add_css_class('flat');
            up.connect('clicked', () => moveAction(i, -1));

            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Move down',
                sensitive: i < quickActionIds.length - 1,
            });
            down.add_css_class('flat');
            down.connect('clicked', () => moveAction(i, 1));

            const remove = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Remove from Quick Actions',
            });
            remove.add_css_class('flat');
            remove.connect('clicked', () => {
                saveQuickActions(quickActionIds.filter(val => val !== id));
            });

            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(remove);

            this._quickActionsGroup.add(row);
            this._quickActionRows.push(row);
        }

        if (quickActionIds.length < 4) {
            const add = new Adw.ActionRow({ title: 'Add quick action', activatable: true });
            add.add_prefix(new Gtk.Image({ icon_name: 'list-add-symbolic' }));
            add.connect('activated', () => {
                this._showAddQuickActionDialog(settings, allActions, quickActionIds, (newId) => {
                    saveQuickActions([...quickActionIds, newId]);
                });
            });
            this._quickActionsGroup.add(add);
            this._quickActionRows.push(add);
        } else {
            const limit = new Adw.ActionRow({
                title: 'Limit reached',
                subtitle: 'Up to four actions appear beside the selection button. More remain available in the palette.'
            });
            this._quickActionsGroup.add(limit);
            this._quickActionRows.push(limit);
        }
    }

    _showAddQuickActionDialog(settings, allActions, currentIds, onAdd) {
        const availableActions = allActions.filter(a => a.id && !currentIds.includes(a.id));

        const dialog = new Adw.PreferencesWindow({
            title: 'Add Quick Action',
            modal: true,
            destroy_with_parent: true,
            transient_for: this._actionsGroup.get_root(),
            default_width: 400,
            default_height: 500,
        });

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({ title: 'Available Actions' });

        for (const action of availableActions) {
            const row = new Adw.ActionRow({ title: action.name, activatable: true });
            row.connect('activated', () => {
                onAdd(action.id);
                dialog.close();
            });
            group.add(row);
        }

        if (availableActions.length === 0) {
            group.add(new Adw.ActionRow({ title: 'No more actions available.' }));
        }

        page.add(group);
        dialog.add(page);
        dialog.present();
    }

    _moveAction(settings, id, offset) {
        const actions = readActions(settings);
        const index = actions.findIndex(action => action.id === id);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= actions.length)
            return;
        [actions[index], actions[target]] = [actions[target], actions[index]];
        writeActions(settings, actions);
        this._renderActions(settings);
    }

    _editAction(settings, action = null) {
        const page = new Adw.PreferencesPage();
        const fields = new Adw.PreferencesGroup({title: action ? 'Edit action' : 'New action'});
        const name = new Adw.EntryRow({title: 'Name', text: action?.name ?? ''});
        const inputMode = new Adw.ComboRow({
            title: 'Input mode',
            subtitle: 'Transform the selection or use it directly as the user instruction.',
            model: Gtk.StringList.new([
                'Transform selected text',
                'Use selected text as prompt',
            ]),
            selected: action?.inputMode === 'prompt' ? 1 : 0,
        });
        const promptBuffer = new Gtk.TextBuffer();
        promptBuffer.set_text(action?.prompt ?? '', -1);
        const promptView = new Gtk.TextView({
            buffer: promptBuffer,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            accepts_tab: true,
            left_margin: 8,
            right_margin: 8,
            top_margin: 8,
            bottom_margin: 8,
        });
        const promptScroll = new Gtk.ScrolledWindow({
            child: promptView,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 130,
            max_content_height: 220,
            propagate_natural_height: true,
        });
        promptScroll.add_css_class('frame');
        const promptLabel = new Gtk.Label({
            label: 'Prompt',
            xalign: 0,
        });
        promptLabel.add_css_class('caption');
        const promptBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_start: 12,
            margin_end: 12,
            margin_top: 10,
            margin_bottom: 12,
        });
        promptBox.append(promptLabel);
        promptBox.append(promptScroll);
        const prompt = new Adw.PreferencesRow({
            title: 'Prompt',
            child: promptBox,
        });
        const updatePromptLabel = () => {
            const title = inputMode.selected === 1
                ? 'System guidance (optional)'
                : 'Transformation prompt';
            prompt.title = title;
            promptLabel.label = title;
        };
        inputMode.connect('notify::selected', updatePromptLabel);
        updatePromptLabel();
        const providerNames = ['Use active provider', ...PROVIDERS.map(item => item.name)];
        const provider = new Adw.ComboRow({
            title: 'Provider override',
            model: Gtk.StringList.new(providerNames),
        });
        provider.selected = Math.max(0,
            PROVIDERS.findIndex(item => item.id === action?.provider) + 1);
        const model = new Adw.EntryRow({
            title: 'Model override (optional)',
            text: action?.model ?? '',
            sensitive: provider.selected > 0,
        });
        provider.connect('notify::selected', () => {
            model.sensitive = provider.selected > 0;
        });
        const inputLimit = tokenLimitControl(
            'Input limit',
            'Stops before sending when the selected text is over this estimate.',
            INPUT_LIMIT_VALUES,
            INPUT_LIMIT_LABELS,
            action?.inputLimit ?? 0);
        const outputLimit = tokenLimitControl(
            'Output limit',
            'Sets the maximum response length for this action.',
            OUTPUT_LIMIT_VALUES,
            OUTPUT_LIMIT_LABELS,
            action?.outputLimit ?? 0);
        const visible = new Adw.SwitchRow({
            title: 'Show in panel menu',
            active: action?.enabled !== false,
        });
        fields.add(name);
        fields.add(inputMode);
        fields.add(prompt);
        fields.add(provider);
        fields.add(model);
        fields.add(inputLimit.row);
        fields.add(inputLimit.custom);
        fields.add(outputLimit.row);
        fields.add(outputLimit.custom);
        fields.add(visible);
        page.add(fields);

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.END,
            margin_start: 18,
            margin_end: 18,
            margin_bottom: 18,
        });
        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: 'Save'});
        save.add_css_class('suggested-action');
        buttons.append(cancel);
        if (action) {
            const remove = new Gtk.Button({label: 'Delete'});
            remove.add_css_class('destructive-action');
            buttons.prepend(remove);
            remove.connect('clicked', () => {
                writeActions(settings, readActions(settings).filter(item => item.id !== action.id));
                dialog.close();
                this._renderActions(settings);
            });
        }
        buttons.append(save);

        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(page);
        content.append(buttons);
        const dialog = new Adw.Window({
            title: action ? 'Edit action' : 'New action',
            modal: true,
            destroy_with_parent: true,
            transient_for: this._actionsGroup.get_root(),
            default_width: 520,
            default_height: 540,
            content,
        });
        cancel.connect('clicked', () => dialog.close());
        save.connect('clicked', () => {
            const actionName = name.text.trim();
            const [promptStart, promptEnd] = promptBuffer.get_bounds();
            const actionPrompt = promptBuffer.get_text(promptStart, promptEnd, false).trim();
            const inputModeValue = inputMode.selected === 1 ? 'prompt' : 'transform';
            if (!actionName || (inputModeValue === 'transform' && !actionPrompt))
                return;
            const inputLimitValue = inputLimit.value();
            const outputLimitValue = outputLimit.value();
            if (inputLimitValue === null || outputLimitValue === null)
                return;
            const actions = readActions(settings);
            const providerId = provider.selected > 0 ? PROVIDERS[provider.selected - 1]?.id ?? '' : '';
            const next = {
                id: action?.id ?? GLib.uuid_string_random(),
                name: actionName,
                prompt: actionPrompt,
                enabled: visible.active,
                provider: providerId,
                model: providerId ? model.text.trim() : '',
                inputMode: inputModeValue,
                inputLimit: inputLimitValue,
                outputLimit: outputLimitValue,
            };
            const index = actions.findIndex(item => item.id === next.id);
            if (index >= 0)
                actions[index] = next;
            else
                actions.push(next);
            writeActions(settings, actions);
            dialog.close();
            this._renderActions(settings);
        });
        dialog.present();
    }

    _shortcutRow(group, settings, key, title) {
        const row = new Adw.ActionRow({title, activatable: true});
        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            disabled_text: 'Not set',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        row.connect('activated', () => {
            const content = new Adw.StatusPage({
                title: `Set ${title.toLowerCase()} shortcut`,
                description: 'Press a key combination. Backspace clears it; Escape cancels.',
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            });
            const dialog = new Adw.Window({
                modal: true,
                destroy_with_parent: true,
                transient_for: row.get_root(),
                default_width: 480,
                default_height: 300,
                content,
            });
            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
                let mask = state & Gtk.accelerator_get_default_mod_mask();
                mask &= ~Gdk.ModifierType.LOCK_MASK;

                if (!mask && keyval === Gdk.KEY_Escape) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (!mask && keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv(key, []);
                    label.accelerator = '';
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (!mask || !Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;

                const accelerator = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                settings.set_strv(key, [accelerator]);
                label.accelerator = accelerator;
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(controller);
            dialog.present();
        });
        group.add(row);
    }
}
