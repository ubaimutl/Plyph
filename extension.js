import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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
const FLOATING_COLLAPSE_DELAY = 900;
const FLOATING_HIDE_DELAY = 2800;
const FLOATING_INITIAL_HIDE_DELAY = 4000;
const FLOATING_TIMEOUT_CHECK_INTERVAL = 100;
const DISMISSED_SELECTION_COOLDOWN = 1200000;

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

const AskDialog = GObject.registerClass(
class AskDialog extends ModalDialog.ModalDialog {
    _init(onAsk, onCancel, onClose) {
        super._init({destroyOnClose: true});
        this._finished = false;
        this._onClose = onClose;
        this._onAsk = onAsk;

        const header = new St.BoxLayout({
            style_class: 'plyph-preview-header',
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: 'Ask',
            style_class: 'modal-dialog-headline',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        this.contentLayout.add_child(header);

        this._entry = new St.Entry({
            hint_text: 'Instruction...',
            style_class: 'plyph-ask-entry',
            can_focus: true,
            x_expand: true,
        });
        this.contentLayout.add_child(this._entry);

        this.setButtons([
            {
                label: 'Cancel',
                key: Clutter.KEY_Escape,
                action: () => this._finish(onCancel),
            },
            {
                label: 'Ask',
                default: true,
                action: () => this._finish(onAsk, this._entry.get_text()),
            },
        ]);

        this._entryActivateId = this._entry.clutter_text.connect('activate', () => {
            this._finish(onAsk, this._entry.get_text());
        });

        this.setInitialKeyFocus(this._entry.clutter_text);
    }

    destroy() {
        if (this._entryActivateId) {
            this._entry.clutter_text.disconnect(this._entryActivateId);
            this._entryActivateId = null;
        }
        this._entry?.destroy();
        this._entry = null;
        this._onAsk = null;
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

const FloatingToolbar = GObject.registerClass(
class FloatingToolbar extends St.BoxLayout {
    _init(gicon, getActions, onAction, onMore, onExpandedChanged, settings, iconDirectory) {
        super._init({
            style_class: 'plyph-floating-toolbar',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._expanded = false;
        this._showingFeedback = false;
        this._busy = false;
        this._gicon = gicon;
        this._getActions = getActions;
        this._onAction = onAction;
        this._onMore = onMore;
        this._onExpandedChanged = onExpandedChanged;
        this._settings = settings;
        this._toolbarIcons = Object.fromEntries(
            ['ask', 'correct', 'rewrite', 'prompt', 'custom', 'more'].map(name =>
                [name, Gio.icon_new_for_string(`${iconDirectory}/plyph-${name}-symbolic.svg`)]));

        this._logoButton = new St.Button({
            style_class: 'plyph-floating-logo',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this._logoIcon = new St.Icon({
            gicon: gicon,
            style_class: 'plyph-floating-logo-icon',
        });
        this._logoButton.set_child(this._logoIcon);
        this._logoButton.connect('clicked', () => this.toggleExpanded());
        this.add_child(this._logoButton);

        this._actionsBox = new St.BoxLayout({
            style_class: 'plyph-floating-actions',
            opacity: 0,
            visible: false,
        });
        this.add_child(this._actionsBox);
    }

    get expanded() {
        return this._expanded;
    }

    get showingFeedback() {
        return this._showingFeedback;
    }

    collapse() {
        if (!this._expanded && !this._showingFeedback) return;
        this._expanded = false;
        this._showingFeedback = false;
        this._busy = false;
        if (this._onExpandedChanged) this._onExpandedChanged(false);

        this._logoButton.reactive = true;
        this._logoButton.can_focus = true;
        this._logoButton.accessible_name = 'Open Plyph actions';
        this._logoIcon.icon_name = null;
        this._logoIcon.gicon = this._gicon;
        this._setLogoState();

        this._logoButton.remove_style_pseudo_class('active');
        this._actionsBox.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._expanded && !this._showingFeedback) {
                    this._actionsBox.hide();
                    this._actionsBox.destroy_all_children();
                }
            }
        });
    }

    showFeedback(message, state = 'success') {
        this._expanded = false;
        this._showingFeedback = true;
        this._busy = state === 'working';
        this._logoButton.add_style_pseudo_class('active');
        this._logoButton.reactive = !this._busy;
        this._logoButton.can_focus = !this._busy;
        this._logoButton.accessible_name = message;

        const iconName = state === 'working'
            ? 'content-loading-symbolic'
            : state === 'error'
                ? 'dialog-error-symbolic'
                : 'emblem-ok-symbolic';
        this._logoIcon.gicon = null;
        this._logoIcon.icon_name = iconName;
        this._setLogoState(state);

        this._actionsBox.remove_transition('opacity');
        this._actionsBox.destroy_all_children();

        const box = new St.BoxLayout({
            vertical: false,
            style_class: `plyph-floating-status ${state}`,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const label = new St.Label({
            text: message,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'plyph-floating-status-label',
        });
        box.add_child(label);

        this._actionsBox.add_child(box);
        this._actionsBox.show();

        this._actionsBox.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    toggleExpanded() {
        if (this._busy)
            return;
        if (this._expanded) {
            this.collapse();
            return;
        }

        this._expanded = true;
        this._showingFeedback = false;
        this._logoButton.reactive = true;
        this._logoButton.can_focus = true;
        this._logoButton.accessible_name = 'Close Plyph actions';
        this._logoIcon.icon_name = null;
        this._logoIcon.gicon = this._gicon;
        this._setLogoState();
        if (this._onExpandedChanged) this._onExpandedChanged(true);

        this._logoButton.add_style_pseudo_class('active');

        this._actionsBox.destroy_all_children();

        const allActions = this._getActions();

        // Read quick action references from settings if available, else default
        let quickActionIds = [];
        try {
            quickActionIds = JSON.parse(this._settings?.get_string('quick-actions') || '[]');
        } catch (e) {}

        if (!Array.isArray(quickActionIds) || quickActionIds.length === 0) {
            quickActionIds = ['ask', 'correct', 'rewrite'];
        }

        const quickActions = quickActionIds.map(id => {
            const action = allActions.find(a => a.id === id || a.mode === id);
            if (!action) return null;

            // Make built-in action names compact for the toolbar
            let compactName = action.name;
            if (action.mode === 'ask') compactName = 'Ask';
            if (action.mode === 'correct') compactName = 'Correct';
            if (action.mode === 'rewrite') compactName = 'Rewrite';
            if (action.mode === 'prompt') compactName = 'Run Prompt';

            return { ...action, compactName };
        }).filter(Boolean).slice(0, 4);

        for (const action of quickActions) {
            const btn = new St.Button({
                style_class: 'plyph-floating-action-btn flat',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            const content = new St.BoxLayout({ style_class: 'plyph-floating-action-content' });
            content.add_child(new St.Icon({
                gicon: this._toolbarIcons[action.mode] ?? this._toolbarIcons.custom,
                style_class: 'plyph-floating-action-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            content.add_child(new St.Label({
                text: action.compactName,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            btn.set_child(content);
            btn.connect('clicked', () => {
                this.collapse();
                this._onAction(action);
            });
            this._actionsBox.add_child(btn);
        }

        const moreBtn = new St.Button({
            style_class: 'plyph-floating-action-btn flat',
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({
                gicon: this._toolbarIcons.more,
                style_class: 'plyph-floating-action-icon',
                y_align: Clutter.ActorAlign.CENTER,
            })
        });
        moreBtn.connect('clicked', () => {
            this.collapse();
            this._onMore();
        });
        this._actionsBox.add_child(moreBtn);

        this._actionsBox.show();
        this._actionsBox.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _setLogoState(state = null) {
        for (const name of ['working', 'success', 'error'])
            this._logoIcon.remove_style_class_name(name);
        if (state)
            this._logoIcon.add_style_class_name(state);
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

        const ask = new PopupMenu.PopupMenuItem('Ask...');
        ask.connect('activate', () => this._run('ask'));
        this._indicator.menu.addMenuItem(ask);

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

        this._addShortcut('ask-shortcut', 'ask');
        this._addShortcut('correct-shortcut', 'correct');
        this._addShortcut('rewrite-shortcut', 'rewrite');
        Main.wm.addKeybinding('actions-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._openActions());

        this._setupFloatingButton();
    }

    disable() {
        this._destroyFloatingButton();

        Main.wm.removeKeybinding('ask-shortcut');
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
        if (this._askDialog) {
            this._askDialog.destroy();
            this._askDialog = null;
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

    _runAction(action) {
        this._floatingButton?.collapse();
        this._run(
            action.mode, action.prompt,
            action.mode === 'custom' ? action.name : null,
            {
                provider: action.provider ?? '',
                model: action.model ?? '',
                inputMode: action.inputMode ?? 'transform',
                inputLimit: action.inputLimit ?? 0,
                outputLimit: action.outputLimit ?? 'auto',
            },
            true
        );
    }

    _runAvailableAction(action, fromFloatingToolbar = false) {
        if (fromFloatingToolbar) {
            this._runAction(action);
            return;
        }

        this._run(
            action.mode, action.prompt,
            action.mode === 'custom' ? action.name : null,
            {
                provider: action.provider ?? '',
                model: action.model ?? '',
                inputMode: action.inputMode ?? 'transform',
                inputLimit: action.inputLimit ?? 0,
                outputLimit: action.outputLimit ?? 0,
            }
        );
    }

    _setupFloatingButton() {
        this._floatingButton = new FloatingToolbar(
            this._defaultIcon,
            () => this._getAvailableActions(),
            (action) => this._runAction(action),
            () => this._openActions(true),
            expanded => this._handleFloatingExpandedChanged(expanded),
            this._settings,
            `${this.path}/icons`
        );
        this._floatingButton.hide();
        Main.layoutManager.uiGroup.add_child(this._floatingButton);
        this._applyFloatingToolbarScale();
        this._floatingToolbarScaleId = this._settings.connect('changed::floating-toolbar-scale', () =>
            this._applyFloatingToolbarScale());
        // CSS scaling changes the actual allocation, keeping text sharp and
        // pointer targets aligned with the visible controls.
        this._floatingButtonSizeSignalIds = [
            this._floatingButton.connect('notify::width', () => this._clampFloatingToolbar()),
            this._floatingButton.connect('notify::height', () => this._clampFloatingToolbar()),
        ];

        this._floatingButtonTimeoutId = null;
        this._floatingToolbarCollapseId = null;
        this._floatingButtonDismissDelay = 0;
        this._selectionReadSerial = 0;
        this._dismissedSelectionText = null;
        this._dismissedSelectionUntil = 0;
        this._dismissedSelectionWindow = null;
        this._floatingSourceWindow = null;
        this._floatingSourceSignalIds = [];
        this._hidingFloatingButton = false;
        this._lastSelectionText = null;

        this._floatingButtonHoverId = this._floatingButton.connect('notify::hover', () =>
            this._handleFloatingHoverChanged());

        this._floatingButtonCaptureId = global.stage.connect(
            'captured-event', (_actor, event) => this._handleFloatingCapturedEvent(event));

        const selection = global.display.get_selection();
        this._selectionChangedId = selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_PRIMARY)
                this._handleSelectionChange();
        });

        this._floatingButtonFocusId = global.display.connect('notify::focus-window', () => {
            const window = global.display.focus_window;
            if (window === this._floatingSourceWindow)
                return;
            // Shell controls may temporarily take focus from the source window.
            if (!window && (this._actionPalette || this._isPointerInsideFloatingButton(0)))
                return;
            this._hideFloatingButton(true);
        });
        this._floatingButtonSettingId = this._settings.connect('changed::show-floating-button', () => {
            if (!this._settings.get_boolean('show-floating-button'))
                this._hideFloatingButton(true);
        });
        this._floatingOverviewId = Main.overview.connect('showing', () =>
            this._hideFloatingButton(true));
    }

    _applyFloatingToolbarScale() {
        const scales = [100, 125, 150, 175, 200];
        const requested = Math.round(this._settings.get_double('floating-toolbar-scale') * 100);
        const scale = scales.includes(requested) ? requested : 100;
        for (const value of scales)
            this._floatingButton.remove_style_class_name(`plyph-toolbar-scale-${value}`);
        if (scale !== 100)
            this._floatingButton.add_style_class_name(`plyph-toolbar-scale-${scale}`);
    }

    _clampFloatingToolbar() {
        const toolbar = this._floatingButton;
        if (!toolbar?.visible)
            return;
        const monitorIndex = this._floatingSourceWindow?.get_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex]
            ?? Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const x = Math.max(monitor.x + 8,
            Math.min(toolbar.x, monitor.x + monitor.width - toolbar.width - 8));
        const y = Math.max(monitor.y + 8,
            Math.min(toolbar.y, monitor.y + monitor.height - toolbar.height - 8));
        if (x !== toolbar.x || y !== toolbar.y)
            toolbar.set_position(x, y);
    }

    _destroyFloatingButton() {
        this._hideFloatingButton();
        for (const id of this._floatingButtonSizeSignalIds ?? [])
            this._floatingButton?.disconnect(id);
        this._floatingButtonSizeSignalIds = [];
        if (this._floatingButtonHoverId) {
            this._floatingButton?.disconnect(this._floatingButtonHoverId);
            this._floatingButtonHoverId = null;
        }
        if (this._floatingToolbarScaleId) {
            this._settings.disconnect(this._floatingToolbarScaleId);
            this._floatingToolbarScaleId = null;
        }
        if (this._floatingButtonSettingId) {
            this._settings.disconnect(this._floatingButtonSettingId);
            this._floatingButtonSettingId = null;
        }
        if (this._floatingOverviewId) {
            Main.overview.disconnect(this._floatingOverviewId);
            this._floatingOverviewId = null;
        }
        if (this._selectionChangedId) {
            const selection = global.display.get_selection();
            selection.disconnect(this._selectionChangedId);
            this._selectionChangedId = null;
        }
        if (this._floatingButtonCaptureId) {
            global.stage.disconnect(this._floatingButtonCaptureId);
            this._floatingButtonCaptureId = null;
        }
        if (this._floatingButtonFocusId) {
            global.display.disconnect(this._floatingButtonFocusId);
            this._floatingButtonFocusId = null;
        }
        if (this._floatingButtonTimeoutId) {
            GLib.Source.remove(this._floatingButtonTimeoutId);
            this._floatingButtonTimeoutId = null;
        }
        if (this._floatingToolbarCollapseId) {
            GLib.Source.remove(this._floatingToolbarCollapseId);
            this._floatingToolbarCollapseId = null;
        }
        if (this._floatingButton) {
            this._floatingButton.destroy();
            this._floatingButton = null;
        }
    }

    _watchFloatingSourceWindow(window) {
        if (this._floatingSourceWindow === window)
            return;

        this._clearFloatingSourceWindow();
        this._floatingSourceWindow = window;
        // Wayland delivers application input before Clutter's captured-event.
        // Mutter updates user-time for clicks, touch and keys in that window,
        // including clicks that clear a selection without releasing PRIMARY.
        this._floatingSourceSignalIds = [
            window.connect('notify::user-time', () => this._hideFloatingButton(true)),
            window.connect('unmanaged', () => this._hideFloatingButton(true)),
            window.connect('position-changed', () => this._hideFloatingButton(true)),
            window.connect('size-changed', () => this._hideFloatingButton(true)),
        ];
    }

    _clearFloatingSourceWindow() {
        for (const id of this._floatingSourceSignalIds ?? [])
            this._floatingSourceWindow.disconnect(id);
        this._floatingSourceSignalIds = [];
        this._floatingSourceWindow = null;
    }

    _isAppExcluded(window) {
        if (!window) return false;

        if (this._previewDialog || this._askDialog || this._actionPalette) {
            return true;
        }

        const allowed = this._settings.get_string('excluded-apps')
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
        ].filter(Boolean).map(value => value?.toLowerCase());
        return allowed.some(name => values.some(value => value?.includes(name)));
    }

    async _handleSelectionChange() {
        const serial = ++this._selectionReadSerial;

        if (!this._settings?.get_boolean('show-floating-button')) {
            this._hideFloatingButton();
            return;
        }

        if (this._busy || this._ignoreNextSelection) return;

        const window = global.display.focus_window;
        if (!window || Main.overview.visible || this._isAppExcluded(window)) {
            this._hideFloatingButton();
            return;
        }

        this._watchFloatingSourceWindow(window);
        const userTime = window.get_user_time();
        const isCurrent = () => serial === this._selectionReadSerial &&
            this._settings?.get_boolean('show-floating-button') &&
            global.display.focus_window === window && window.get_user_time() === userTime;

        if (!await this._delay(120) || !isCurrent())
            return;

        // Wait until a drag/Shift-selection finishes before placing the button.
        const selectingMask = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.SHIFT_MASK;
        while (global.get_pointer()[2] & selectingMask) {
            if (!await this._delay(50) || !isCurrent())
                return;
        }

        if (!this._clipboard)
            return;

        let text = await this._getClipboardText(St.ClipboardType.PRIMARY);
        if (!isCurrent())
            return;

        if (!text?.trim()) {
            if (!await this._delay(120) || !isCurrent())
                return;
            text = await this._getClipboardText(St.ClipboardType.PRIMARY);
            if (!isCurrent())
                return;
        }

        if (!text?.trim()) {
            this._hideFloatingButton(true);
            return;
        }

        if (this._dismissedSelectionText) {
            if (text === this._dismissedSelectionText && window === this._dismissedSelectionWindow) {
                if (GLib.get_monotonic_time() < this._dismissedSelectionUntil)
                    return;
            }
            this._dismissedSelectionText = null;
            this._dismissedSelectionUntil = 0;
            this._dismissedSelectionWindow = null;
        }

        if (this._lastSelectionText === text && this._floatingButton?.visible) {
            return;
        }

        this._lastSelectionText = text;

        if (this._busy || this._previewDialog || this._askDialog || this._actionPalette) {
            return;
        }

        this._positionFloatingButton();
    }

    _positionFloatingButton() {
        if (!this._floatingButton) return;

        const [pointerX, pointerY] = global.get_pointer();
        let x = pointerX + 12;
        let y = pointerY + 12;

        this._floatingButton.remove_transition('opacity');
        this._floatingButton.opacity = 0;
        this._floatingButton.show();

        const [, naturalWidth] = this._floatingButton.get_preferred_width(-1);
        const [, naturalHeight] = this._floatingButton.get_preferred_height(naturalWidth);

        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - naturalWidth - 8));
        y = Math.max(monitor.y + 8, Math.min(y, monitor.y + monitor.height - naturalHeight - 8));

        this._floatingButton.set_position(x, y);

        this._floatingButton.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._resetFloatingButtonTimeout(FLOATING_INITIAL_HIDE_DELAY);
    }

    _handleFloatingCapturedEvent(event) {
        const type = event.type();

        if (this._actionPalette)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this._isFloatingButtonEvent(event))
                this._hideFloatingButton(true);
        } else if (type === Clutter.EventType.KEY_PRESS) {
            const focus = global.stage.get_key_focus();
            const toolbarFocused = focus && this._floatingButton?.contains(focus);
            if (!toolbarFocused || event.get_key_symbol() === Clutter.KEY_Escape)
                this._hideFloatingButton(true);
        } else if (type === Clutter.EventType.SCROLL) {
            if (!this._isFloatingButtonEvent(event))
                this._hideFloatingButton(true);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleFloatingExpandedChanged(expanded) {
        if (this._hidingFloatingButton)
            return;

        this._clearFloatingToolbarCollapse();
        if (expanded) {
            this._resetFloatingButtonTimeout(0);
            this._scheduleFloatingToolbarCollapse();
        } else if (!this._floatingButton?.showingFeedback) {
            this._resetFloatingButtonTimeout(FLOATING_HIDE_DELAY);
        }
    }

    _handleFloatingHoverChanged() {
        if (this._hidingFloatingButton || !this._floatingButton?.visible)
            return;
        if (this._floatingButton?.hover || this._isPointerInsideFloatingButton())
            return;

        if (this._floatingButton?.expanded)
            this._scheduleFloatingToolbarCollapse();
        else if (this._floatingButton?.showingFeedback)
            this._resetFloatingButtonTimeout();
        else
            this._resetFloatingButtonTimeout(FLOATING_HIDE_DELAY);
    }

    _scheduleFloatingToolbarCollapse() {
        this._clearFloatingToolbarCollapse();
        if (!this._floatingButton?.expanded)
            return;

        this._floatingToolbarCollapseId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, FLOATING_COLLAPSE_DELAY, () => {
                this._floatingToolbarCollapseId = null;
                if (!this._floatingButton?.expanded)
                    return GLib.SOURCE_REMOVE;
                if (this._isPointerInsideFloatingButton()) {
                    this._scheduleFloatingToolbarCollapse();
                    return GLib.SOURCE_REMOVE;
                }
                this._floatingButton.collapse();
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearFloatingToolbarCollapse() {
        if (this._floatingToolbarCollapseId) {
            GLib.Source.remove(this._floatingToolbarCollapseId);
            this._floatingToolbarCollapseId = null;
        }
    }

    _isPointerInsideFloatingButton(margin = 6) {
        if (!this._floatingButton?.visible)
            return false;

        const [pointerX, pointerY] = global.get_pointer();
        const [buttonX, buttonY] = this._floatingButton.get_transformed_position();
        const [buttonWidth, buttonHeight] = this._floatingButton.get_transformed_size();
        return pointerX >= buttonX - margin && pointerX <= buttonX + buttonWidth + margin &&
            pointerY >= buttonY - margin && pointerY <= buttonY + buttonHeight + margin;
    }

    _isFloatingButtonEvent(event) {
        if (!this._floatingButton?.visible)
            return false;

        const source = event.get_source?.();
        if (source && (source === this._floatingButton || this._floatingButton.contains(source)))
            return true;

        const [x, y] = event.get_coords();
        const [buttonX, buttonY] = this._floatingButton.get_transformed_position();
        const [buttonWidth, buttonHeight] = this._floatingButton.get_transformed_size();
        return x >= buttonX && x <= buttonX + buttonWidth &&
            y >= buttonY && y <= buttonY + buttonHeight;
    }

    _resetFloatingButtonTimeout(timeoutDuration = null) {
        if (Number.isFinite(timeoutDuration))
            this._floatingButtonDismissDelay = Math.max(0, timeoutDuration);

        if (this._floatingButtonTimeoutId) {
            GLib.Source.remove(this._floatingButtonTimeoutId);
            this._floatingButtonTimeoutId = null;
        }

        if (!this._floatingButtonDismissDelay || !this._floatingButton?.visible ||
            this._hidingFloatingButton)
            return;

        const deadline = GLib.get_monotonic_time() + this._floatingButtonDismissDelay * 1000;
        this._floatingButtonTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, FLOATING_TIMEOUT_CHECK_INTERVAL, () => {
                // Keep the deadline while hovered, so a missed leave event cannot
                // extend it by another full timeout every time we check.
                if (GLib.get_monotonic_time() < deadline || this._isPointerInsideFloatingButton())
                    return GLib.SOURCE_CONTINUE;
                this._floatingButtonTimeoutId = null;
                this._hideFloatingButton(true);
                return GLib.SOURCE_REMOVE;
            });
    }

    _hideFloatingButton(suppressSelection = false) {
        if (suppressSelection && this._lastSelectionText && this._floatingSourceWindow) {
            this._dismissedSelectionText = this._lastSelectionText;
            this._dismissedSelectionWindow = this._floatingSourceWindow;
            this._dismissedSelectionUntil = GLib.get_monotonic_time() +
                DISMISSED_SELECTION_COOLDOWN;
        }
        this._selectionReadSerial = (this._selectionReadSerial ?? 0) + 1;
        this._lastSelectionText = null;
        this._floatingButtonDismissDelay = 0;
        this._clearFloatingSourceWindow();
        this._clearFloatingToolbarCollapse();
        if (this._floatingButtonTimeoutId) {
            GLib.Source.remove(this._floatingButtonTimeoutId);
            this._floatingButtonTimeoutId = null;
        }

        if (!this._floatingButton?.visible)
            return;

        // Hide synchronously: repeated input/hover callbacks must not restart a
        // fade or leave an invisible reactive actor over the application.
        this._hidingFloatingButton = true;
        try {
            this._floatingButton.remove_transition('opacity');
            this._floatingButton.hide();
            this._floatingButton.collapse();
        } finally {
            this._hidingFloatingButton = false;
        }
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

    _getAvailableActions() {
        return [
            {name: 'Ask...', mode: 'ask', icon: 'dialog-question-symbolic'},
            {name: 'Correct selected text', mode: 'correct', icon: 'tools-check-spelling-symbolic'},
            {name: 'Rewrite selected text', mode: 'rewrite', icon: 'document-edit-symbolic'},
            {name: 'Run selected prompt', mode: 'prompt', icon: 'system-run-symbolic'},
            ...readActions(this._settings)
                .filter(action => action.enabled)
                .map((action, index) => ({
                    id: action.id,
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
    }

    _openActions(fromFloatingToolbar = false) {
        let position = this._settings.get_string('action-palette-position');
        if (fromFloatingToolbar) {
            this._clearFloatingToolbarCollapse();
            this._resetFloatingButtonTimeout(0);
            if (position !== 'monitor-center' && position !== 'near-pointer')
                position = 'near-pointer';
        }
        if (position !== 'monitor-center' && position !== 'near-pointer') {
            this._indicator.menu.open();
            return;
        }
        if (this._actionPalette)
            return;

        const actions = this._getAvailableActions();
        const runAction = action =>
            this._runAvailableAction(action, fromFloatingToolbar);
        const resumeFloatingDismiss = () => {
            if (fromFloatingToolbar && !this._busy && this._floatingButton?.visible)
                this._resetFloatingButtonTimeout(FLOATING_HIDE_DELAY);
        };

        if (position === 'monitor-center') {
            const palette = new ActionPalette(actions,
                action => runAction(action),
                () => {
                    if (this._actionPalette === palette)
                        this._actionPalette = null;
                    resumeFloatingDismiss();
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
        for (const action of actions.slice(0, 4))
            addAction(action.name, () => runAction(action));

        const customActions = actions.slice(4);
        if (customActions.length > 0)
            palette.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const action of customActions)
            addAction(action.name, () => runAction(action));

        this._actionPalette = palette;
        palette.connect('open-state-changed', (_menu, open) => {
            if (!open && this._actionPalette === palette) {
                this._destroyActionPalette();
                resumeFloatingDismiss();
            }
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

    async _run(mode, customPrompt = null, actionName = null, options = {}, fromFloatingToolbar = false) {
        if (this._busy)
            return;
        const client = this._client;
        const focusedWindow = global.display.focus_window;
        this._hideFloatingButton(true);
        this._busy = true;
        this._setIcon('content-loading-symbolic');
        this._showFeedback('Working…', 'working', 0);

        let isAskDialogPending = false;
        try {
            const selection = await this._readSelection(focusedWindow);
            const text = selection.text;
            if (this._client !== client)
                return;
            if (!text.trim())
                throw new Error('Select text first.');

            if (mode === 'ask') {
                isAskDialogPending = true;
                this._restoreDefaultIcon();
                this._hideFloatingButton();
                this._clearPointerFeedback();
                this._showAskDialog(focusedWindow, selection, text, client);
                return;
            }

            const requestOptions = mode === 'prompt' ? this._promptOptions() : options;
            const output = await client.transform(text, mode, customPrompt, requestOptions);
            if (this._client !== client)
                return;
            if (this._settings.get_boolean('preview-results'))
                this._showPreview(output, focusedWindow, selection.primaryText);
            else
                await this._replace(
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
            this._setIcon('dialog-error-symbolic', 1800);
            this._showFeedback(error.message ?? String(error), 'error', 3500);
        } finally {
            if (!isAskDialogPending)
                this._busy = false;
        }
    }

    _showAskDialog(focusedWindow, selection, text, client) {
        if (this._askDialog)
            this._askDialog.destroy();

        const dialog = new AskDialog(
            instruction => {
                if (!instruction.trim()) {
                    this._busy = false;
                    return;
                }
                const systemPrompt = "Use the provided context and the user's instruction to produce the requested response. Return only the useful requested output unless the user explicitly asks for an explanation.";
                const userPrompt = `Context:\n${text}\n\nInstruction:\n${instruction}`;
                this._processAsk(focusedWindow, selection, userPrompt, client, systemPrompt);
            },
            () => {
                this._busy = false;
            },
            () => {
                if (this._askDialog === dialog)
                    this._askDialog = null;
            }
        );
        this._askDialog = dialog;
        dialog.open();
    }

    async _processAsk(focusedWindow, selection, text, client, prompt) {
        this._setIcon('content-loading-symbolic');
        this._showFeedback('Working…', 'working', 0);
        try {
            const output = await client.transform(text, 'ask', prompt, { inputMode: 'prompt' });
            if (this._client !== client)
                return;
            if (this._settings.get_boolean('preview-results'))
                this._showPreview(output, focusedWindow, selection.primaryText);
            else
                await this._replace(output, false, 'Generated', focusedWindow, selection.primaryText);
        } catch (error) {
            if (this._client !== client)
                return;
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setIcon('dialog-error-symbolic', 1800);
            this._showFeedback(error.message ?? String(error), 'error', 3500);
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
            null,
            () => {
                if (this._previewDialog === dialog)
                    this._previewDialog = null;
            });
        this._previewDialog = dialog;
        dialog.open();
        this._restoreDefaultIcon();
        this._hideFloatingButton();
        this._clearPointerFeedback();
    }

    _replace(output, delayed, message, focusedWindow, primaryText) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, output);
        return this._pasteWhenReady(delayed ? 200 : 0, message, () => {
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
            this._setIcon('dialog-error-symbolic', 1800);
            this._showFeedback('Release the shortcut keys and try again.', 'error', 3500);
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
            this._setIcon('dialog-error-symbolic', 1800);
            this._showFeedback('Return to the original window before undoing.', 'error', 3500);
            return;
        }

        const released = await this._waitForModifiersReleased();
        if (!released || !this._keyboard) {
            this._setIcon('dialog-error-symbolic', 1800);
            this._showFeedback('Release the shortcut keys and try again.', 'error', 3500);
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

    _clearPointerFeedback() {
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
    }

    _showFeedback(message, state = 'success', duration = 1500) {
        if (!this._settings?.get_boolean('pointer-feedback')) {
            this._clearPointerFeedback();
            if (state === 'error')
                Main.notifyError('Plyph', message);
            return;
        }

        this._clearPointerFeedback();

        const feedback = new St.BoxLayout({
            style_class: `plyph-feedback ${state}`,
            opacity: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            icon_name: state === 'working'
                ? 'content-loading-symbolic'
                : state === 'error'
                    ? 'dialog-error-symbolic'
                    : 'emblem-ok-symbolic',
            style_class: 'plyph-feedback-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        feedback.add_child(icon);
        const label = new St.Label({
            text: message,
            style_class: 'plyph-feedback-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.line_wrap = true;
        feedback.add_child(label);
        Main.uiGroup.add_child(feedback);

        const [, naturalWidth] = feedback.get_preferred_width(-1);
        const [, naturalHeight] = feedback.get_preferred_height(naturalWidth);
        const windowMonitor = global.display.focus_window?.get_monitor();
        const monitor = Number.isInteger(windowMonitor)
            ? Main.layoutManager.monitors[windowMonitor]
                ?? Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor
            : Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const position = this._settings.get_string('feedback-position');
        const margin = 32;
        let x;
        let y;

        if (position.endsWith('-left'))
            x = monitor.x + margin;
        else if (position.endsWith('-right'))
            x = monitor.x + monitor.width - naturalWidth - margin;
        else
            x = monitor.x + (monitor.width - naturalWidth) / 2;

        if (position.startsWith('top-'))
            y = monitor.y + margin;
        else if (position.startsWith('bottom-'))
            y = monitor.y + monitor.height - naturalHeight - margin;
        else
            y = monitor.y + (monitor.height - naturalHeight) / 2;

        x = Math.max(monitor.x + 8,
            Math.min(x, monitor.x + monitor.width - naturalWidth - 8));
        y = Math.max(monitor.y + 8,
            Math.min(y, monitor.y + monitor.height - naturalHeight - 8));
        feedback.set_position(Math.round(x), Math.round(y));
        feedback.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._feedback = feedback;

        if (duration > 0) {
            this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                this._feedbackId = null;
                feedback.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._feedback === feedback)
                            this._feedback = null;
                        feedback.destroy();
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
