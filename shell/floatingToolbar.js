import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const FloatingToolbar = GObject.registerClass(
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
