import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

export const ActionPalette = GObject.registerClass(
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
