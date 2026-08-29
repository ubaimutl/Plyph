import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AiClient} from './ai.js';
import {readActions} from './actions.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

const ResultDialog = GObject.registerClass(
class ResultDialog extends ModalDialog.ModalDialog {
    _init(result, onReplace, onCopy, onCopySelection, onCancel, onClose) {
        super._init({destroyOnClose: true});
        this._finished = false;
        this._onClose = onClose;
        this._onReplace = onReplace;
        this._onCopySelection = onCopySelection;
        this._expanded = false;
        this._estimatedLines = result.split('\n').reduce((total, line) =>
            total + Math.max(1, Math.ceil(line.length / 70)), 0);

        const header = new St.BoxLayout({
            style_class: 'plyph-preview-header',
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: 'Result',
            style_class: 'modal-dialog-headline',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        const wrapButton = new St.Button({
            label: 'Wrap',
            style_class: 'button flat plyph-preview-wrap',
            toggle_mode: true,
            checked: true,
            accessible_name: 'Wrap lines',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        header.add_child(wrapButton);
        this._expandIcon = new St.Icon({icon_name: 'view-fullscreen-symbolic'});
        const expandButton = new St.Button({
            style_class: 'icon-button flat plyph-preview-icon',
            child: this._expandIcon,
            accessible_name: 'Expand preview',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        expandButton.connect('clicked', () => this._toggleExpanded(expandButton));
        header.add_child(expandButton);
        this.contentLayout.add_child(header);

        this._scroll = new St.ScrollView({
            overlay_scrollbars: true,
            style_class: 'vfade plyph-result-scroll',
        });
        const surface = new St.BoxLayout(SHELL_MAJOR >= 48
            ? {
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'plyph-result-surface',
                x_expand: true,
            }
            : {
                vertical: true,
                style_class: 'plyph-result-surface',
                x_expand: true,
            });
        this._label = new St.Label({
            text: result,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            style_class: 'plyph-result',
        });
        this._label.clutter_text.set_selectable(true);
        this._label.clutter_text.set_editable(true);
        this._label.clutter_text.set_cursor_visible(true);
        this._label.clutter_text.set_reactive(true);
        this._label.clutter_text.set_line_wrap(true);
        this._label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        wrapButton.connect('notify::checked', () =>
            this._label.clutter_text.set_line_wrap(wrapButton.checked));
        surface.add_child(this._label);
        this._scroll.set_child(surface);
        this.contentLayout.add_child(this._scroll);
        this._resizePreview();

        this.setButtons([
            {
                label: 'Cancel',
                key: Clutter.KEY_Escape,
                action: () => this._finish(onCancel),
            },
            {
                label: 'Copy',
                action: () => this._finish(onCopy, this._label.clutter_text.get_text()),
            },
            {
                label: 'Replace',
                default: true,
                action: () => this._finish(onReplace, this._label.clutter_text.get_text()),
            },
        ]);
        this.setInitialKeyFocus(this._label.clutter_text);
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        const state = event.get_state();
        const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (control && (key === Clutter.KEY_a || key === Clutter.KEY_A)) {
            this._label.clutter_text.set_selection(0, -1);
            return Clutter.EVENT_STOP;
        }
        if (control && (key === Clutter.KEY_c || key === Clutter.KEY_C)) {
            const selection = this._label.clutter_text.get_selection();
            if (selection)
                this._onCopySelection(selection);
            return Clutter.EVENT_STOP;
        }
        if (control && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
            this._finish(this._onReplace, this._label.clutter_text.get_text());
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    _toggleExpanded(button) {
        this._expanded = !this._expanded;
        this._expandIcon.icon_name = this._expanded
            ? 'view-restore-symbolic'
            : 'view-fullscreen-symbolic';
        button.accessible_name = this._expanded ? 'Restore preview size' : 'Expand preview';
        this._resizePreview();
    }

    _resizePreview() {
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const availableWidth = Math.max(480, monitor.width - 160);
        const availableHeight = Math.max(260, monitor.height - 300);
        const width = this._expanded
            ? availableWidth
            : Math.min(680, Math.max(500, Math.floor(monitor.width * 0.4)));
        const height = this._expanded
            ? availableHeight
            : Math.min(
                Math.max(200, Math.floor(monitor.height * 0.5)),
                Math.max(96, this._estimatedLines * 21 + 24));
        this._scroll.set_size(Math.min(width, availableWidth), Math.min(height, availableHeight));
    }

    destroy() {
        this._expandIcon?.destroy();
        this._expandIcon = null;
        this._label?.destroy();
        this._label = null;
        this._scroll?.destroy();
        this._scroll = null;
        this._onReplace = null;
        this._onCopySelection = null;
        this._onClose = null;
        super.destroy();
    }

    _finish(action = null, value = undefined) {
        if (this._finished)
            return;
        this._finished = true;
        const onClose = this._onClose;
        this._onClose = null;
        this.close();
        onClose?.();
        action?.(value);
    }
});

const ActionPalette = GObject.registerClass(
class ActionPalette extends ModalDialog.ModalDialog {
    _init(actions, onActivate, onClose) {
        super._init({destroyOnClose: true, styleClass: 'plyph-palette'});
        this._actions = actions;
        this._buttons = [];
        this._selected = 0;
        this._finished = false;
        this._onActivate = onActivate;
        this._onClose = onClose;

        const header = new St.BoxLayout({
            style_class: 'plyph-palette-header',
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: 'Plyph',
            style_class: 'plyph-palette-title',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        const closeButton = new St.Button({
            style_class: 'icon-button flat plyph-palette-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: 'Close action palette',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        closeButton.connect('clicked', () => this._finish());
        header.add_child(closeButton);
        this.contentLayout.add_child(header);
        const list = new St.BoxLayout(SHELL_MAJOR >= 48
            ? {orientation: Clutter.Orientation.VERTICAL, style_class: 'plyph-palette-list'}
            : {vertical: true, style_class: 'plyph-palette-list'});
        this.contentLayout.add_child(list);

        actions.forEach(action => {
            if (action.separatorBefore) {
                list.add_child(new St.Widget({
                    style_class: 'plyph-palette-separator',
                    x_expand: true,
                }));
            }
            const row = new St.BoxLayout({style_class: 'plyph-palette-row'});
            row.add_child(new St.Icon({
                icon_name: action.icon,
                style_class: 'plyph-palette-icon',
            }));
            row.add_child(new St.Label({
                text: action.name,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                child: row,
                can_focus: true,
                reactive: true,
                track_hover: true,
                style_class: 'plyph-palette-item',
                x_expand: true,
            });
            button.connect('clicked', () => this._finish(action));
            list.add_child(button);
            this._buttons.push(button);
        });

        this._select(0);
        this.setInitialKeyFocus(this._buttons[0]);
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this._finish();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up) {
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down) {
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this._finish(this._actions[this._selected]);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    _select(index) {
        this._buttons[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = (index + this._buttons.length) % this._buttons.length;
        const button = this._buttons[this._selected];
        button.add_style_pseudo_class('selected');
        button.grab_key_focus();
    }

    destroy() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
        super.destroy();
    }

    _finish(action = null) {
        if (this._finished)
            return;
        this._finished = true;
        this.close();
        this._onClose();
        if (action)
            this._onActivate(action);
    }
});

export default class PlyphExtension extends Extension {
    enable() {
        this._busy = false;
        this._iconResetId = null;
        this._feedbackId = null;
        this._feedbackFollowId = null;
        this._feedback = null;
        this._previewDialog = null;
        this._actionPalette = null;
        this._undo = null;
        this._undoClearId = null;
        this._pendingDelays = new Map();
        this._settings = this.getSettings();
        this._client = new AiClient(this._settings);
        this._clipboard = St.Clipboard.get_default();
        this._keyboard = Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._defaultIcon = Gio.icon_new_for_string(
            this.path + '/icons/plyph-symbolic.svg');
        this._indicator = new PanelMenu.Button(0, this.metadata.name, false);
        this._icon = new St.Icon({
            gicon: this._defaultIcon,
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(this._icon);

        const correct = new PopupMenu.PopupMenuItem('Correct selected text');
        correct.connect('activate', () => this._run('correct'));
        this._indicator.menu.addMenuItem(correct);

        const rewrite = new PopupMenu.PopupMenuItem('Rewrite selected text');
        rewrite.connect('activate', () => this._run('rewrite'));
        this._indicator.menu.addMenuItem(rewrite);

        const runPrompt = new PopupMenu.PopupMenuItem('Run selected prompt');
        runPrompt.connect('activate', () => this._run('prompt'));
        this._indicator.menu.addMenuItem(runPrompt);

        this._actionsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._actionsSection);
        this._rebuildActions();
        this._actionsChangedId = this._settings.connect('changed::custom-actions',
            () => this._rebuildActions());

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._undoItem = new PopupMenu.PopupMenuItem('Undo last replacement');
        this._undoItem.setSensitive(false);
        this._undoItem.connect('activate', () => this._undoLast());
        this._indicator.menu.addMenuItem(this._undoItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._addShortcut('correct-shortcut', 'correct');
        this._addShortcut('rewrite-shortcut', 'rewrite');
        Main.wm.addKeybinding('actions-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._openActions());
    }

    disable() {
        Main.wm.removeKeybinding('correct-shortcut');
        Main.wm.removeKeybinding('rewrite-shortcut');
        Main.wm.removeKeybinding('actions-shortcut');
        this._settings.disconnect(this._actionsChangedId);
        this._actionsChangedId = null;
        this._client.destroy();
        this._client = null;

        if (this._previewDialog) {
            this._previewDialog.destroy();
            this._previewDialog = null;
        }
        this._destroyActionPalette();

        if (this._feedbackFollowId) {
            GLib.Source.remove(this._feedbackFollowId);
            this._feedbackFollowId = null;
        }
        if (this._feedbackId) {
            GLib.Source.remove(this._feedbackId);
            this._feedbackId = null;
        }
        if (this._feedback) {
            this._feedback.destroy();
            this._feedback = null;
        }

        if (this._iconResetId) {
            GLib.Source.remove(this._iconResetId);
            this._iconResetId = null;
        }
        this._clearUndo();
        this._undoItem.destroy();
        this._undoItem = null;

        for (const [id, resolve] of this._pendingDelays) {
            GLib.Source.remove(id);
            resolve(false);
        }
        this._pendingDelays.clear();
        this._pendingDelays = null;

        this._actionsSection.destroy();
        this._actionsSection = null;
        this._icon.destroy();
        this._icon = null;
        this._defaultIcon = null;
        this._indicator.destroy();
        this._indicator = null;
        this._keyboard = null;
        this._clipboard = null;
        this._settings = null;
    }

    _addShortcut(name, mode) {
        Main.wm.addKeybinding(name, this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._run(mode));
    }

    _rebuildActions() {
        this._actionsSection.removeAll();
        for (const action of readActions(this._settings).filter(item => item.enabled)) {
            const item = new PopupMenu.PopupMenuItem(action.name);
            item.connect('activate', () => this._run(
                'custom', action.prompt, action.name,
                {
                    provider: action.provider,
                    model: action.model,
                    inputMode: action.inputMode,
                    inputLimit: action.inputLimit,
                    outputLimit: action.outputLimit,
                }));
            this._actionsSection.addMenuItem(item);
        }
    }

    _openActions() {
        const position = this._settings.get_string('action-palette-position');
        if (position !== 'monitor-center' && position !== 'near-pointer') {
            this._indicator.menu.open();
            return;
        }
        if (this._actionPalette)
            return;

        const actions = [
            {name: 'Correct selected text', mode: 'correct', icon: 'tools-check-spelling-symbolic'},
            {name: 'Rewrite selected text', mode: 'rewrite', icon: 'document-edit-symbolic'},
            {name: 'Run selected prompt', mode: 'prompt', icon: 'system-run-symbolic'},
            ...readActions(this._settings)
                .filter(action => action.enabled)
                .map((action, index) => ({
                    name: action.name,
                    mode: 'custom',
                    prompt: action.prompt,
                    provider: action.provider,
                    model: action.model,
                    inputMode: action.inputMode,
                    inputLimit: action.inputLimit,
                    outputLimit: action.outputLimit,
                    icon: 'system-run-symbolic',
                    separatorBefore: index === 0,
                })),
        ];

        if (position === 'monitor-center') {
            const palette = new ActionPalette(actions,
                action => this._run(
                    action.mode, action.prompt,
                    action.mode === 'custom' ? action.name : null,
                    {
                        provider: action.provider ?? '',
                        model: action.model ?? '',
                        inputMode: action.inputMode ?? 'transform',
                        inputLimit: action.inputLimit ?? 0,
                        outputLimit: action.outputLimit ?? 0,
                    }),
                () => {
                    if (this._actionPalette === palette)
                        this._actionPalette = null;
                });
            this._actionPalette = palette;
            palette.open();
            return;
        }

        const source = new St.Widget({
            reactive: true,
            width: 1,
            height: 1,
            opacity: 0,
        });
        Main.uiGroup.add_child(source);
        const palette = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(palette.actor);
        const manager = new PopupMenu.PopupMenuManager(source);
        manager.addMenu(palette);

        const addAction = (label, callback) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', callback);
            palette.addMenuItem(item);
        };
        addAction('Correct selected text', () => this._run('correct'));
        addAction('Rewrite selected text', () => this._run('rewrite'));
        addAction('Run selected prompt', () => this._run('prompt'));

        const customActions = actions.slice(3);
        if (customActions.length > 0)
            palette.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const action of customActions) {
            addAction(action.name, () => this._run(
                'custom', action.prompt, action.name,
                {
                    provider: action.provider,
                    model: action.model,
                    inputMode: action.inputMode,
                    inputLimit: action.inputLimit,
                    outputLimit: action.outputLimit,
                }));
        }

        this._actionPalette = palette;
        palette.connect('open-state-changed', (_menu, open) => {
            if (!open && this._actionPalette === palette)
                this._destroyActionPalette();
        });
        palette.connect('destroy', () => source.destroy());

        const [pointerX, pointerY] = global.get_pointer();
        source.set_position(pointerX, pointerY + 8);
        palette.open();
    }

    _destroyActionPalette() {
        if (this._actionPalette) {
            this._actionPalette.destroy();
            this._actionPalette = null;
        }
    }

    _promptOptions() {
        return {
            provider: this._settings.get_string('prompt-run-provider'),
            model: this._settings.get_string('prompt-run-model'),
            inputLimit: this._settings.get_int64('prompt-run-input-limit'),
            outputLimit: this._settings.get_int64('prompt-run-output-limit'),
        };
    }

    async _run(mode, customPrompt = null, actionName = null, options = {}) {
        if (this._busy)
            return;
        const client = this._client;
        const focusedWindow = global.display.focus_window;
        this._busy = true;
        this._setIcon('content-loading-symbolic');
        this._showFeedback('Working…', false, 0);
        try {
            const selection = await this._readSelection(focusedWindow);
            const text = selection.text;
            if (this._client !== client)
                return;
            if (!text.trim())
                throw new Error('Select text first.');
            const requestOptions = mode === 'prompt' ? this._promptOptions() : options;
            const output = await client.transform(text, mode, customPrompt, requestOptions);
            if (this._client !== client)
                return;
            if (this._settings.get_boolean('preview-results'))
                this._showPreview(output, focusedWindow, selection.primaryText);
            else
                this._replace(
                    output, false,
                    actionName ?? (mode === 'rewrite'
                        ? 'Rewritten'
                        : mode === 'prompt' ? 'Generated' : 'Corrected'),
                    focusedWindow, selection.primaryText);
        } catch (error) {
            if (this._client !== client)
                return;
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._restoreDefaultIcon();
            this._showFeedback(error.message ?? String(error), true, 3500);
        } finally {
            this._busy = false;
        }
    }

    _showPreview(output, focusedWindow, primaryText) {
        if (this._previewDialog)
            this._previewDialog.destroy();
        const dialog = new ResultDialog(output,
            result => this._replace(result, true, 'Replaced', focusedWindow, primaryText),
            result => {
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, result);
                this._setIcon('emblem-ok-symbolic', 1200);
                this._showFeedback('Copied');
            },
            selection =>
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, selection),
            () => this._showFeedback('Cancelled'),
            () => {
                if (this._previewDialog === dialog)
                    this._previewDialog = null;
            });
        this._previewDialog = dialog;
        dialog.open();
        this._restoreDefaultIcon();
        this._showFeedback('Ready to review');
    }

    _replace(output, delayed, message, focusedWindow, primaryText) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
        this._pasteWhenReady(delayed ? 200 : 0, message, () => {
            this._rememberUndo(focusedWindow);
            this._discardConsumedPrimary(primaryText);
        });
    }

    async _pasteWhenReady(initialDelay, message, onPasted = null) {
        if (initialDelay > 0 && !await this._delay(initialDelay))
            return;
        const released = await this._waitForModifiersReleased();
        if (!this._keyboard)
            return;
        if (!released) {
            this._restoreDefaultIcon();
            this._showFeedback('Release the shortcut keys and try again.', true, 3500);
            return;
        }
        if (!await this._delay(25) || !this._keyboard)
            return;
        this._paste();
        onPasted?.();
        this._setIcon('emblem-ok-symbolic', 1200);
        this._showFeedback(message);
    }

    _rememberUndo(focusedWindow) {
        this._clearUndo();
        this._undo = {focusedWindow};
        this._undoItem.setSensitive(true);
        this._undoClearId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._undoClearId = null;
            this._clearUndo();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _undoLast() {
        if (!this._undo)
            return;
        if (global.display.focus_window !== this._undo.focusedWindow) {
            this._showFeedback('Return to the original window before undoing.', true, 3500);
            return;
        }

        const released = await this._waitForModifiersReleased();
        if (!released || !this._keyboard) {
            this._showFeedback('Release the shortcut keys and try again.', true, 3500);
            return;
        }
        if (!await this._delay(25) || !this._keyboard)
            return;
        this._sendUndo();
        this._clearUndo();
        this._setIcon('emblem-ok-symbolic', 1200);
        this._showFeedback('Replacement undone');
    }

    _clearUndo() {
        if (this._undoClearId) {
            GLib.Source.remove(this._undoClearId);
            this._undoClearId = null;
        }
        this._undo = null;
        this._undoItem?.setSensitive(false);
    }

    _showFeedback(message, error = false, duration = 1500) {
        if (!this._settings?.get_boolean('pointer-feedback')) {
            if (error)
                Main.notifyError('Plyph', message);
            return;
        }
        if (this._feedbackId) {
            GLib.Source.remove(this._feedbackId);
            this._feedbackId = null;
        }
        if (this._feedbackFollowId) {
            GLib.Source.remove(this._feedbackFollowId);
            this._feedbackFollowId = null;
        }
        if (this._feedback) {
            this._feedback.destroy();
            this._feedback = null;
        }

        const label = new St.Label({
            text: message,
            style_class: error ? 'plyph-feedback error' : 'plyph-feedback',
            opacity: 0,
        });
        label.clutter_text.line_wrap = true;
        Main.uiGroup.add_child(label);
        const [, naturalWidth] = label.get_preferred_width(-1);
        const [, naturalHeight] = label.get_preferred_height(naturalWidth);

        const position = () => {
            const [pointerX, pointerY] = global.get_pointer();
            const x = Math.max(8, Math.min(pointerX + 16, global.stage.width - naturalWidth - 8));
            const y = Math.max(8, Math.min(pointerY + 20, global.stage.height - naturalHeight - 8));
            label.set_position(x, y);
        };
        position();
        label.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._feedback = label;

        this._feedbackFollowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._feedback)
                return GLib.SOURCE_REMOVE;
            position();
            return GLib.SOURCE_CONTINUE;
        });

        if (duration > 0) {
            this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                this._feedbackId = null;
                if (this._feedbackFollowId) {
                    GLib.Source.remove(this._feedbackFollowId);
                    this._feedbackFollowId = null;
                }
                label.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._feedback === label)
                            this._feedback = null;
                        label.destroy();
                    },
                });
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    async _readSelection(focusedWindow) {
        if (this._usesExplicitCopy(focusedWindow))
            return {text: await this._readExplicitCopy(), primaryText: null};

        const text = await this._getClipboardText(St.ClipboardType.PRIMARY);
        if (text?.trim())
            return {text, primaryText: text};
        if (!this._settings?.get_boolean('clipboard-fallback'))
            return {text: '', primaryText: null};
        return {
            text: await this._getClipboardText(St.ClipboardType.CLIPBOARD),
            primaryText: null,
        };
    }

    async _discardConsumedPrimary(consumedText) {
        if (!consumedText || !await this._delay(100) || !this._clipboard)
            return;
        const currentText = await this._getClipboardText(St.ClipboardType.PRIMARY);
        if (this._clipboard && currentText === consumedText)
            this._clipboard.set_text(St.ClipboardType.PRIMARY, '');
    }

    _usesExplicitCopy(window) {
        if (!window || !this._settings)
            return false;
        const allowed = this._settings.get_string('explicit-copy-apps')
            .split(/[\n,]/)
            .map(value => value.trim().toLowerCase())
            .filter(Boolean);
        if (allowed.length === 0)
            return false;

        const appId = Shell.WindowTracker.get_default()
            .get_window_app(window)?.get_id();
        const values = [
            appId,
            window.get_wm_class(),
            window.get_wm_class_instance(),
            window.get_gtk_application_id(),
        ].filter(Boolean).map(value => value.toLowerCase());
        return allowed.some(name => values.some(value => value.includes(name)));
    }

    async _readExplicitCopy() {
        const previous = await this._getClipboardText(St.ClipboardType.CLIPBOARD);
        const released = await this._waitForModifiersReleased();
        if (!this._keyboard)
            return '';
        if (!released)
            throw new Error('Release the shortcut keys and try again.');
        if (!await this._delay(25))
            return '';

        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        if (!await this._delay(25))
            return '';
        this._copy();

        for (const delay of [60, 100, 180, 300]) {
            if (!await this._delay(delay))
                return '';
            const text = await this._getClipboardText(St.ClipboardType.CLIPBOARD);
            if (text?.trim())
                return text;
        }

        if (previous)
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
        if (this._settings?.get_boolean('clipboard-fallback') && previous?.trim())
            return previous;
        throw new Error('Could not capture selected text. Select it and try again.');
    }

    _getClipboardText(type) {
        const clipboard = this._clipboard;
        return new Promise(resolve => {
            if (!clipboard) {
                resolve('');
                return;
            }
            clipboard.get_text(type, (_clipboard, text) => resolve(text ?? ''));
        });
    }

    _delay(milliseconds) {
        return new Promise(resolve => {
            if (!this._pendingDelays) {
                resolve(false);
                return;
            }
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                this._pendingDelays?.delete(id);
                resolve(Boolean(this._keyboard));
                return GLib.SOURCE_REMOVE;
            });
            this._pendingDelays.set(id, resolve);
        });
    }

    async _waitForModifiersReleased(timeoutMs = 1500) {
        const modifierMask = [
            Clutter.ModifierType.SHIFT_MASK,
            Clutter.ModifierType.CONTROL_MASK,
            Clutter.ModifierType.MOD1_MASK,
            Clutter.ModifierType.MOD3_MASK,
            Clutter.ModifierType.MOD4_MASK,
            Clutter.ModifierType.MOD5_MASK,
            Clutter.ModifierType.SUPER_MASK,
            Clutter.ModifierType.HYPER_MASK,
            Clutter.ModifierType.META_MASK,
        ].reduce((mask, value) => mask | (value ?? 0), 0);
        const startedAt = GLib.get_monotonic_time();

        while (this._keyboard) {
            const [, , modifiers] = global.get_pointer();
            if ((modifiers & modifierMask) === 0)
                return true;
            const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
            if (elapsedMs >= timeoutMs)
                return false;
            if (!await this._delay(20))
                return false;
        }
        return false;
    }

    _copy() {
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_c, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_c, Clutter.KeyState.RELEASED);
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    _paste() {
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.RELEASED);
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    _sendUndo() {
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_z, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_z, Clutter.KeyState.RELEASED);
        this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    _setIcon(name, resetAfter = 0) {
        this._icon.gicon = null;
        this._icon.icon_name = name;
        if (this._iconResetId) {
            GLib.Source.remove(this._iconResetId);
            this._iconResetId = null;
        }
        if (resetAfter) {
            this._iconResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, resetAfter, () => {
                this._icon.icon_name = null;
                this._icon.gicon = this._defaultIcon;
                this._iconResetId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _restoreDefaultIcon() {
        if (this._iconResetId) {
            GLib.Source.remove(this._iconResetId);
            this._iconResetId = null;
        }
        this._icon.icon_name = null;
        this._icon.gicon = this._defaultIcon;
    }

}
