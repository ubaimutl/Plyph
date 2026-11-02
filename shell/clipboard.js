import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

export function installTextClipboard(owner, actor, {editable = false, multiline = false, canEdit = () => true, onSubmit = null} = {}) {
    const text = actor.clutter_text;
    actor.can_focus = true;
    text.set_reactive(true);
    text.set_selectable(true);
    if (!editable) {
        text.set_editable(false);
        text.set_cursor_visible(true);
        text.set_cursor_size(0);
    }
    let alive = true;
    let pendingPaste = 0;
    const insertAtSelection = value => {
        text.delete_selection();
        const position = text.get_cursor_position();
        const start = position < 0 ? Array.from(text.get_text()).length : position;
        text.insert_text(value, start);
        const end = start + Array.from(value).length;
        text.set_selection(end, end);
    };
    const handler = event => {
        const key = event.get_key_symbol();
        const state = event.get_state();
        const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        if (state & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;
        const selectAll = control && (key === Clutter.KEY_a || key === Clutter.KEY_A);
        const copy = control && (key === Clutter.KEY_c || key === Clutter.KEY_C || key === Clutter.KEY_Insert);
        const cut = (control && (key === Clutter.KEY_x || key === Clutter.KEY_X)) || (shift && key === Clutter.KEY_Delete);
        const paste = (control && (key === Clutter.KEY_v || key === Clutter.KEY_V)) || (shift && key === Clutter.KEY_Insert);
        const newline = multiline && !control && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter);
        const submit = onSubmit && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter);
        if (!selectAll && !copy && !cut && !paste && !newline && !submit)
            return Clutter.EVENT_PROPAGATE;
        if (submit) {
            if (canEdit())
                onSubmit();
        } else if (selectAll) {
            text.set_selection(0, -1);
        } else if (copy || cut) {
            const selection = text.get_selection();
            if (selection && (!cut || editable && canEdit())) {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selection);
                if (cut)
                    text.delete_selection();
            }
        } else if (newline) {
            if (editable && canEdit())
                insertAtSelection('\n');
        } else if (editable && canEdit()) {
            const request = ++pendingPaste;
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, value) => {
                if (!alive || request !== pendingPaste || !canEdit() || !value ||
                    !actor.contains(global.stage.get_key_focus()))
                    return;
                insertAtSelection(value);
            });
        }
        return Clutter.EVENT_STOP;
    };
    if (!owner._textClipboardHandlers) {
        owner._textClipboardHandlers = new Map();
        const route = event => {
            const focus = global.stage.get_key_focus();
            for (const [field, callback] of owner._textClipboardHandlers) {
                if (field.contains(focus))
                    return callback(event);
            }
            return Clutter.EVENT_PROPAGATE;
        };
        let keyId;
        if (SHELL_MAJOR >= 51) {
            owner._clipboardKeys = new Clutter.KeyController();
            owner._clipboardKeys.set_trigger_keybindings(false);
            keyId = owner._clipboardKeys.connect('key-press', () => route({
                get_key_symbol: () => owner._clipboardKeys.get_key()[1],
                get_state: () => {
                    const [, pressed, latched, locked] = owner._clipboardKeys.get_state();
                    return pressed | latched | locked;
                },
            }));
            owner.add_action_full('plyph-clipboard', Clutter.EventPhase.CAPTURE, owner._clipboardKeys);
        } else {
            keyId = owner.connect('captured-event', (_actor, event) => event.type() === Clutter.EventType.KEY_PRESS
                ? route(event) : Clutter.EVENT_PROPAGATE);
        }
        owner.connect('destroy', () => {
            (owner._clipboardKeys ?? owner).disconnect(keyId);
            owner._textClipboardHandlers.clear();
        });
    }
    owner._textClipboardHandlers.set(actor, handler);
    actor.connect('destroy', () => {
        alive = false;
        pendingPaste++;
        owner._textClipboardHandlers.delete(actor);
    });
    return handler;
}
