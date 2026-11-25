import {_, N_, format} from './i18n.js';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {ACTION_ICONS, readActions, writeActions} from './actions.js';
import {abortModelRequests, fetchModels} from './models.js';
import {listProviders, providerLabels, readProviders, migrateProviders, validateProvider, validateHeaders, REASONING_EFFORTS, resolveProvider, providerModel, setProviderModel, providerReferences, PROVIDER_PRESETS} from './providers.js';
import {migrateProviderSettings, deleteProvider, getApiKey, setApiKey, getProviderHeaders, saveProviderConnection} from './secrets.js';
import {ChatGPTClient} from './chatgpt.js';

const INPUT_LIMIT_VALUES = [0, 2000, 4000, 8000, 16000, 32000];
const INPUT_LIMIT_LABELS = [N_('Auto'), N_('2K'), N_('4K'), N_('8K'), N_('16K'), N_('32K'), N_('Custom')];
const OUTPUT_LIMIT_VALUES = [0, 1000, 2000, 4000, 8000, 16000];
const OUTPUT_LIMIT_LABELS = [N_('Auto'), N_('1K'), N_('2K'), N_('4K'), N_('8K'), N_('16K'), N_('Custom')];
const PROVIDER_OUTPUT_LIMIT_LABELS = [N_('Provider default'), ...OUTPUT_LIMIT_LABELS.slice(1)];

const SUPPORTS_COMPACT_BLUR = Number.parseInt(Config.PACKAGE_VERSION, 10) === 51;

function entry(group, settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function formatTokenLimit(value) {
    if (!value)
        return _('Auto');
    return value % 1000 === 0 ? format(_('%sK'), value / 1000) : String(value);
}

function promptPreview(prompt, maximum = 140) {
    const compact = prompt.replace(/\s+/g, ' ').trim();
    const characters = Array.from(compact);
    if (characters.length <= maximum)
        return compact;
    return format(_('%s…'), characters.slice(0, maximum).join('').trimEnd());
}

function textEditor(title, text, onChanged) {
    const buffer = new Gtk.TextBuffer();
    buffer.set_text(text, -1);
    const view = new Gtk.TextView({buffer, wrap_mode: Gtk.WrapMode.WORD_CHAR,
        left_margin: 12, right_margin: 12, top_margin: 12, bottom_margin: 12,
        accepts_tab: false});
    const scroll = new Gtk.ScrolledWindow({child: view,
        hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        min_content_height: 112, max_content_height: 200, propagate_natural_height: true});
    scroll.add_css_class('frame');
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        margin_start: 12, margin_end: 12, margin_top: 12, margin_bottom: 12});
    const label = new Gtk.Label({label: title, xalign: 0, wrap: true});
    box.append(label);
    box.append(scroll);
    const row = new Adw.PreferencesRow({title, child: box});
    row._buffer = buffer;
    buffer.connect('changed', () => {
        const [start, end] = buffer.get_bounds();
        onChanged(buffer.get_text(start, end, false));
    });
    return row;
}

function providerJson(text, title) {
    try {
        return JSON.parse(text.trim() || '{}');
    } catch {
        throw new Error(format(_('%s must contain valid JSON.'), title));
    }
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
        model: Gtk.StringList.new(labels.map(_)),
        selected: presetIndex >= 0 ? presetIndex : customIndex,
    });
    const custom = new Adw.EntryRow({
        title: format(_('Custom %s'), title),
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
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);
        this._keyCancellable = new Gio.Cancellable();
        const cancellable = this._keyCancellable;
        window.connect('close-request', () => cancellable.cancel());
        window.connect('unrealize', () => cancellable.cancel());
        try {
            migrateProviders(settings);
        } catch (error) {
            const group = new Adw.PreferencesGroup({title: _('Saved providers unavailable')});
            group.add(new Adw.ActionRow({title: _('Your saved settings were kept.'),
                subtitle: error.message, use_markup: false}));
            generalPage.add(group);
            return;
        }
        this._providerChoices = listProviders(settings);
        this._providerSelectors = [];
        window.default_width = 760;
        window.default_height = 760;
        window.search_enabled = true;
        window.add_css_class('plyph-preferences');
        const appearance = new Gtk.CssProvider();
        appearance.load_from_data(`
            .plyph-preferences headerbar viewswitcher button {
                padding: 6px 14px;
                margin: 4px 2px;
                border-radius: 8px;
                border: none;
                background-image: none;
                background-color: transparent;
                box-shadow: none;
            }
            .plyph-preferences headerbar viewswitcher image {
                -gtk-icon-size: 1px;
                min-width: 0;
                min-height: 0;
                margin: 0;
                padding: 0;
                opacity: 0;
            }
            .plyph-preferences headerbar viewswitcher button:hover {
                background-color: alpha(@theme_fg_color, 0.05);
            }
            .plyph-preferences headerbar viewswitcher button:checked {
                background-color: alpha(@theme_fg_color, 0.08);
                color: @theme_fg_color;
                box-shadow: inset 0 -2px @accent_bg_color;
            }
        `, -1);
        Gtk.StyleContext.add_provider_for_display(window.get_display(), appearance,
            Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);
        const actionsPage = new Adw.PreferencesPage({
            title: _('Actions'),
            icon_name: 'emblem-system-symbolic',
        });
        const promptsPage = new Adw.PreferencesPage({
            title: _('Instructions'),
            icon_name: 'document-edit-symbolic',
        });
        const advancedPage = new Adw.PreferencesPage({title: _('Advanced'),
            icon_name: 'preferences-other-symbolic'});

        const providerGroup = new Adw.PreferencesGroup({title: _('Provider')});
        const provider = new Adw.ComboRow({title: _('Active provider')});
        providerGroup.add(provider);
        generalPage.add(providerGroup);
        this._bindProviderSelector(provider, settings, 'provider', false, () => {
            this._renderProviderSettings(settings);
        });

        this._providerSettings = new Adw.PreferencesGroup({title: _('Provider settings')});
        this._providerRows = [];
        this._renderProviderSettings(settings);
        generalPage.add(this._providerSettings);
        this._customProvidersGroup = new Adw.PreferencesGroup({title: _('Saved providers')});
        this._customProviderRows = [];
        this._renderCustomProviders(settings);
        generalPage.add(this._customProvidersGroup);
        const migrationStatus = new Adw.ActionRow({title: _('Saved connections could not be checked'),
            visible: false, use_markup: false});
        this._customProvidersGroup.add(migrationStatus);

        const runPrompt = new Adw.PreferencesGroup({
            title: _('Run selected prompt'),
            description: _('Selected text is sent directly as the user instruction.'),
        });
        const runProvider = new Adw.ComboRow({title: _('Provider override')});
        const runModel = new Adw.EntryRow({
            title: _('Model override (optional)'),
            text: settings.get_string('prompt-run-model'),
            sensitive: Boolean(settings.get_string('prompt-run-provider')),
        });
        settings.bind('prompt-run-model', runModel, 'text', Gio.SettingsBindFlags.DEFAULT);
        this._bindProviderSelector(runProvider, settings, 'prompt-run-provider', true, () => {
            runModel.sensitive = Boolean(settings.get_string('prompt-run-provider'));
        });
        const runInputLimit = tokenLimitControl(
            _('Input limit'),
            _('Stops before sending when the selected prompt is over this estimate.'),
            INPUT_LIMIT_VALUES,
            INPUT_LIMIT_LABELS,
            settings.get_int64('prompt-run-input-limit'));
        bindTokenLimit(settings, 'prompt-run-input-limit', runInputLimit, INPUT_LIMIT_VALUES);
        const runOutputLimit = tokenLimitControl(
            _('Output limit'),
            _('Auto uses the selected provider’s output limit settings.'),
            OUTPUT_LIMIT_VALUES,
            OUTPUT_LIMIT_LABELS,
            settings.get_int64('prompt-run-output-limit'));
        bindTokenLimit(settings, 'prompt-run-output-limit', runOutputLimit, OUTPUT_LIMIT_VALUES);
        const runAdvanced = new Adw.ExpanderRow({title: _('Provider and limits'),
            subtitle: _('Use the active provider and automatic limits, or customize.')});
        for (const row of [runProvider, runModel, runInputLimit.row, runInputLimit.custom,
            runOutputLimit.row, runOutputLimit.custom])
            runAdvanced.add_row(row);
        runPrompt.add(runAdvanced);

        this._quickActionsGroup = new Adw.PreferencesGroup({
            title: _('Toolbar actions'),
            description: _('Select which actions appear in the floating toolbar.'),
        });

        const actions = new Adw.PreferencesGroup({
            title: _('Custom actions'),
            description: _('Create actions for the panel menu. Use the Open actions shortcut for quick access.'),
        });
        this._actionsGroup = actions;
        this._actionRows = [];
        this._renderActions(settings);
        let previousProviders = listProviders(settings);
        const connection = item => item ? [item.id, item.name, item.url, item.adapter] : null;
        const providersChanged = settings.connect('changed::custom-providers', () => {
            const next = listProviders(settings);
            const selected = settings.get_string('provider');
            const previous = previousProviders.find(item => item.id === selected);
            const current = next.find(item => item.id === selected);
            const listChanged = JSON.stringify(previousProviders.map(connection)) !==
                JSON.stringify(next.map(connection));
            previousProviders = next;
            this._providerChoices = next;
            if (listChanged) {
                for (const selector of this._providerSelectors)
                    selector();
                this._renderCustomProviders(settings);
                this._renderActions(settings);
            }
            if (JSON.stringify(connection(previous)) !== JSON.stringify(connection(current)))
                this._renderProviderSettings(settings);
            else if (current && previous?.model !== current.model && this._modelRow &&
                this._modelRow._modelIds?.[this._modelRow.selected] !== current.model)
                this._setModelOptions(this._modelRow, settings, selected, this._cachedModels(settings, selected));
        });


        const shortcuts = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('Click an action, then press the shortcut you want.'),
        });
        this._shortcutRow(shortcuts, settings, 'ask-shortcut', _('Ask'));
        this._shortcutRow(shortcuts, settings, 'correct-shortcut', _('Correct'));
        this._shortcutRow(shortcuts, settings, 'rewrite-shortcut', _('Rewrite'));
        this._shortcutRow(shortcuts, settings, 'actions-shortcut', _('Open actions'));
        const palettePositions = ['disabled', 'monitor-center', 'near-pointer'];
        const actionPalette = new Adw.ComboRow({
            title: _('Action palette'),
            subtitle: _('Choose where the Open actions shortcut displays actions.'),
            model: Gtk.StringList.new([_('Off'), _('Active monitor center'), _('Near pointer')]),
        });
        actionPalette.selected = Math.max(0,
            palettePositions.indexOf(settings.get_string('action-palette-position')));
        actionPalette.connect('notify::selected', () => {
            settings.set_string('action-palette-position',
                palettePositions[actionPalette.selected] ?? 'disabled');
        });
        shortcuts.add(actionPalette);
        actionsPage.add(shortcuts);
        actionsPage.add(this._quickActionsGroup);
        actionsPage.add(actions);
        actionsPage.add(runPrompt);

        const capture = new Adw.PreferencesGroup({
            title: _('Selection capture'),
            description:
                _('GNOME normally reads the PRIMARY selection. Some apps—especially Firefox on Wayland—do not update it reliably. For listed apps, Plyph sends Ctrl+C and reads the regular clipboard instead. This changes the clipboard. Avoid adding terminals unless Ctrl+C copies text there.'),
        });
        entry(capture, settings, 'explicit-copy-apps', _('Compatibility apps'));

        const behavior = new Adw.PreferencesGroup({title: _('Results'),
            description: _('Choose how results appear before returning to your app.')});
        const toolbar = new Adw.PreferencesGroup({title: _('Selection toolbar'),
            description: _('Keep your actions close to the text you select.')});
        const feedback = new Adw.PreferencesGroup({title: _('Feedback')});

        const showFloating = new Adw.SwitchRow({
            title: _('Show selection toolbar'),
            subtitle: _('An alternative to keyboard shortcuts.'),
        });
        settings.bind('show-floating-button', showFloating, 'active', Gio.SettingsBindFlags.DEFAULT);
        toolbar.add(showFloating);

        const choice = (group, key, title, values, labels) => {
            const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
            row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
            row.connect('notify::selected', () => {
                if (values[row.selected] !== undefined)
                    settings.set_string(key, values[row.selected]);
            });
            group.add(row);
            return row;
        };
        const toolbarLayout = choice(toolbar, 'toolbar-layout', _('Toolbar layout'),
            ['labels', 'icons', 'vertical'], [_('Horizontal with labels'), _('Horizontal icons'), _('Vertical icons')]);
        const duration = choice(toolbar, 'toolbar-duration', _('Toolbar visibility'),
            ['longer', 'classic'], [_('Stay visible longer'), _('Previous timing')]);
        const expanded = new Adw.SwitchRow({title: _('Show toolbar actions immediately')});
        settings.bind('toolbar-open-expanded', expanded, 'active', Gio.SettingsBindFlags.DEFAULT);
        toolbar.add(expanded);
        const radius = new Adw.SpinRow({title: _('Toolbar corner radius'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 32, step_increment: 1, page_increment: 4})});
        radius.value = settings.get_int('toolbar-radius');
        radius.connect('notify::value', () => settings.set_int('toolbar-radius', Math.round(radius.value)));
        toolbar.add(radius);
        for (const row of [toolbarLayout, duration, expanded, radius])
            settings.bind('show-floating-button', row, 'sensitive', Gio.SettingsBindFlags.GET);
        choice(toolbar, 'popup-theme', _('Toolbar and compact popup appearance'),
            ['default', 'light', 'dark'], [_('Default'), _('Light'), _('Dark')]);
        const toolbarScales = [1, 1.25, 1.5, 1.75, 2];
        const toolbarScale = new Adw.ComboRow({
            title: _('Toolbar size'),
            subtitle: _('Enlarge the button, icons, and text together.'),
            model: Gtk.StringList.new([_('1× (Default)'), '1.25×', '1.5×', '1.75×', '2×']),
        });
        toolbarScale.selected = Math.max(0,
            toolbarScales.indexOf(settings.get_double('floating-toolbar-scale')));
        settings.bind('show-floating-button', toolbarScale, 'sensitive', Gio.SettingsBindFlags.GET);
        toolbarScale.connect('notify::selected', () => {
            settings.set_double('floating-toolbar-scale', toolbarScales[toolbarScale.selected] ?? 1);
        });
        toolbar.add(toolbarScale);

        const preview = new Adw.SwitchRow({
            title: _('Preview before replacing'),
            subtitle: _('Confirm, copy, or cancel the generated result.'),
        });
        settings.bind('preview-results', preview, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(preview);
        const previewStyle = choice(behavior, 'result-preview-style', _('Preview style'),
            ['dialog', 'compact'], [_('Dialog'), _('Compact popup')]);
        settings.bind('preview-results', previewStyle, 'sensitive', Gio.SettingsBindFlags.GET);
        const dismissOutside = new Adw.SwitchRow({title: _('Close compact popup when clicking outside')});
        settings.bind('compact-dismiss-outside', dismissOutside, 'active', Gio.SettingsBindFlags.DEFAULT);
        const blur = new Adw.SwitchRow({
            title: _('Blur compact popup background'),
            subtitle: SUPPORTS_COMPACT_BLUR ? '' : _('Background blur is currently supported only on GNOME Shell 51.'),
        });
        if (SUPPORTS_COMPACT_BLUR)
            settings.bind('compact-background-blur', blur, 'active', Gio.SettingsBindFlags.DEFAULT);
        const updateCompactOptions = () => {
            const compact = preview.active && previewStyle.selected === 1;
            dismissOutside.sensitive = compact;
            blur.sensitive = compact && SUPPORTS_COMPACT_BLUR;
        };
        preview.connect('notify::active', updateCompactOptions);
        previewStyle.connect('notify::selected', updateCompactOptions);
        updateCompactOptions();
        behavior.add(dismissOutside);
        behavior.add(blur);
        const previewChanges = new Adw.SwitchRow({
            title: _('Show changes by default'),
            subtitle: _('Open transformed-text previews in the changes view.'),
        });
        settings.bind('preview-show-changes', previewChanges, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('preview-results', previewChanges, 'sensitive', Gio.SettingsBindFlags.GET);
        behavior.add(previewChanges);

        const plainText = new Adw.SwitchRow({
            title: _('Prefer plain text responses'),
            subtitle: _('Use Markdown only when requested or already present in the text being transformed.'),
        });
        settings.bind('prefer-plain-text', plainText, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(plainText);
        const clipboardFallback = new Adw.SwitchRow({
            title: _('Use clipboard when no text is selected'),
            subtitle: _('Allow actions to use previously copied text.'),
        });
        settings.bind('clipboard-fallback', clipboardFallback, 'active', Gio.SettingsBindFlags.DEFAULT);
        capture.add(clipboardFallback);
        const preserveClipboard = new Adw.SwitchRow({
            title: _('Preserve clipboard'),
            subtitle: _('Restore the clipboard after actions. Copied images are cached in memory.'),
        });
        settings.bind('preserve-clipboard', preserveClipboard, 'active', Gio.SettingsBindFlags.DEFAULT);
        capture.add(preserveClipboard);
        const protectClipboard = new Adw.SwitchRow({
            title: _('Require clipboard preservation'),
            subtitle: _('Stop compatibility copying if the previous clipboard cannot be preserved.'),
        });
        settings.bind('protect-clipboard', protectClipboard, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('preserve-clipboard', protectClipboard, 'sensitive', Gio.SettingsBindFlags.GET);
        capture.add(protectClipboard);
        const pointerFeedback = new Adw.SwitchRow({
            title: _('Show action feedback'),
            subtitle: _('Display a lightweight on-screen status while actions run.'),
        });
        settings.bind('pointer-feedback', pointerFeedback, 'active', Gio.SettingsBindFlags.DEFAULT);
        feedback.add(pointerFeedback);
        const debugLogging = new Adw.SwitchRow({
            title: _('Log request diagnostics'),
            subtitle: _('Write request details and response status to the GNOME system log.'),
        });
        settings.bind('debug-logging', debugLogging, 'active', Gio.SettingsBindFlags.DEFAULT);
        const diagnostics = new Adw.PreferencesGroup({title: _('Diagnostics')});
        diagnostics.add(debugLogging);
        const feedbackPositions = [
            'top-left', 'top-center', 'top-right',
            'center-left', 'center', 'center-right',
            'bottom-left', 'bottom-center', 'bottom-right',
        ];
        const feedbackPosition = new Adw.ComboRow({
            title: _('Feedback location'),
            subtitle: _('Choose where the action status appears on the active monitor.'),
            model: Gtk.StringList.new([
                _('Top left'), _('Top center'), _('Top right'),
                _('Center left'), _('Center'), _('Center right'),
                _('Bottom left'), _('Bottom center'), _('Bottom right'),
            ]),
        });
        feedbackPosition.selected = Math.max(0,
            feedbackPositions.indexOf(settings.get_string('feedback-position')));
        feedbackPosition.sensitive = pointerFeedback.active;
        feedbackPosition.connect('notify::selected', () => {
            settings.set_string('feedback-position',
                feedbackPositions[feedbackPosition.selected] ?? 'bottom-center');
        });
        pointerFeedback.connect('notify::active', () => {
            feedbackPosition.sensitive = pointerFeedback.active;
        });
        feedback.add(feedbackPosition);
        generalPage.add(behavior);
        generalPage.add(toolbar);
        generalPage.add(feedback);
        advancedPage.add(capture);

        const exclusion = new Adw.PreferencesGroup({
            title: _('Toolbar exclusions'),
            description: _('Comma-separated list of application IDs or WM_CLASS names where the floating button will be hidden.'),
        });
        entry(exclusion, settings, 'excluded-apps', _('Excluded apps'));
        advancedPage.add(exclusion);
        advancedPage.add(diagnostics);

        const personal = new Adw.PreferencesGroup({title: _('Personal context'),
            description: _('Context to include with your actions.')});
        const personalRow = new Adw.ExpanderRow({title: _('About you'),
            subtitle: promptPreview(settings.get_string('personal-preferences'), 90) || _('Optional')});
        personalRow.add_row(textEditor(_('Personal context'), settings.get_string('personal-preferences'), value => {
            settings.set_string('personal-preferences', value);
            personalRow.subtitle = promptPreview(value, 90) || _('Optional');
        }));
        personal.add(personalRow);
        promptsPage.add(personal);

        const prompts = new Adw.PreferencesGroup({title: _('Built-in instructions')});
        for (const [key, title, mode] of [['prompt-correct', _('Correct'), 'correct'], ['prompt-rewrite', _('Rewrite'), 'rewrite'],
            ['prompt-run', _('Run selected prompt'), 'prompt'], [null, _('Ask'), 'ask']]) {
            const row = new Adw.ExpanderRow({title,
                subtitle: key ? promptPreview(settings.get_string(key), 90) : ''});
            if (key) {
                row.add_row(textEditor(format(_('%s instructions'), title), settings.get_string(key), value => {
                    settings.set_string(key, value);
                    row.subtitle = promptPreview(value, 90);
                }));
            }
            const context = new Adw.SwitchRow({title: _('Use personal context')});
            settings.bind(`${mode}-use-personal-preferences`, context, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_row(context);
            prompts.add(row);
        }
        promptsPage.add(prompts);

        const variables = new Adw.PreferencesGroup({
            title: _('Prompt variables'),
            description: _('Available as ${language}, ${tone}, ${style}, and ${selection}.'),
        });
        entry(variables, settings, 'variable-language', _('Language'));
        entry(variables, settings, 'variable-tone', _('Tone'));
        entry(variables, settings, 'variable-style', _('Style'));
        promptsPage.add(variables);

        window.connect('close-request', () => {
            settings.disconnect(providersChanged);
            this._providerSelectors = [];
            this._customProvidersGroup = null;
            this._customProviderRows = null;
            Gtk.StyleContext.remove_provider_for_display(window.get_display(), appearance);
            this._chatgptClient?.destroy();
            this._chatgptClient = null;
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
        window.add(actionsPage);
        window.add(promptsPage);
        window.add(advancedPage);
        migrateProviderSettings(settings, cancellable).catch(error => {
            if (!cancellable.is_cancelled()) {
                migrationStatus.subtitle = error.message ?? String(error);
                migrationStatus.visible = true;
            }
        });
    }

    _bindProviderSelector(row, settings, key, optional, changed) {
        let ids = [];
        let updating = false;
        const refresh = () => {
            updating = true;
            const choices = listProviders(settings);
            ids = [...(optional ? [''] : []), ...choices.map(item => item.id)];
            const names = [...(optional ? [_('Use active provider')] : []), ...providerLabels(choices)];
            const current = settings.get_string(key);
            if (!ids.includes(current)) {
                ids.push(current);
                names.push(_('Unavailable provider'));
            }
            row.model = Gtk.StringList.new(names);
            row.selected = ids.indexOf(current);
            updating = false;
        };
        refresh();
        this._providerSelectors.push(refresh);
        row.connect('notify::selected', () => {
            if (updating || ids[row.selected] === undefined)
                return;
            settings.set_string(key, ids[row.selected]);
            changed();
        });
    }

    _renderCustomProviders(settings) {
        for (const row of this._customProviderRows)
            this._customProvidersGroup.remove(row);
        this._customProviderRows = [];
        const profiles = readProviders(settings);
        const labels = providerLabels(profiles);
        for (const [index, profile] of profiles.entries()) {
            const row = new Adw.ActionRow({title: labels[index], subtitle: profile.url,
                use_markup: false, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => this._editProvider(settings, resolveProvider(settings, profile.id)));
            this._customProvidersGroup.add(row);
            this._customProviderRows.push(row);
        }
        const add = new Adw.ActionRow({title: _('Add provider'), activatable: true});
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.connect('activated', () => this._editProvider(settings));
        this._customProvidersGroup.add(add);
        this._customProviderRows.push(add);
    }

    _editProvider(settings, existing = null) {
        const profile = existing ? {...existing} : {id: `custom:${GLib.uuid_string_random()}`,
            name: '', url: '', model: '', adapter: ''};
        const window = new Adw.Window({title: existing ? _('Edit provider') : _('Add provider'),
            transient_for: this._providerSettings.get_root(), modal: true,
            destroy_with_parent: true, default_width: 520, default_height: 500});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const header = new Adw.HeaderBar();
        box.append(header);
        const page = new Adw.PreferencesPage({vexpand: true});
        const group = new Adw.PreferencesGroup();
        page.add(group);
        box.append(page);
        window.content = box;
        const name = new Adw.EntryRow({title: _('Name'), text: profile.name});
        const url = new Adw.EntryRow({title: _('Base URL'), text: profile.url});
        const key = new Adw.PasswordEntryRow({title: _('API key (optional)'), sensitive: !existing});
        const model = new Adw.EntryRow({title: _('Default model (optional)'), text: profile.model});
        if (!existing) {
            const preset = new Adw.ComboRow({title: _('Start with'),
                model: Gtk.StringList.new([_('Custom connection'), ...PROVIDER_PRESETS.map(item => _(item.name))])});
            group.add(preset);
            preset.connect('notify::selected', () => {
                const selected = PROVIDER_PRESETS[preset.selected - 1];
                profile.adapter = selected?.adapter ?? '';
                name.text = selected?.name ?? '';
                url.text = selected?.url ?? '';
                model.text = '';
            });
        }
        for (const row of [name, url, key, model])
            group.add(row);
        const advanced = new Adw.ExpanderRow({title: _('Advanced'), expanded: false,
            subtitle: _('Optional request controls'), use_markup: false});
        const outputLimit = tokenLimitControl(
            _('Output limit'),
            _('Applies to built-in actions and actions with an Auto output limit.'),
            OUTPUT_LIMIT_VALUES,
            PROVIDER_OUTPUT_LIMIT_LABELS,
            profile.advanced?.outputLimit ?? 0);
        const temperature = new Adw.EntryRow({title: _('Temperature (optional)'),
            text: profile.advanced?.temperature !== undefined ? String(profile.advanced.temperature) : '',
            tooltip_text: _('Leave blank for the provider default, or enter a value from 0 to 2.')});
        const reasoning = new Adw.ComboRow({title: _('Reasoning effort'),
            tooltip_text: _('Supported values depend on the provider and model.'),
            model: Gtk.StringList.new([_('Provider default'), _('None'), _('Minimal'), _('Low'), _('Medium'), _('High'), _('Extra high')]),
            selected: Math.max(0, REASONING_EFFORTS.indexOf(profile.advanced?.reasoningEffort ?? ''))});
        let headerText = '{}';
        let parameterText = JSON.stringify(profile.advanced?.parameters ?? {}, null, 2);
        const headerEditor = textEditor(_('Custom headers (JSON)'), headerText, value => { headerText = value; });
        headerEditor.tooltip_text = _('Optional HTTP headers. Values are stored securely in Passwords and Keys.');
        headerEditor.sensitive = !existing;
        const parameterEditor = textEditor(_('Extra request parameters (JSON)'), parameterText, value => { parameterText = value; });
        parameterEditor.tooltip_text = _('Use non-secret parameters. For example: {"top_p": 0.9}. Conversation, model, and action limits remain controlled by Plyph.');
        for (const row of [outputLimit.row, outputLimit.custom, temperature, reasoning, headerEditor, parameterEditor])
            advanced.add_row(row);
        group.add(advanced);
        const status = new Adw.ActionRow({title: '', visible: false, use_markup: false});
        group.add(status);
        const showError = error => {
            status.title = error.message ?? String(error);
            status.visible = true;
        };
        const save = new Gtk.Button({label: _('Save'), valign: Gtk.Align.CENTER, sensitive: !existing});
        save.add_css_class('suggested-action');
        header.pack_end(save);
        const cancellable = new Gio.Cancellable();
        window.connect('close-request', () => cancellable.cancel());
        window.connect('unrealize', () => cancellable.cancel());
        let originalKey = '';
        let originalHeaders = {};
        let removeButton = null;
        if (existing) {
            const loadCredentials = async () => {
                const value = await getApiKey(settings, profile.id, cancellable, true);
                const headers = await getProviderHeaders(profile, cancellable, true);
                return [value, headers];
            };
            loadCredentials().then(([value, headers]) => {
                if (cancellable.is_cancelled())
                    return;
                originalKey = value;
                originalHeaders = headers;
                headerEditor._buffer.set_text(JSON.stringify(headers, null, 2), -1);
                headerEditor.sensitive = true;
                key.text = value;
                key.sensitive = true;
                save.sensitive = true;
                if (removeButton)
                    removeButton.sensitive = true;
            }).catch(error => {
                if (!cancellable.is_cancelled())
                    showError(error);
            });
        }
        save.connect('clicked', async () => {
            const outputLimitValue = outputLimit.value();
            if (outputLimitValue === null)
                return;
            save.sensitive = false;
            group.sensitive = false;
            try {
                const headers = validateHeaders(providerJson(headerText, _('Custom headers')));
                const parameters = providerJson(parameterText, _('Extra request parameters'));
                const candidate = {...profile, name: name.text, url: url.text, model: model.text,
                    hasCustomHeaders: Object.keys(headers).length ? true : undefined,
                    advanced: {outputLimit: outputLimitValue || undefined,
                        temperature: temperature.text.trim() ? Number(temperature.text) : undefined,
                        reasoningEffort: REASONING_EFFORTS[reasoning.selected] ?? '', parameters}};
                const validated = validateProvider(candidate, false);
                await saveProviderConnection(settings, validated, {apiKey: key.text, headers}, cancellable);
                if (cancellable.is_cancelled())
                    return;
                const connectionChanged = !existing || existing.url !== validated.url ||
                    existing.adapter !== validated.adapter;
                if (connectionChanged || key.text !== originalKey ||
                    JSON.stringify(headers) !== JSON.stringify(originalHeaders)) {
                    this._cacheModels(settings, profile.id, []);
                    if (settings.get_string('provider') === profile.id) {
                        abortModelRequests();
                        if (this._modelRow) {
                            this._modelRow._request = null;
                            this._modelRow._refreshButton.sensitive = true;
                            this._modelRow._statusRow.visible = false;
                            this._modelRow.title = _('Model');
                            this._setModelOptions(this._modelRow, settings, profile.id, []);
                        }
                    }
                }
                window.close();
            } catch (error) {
                if (!cancellable.is_cancelled())
                    showError(error);
            } finally {
                if (!cancellable.is_cancelled()) {
                    save.sensitive = key.sensitive;
                    group.sensitive = true;
                }
            }
        });
        if (existing) {
            const remove = new Gtk.Button({label: _('Delete provider'), valign: Gtk.Align.CENTER,
                sensitive: key.sensitive});
            removeButton = remove;
            remove.add_css_class('destructive-action');
            const deletion = new Adw.ActionRow({title: _('Remove this connection')});
            deletion.add_suffix(remove);
            group.add(deletion);
            remove.connect('clicked', async () => {
                remove.sensitive = false;
                save.sensitive = false;
                group.sensitive = false;
                try {
                    if (settings.get_int('provider-migration-version') < 1)
                        throw new Error(_('Finish provider migration before deleting a provider.'));
                    const references = providerReferences(settings, profile.id);
                    if (references.length)
                        throw new Error(format(_('Choose another provider first for: %s.'), references.join(', ')));
                    const confirmed = await new Promise(resolve => {
                        const confirmation = new Adw.MessageDialog({transient_for: window,
                            modal: true, destroy_with_parent: true,
                            heading: _('Delete provider?'),
                            body: format(_('Remove “%s” and its saved API key?'), profile.name),
                            default_response: 'cancel', close_response: 'cancel'});
                        confirmation.add_response('cancel', _('Cancel'));
                        confirmation.add_response('delete', _('Delete'));
                        confirmation.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
                        confirmation.connect('response', (_dialog, response) => resolve(response === 'delete'));
                        confirmation.present();
                    });
                    if (!confirmed || cancellable.is_cancelled())
                        return;
                    await deleteProvider(settings, profile.id, cancellable);
                    if (cancellable.is_cancelled())
                        return;
                    this._cacheModels(settings, profile.id, []);
                    window.close();
                } catch (error) {
                    if (!cancellable.is_cancelled())
                        showError(error);
                } finally {
                    if (!cancellable.is_cancelled()) {
                        remove.sensitive = true;
                        save.sensitive = key.sensitive;
                        group.sensitive = true;
                    }
                }
            });
        }
        window.present();
    }

    _renderProviderSettings(settings) {
        this._chatgptClient?.destroy();
        this._chatgptClient = null;
        abortModelRequests();
        for (const row of this._providerRows)
            this._providerSettings.remove(row);
        this._providerRows = [];

        let provider = settings.get_string('provider');
        let info;
        try {
            info = resolveProvider(settings, provider);
        } catch (error) {
            this._providerSettings.title = _('Provider unavailable');
            const row = new Adw.ActionRow({title: error.message});
            this._providerSettings.add(row);
            this._providerRows.push(row);
            return;
        }
        this._providerSettings.title = info.name;
        this._providerSettings.description = provider === 'chatgpt'
            ? _('Use your ChatGPT plan. Credentials are stored securely in Passwords and Keys.')
            : provider === 'ollama'
            ? _('Runs on your configured local server.')
            : provider === 'openai-compatible'
                ? _('Connects to LM Studio or another OpenAI-compatible server.')
            : provider === 'cloudflare'
                ? _('API tokens are stored securely in Passwords and Keys.')
                : _('API keys are stored securely in Passwords and Keys.');
        if (provider === 'chatgpt')
            this._chatgptAccounts(settings);
        else if (provider === 'ollama')
            this._providerRows.push(entry(this._providerSettings, settings, 'ollama-url', _('Address')));
        else if (info.url !== undefined) {
            const edit = new Adw.ActionRow({title: _('Connection'), subtitle: info.url,
                activatable: true});
            edit.add_suffix(new Gtk.Image({icon_name: 'document-edit-symbolic'}));
            edit.connect('activated', () => this._editProvider(settings, info));
            this._providerSettings.add(edit);
            this._providerRows.push(edit);
        } else if (provider === 'cloudflare') {
            this._providerRows.push(entry(
                this._providerSettings, settings, 'cloudflare-account-id', _('Account ID')));
            this._providerRows.push(this._secretEntry(settings, provider, _('API token')));
        } else {
            this._providerRows.push(this._secretEntry(settings, provider));
        }

        const modelRow = new Adw.ComboRow({title: _('Model'), enable_search: true,
            use_subtitle: true, subtitle_lines: 2, use_markup: false});
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Refresh models'),
            valign: Gtk.Align.CENTER,
        });
        refresh.add_css_class('flat');
        const custom = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Enter a custom model'),
            valign: Gtk.Align.CENTER,
        });
        custom.add_css_class('flat');
        modelRow.add_suffix(refresh);
        if (provider !== 'chatgpt')
            modelRow.add_suffix(custom);
        this._providerSettings.add(modelRow);
        this._providerRows.push(modelRow);
        modelRow._refreshButton = refresh;
        this._modelRow = modelRow;
        const modelStatus = new Adw.ActionRow({title: _('Model refresh failed'), visible: false});
        modelRow._statusRow = modelStatus;
        this._providerSettings.add(modelStatus);
        this._providerRows.push(modelStatus);

        if (provider === 'chatgpt') {
            const efforts = ['auto', 'low', 'medium', 'high'];
            const thinking = new Adw.ComboRow({
                title: _('Thinking effort'),
                subtitle: _('More effort can take longer.'),
                tooltip_text: _('Applies to all actions using this provider. Support varies by model.'),
                model: Gtk.StringList.new([_('Auto'), _('Low'), _('Medium'), _('High')]),
                selected: Math.max(0, efforts.indexOf(settings.get_string('chatgpt-thinking-effort'))),
            });
            thinking.connect('notify::selected', () => {
                settings.set_string('chatgpt-thinking-effort', efforts[thinking.selected] ?? 'auto');
            });
            this._providerSettings.add(thinking);
            this._providerRows.push(thinking);
        }

        const cached = this._cachedModels(settings, provider);
        this._setModelOptions(modelRow, settings, provider, cached);
        modelRow.connect('notify::selected', () => {
            if (modelRow._updating)
                return;
            const id = modelRow._modelIds?.[modelRow.selected];
            if (id !== undefined)
                setProviderModel(settings, provider, id);
        });
        refresh.connect('clicked', () => this._refreshModels(settings, provider, modelRow, refresh));
        custom.connect('clicked', () => this._customModel(settings, provider, modelRow));
        if (provider === 'chatgpt')
            this._refreshChatGPTModels = () => this._refreshModels(settings, provider, modelRow, refresh);
    }

    _chatgptAccounts(settings) {
        const client = new ChatGPTClient(settings);
        this._chatgptClient = client;
        const row = new Adw.ComboRow({title: _('Account'), use_markup: false,
            use_subtitle: true, subtitle_lines: 2});
        const controls = new Adw.ExpanderRow({title: _('Connect your account'), use_markup: false});
        const buttons = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
            margin_start: 16, margin_end: 16, margin_top: 12, margin_bottom: 12});
        controls.add_row(new Adw.PreferencesRow({title: _('Account controls'), child: buttons}));
        const connect = new Gtk.Button({label: _('Continue with ChatGPT'), valign: Gtk.Align.CENTER});
        const add = new Gtk.Button({label: _('Add account'), valign: Gtk.Align.CENTER});
        const signOut = new Gtk.Button({label: _('Sign out'), valign: Gtk.Align.CENTER});
        const cancel = new Gtk.Button({label: _('Cancel'), visible: false, valign: Gtk.Align.CENTER});
        for (const button of [connect, add, signOut, cancel])
            buttons.append(button);
        for (const item of [row, controls]) {
            this._providerSettings.add(item);
            this._providerRows.push(item);
        }
        buttons.append(new Gtk.LinkButton({label: _('Manage usage'),
            uri: 'https://chatgpt.com/settings/usage', valign: Gtk.Align.CENTER}));
        let accounts = [];
        let updating = false;
        let firstLoad = true;
        let pending = null;
        const current = () => this._chatgptClient === client;
        const updateButtons = () => {
            const account = accounts[row.selected];
            row.sensitive = !pending && accounts.length > 0;
            connect.visible = !account?.connected || !account?.authorized;
            connect.sensitive = !pending;
            controls.title = account?.connected ? _('Account options') : _('Connect your account');
            if (!account?.connected)
                controls.expanded = true;
            add.visible = accounts.length > 0;
            add.sensitive = !pending;
            signOut.visible = Boolean(account?.connected);
            signOut.sensitive = !pending;
            cancel.visible = Boolean(pending);
            row.title = account?.connected && account.authorized ? _('Connected account') : _('Account');
            row.tooltip_text = account?.label ?? _('No saved accounts');
        };
        const reload = async () => {
            const loaded = await client.accounts();
            if (!current()) return;
            accounts = loaded;
            updating = true;
            row.model = Gtk.StringList.new(accounts.length ? accounts.map(account => account.label) : [_('No saved accounts')]);
            row.selected = Math.max(0, accounts.findIndex(account => account.id === settings.get_string('chatgpt-account-id')));
            updating = false;
            const id = accounts[row.selected]?.id ?? '';
            if (id !== settings.get_string('chatgpt-account-id')) {
                settings.set_string('chatgpt-account-id', id);
                clearModels();
                if (accounts[row.selected]?.connected)
                    this._refreshChatGPTModels();
            }
            updateButtons();
            if (firstLoad) {
                controls.expanded = !accounts[row.selected]?.connected;
                firstLoad = false;
            }
        };
        const clearModels = () => {
            abortModelRequests();
            settings.set_string('chatgpt-model', '');
            this._cacheModels(settings, 'chatgpt', []);
            this._setModelOptions(this._modelRow, settings, 'chatgpt', []);
        };
        row.connect('notify::selected', () => {
            if (updating || pending || !current()) return;
            settings.set_string('chatgpt-account-id', accounts[row.selected]?.id ?? '');
            clearModels();
            updateButtons();
            if (accounts[row.selected]?.connected)
                this._refreshChatGPTModels();
        });
        const run = async action => {
            pending = new Gio.Cancellable();
            controls.expanded = true;
            controls.subtitle = _('Connecting…');
            updateButtons();
            try {
                await action(pending);
            } catch (error) {
                if (current()) controls.subtitle = error.message ?? String(error);
            } finally {
                pending = null;
                if (current()) {
                    updateButtons();
                    try { await reload(); } catch (error) { controls.subtitle = error.message ?? String(error); }
                }
            }
        };
        const login = id => run(async cancellable => {
            const result = await client.signIn(id, cancellable);
            if (!current()) return;
            settings.set_string('chatgpt-account-id', result.id);
            clearModels();
            controls.subtitle = result.authorized ? _('Connected to your ChatGPT plan.') : _('Plan access was not granted. Reconnect and allow plan usage.');
            if (result.authorized) {
                this._refreshChatGPTModels();

            }
        });
        connect.connect('clicked', () => login(accounts[row.selected]?.id ?? null));
        add.connect('clicked', () => login(null));
        cancel.connect('clicked', () => pending?.cancel());
        signOut.connect('clicked', () => run(async cancellable => {
            const id = accounts[row.selected]?.id;
            const result = await client.signOut(id, cancellable);
            if (!current()) return;
            clearModels();
            controls.subtitle = result.revoked ? _('Signed out.') : _('Signed out locally. Remove this connection in Manage usage to confirm remote revocation.');
        }));
        updateButtons();
        reload().catch(error => { if (current()) controls.subtitle = error.message ?? String(error); });
    }

    _secretEntry(settings, provider, title = _('API key')) {
        const credential = provider === 'cloudflare' ? _('API token') : _('API key');
        const row = new Adw.PasswordEntryRow({
            title,
            show_apply_button: true,
        });
        const status = new Gtk.Image({
            icon_name: 'content-loading-symbolic',
            tooltip_text: _('Loading from Passwords and Keys…'),
        });
        row.add_suffix(status);
        row.sensitive = false;
        this._providerSettings.add(row);

        const unlock = new Gtk.Button({label: _('Unlock'), valign: Gtk.Align.CENTER, visible: false});
        row.add_suffix(unlock);
        const load = async interactive => {
            unlock.sensitive = false;
            try {
                const key = await getApiKey(settings, provider, this._keyCancellable, interactive);
                if (this._keyCancellable && row.get_parent()) {
                    row.text = key;
                    row.editable = true;
                    row.sensitive = true;
                    unlock.visible = false;
                    status.icon_name = key ? 'emblem-ok-symbolic' : 'dialog-password-symbolic';
                    status.tooltip_text = key ? _('Stored securely in Passwords and Keys') : format(_('No %s saved'), credential);
                }
            } catch (error) {
                if (this._keyCancellable && row.get_parent()) {
                    status.icon_name = 'dialog-error-symbolic';
                    status.tooltip_text = error.message ?? String(error);
                    row.sensitive = true;
                    row.editable = false;
                    unlock.visible = true;
                }
            } finally {
                if (this._keyCancellable && row.get_parent())
                    unlock.sensitive = true;
            }
        };
        unlock.connect('clicked', () => load(true));
        load(false);

        const save = async () => {
            if (!row.editable)
                return;
            row.sensitive = false;
            status.icon_name = 'content-loading-symbolic';
            status.tooltip_text = _('Saving…');
            try {
                await setApiKey(settings, provider, row.text, this._keyCancellable);
                if (row.get_parent()) {
                    status.icon_name = row.text.trim() ? 'emblem-ok-symbolic' : 'dialog-password-symbolic';
                    status.tooltip_text = row.text.trim()
                        ? _('Stored securely in Passwords and Keys')
                        : format(_('%s removed'), credential);
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
        }
        cache[provider] = models;
        settings.set_string('model-cache', JSON.stringify(cache));
    }

    _setModelOptions(row, settings, provider, models) {
        const current = providerModel(settings, provider);
        const options = [...models];
        if (!current && provider !== 'chatgpt')
            options.unshift({id: '', name: _('Choose a model')});
        if (provider !== 'chatgpt' && current && !options.some(model => model.id === current))
            options.unshift({id: current, name: current});
        row._modelIds = options.map(model => model.id);
        row._updating = true;
        row.model = Gtk.StringList.new(options.map(model =>
            !model.id ? model.name :
                model.name && model.name !== model.id ? format(_('%s — %s'), model.name, model.id) : model.id));
        row.selected = Math.max(0, row._modelIds.indexOf(current));
        row._updating = false;
        if (provider === 'chatgpt')
            settings.set_string('chatgpt-model', row._modelIds[row.selected] ?? '');
    }

    async _refreshModels(settings, provider, row, button) {
        button.sensitive = false;
        row.title = _('Loading models…');
        row._statusRow.visible = false;
        const request = Symbol();
        row._request = request;
        try {
            const models = await fetchModels(settings, provider, true);
            if (this._modelRow !== row || row._request !== request)
                return;
            this._cacheModels(settings, provider, models);
            this._setModelOptions(row, settings, provider, models);
        } catch (error) {
            if (this._modelRow === row && row._request === request) {
                row._statusRow.subtitle = error.message ?? String(error);
                row._statusRow.visible = true;
            }
        } finally {
            if (this._modelRow === row && row._request === request) {
                row.title = _('Model');
                button.sensitive = true;
            }
        }
    }

    _customModel(settings, provider, modelRow) {
        const field = new Adw.EntryRow({
            title: _('Model ID'),
            text: providerModel(settings, provider),
            show_apply_button: true,
        });
        const group = new Adw.PreferencesGroup();
        group.add(field);
        const page = new Adw.PreferencesPage();
        page.add(group);
        const dialog = new Adw.Window({
            title: _('Custom model'),
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
            setProviderModel(settings, provider, id);
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
            const provider = this._providerChoices.find(item => item.id === action.provider);
            const override = provider
                ? format(_('%s%s'), provider.name, action.model ? ` — ${action.model}` : '')
                : action.provider ? _('Provider unavailable — choose another provider') : _('Uses active provider and model');
            const limits = action.inputLimit || action.outputLimit
                ? format(_('Limits: input %s, output %s'), formatTokenLimit(action.inputLimit), formatTokenLimit(action.outputLimit))
                : '';
            const mode = action.inputMode === 'prompt'
                ? _('Uses selected text as the prompt')
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
                tooltip_text: _('Show in panel menu'),
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
                tooltip_text: _('Move up'),
                sensitive: index > 0,
                valign: Gtk.Align.CENTER,
            });
            up.add_css_class('flat');
            up.connect('clicked', () => this._moveAction(settings, action.id, -1));
            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: _('Move down'),
                sensitive: index < storedActions.length - 1,
                valign: Gtk.Align.CENTER,
            });
            down.add_css_class('flat');
            down.connect('clicked', () => this._moveAction(settings, action.id, 1));
            const edit = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                tooltip_text: _('Edit action'),
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

        const add = new Adw.ActionRow({title: _('Add action'), activatable: true});
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
            { id: 'ask', name: _('Ask') },
            { id: 'correct', name: _('Correct selected text') },
            { id: 'rewrite', name: _('Rewrite selected text') },
            { id: 'prompt', name: _('Run selected prompt') },
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
                tooltip_text: _('Move up'),
                sensitive: i > 0,
            });
            up.add_css_class('flat');
            up.connect('clicked', () => moveAction(i, -1));

            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Move down'),
                sensitive: i < quickActionIds.length - 1,
            });
            down.add_css_class('flat');
            down.connect('clicked', () => moveAction(i, 1));

            const remove = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Remove from Quick Actions'),
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
            const add = new Adw.ActionRow({ title: _('Add quick action'), activatable: true });
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
                title: _('Limit reached'),
                subtitle: _('Up to four actions appear beside the selection button. More remain available in the palette.')
            });
            this._quickActionsGroup.add(limit);
            this._quickActionRows.push(limit);
        }
    }

    _showAddQuickActionDialog(settings, allActions, currentIds, onAdd) {
        const availableActions = allActions.filter(a => a.id && !currentIds.includes(a.id));

        const dialog = new Adw.PreferencesWindow({
            title: _('Add Quick Action'),
            modal: true,
            destroy_with_parent: true,
            transient_for: this._actionsGroup.get_root(),
            default_width: 400,
            default_height: 500,
        });

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({ title: _('Available Actions') });

        for (const action of availableActions) {
            const row = new Adw.ActionRow({ title: action.name, activatable: true });
            row.connect('activated', () => {
                onAdd(action.id);
                dialog.close();
            });
            group.add(row);
        }

        if (availableActions.length === 0) {
            group.add(new Adw.ActionRow({ title: _('No more actions available.') }));
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
        const fields = new Adw.PreferencesGroup({title: action ? _('Edit action') : _('New action')});
        const name = new Adw.EntryRow({title: _('Name'), text: action?.name ?? ''});
        const inputMode = new Adw.ComboRow({
            title: _('Input mode'),
            subtitle: _('Transform the selection or use it directly as the user instruction.'),
            model: Gtk.StringList.new([
                _('Transform text'),
                _('Run as prompt'),
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
            label: _('Prompt'),
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
            title: _('Prompt'),
            child: promptBox,
        });
        const updatePromptLabel = () => {
            const title = inputMode.selected === 1
                ? _('System guidance (optional)')
                : _('Transformation prompt');
            prompt.title = title;
            promptLabel.label = title;
        };
        inputMode.connect('notify::selected', updatePromptLabel);
        updatePromptLabel();
        const choices = listProviders(settings);
        if (action?.provider && !choices.some(item => item.id === action.provider))
            choices.push({id: action.provider, name: _('Unavailable provider')});
        const providerNames = [_('Use active provider'), ...providerLabels(choices)];
        const provider = new Adw.ComboRow({
            title: _('Provider override'),
            model: Gtk.StringList.new(providerNames),
        });
        provider.selected = Math.max(0,
            choices.findIndex(item => item.id === action?.provider) + 1);
        const model = new Adw.EntryRow({
            title: _('Model override (optional)'),
            text: action?.model ?? '',
            sensitive: provider.selected > 0,
        });
        provider.connect('notify::selected', () => {
            model.sensitive = provider.selected > 0;
        });
        const inputLimit = tokenLimitControl(
            _('Input limit'),
            _('Stops before sending when the selected text is over this estimate.'),
            INPUT_LIMIT_VALUES,
            INPUT_LIMIT_LABELS,
            action?.inputLimit ?? 0);
        const outputLimit = tokenLimitControl(
            _('Output limit'),
            _('Auto uses the selected provider’s output limit settings.'),
            OUTPUT_LIMIT_VALUES,
            OUTPUT_LIMIT_LABELS,
            action?.outputLimit ?? 0);
        const visible = new Adw.SwitchRow({
            title: _('Show in panel menu'),
            active: action?.enabled !== false,
        });
        const personal = new Adw.SwitchRow({title: _('Use personal context'),
            active: action?.usePersonalPreferences ?? true});
        fields.add(name);
        const iconLabels = [_('Default'), _('Search'), _('Edit'), _('Spelling'), _('Question'),
            _('Web'), _('Text'), _('Terminal'), _('Star'), _('List'), _('Mail'), _('Find and replace'),
            _('Copy'), _('New document'), _('Bold'), _('Italic'), _('Underline'), _('Align left'),
            _('Bulleted list'), _('Numbered list'), _('Subtitles'), _('Send document'), _('Save'),
            _('Refresh'), _('Pin'), _('Jump')];
        let selectedIcon = ACTION_ICONS.includes(action?.icon) ? action.icon : ACTION_ICONS[0];
        const iconRow = new Adw.ActionRow({title: _('Action icon')});
        const iconChoices = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            min_children_per_line: 5,
            max_children_per_line: 5,
            homogeneous: true,
            column_spacing: 4,
            row_spacing: 4,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
        });
        const iconPopover = new Gtk.Popover({child: iconChoices});
        const actionIcon = new Gtk.MenuButton({
            icon_name: selectedIcon, popover: iconPopover, valign: Gtk.Align.CENTER,
            tooltip_text: _('Choose an action icon'),
        });
        let activeIconButton;
        for (const [index, icon] of ACTION_ICONS.entries()) {
            const button = new Gtk.Button({icon_name: icon,
                width_request: 36, height_request: 36, tooltip_text: iconLabels[index]});
            button.update_property([Gtk.AccessibleProperty.LABEL], [iconLabels[index]]);
            if (icon === selectedIcon) {
                button.add_css_class('suggested-action');
                activeIconButton = button;
            } else {
                button.add_css_class('flat');
            }
            button.connect('clicked', () => {
                activeIconButton.remove_css_class('suggested-action');
                activeIconButton.add_css_class('flat');
                button.remove_css_class('flat');
                button.add_css_class('suggested-action');
                activeIconButton = button;
                selectedIcon = icon;
                actionIcon.icon_name = icon;
                iconPopover.popdown();
            });
            iconChoices.append(button);
        }
        iconRow.add_suffix(actionIcon);
        iconRow.activatable_widget = actionIcon;
        fields.add(iconRow);
        fields.add(inputMode);
        fields.add(prompt);
        fields.add(visible);
        page.add(fields);
        const advanced = new Adw.PreferencesGroup();
        const advancedOptions = new Adw.ExpanderRow({title: _('Advanced options'),
            subtitle: _('Provider, model, and token limits')});
        for (const row of [personal, provider, model, inputLimit.row, inputLimit.custom, outputLimit.row, outputLimit.custom])
            advancedOptions.add_row(row);
        advanced.add(advancedOptions);
        page.add(advanced);

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.END,
            margin_start: 18,
            margin_end: 18,
            margin_bottom: 18,
        });
        const cancel = new Gtk.Button({label: _('Cancel')});
        const save = new Gtk.Button({label: _('Save')});
        save.add_css_class('suggested-action');
        buttons.append(cancel);
        if (action) {
            const remove = new Gtk.Button({label: _('Delete')});
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
            title: action ? _('Edit action') : _('New action'),
            modal: true,
            destroy_with_parent: true,
            transient_for: this._actionsGroup.get_root(),
            default_width: 620,
            default_height: 680,
            content,
        });
        dialog.add_css_class('plyph-preferences');
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
            const providerId = provider.selected > 0 ? choices[provider.selected - 1]?.id ?? '' : '';
            const next = {
                id: action?.id ?? GLib.uuid_string_random(),
                name: actionName,
                prompt: actionPrompt,
                icon: selectedIcon,
                enabled: visible.active,
                provider: providerId,
                model: providerId ? model.text.trim() : '',
                inputMode: inputModeValue,
                usePersonalPreferences: personal.active,
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
            disabled_text: _('Not set'),
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        row.connect('activated', () => {
            const content = new Adw.StatusPage({
                title: format(_('Set %s shortcut'), title),
                description: _('Press a key combination. Backspace clears it; Escape cancels.'),
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
