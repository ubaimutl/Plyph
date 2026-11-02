import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {diffMarkup} from '../diff.js';
import {markdownMarkup} from '../markdown.js';
import {installTextClipboard} from './clipboard.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

export const ErrorDialog = GObject.registerClass(
class ErrorDialog extends ModalDialog.ModalDialog {
    _init(message, onCopy) {
        super._init({destroyOnClose: true});
        this.contentLayout.add_child(new St.Label({
            text: 'Plyph couldn’t complete the action',
            style_class: 'modal-dialog-headline',
        }));
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.max(1, Math.min(600, (monitor.width - 120) / scale));
        const height = Math.max(1, Math.min(320, (monitor.height - 200) / scale));
        const scroll = new St.ScrollView({
            overlay_scrollbars: true,
            style_class: 'vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style: `width: ${width}px; max-height: ${height}px;`,
        });
        const surface = new St.BoxLayout(SHELL_MAJOR >= 48
            ? {orientation: Clutter.Orientation.VERTICAL, x_expand: true}
            : {vertical: true, x_expand: true});
        const label = new St.Label({text: message, x_expand: true});
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.set_selectable(true);
        installTextClipboard(this, label);
        surface.add_child(label);
        scroll.set_child(surface);
        this.contentLayout.add_child(scroll);
        this.setButtons([
            {label: 'Copy error', action: () => onCopy(message)},
            {label: 'Close', key: Clutter.KEY_Escape, default: true, action: () => this.close()},
        ]);
    }
});

export const ResultDialog = GObject.registerClass(
class ResultDialog extends ModalDialog.ModalDialog {
    _init(result, onReplace, onCopy, onCopySelection, onCancel, onClose, original = null, showChanges = false, refinement = null) {
        super._init({destroyOnClose: true, styleClass: 'plyph-preview-dialog'});
        this.contentLayout.get_parent().set_style('padding: 16px; spacing: 12px; min-width: 0; min-height: 0;');
        this.contentLayout.y_expand = false;
        this.buttonLayout.x_align = Clutter.ActorAlign.END;
        this.buttonLayout.x_expand = false;
        this.buttonLayout.set_style('padding: 0; margin: 0; min-height: 0;');
        this.buttonLayout.layout_manager.homogeneous = false;
        this.buttonLayout.layout_manager.spacing = 8 * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._refinement = refinement;
        this._revisions = [result];
        this._revisionIndex = 0;
        this._refining = false;
        this._original = original;
        this._showChanges = false;
        this._finished = false;
        this._onClose = onClose;
        this._onReplace = onReplace;
        this._onCopySelection = onCopySelection;
        this._expanded = false;
        this._splitRatio = null;
        this._discussion = [];
        this._discussing = false;
        this._followUpDrafts = {refine: '', discuss: ''};

        const header = new St.BoxLayout({
            style_class: 'plyph-preview-header',
            x_expand: true,
        });
        const title = new St.BoxLayout({x_expand: true, style_class: 'plyph-preview-title'});
        title.add_child(new St.Label({text: 'Result', style_class: 'modal-dialog-headline',
            y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(title);
        if (refinement) {
            const icon = name => new St.Icon({
                gicon: Gio.icon_new_for_string(`${refinement.iconsPath}/plyph-${name}-symbolic.svg`),
                icon_size: 16,
            });
            this._resultCount = new St.Label({visible: false, y_align: Clutter.ActorAlign.CENTER,
                style_class: 'plyph-result-count'});
            title.add_child(this._resultCount);
            this._previousButton = new St.Button({visible: false, child: icon('previous'),
                style_class: 'icon-button flat plyph-result-nav', accessible_name: 'Previous result',
                reactive: false, can_focus: false, track_hover: true});
            this._nextButton = new St.Button({visible: false, child: icon('next'),
                style_class: 'icon-button flat plyph-result-nav', accessible_name: 'Next result',
                reactive: false, can_focus: false, track_hover: true});
            this._previousId = this._previousButton.connect('clicked', () => this._switchResult(-1));
            this._nextId = this._nextButton.connect('clicked', () => this._switchResult(1));
            title.add_child(this._previousButton);
            title.add_child(this._nextButton);
        }
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
            accessible_name: 'Enlarge preview',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        expandButton.connect('clicked', () => this._toggleExpanded(expandButton));
        header.add_child(expandButton);
        if (original !== null) {
            this._changesButton = new St.Button({
                label: 'Show changes',
                style_class: 'button flat plyph-preview-wrap',
                toggle_mode: true, checked: false, can_focus: true,
                reactive: true, track_hover: true,
                accessible_name: 'Show changes from the original text',
            });
            this._changesChangedId = this._changesButton.connect('notify::checked', () => this._toggleChanges());
            header.add_child(this._changesButton);
        }
        this.contentLayout.add_child(header);

        this._scroll = new St.ScrollView({
            overlay_scrollbars: true,
            style_class: 'vfade plyph-result-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
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
        this._label.clutter_text.set_single_line_mode(false);
        this._label.clutter_text.set_activatable(false);
        this._resultClipboard = installTextClipboard(this, this._label, {editable: true, multiline: true, canEdit: () => !this._refining});
        this._label.clutter_text.set_line_wrap(true);
        this._label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._diffLabel = new St.Label({
            visible: false, x_expand: true, style_class: 'plyph-result',
            y_align: Clutter.ActorAlign.START,
        });
        this._diffLabel.clutter_text.set_selectable(true);
        this._diffLabel.clutter_text.set_reactive(true);
        this._diffClipboard = installTextClipboard(this, this._diffLabel);
        this._diffLabel.clutter_text.set_editable(false);
        this._diffLabel.clutter_text.set_line_wrap(true);
        this._diffLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._diffLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        wrapButton.connect('notify::checked', () => {
            this._label.clutter_text.set_line_wrap(wrapButton.checked);
            this._diffLabel.clutter_text.set_line_wrap(wrapButton.checked);
            this._scroll.hscrollbar_policy = wrapButton.checked ? St.PolicyType.NEVER : St.PolicyType.AUTOMATIC;
            this._resizePreview();
        });
        this._resultChangedId = this._label.clutter_text.connect('text-changed', () => this._toggleChanges());
        surface.add_child(this._label);
        surface.add_child(this._diffLabel);
        this._scroll.set_child(surface);
        this.contentLayout.add_child(this._scroll);
        if (this._changesButton)
            this._changesButton.checked = showChanges && original !== result;
        this._toggleChanges();

        if (refinement) {
            this._divider = new St.Bin({visible: false, x_expand: true, can_focus: true,
                reactive: true, track_hover: true, style_class: 'plyph-preview-divider',
                accessible_name: 'Resize result and discussion. Use Up and Down to adjust, Home to reset.',
                child: new St.Widget({style_class: 'plyph-preview-divider-grip',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})});
            if (SHELL_MAJOR >= 51) {
                this._dividerPan = new Clutter.PanGesture();
                this._dividerPan.set_begin_threshold(0);
                this._dividerPan.set_required_button(1);
                this._dividerPanIds = [this._dividerPan.connect('recognize', () => {
                    this._endDividerDrag();
                    this._dividerStartHeight = this._scroll.height / St.ThemeContext.get_for_stage(global.stage).scale_factor;
                    this._dividerStartY = this._dividerPan.get_begin_centroid_abs().y;
                    this._dividerGrab = global.stage.grab(this._divider);
                    this._divider.add_style_pseudo_class('active');
                    this._divider.grab_key_focus();
                    return Clutter.EVENT_STOP;
                }), this._dividerPan.connect('pan-update', () => {
                    if (!this._dividerGrab)
                        return;
                    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                    this._adjustSplit(this._dividerStartHeight + (this._dividerPan.get_centroid_abs().y - this._dividerStartY) / scale);
                }), this._dividerPan.connect('end', () => this._endDividerDrag())];
                this._divider.add_action(this._dividerPan);
                this._dividerKeys = new Clutter.KeyController();
                this._dividerKeys.set_trigger_keybindings(false);
                this._dividerKeyControllerId = this._dividerKeys.connect('key-press', () =>
                    this._handleDividerKey(this._dividerKeys.get_key()[1]));
                this._divider.add_action_full('plyph-divider-keys', Clutter.EventPhase.CAPTURE, this._dividerKeys);
            } else {
                this._dividerPressId = this._divider.connect('button-press-event', (_actor, event) => this._beginDividerDrag(event));
                this._dividerKeyId = this._divider.connect('key-press-event', (_actor, event) =>
                    this._handleDividerKey(event.get_key_symbol()));
            }
            this.contentLayout.add_child(this._divider);
            this._discussionScroll = new St.ScrollView({visible: false, x_expand: true,
                style_class: 'plyph-discussion-scroll',
                hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
            this._discussionMessages = new St.BoxLayout(SHELL_MAJOR >= 48
                ? {orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'plyph-discussion-messages'}
                : {vertical: true, x_expand: true, style_class: 'plyph-discussion-messages'});
            this._discussionScroll.set_child(this._discussionMessages);
            this._discussionAllocationId = this._discussionMessages.connect('notify::allocation', () => {
                const adjustment = this._discussionScroll.vadjustment;
                if (this._scrollDiscussionToEnd && adjustment) {
                    adjustment.value = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
                    this._scrollDiscussionToEnd = false;
                }
            });
            this.contentLayout.add_child(this._discussionScroll);
            this._refineRow = new St.BoxLayout({visible: false, style_class: 'plyph-refine-row', x_expand: true});
            this._refineEntry = new St.Entry({hint_text: 'Refine this result…',
                accessible_name: 'Refinement instruction', can_focus: true, x_expand: true});
            installTextClipboard(this, this._refineEntry, {editable: true,
                canEdit: () => !this._refining, onSubmit: () => this._refine()});
            this._refineActivateId = this._refineEntry.clutter_text.connect('activate', () => this._refine());
            this._refineButton = new St.Button({style_class: 'icon-button plyph-refine-submit',
                child: new St.Icon({gicon: Gio.icon_new_for_string(`${refinement.iconsPath}/plyph-submit-symbolic.svg`), icon_size: 16}),
                y_align: Clutter.ActorAlign.CENTER, x_expand: false, y_expand: false,
                accessible_name: 'Submit refinement', reactive: true, can_focus: true, track_hover: true});
            this._refineClickId = this._refineButton.connect('clicked', () => this._refine());
            this._refineRow.add_child(this._refineEntry);
            this._refineRow.add_child(this._refineButton);
            this.contentLayout.add_child(this._refineRow);
            this._refineStatus = new St.Label({text: '', x_expand: true});
            this._refineStatus.clutter_text.set_line_wrap(true);
            this._refineStatus.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this._refineStatus.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._refineStatus.clutter_text.set_selectable(true);
            installTextClipboard(this, this._refineStatus);
            this._statusScroll = new St.ScrollView({visible: false, x_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
                style: 'max-height: 72px;'});
            const statusBox = new St.BoxLayout({x_expand: true});
            statusBox.add_child(this._refineStatus);
            this._statusScroll.set_child(statusBox);
            this.contentLayout.add_child(this._statusScroll);
            this._resizePreview();
        }

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
        this._actionButtons = this.buttonLayout.get_children();
        this._replaceButton = this._actionButtons.at(-1);
        this.setInitialKeyFocus(this._replaceButton);
        for (const button of this._actionButtons) {
            button.x_expand = false;
            button.y_expand = false;
            button.set_style('padding: 6px 14px; min-width: 0; min-height: 0; border-radius: 8px;');
        }
        if (refinement) {
            this._refineToggle = new St.Button({style_class: 'button flat',
                style: 'padding: 6px 10px; min-width: 0; min-height: 0; border-radius: 8px;',
                accessible_name: 'Refine result', reactive: true, can_focus: true, track_hover: true});
            const toggleContent = new St.BoxLayout({style_class: 'plyph-refine-toggle'});
            toggleContent.add_child(new St.Icon({
                gicon: Gio.icon_new_for_string(`${refinement.iconsPath}/plyph-refine-symbolic.svg`), icon_size: 16}));
            this._refineToggleLabel = new St.Label({text: 'Refine', y_align: Clutter.ActorAlign.CENTER});
            toggleContent.add_child(this._refineToggleLabel);
            this._refineToggle.set_child(toggleContent);
            this._refineToggleId = this._refineToggle.connect('clicked', () => this._toggleRefinement());
            this.buttonLayout.x_align = Clutter.ActorAlign.FILL;
            this.buttonLayout.x_expand = true;
            this.buttonLayout.insert_child_at_index(this._refineToggle, 0);
            this.buttonLayout.insert_child_at_index(new St.Widget({x_expand: true}), 1);
            this._discussToggle = new St.Button({label: 'Discuss', style_class: 'button flat',
                style: 'padding: 6px 10px; min-width: 0; min-height: 0; border-radius: 8px;',
                accessible_name: 'Discuss result', reactive: true, can_focus: true, track_hover: true});
            this._discussToggleId = this._discussToggle.connect('clicked', () => this._toggleRefinement(true));
            this.buttonLayout.insert_child_at_index(this._discussToggle, 1);
        }
    }

    _toggleRefinement(discuss = false) {
        if (this._refining)
            return;
        this._followUpDrafts[this._discussing ? 'discuss' : 'refine'] = this._refineEntry.get_text();
        this._refineRow.visible = !this._refineRow.visible || discuss !== this._discussing;
        this._discussing = discuss;
        this._refineEntry.set_text(this._followUpDrafts[discuss ? 'discuss' : 'refine']);
        this._refineEntry.hint_text = discuss ? 'Ask about this result…' : 'Refine this result…';
        this._refineEntry.accessible_name = discuss ? 'Question about result' : 'Refinement instruction';
        this._refineButton.accessible_name = discuss ? 'Send question' : 'Submit refinement';
        this._discussionScroll.visible = discuss && this._refineRow.visible && this._discussion.length > 0;
        this._statusScroll.visible = false;
        this._setRefining(false);
        this._resizePreview();
        (this._refineRow.visible ? this._refineEntry : this._replaceButton).grab_key_focus();
    }

    _updateResultNavigation() {
        const multiple = this._revisions.length > 1;
        this._resultCount.text = `${this._revisionIndex + 1}/${this._revisions.length}`;
        this._resultCount.visible = multiple;
        this._previousButton.visible = multiple;
        this._nextButton.visible = multiple;
        this._previousButton.reactive = !this._refining && this._revisionIndex > 0;
        this._nextButton.reactive = !this._refining && this._revisionIndex < this._revisions.length - 1;
        this._previousButton.can_focus = this._previousButton.reactive;
        this._nextButton.can_focus = this._nextButton.reactive;
    }

    _setRefining(busy) {
        this._refining = busy;
        this._label.clutter_text.set_editable(!busy);
        this._refineEntry.clutter_text.set_editable(!busy);
        this._refineToggleLabel.text = busy && !this._discussing ? 'Refining…'
            : this._refineRow.visible && !this._discussing ? 'Hide refinement' : 'Refine';
        this._discussToggle.label = busy && this._discussing ? 'Replying…'
            : this._refineRow.visible && this._discussing ? 'Hide discussion' : 'Discuss';
        this._discussToggle.reactive = !busy;
        this._discussToggle.can_focus = !busy;
        this._refineToggle.reactive = !busy;
        this._refineToggle.can_focus = !busy;
        this._refineButton.reactive = !busy;
        this._refineButton.can_focus = !busy;
        this._updateResultNavigation();
        for (const button of this._actionButtons.slice(1)) {
            button.reactive = !busy;
            button.can_focus = !busy;
        }
    }

    async _refine() {
        const refinement = this._refinement;
        if (!refinement || this._refining || this._finished)
            return;
        if (this._discussing) {
            await this._discuss();
            return;
        }
        const instruction = this._refineEntry.get_text().trim();
        if (!instruction)
            return;
        const previous = this._label.clutter_text.get_text();
        this._statusScroll.visible = false;
        this._setRefining(true);
        this._resizePreview();
        try {
            const result = await refinement.run(previous, instruction);
            if (this._refinement !== refinement || this._finished)
                return;
            if (typeof result !== 'string' || !result.trim())
                throw new Error('No text was returned. Try another instruction.');
            this._revisions[this._revisionIndex] = previous;
            this._revisions.push(result);
            this._revisionIndex = this._revisions.length - 1;
            this._label.clutter_text.set_text(result);
            this._refineEntry.set_text('');
            this._followUpDrafts.refine = '';
            this._toggleChanges();
        } catch (error) {
            if (this._refinement === refinement && !this._finished) {
                this._refineStatus.text = error.message ?? String(error);
                this._statusScroll.visible = true;
            }
        } finally {
            if (this._refinement === refinement && !this._finished) {
                this._setRefining(false);
                this._resizePreview();
                this._refineEntry.grab_key_focus();
            }
        }
    }

    _addDiscussionMessage(role, text, {loading = false} = {}) {
        const row = new St.BoxLayout({x_expand: true, style_class: 'plyph-discussion-row'});
        const column = new St.BoxLayout(SHELL_MAJOR >= 48
            ? {orientation: Clutter.Orientation.VERTICAL, style_class: 'plyph-discussion-column'}
            : {vertical: true, style_class: 'plyph-discussion-column'});
        const message = new St.BoxLayout(SHELL_MAJOR >= 48
            ? {orientation: Clutter.Orientation.VERTICAL, style_class: `plyph-discussion-message ${role}`}
            : {vertical: true, style_class: `plyph-discussion-message ${role}`});
        message.set_style(`max-width: ${this._discussionBubbleWidth ?? 440}px;`);
        const body = new St.Label({text, x_expand: true,
            accessible_name: `${role === 'user' ? 'You' : 'Plyph'}: ${text}`});
        body.clutter_text.set_line_wrap(true);
        body.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        body.clutter_text.set_selectable(true);
        installTextClipboard(this, body);
        body.connect('style-changed', () => {
            this._refineEntry.ensure_style();
            const source = this._refineEntry.clutter_text;
            body.clutter_text.set_selection_color(source.get_selection_color());
            body.clutter_text.set_selected_text_color(source.get_selected_text_color());
        });
        if (role === 'assistant')
            body.clutter_text.set_markup(markdownMarkup(text));
        message.add_child(body);
        column.add_child(message);
        if (role === 'assistant' && !loading) {
            const icon = new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 16});
            const copy = new St.Button({style_class: 'icon-button flat plyph-discussion-copy',
                accessible_name: 'Copy response', can_focus: true,
                x_align: Clutter.ActorAlign.START, child: icon});
            let feedbackId = 0;
            copy.connect('clicked', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
                icon.icon_name = 'object-select-symbolic';
                copy.accessible_name = 'Response copied';
                if (feedbackId)
                    GLib.Source.remove(feedbackId);
                feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    feedbackId = 0;
                    icon.icon_name = 'edit-copy-symbolic';
                    copy.accessible_name = 'Copy response';
                    return GLib.SOURCE_REMOVE;
                });
            });
            copy.connect('destroy', () => {
                if (feedbackId)
                    GLib.Source.remove(feedbackId);
            });
            column.add_child(copy);
            row._copyButton = copy;
        }
        const spacer = new St.Widget({x_expand: true});
        if (role === 'user')
            row.add_child(spacer);
        row.add_child(column);
        if (role !== 'user')
            row.add_child(spacer);
        row._bubble = message;
        row._body = body;
        this._discussionMessages.add_child(row);
        const adjustment = this._discussionScroll.vadjustment;
        this._scrollDiscussionToEnd = role === 'user' || !adjustment ||
            adjustment.upper - adjustment.page_size - adjustment.value < 32;
        return row;
    }

    _showDiscussionLoading() {
        this._clearDiscussionLoading();
        this._discussionLoading = this._addDiscussionMessage('assistant', 'Replying…', {loading: true});
        this._discussionLoading._bubble.add_style_class_name('loading');
        let dots = 0;
        this._discussionLoadingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            dots = dots % 3 + 1;
            this._discussionLoading._body.set_text(`Replying${'.'.repeat(dots)}`);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearDiscussionLoading() {
        if (this._discussionLoadingId) {
            GLib.Source.remove(this._discussionLoadingId);
            this._discussionLoadingId = null;
        }
        this._discussionLoading?.destroy();
        this._discussionLoading = null;
    }

    async _discuss() {
        const refinement = this._refinement;
        if (!refinement || this._refining || this._finished)
            return;
        const question = this._refineEntry.get_text().trim();
        if (!question)
            return;
        const turn = {role: 'user', content: question,
            currentResult: this._label.clutter_text.get_text(), revision: this._revisionIndex + 1};
        this._statusScroll.visible = false;
        this._setRefining(true);
        this._addDiscussionMessage('user', question);
        this._showDiscussionLoading();
        this._discussionScroll.visible = true;
        this._resizePreview();
        try {
            const answer = await refinement.discuss([...this._discussion, turn]);
            if (this._refinement !== refinement || this._finished)
                return;
            if (typeof answer !== 'string' || !answer.trim())
                throw new Error('No reply was returned. Try again.');
            this._clearDiscussionLoading();
            this._discussion.push(turn, {role: 'assistant', content: answer});
            this._addDiscussionMessage('assistant', answer);
            this._refineEntry.set_text('');
            this._followUpDrafts.discuss = '';
        } catch (error) {
            if (this._refinement === refinement && !this._finished) {
                this._clearDiscussionLoading();
                this._discussionMessages.get_children().at(-1)?.destroy();
                this._discussionScroll.visible = this._discussion.length > 0;
                this._refineStatus.text = error.message ?? String(error);
                this._statusScroll.visible = true;
            }
        } finally {
            if (this._refinement === refinement && !this._finished) {
                this._setRefining(false);
                this._resizePreview();
                this._refineEntry.grab_key_focus();
            }
        }
    }

    _switchResult(direction) {
        const index = this._revisionIndex + direction;
        if (this._refining || index < 0 || index >= this._revisions.length)
            return;
        this._revisions[this._revisionIndex] = this._label.clutter_text.get_text();
        this._revisionIndex = index;
        this._label.clutter_text.set_text(this._revisions[index]);
        this._statusScroll.visible = false;
        this._updateResultNavigation();
        this._toggleChanges();
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        const state = event.get_state();
        const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const focus = global.stage.get_key_focus();
        if (this._discussionScroll?.contains(focus) && key !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        if (this._refineEntry?.contains(focus) && key !== Clutter.KEY_Escape) {
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                this._refine();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }


        if (this._label.contains(focus) && this._resultClipboard(event) === Clutter.EVENT_STOP)
            return Clutter.EVENT_STOP;
        if (this._diffLabel.contains(focus) && this._diffClipboard(event) === Clutter.EVENT_STOP)
            return Clutter.EVENT_STOP;
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
        button.accessible_name = this._expanded ? 'Restore compact preview' : 'Enlarge preview';
        this._resizePreview();
    }

    _adjustSplit(resultHeight) {
        if (!this._splitHeight)
            return;
        const minimumResult = Math.min(100, this._splitHeight * 0.4);
        const minimumDiscussion = Math.min(160, this._splitHeight * 0.5);
        this._splitRatio = Math.max(minimumResult, Math.min(this._splitHeight - minimumDiscussion, resultHeight))
            / this._splitHeight;
        this._resizePreview();
    }

    _handleDividerKey(key) {
        if (key === Clutter.KEY_Escape && this._dividerGrab) {
            this._endDividerDrag();
        } else if (key === Clutter.KEY_Home) {
            this._splitRatio = null;
            this._resizePreview();
        } else if (key === Clutter.KEY_Up || key === Clutter.KEY_Down) {
            this._adjustSplit(this._scroll.height / St.ThemeContext.get_for_stage(global.stage).scale_factor
                + (key === Clutter.KEY_Up ? -32 : 32));
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _beginDividerDrag(event) {
        if (event.get_button() !== 1 || !this._discussionScroll.visible)
            return Clutter.EVENT_PROPAGATE;
        this._endDividerDrag();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const startY = event.get_coords()[1];
        const startHeight = this._scroll.height / scale;
        this._dividerGrab = global.stage.grab(this._divider);
        this._divider.add_style_pseudo_class('active');
        this._divider.grab_key_focus();
        this._dividerDragId = global.stage.connect('captured-event', (_stage, captured) => {
            const type = captured.type();
            if (type === Clutter.EventType.MOTION) {
                this._adjustSplit(startHeight + (captured.get_coords()[1] - startY) / scale);
                return Clutter.EVENT_STOP;
            }
            if ((type === Clutter.EventType.BUTTON_RELEASE && captured.get_button() === 1) ||
                (type === Clutter.EventType.KEY_PRESS && captured.get_key_symbol() === Clutter.KEY_Escape)) {
                this._endDividerDrag();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    }

    _endDividerDrag() {
        const grab = this._dividerGrab;
        this._dividerGrab = null;
        grab?.dismiss();
        if (this._dividerDragId) {
            global.stage.disconnect(this._dividerDragId);
            this._dividerDragId = null;
        }
        this._divider?.remove_style_pseudo_class('active');
    }

    _toggleChanges() {
        if (!this._changesButton) {
            this._resizePreview();
            return;
        }
        const hasChanges = this._original !== this._label.clutter_text.get_text();
        if (!hasChanges)
            this._changesButton.checked = false;
        this._changesButton.reactive = hasChanges;
        this._changesButton.can_focus = hasChanges;
        this._showChanges = hasChanges && this._changesButton.checked;
        this._changesButton.label = !hasChanges ? 'No changes'
            : this._showChanges ? 'Show result' : 'Show changes';
        this._changesButton.accessible_name = !hasChanges ? 'No changes from the original text'
            : this._showChanges ? 'Show editable result' : 'Show changes from the original text';
        if (this._showChanges)
            this._diffLabel.clutter_text.set_markup(diffMarkup(this._original, this._label.clutter_text.get_text()));
        this._label.visible = !this._showChanges;
        this._diffLabel.visible = this._showChanges;
        this._resizePreview();
    }

    _resizePreview() {
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const availableWidth = Math.max(1, (monitor.width - 96) / scale);
        const monitorHeight = monitor.height / scale;
        const availableHeight = Math.max(1, Math.min(monitorHeight * 0.8, monitorHeight - 64)
            - (this._refineRow?.visible ? 220 : 160) - (this._statusScroll?.visible ? 80 : 0));
        const discussing = Boolean(this._discussionScroll?.visible);
        const text = this._label.clutter_text.get_text();
        const longestLine = text.split('\n').reduce((longest, line) => Math.max(longest, line.length), 0);
        const width = Math.min(availableWidth, this._expanded
            ? 1000 : Math.max(600, Math.min(680, longestLine * 8 + 24)));
        const label = this._showChanges ? this._diffLabel : this._label;
        const [, naturalHeight] = label.get_preferred_height(Math.max(1, (width - 40) * scale));
        const naturalPreviewHeight = Math.ceil(naturalHeight / scale) + 24;
        let height = Math.min(availableHeight, Math.max(260, naturalPreviewHeight));
        let discussionHeight = 0;
        if (discussing) {
            const paneHeight = this._expanded ? availableHeight : Math.min(availableHeight,
                Math.max(100, Math.min(160, naturalPreviewHeight)) + Math.min(300, monitorHeight * 0.32) + 28);
            this._splitHeight = Math.max(2, paneHeight - 28);
            const minimumResult = Math.min(100, this._splitHeight * 0.4);
            const minimumDiscussion = Math.min(160, this._splitHeight * 0.5);
            const preferredResult = this._splitRatio === null
                ? Math.min(naturalPreviewHeight, this._expanded ? this._splitHeight / 3 : 160)
                : this._splitHeight * this._splitRatio;
            height = Math.max(minimumResult, Math.min(this._splitHeight - minimumDiscussion, preferredResult));
            discussionHeight = this._splitHeight - height;
        } else {
            this._splitHeight = 0;
            this._endDividerDrag();
        }
        if (this._divider)
            this._divider.visible = discussing;
        this.contentLayout.set_style(`padding: 0; margin: 0; spacing: 8px; min-height: 0; max-width: ${width}px;`);
        this._scroll.width = width * scale;
        this._scroll.height = height * scale;
        this._scroll.set_style(`max-height: ${height}px;`);
        if (this._discussionScroll) {
            this._discussionScroll.width = width * scale;
            this._discussionScroll.height = discussionHeight * scale;
            this._discussionBubbleWidth = Math.floor((width - 32) * 0.82);
            for (const row of this._discussionMessages.get_children())
                row._bubble.set_style(`max-width: ${this._discussionBubbleWidth}px;`);
        }
    }

    destroy() {
        this._endDividerDrag();
        for (const id of this._dividerPanIds ?? [])
            this._dividerPan.disconnect(id);
        if (this._dividerKeyControllerId)
            this._dividerKeys.disconnect(this._dividerKeyControllerId);
        if (this._dividerPressId)
            this._divider.disconnect(this._dividerPressId);
        if (this._dividerKeyId)
            this._divider.disconnect(this._dividerKeyId);
        this._divider?.destroy();
        this._divider = null;
        this._dividerPan = null;
        this._dividerKeys = null;
        this._clearDiscussionLoading();
        this._refinement?.destroy();
        this._refinement = null;
        this._revisions = [];
        this._discussion = [];
        this._followUpDrafts = null;
        if (this._discussToggleId)
            this._discussToggle.disconnect(this._discussToggleId);
        if (this._discussionAllocationId)
            this._discussionMessages.disconnect(this._discussionAllocationId);
        this._discussToggle?.destroy();
        this._discussionScroll?.destroy();
        this._discussToggle = null;
        this._discussionScroll = null;
        this._discussionMessages = null;
        if (this._refineActivateId)
            this._refineEntry.clutter_text.disconnect(this._refineActivateId);
        if (this._refineClickId)
            this._refineButton.disconnect(this._refineClickId);
        if (this._previousId)
            this._previousButton.disconnect(this._previousId);
        if (this._nextId)
            this._nextButton.disconnect(this._nextId);
        if (this._refineToggleId)
            this._refineToggle.disconnect(this._refineToggleId);
        this._refineEntry?.destroy();
        this._refineButton?.destroy();
        this._previousButton?.destroy();
        this._nextButton?.destroy();
        this._resultCount?.destroy();
        this._refineToggle?.destroy();
        this._refineRow?.destroy();
        this._statusScroll?.destroy();
        this._refineEntry = null;
        this._refineButton = null;
        this._previousButton = null;
        this._nextButton = null;
        this._resultCount = null;
        this._refineToggle = null;
        this._refineRow = null;
        this._refineToggleLabel = null;
        this._replaceButton = null;
        this._actionButtons = [];
        this._statusScroll = null;
        this._refineStatus = null;

        if (this._changesChangedId) {
            this._changesButton.disconnect(this._changesChangedId);
            this._changesChangedId = null;
        }
        if (this._resultChangedId) {
            this._label.clutter_text.disconnect(this._resultChangedId);
            this._resultChangedId = null;
        }
        this._changesButton?.destroy();
        this._diffLabel?.destroy();
        this._diffLabel = null;
        this._original = null;
        this._changesButton = null;
        this._expandIcon?.destroy();
        this._expandIcon = null;
        this._label?.destroy();
        this._label = null;
        this._scroll?.destroy();
        this._scroll = null;
        this._onReplace = null;
        this._onCopySelection = null;
        this._resultClipboard = null;
        this._diffClipboard = null;
        this._onClose = null;
        super.destroy();
    }

    _finish(action = null, value = undefined) {
        if (this._finished || (this._refining && action))
            return;
        this._finished = true;
        const onClose = this._onClose;
        this._onClose = null;
        this.close();
        onClose?.();
        action?.(value);
    }
});

export const AskDialog = GObject.registerClass(
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
        installTextClipboard(this, this._entry, {editable: true, onSubmit: () => this._submit()});
        this._inputError = new St.Label({text: 'Enter an instruction to continue.', visible: false,
            style_class: 'plyph-input-error'});
        this.contentLayout.add_child(this._inputError);
        this._entryChangedId = this._entry.clutter_text.connect('text-changed', () => {
            if (this._entry.get_text().trim()) {
                this._inputError.visible = false;
                this._entry.remove_style_class_name('error');
            }
        });

        this.setButtons([
            {
                label: 'Cancel',
                key: Clutter.KEY_Escape,
                action: () => this._finish(onCancel),
            },
            {
                label: 'Ask',
                default: true,
                action: () => this._submit(),
            },
        ]);

        this._entryActivateId = this._entry.clutter_text.connect('activate', () => {
            this._submit();
        });

        this.setInitialKeyFocus(this._entry.clutter_text);
    }

    destroy() {
        if (this._entryChangedId) {
            this._entry.clutter_text.disconnect(this._entryChangedId);
            this._entryChangedId = null;
        }
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

    _submit() {
        if (this._finished)
            return;
        const instruction = this._entry.get_text().trim();
        if (!instruction) {
            this._inputError.visible = true;
            this._entry.add_style_class_name('error');
            this._entry.grab_key_focus();
            return;
        }
        this._finish(this._onAsk, instruction);
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
