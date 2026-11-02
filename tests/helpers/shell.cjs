const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');
const {loadShellModules} = require('./modules.cjs');

const root = resolve(__dirname, '../..');
const source = readFileSync(resolve(root, 'extension.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class PlyphExtension', 'globalThis.PlyphExtension = class PlyphExtension');

function createShell(version) {
    const signals = [];
    const actors = [];
    const timers = new Map();
    const bindings = new Map();
    const keyEvents = [];
    const clipboard = new Map();
    const clipboardReads = [];
    const clients = [];
    let nextTimer = 1;
    class Signals {
        handlers = new Map();
        nextId = 1;
        constructor() { signals.push(this); }
        connect(name, callback) {
            const id = this.nextId++;
            this.handlers.set(id, {name, callback});
            return id;
        }
        disconnect(id) { assert.ok(this.handlers.delete(id), `Unknown signal ${id}`); }
        emit(name, ...args) {
            for (const {name: signal, callback} of [...this.handlers.values()])
                if (name === signal) callback(this, ...args);
        }
    }
    class Text extends Signals {
        actions = [];
        constructor(text = '') { super(); this.text = text; }
        set_markup(value) {
            this.markup = value;
            this.text = value.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        }
        set_selectable(value) { this.selectable = value; }
        set_selection_color(value) { this.selection_color = value; }
        get_selection_color() { return this.selection_color ?? 'theme selection'; }
        set_selected_text_color(value) { this.selected_text_color = value; }
        get_selected_text_color() { return this.selected_text_color ?? 'theme selected text'; }
        set_editable(value) { this.editable = value; }
        set_cursor_visible(value) { this.cursor_visible = value; }
        set_cursor_size(value) { this.cursor_size = value; }
        set_reactive(value) { this.reactive = value; }
        set_single_line_mode(value) { this.single_line_mode = value; }
        set_activatable(value) { this.activatable = value; }
        set_line_wrap(value) { this.line_wrap = value; }
        set_line_wrap_mode(value) { this.line_wrap_mode = value; }
        set_selection(start, end) { this.selection = [start, end]; this.cursor = end; }
        get_selection() {
            if (!this.selection) return '';
            const chars = Array.from(this.text);
            const [a, b] = this.selection.map(value => value < 0 ? chars.length : value);
            return chars.slice(Math.min(a, b), Math.max(a, b)).join('');
        }
        get_cursor_position() { return this.cursor ?? -1; }
        delete_selection() {
            if (!this.selection) return;
            const chars = Array.from(this.text);
            const [a, b] = this.selection.map(value => value < 0 ? chars.length : value);
            const start = Math.min(a, b);
            chars.splice(start, Math.abs(b - a));
            this.set_text(chars.join(''));
            this.cursor = start;
        }
        insert_text(value, position) {
            const chars = Array.from(this.text);
            chars.splice(position, 0, ...Array.from(value));
            this.set_text(chars.join(''));
            this.cursor = position + Array.from(value).length;
        }
        add_action_full(_name, _phase, action) { this.actions.push(action); }
        grab_key_focus() { stage.focus = this; }
        get_text() { return this.text; }
        set_text(value) { this.text = value; this.selection = undefined; this.cursor = -1; this.emit('text-changed'); }
    }
    class KeyController extends Signals {
        set_trigger_keybindings() {}
        get_key() { return [0, this.symbol]; }
        get_state() { return [true, this.state ?? 0, 0, 0]; }
    }
    class PanGesture extends Signals {
        set_begin_threshold() {}
        set_required_button() {}
        get_begin_centroid_abs() { return {x: 0, y: this.startY ?? 0}; }
        get_centroid_abs() { return {x: 0, y: this.y ?? 0}; }
    }
    class Actor extends Signals {
        children = [];
        classes = new Set();
        pseudoClasses = new Set();
        actions = [];
        constructor(...args) { super(); actors.push(this); this._init(...args); }
        _init(props = {}) {
            assert.ok(version < 51 || !('vertical' in props), 'GNOME 51 removed vertical');
            assert.ok(version >= 48 || !('orientation' in props), 'Old St widgets use vertical');
            Object.assign(this, {visible: true, x: 0, y: 0, width: 40, height: 40}, props);
            this.clutter_text = new Text(props.text);
            if (props.child) this.add_child(props.child);
        }
        add_child(child) { this.children.push(child); child.parent = this; }
        insert_child_at_index(child, index) { this.children.splice(index, 0, child); child.parent = this; }
        set_child(child) { this.destroy_all_children(); this.add_child(child); }
        set_style(value) { this.style = value; }
        ensure_style() {}
        set_size(width, height) { Object.assign(this, {width, height}); }
        set_position(x, y) { Object.assign(this, {x, y}); }
        get_parent() { return this.parent; }
        get_children() { return [...this.children]; }
        get_preferred_width() { return [this.width, this.width]; }
        get_preferred_height() { return [this.height, this.height]; }
        get_transformed_position() { return [this.x, this.y]; }
        get_transformed_size() { return [this.width, this.height]; }
        get_text() { return this.clutter_text.get_text(); }
        set_text(value) { this.clutter_text.set_text(value); }
        contains(actor) { return this === actor || this.clutter_text === actor || this.children.some(child => child.contains(actor)); }
        add_action(action) { this.actions.push(action); }
        add_action_full(_name, _phase, action) { this.actions.push(action); }
        show() { this.visible = true; }
        hide() { this.visible = false; }
        add_style_class_name(name) { this.classes.add(name); }
        remove_style_class_name(name) { this.classes.delete(name); }
        add_style_pseudo_class(name) { this.pseudoClasses.add(name); }
        remove_style_pseudo_class(name) { this.pseudoClasses.delete(name); }
        grab_key_focus() { stage.focus = this; }
        remove_transition() {}
        ease({onComplete, ...props}) { Object.assign(this, props); onComplete?.(); }
        destroy_all_children() { for (const child of [...this.children]) child.destroy(); }
        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.destroy_all_children();
            this.emit('destroy');
            for (const action of [...this.actions, ...this.clutter_text.actions]) action.handlers.clear();
            this.handlers.clear();
            this.clutter_text?.handlers.clear();
            if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        }
    }
    class Menu extends Signals {
        items = [];
        constructor() { super(); this.actor = new Actor(); }
        addMenuItem(item) { this.items.push(item); }
        removeAll() { for (const item of this.items) item.destroy(); this.items = []; }
        open(params) {
            if (params !== undefined)
                assert.equal(typeof params, version >= 51 ? 'object' : 'number');
            this.isOpen = true;
            this.emit('open-state-changed', true);
        }
        close() { this.isOpen = false; this.emit('open-state-changed', false); }
        destroy() { this.removeAll(); this.actor.destroy(); this.emit('destroy'); this.handlers.clear(); }
    }
    class MenuItem extends Actor {
        _init(label) { super._init({label}); }
        setSensitive(value) { this.sensitive = value; }
    }
    class PanelButton extends Actor {
        _init() { super._init(); this.menu = new Menu(); }
        destroy() { this.menu.destroy(); super.destroy(); }
    }
    class Dialog extends Actor {
        _init(props) {
            super._init(props);
            this.contentLayout = new Actor();
            this.add_child(this.contentLayout);
            this.buttonLayout = new Actor({layout_manager: {homogeneous: true}});
            this.add_child(this.buttonLayout);
        }
        setButtons(buttons) {
            this.buttons = buttons;
            this.buttonLayout.destroy_all_children();
            for (const info of buttons)
                this.buttonLayout.add_child(new Actor({label: info.label, x_expand: true, y_expand: true}));
        }
        setInitialKeyFocus(actor) { this.initialFocus = actor; }
        open() { this.isOpen = true; }
        close() { this.isOpen = false; if (this.destroyOnClose) this.destroy(); }
        vfunc_key_press_event() { return false; }
    }
    const stage = new Signals();
    const grabs = new Set();
    stage.grab = () => {
        const grab = {dismiss() { grabs.delete(grab); }};
        grabs.add(grab);
        return grab;
    };
    stage.get_key_focus = () => stage.focus;
    const selection = new Signals();
    const display = new Signals();
    display.get_selection = () => selection;
    const overview = new Signals();
    const settings = new Signals();
    const values = {
        'custom-actions': '[]', 'quick-actions': '[]', 'floating-toolbar-scale': 1,
        'show-floating-button': true, 'pointer-feedback': true,
        'action-palette-position': 'disabled', 'feedback-position': 'bottom-center',
    };
    settings.get_string = key => values[key] ?? '';
    settings.get_boolean = key => values[key] ?? false;
    settings.get_double = key => values[key];
    settings.get_int64 = key => values[key] ?? 0;
    const keyboard = {notify_keyval: (time, key, state) => keyEvents.push({time, key, state})};
    const backend = {get_default_seat: () => ({create_virtual_device(type) {
        assert.equal(type, 'keyboard');
        return keyboard;
    }})};
    if (version >= 51) stage.context = {get_backend: () => backend};
    const Clutter = {
        InputDeviceType: {KEYBOARD_DEVICE: 'keyboard'},
        Orientation: {VERTICAL: 1, HORIZONTAL: 0},
        ActorAlign: {START: 0, CENTER: 1},
        AnimationMode: {EASE_OUT_QUAD: 1},
        ModifierType: {CONTROL_MASK: 4, SHIFT_MASK: 1, BUTTON1_MASK: 256},
        KeyState: {PRESSED: 1, RELEASED: 0},
        EVENT_STOP: true, EVENT_PROPAGATE: false,
        EventType: {MOTION: 'motion', BUTTON_RELEASE: 'release', KEY_PRESS: 'key-press'},
        ...(version >= 51 ? {EventPhase: {CAPTURE: 1}, KeyController, PanGesture} : {}),
        ...Object.fromEntries(['Escape', 'Return', 'KP_Enter', 'Up', 'Down', 'Home', 'Insert', 'Delete', 'Control_L', 'a', 'A', 'c', 'C', 'v', 'V', 'x', 'X', 'z']
            .map(key => [`KEY_${key}`, key])),
        ...(version < 51 ? {get_default_backend: () => backend} : {}),
    };
    const uiGroup = new Actor();
    const panel = new Actor();
    const Main = {
        overview, uiGroup,
        layoutManager: {uiGroup, currentMonitor: {x: 0, y: 0, width: 1920, height: 1080}, monitors: []},
        panel: {addToStatusArea: (_uuid, actor) => panel.add_child(actor)},
        wm: {
            addKeybinding(name, _settings, _flags, _mode, callback) {
                assert.ok(!bindings.has(name), `Duplicate shortcut ${name}`);
                bindings.set(name, callback);
            },
            removeKeybinding: name => assert.ok(bindings.delete(name)),
        },
    };
    const context = vm.createContext({
        console, Clutter, Main,
        Config: {PACKAGE_VERSION: `${version}.0`},
        GObject: {registerClass: cls => cls},
        GLib: {
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            get_monotonic_time: () => 1000000,
            timeout_add(_priority, delay, callback) { const id = nextTimer++; timers.set(id, {delay, callback}); return id; },
            Source: {remove: id => assert.ok(timers.delete(id), `Unknown timer ${id}`)},
        },
        Gio: {icon_new_for_string: path => path},
        St: {
            PolicyType: {NEVER: 2, AUTOMATIC: 1},
            ThemeContext: {get_for_stage: () => ({scale_factor: values['test-scale'] ?? 1})},
            BoxLayout: Actor, Bin: Actor, Widget: Actor, Button: Actor, Icon: Actor, Label: Actor, Entry: Actor, ScrollView: Actor,
            Side: {TOP: 0}, ClipboardType: {PRIMARY: 0, CLIPBOARD: 1},
            Clipboard: {get_default: () => ({
                set_text: (type, text) => clipboard.set(type, text),
                get_text: (type, callback) => {
                    const read = () => callback(null, clipboard.get(type) ?? '');
                    if (values['test-delay-clipboard']) clipboardReads.push(read);
                    else read();
                },
            })},
        },
        Meta: {KeyBindingFlags: {NONE: 0}, SelectionType: {SELECTION_PRIMARY: 0}},
        Shell: {ActionMode: {NORMAL: 1}},
        Pango: {WrapMode: {WORD_CHAR: 0}, EllipsizeMode: {NONE: 0}},
        ModalDialog: {ModalDialog: Dialog}, PanelMenu: {Button: PanelButton},
        PopupMenu: {
            PopupMenu: Menu, PopupMenuSection: Menu, PopupMenuItem: MenuItem,
            PopupSeparatorMenuItem: MenuItem, PopupMenuManager: class { addMenu() {} },
        },
        Extension: class {
            path = root;
            uuid = 'ai-autocorrect@ubai.dev';
            metadata = {name: 'Plyph'};
            getSettings() { return settings; }
        },
        AiClient: class {
            constructor() { clients.push(this); }
            destroy() { this.destroyed = true; }
        },
        global: {stage, display, get_pointer: () => [300, 300, 0]},
    });
    vm.runInContext(readFileSync(resolve(root, 'actions.js'), 'utf8').replace(/^export /gm, ''), context);
    vm.runInContext(readFileSync(resolve(root, 'diff.js'), 'utf8').replace(/^export /gm, ''), context);
    vm.runInContext(readFileSync(resolve(root, 'markdown.js'), 'utf8').replace(/^export /gm, ''), context);
    loadShellModules(context, root);
    vm.runInContext(source, context);
    return {
        extension: new context.PlyphExtension(),
        ResultDialog: vm.runInContext('ResultDialog', context),
        AskDialog: vm.runInContext('AskDialog', context),
        ErrorDialog: vm.runInContext('ErrorDialog', context),
        values, settings, actors, timers, bindings, keyEvents, clipboard, clients, keyboard, Clutter,
        stage, grabs, layoutManager: Main.layoutManager,
        clipboardReads,
        sendTextKey(actor, symbol, state = 0) {
            actor.clutter_text.grab_key_focus();
            let owner = actor;
            while (!owner._textClipboardHandlers) owner = owner.get_parent();
            const controller = owner._clipboardKeys;
            if (version >= 51) {
                controller.symbol = symbol;
                controller.state = state;
                controller.emit('key-press');
            } else owner.emit('captured-event', {type: () => Clutter.EventType.KEY_PRESS,
                get_key_symbol: () => symbol, get_state: () => state});
        },
        assertClean() {
            assert.equal(bindings.size, 0, 'Shortcuts leaked');
            assert.equal(timers.size, 0, 'Timers leaked');
            assert.equal(grabs.size, 0, 'Pointer grabs leaked');
            assert.equal(uiGroup.children.length, 0, 'Shell actors leaked');
            assert.equal(panel.children.length, 0, 'Panel indicator leaked');
            for (const signal of signals) assert.equal(signal.handlers.size, 0, 'Signal handlers leaked');
            for (const client of clients) assert.equal(client.destroyed, true, 'Client not destroyed');
        },
    };
}

module.exports = {createShell, root};
