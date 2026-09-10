// Run with: node --test --test-isolation=none tests/floating-button.test.cjs
// Exercise the extension's actual lifecycle methods with deterministic Shell
// signals and time, including app input that never emits captured-event.
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const {name: signal, callback} of [...this.handlers.values()]) {
            if (signal === name) callback(this, ...args);
        }
    }
}

function setup() {
    let now = 0;
    let nextTimer = 1;
    const timers = new Map();
    const selection = new Signals();
    const display = new Signals();
    const stage = new Signals();
    const overview = new Signals();
    const settings = new Signals();
    const window = new Signals();
    window.userTime = 1;
    window.get_user_time = () => window.userTime;
    display.focus_window = window;
    display.get_selection = () => selection;
    stage.get_key_focus = () => null;
    settings.enabled = true;
    settings.get_boolean = () => settings.enabled;
    settings.get_string = () => '';
    const pointer = [300, 300, 0];
    const Clutter = {
        EVENT_PROPAGATE: false,
        KEY_Escape: 27,
        ModifierType: {BUTTON1_MASK: 256, SHIFT_MASK: 1},
        EventType: {BUTTON_PRESS: 1, KEY_PRESS: 2, SCROLL: 3, TOUCH_BEGIN: 4},
        AnimationMode: {EASE_OUT_QUAD: 1},
    };
    const GLib = {
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        get_monotonic_time: () => now * 1000,
        timeout_add(_priority, interval, callback) {
            const id = nextTimer++;
            timers.set(id, {interval, at: now + interval, callback});
            return id;
        },
        Source: {remove: id => timers.delete(id)},
    };
    class Actor extends Signals {
        visible = false;
        expanded = false;
        showingFeedback = false;
        x = 0; y = 0;
        hide() { this.visible = false; this.emit('notify::hover'); }
        show() { this.visible = true; }
        collapse() {
            this.expanded = false;
            extension._handleFloatingExpandedChanged(false);
        }
        destroy() { this.hide(); this.handlers.clear(); }
        contains(actor) { return actor === this; }
        remove_transition() {}
        ease({opacity}) { this.opacity = opacity; }
        get_preferred_width() { return [40, 40]; }
        get_preferred_height() { return [40, 40]; }
        get_transformed_position() { return [this.x, this.y]; }
        get_transformed_size() { return [40, 40]; }
        set_position(x, y) { this.x = x; this.y = y; }
    }
    // Keep real extension methods, replacing only the GNOME actor implementation.
    const context = vm.createContext({
        console, Clutter, GLib,
        Config: {PACKAGE_VERSION: '50'},
        GObject: {registerClass: cls => cls.name === 'FloatingToolbar' ? Actor : cls},
        St: {BoxLayout: Actor, ClipboardType: {PRIMARY: 1}},
        Meta: {SelectionType: {SELECTION_PRIMARY: 1}},
        ModalDialog: {ModalDialog: class {}},
        Extension: class {},
        Main: {overview, layoutManager: {
            uiGroup: {add_child() {}}, currentMonitor: {x: 0, y: 0, width: 1920, height: 1080},
        }},
        global: {display, stage, get_pointer: () => pointer},
    });
    const source = readFileSync(new URL('../extension.js', `file://${__filename}`), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('export default class PlyphExtension', 'globalThis.PlyphExtension = class PlyphExtension');
    vm.runInContext(source, context);
    const extension = new context.PlyphExtension();
    extension._settings = settings;
    extension._clipboard = {};
    extension._delay = async () => true;
    extension._getClipboardText = async () => 'Selected text';
    extension._setupFloatingButton();
    function activity() {
        window.userTime++;
        window.emit('notify::user-time');
    }
    function advance(ms) {
        const until = now + ms;
        while (true) {
            const entry = [...timers].filter(([, t]) => t.at <= until)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!entry) break;
            const [id, timer] = entry;
            now = timer.at;
            if (timer.callback() && timers.has(id)) timer.at = now + timer.interval;
            else timers.delete(id);
        }
        now = until;
    }
    return {extension, window, display, stage, overview, settings, selection,
        pointer, Clutter, timers, activity, advance};
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return {promise, resolve};
}

for (const signal of ['notify::user-time', 'unmanaged', 'position-changed', 'size-changed']) {
    test(`dismisses immediately on source-window ${signal}, without a stage event`, async () => {
        const {extension: e, window, timers} = setup();
        await e._handleSelectionChange();
        assert.equal(e._floatingButton.visible, true);
        window.emit(signal);
        assert.equal(e._floatingButton.visible, false);
        assert.equal(window.handlers.size, 0);
        assert.equal(timers.size, 0);
    });
}

test('click before debounce completes cancels the pending popup', async () => {
    const {extension: e, activity} = setup();
    const delay = deferred();
    e._delay = () => delay.promise;
    const pending = e._handleSelectionChange();
    activity();
    delay.resolve(true);
    await pending;
    assert.equal(e._floatingButton.visible, false);
});

test('late clipboard result cannot reopen after input in the same app', async () => {
    const {extension: e, activity} = setup();
    const clipboard = deferred();
    e._getClipboardText = () => clipboard.promise;
    const pending = e._handleSelectionChange();
    await new Promise(setImmediate);
    activity();
    clipboard.resolve('Selected text');
    await pending;
    assert.equal(e._floatingButton.visible, false);
});

test('only the latest selection read may show its result', async () => {
    const {extension: e} = setup();
    const first = deferred();
    let reads = 0;
    e._getClipboardText = () => ++reads === 1 ? first.promise : Promise.resolve('New selection');
    const older = e._handleSelectionChange();
    await new Promise(setImmediate);
    await e._handleSelectionChange();
    first.resolve('Old selection');
    await older;
    assert.equal(e._lastSelectionText, 'New selection');
});

test('waits for the selecting mouse button to be released', async () => {
    const {extension: e, pointer, Clutter} = setup();
    pointer[2] = Clutter.ModifierType.BUTTON1_MASK;
    const release = deferred();
    e._delay = ms => ms === 120 ? Promise.resolve(true) : release.promise;
    const pending = e._handleSelectionChange();
    await new Promise(setImmediate);
    assert.equal(e._floatingButton.visible, false);
    pointer[2] = 0;
    release.resolve(true);
    await pending;
    assert.equal(e._floatingButton.visible, true);
});

test('empty PRIMARY clears an already visible button', async () => {
    const {extension: e} = setup();
    await e._handleSelectionChange();
    e._getClipboardText = async () => '';
    await e._handleSelectionChange();
    assert.equal(e._floatingButton.visible, false);
});

test('missing hover-leave does not renew an expired timeout', async () => {
    const {extension: e, pointer, advance} = setup();
    await e._handleSelectionChange();
    pointer[0] = e._floatingButton.x + 10;
    pointer[1] = e._floatingButton.y + 10;
    advance(5000);
    assert.equal(e._floatingButton.visible, true);
    pointer[0] = 900;
    // Deliberately do not emit notify::hover.
    advance(100);
    assert.equal(e._floatingButton.visible, false);
});

test('repeated dismissal and hover callbacks leave no hide timers', async () => {
    const {extension: e, timers} = setup();
    await e._handleSelectionChange();
    for (let i = 0; i < 10; i++) {
        e._hideFloatingButton(true);
        e._handleFloatingHoverChanged();
    }
    assert.equal(e._floatingButton.visible, false);
    assert.equal(timers.size, 0);
});

test('toolbar clicks propagate and preserve the button; outside clicks hide it', async () => {
    const {extension: e, Clutter} = setup();
    await e._handleSelectionChange();
    const event = {type: () => Clutter.EventType.BUTTON_PRESS,
        get_source: () => e._floatingButton, get_coords: () => [900, 900]};
    assert.equal(e._handleFloatingCapturedEvent(event), Clutter.EVENT_PROPAGATE);
    assert.equal(e._floatingButton.visible, true);
    event.get_source = () => null;
    e._handleFloatingCapturedEvent(event);
    assert.equal(e._floatingButton.visible, false);
});

test('keyboard navigation in the toolbar works and Escape dismisses', async () => {
    const {extension: e, Clutter, stage} = setup();
    await e._handleSelectionChange();
    stage.get_key_focus = () => e._floatingButton;
    const event = {type: () => Clutter.EventType.KEY_PRESS, get_key_symbol: () => 9};
    e._handleFloatingCapturedEvent(event);
    assert.equal(e._floatingButton.visible, true);
    event.get_key_symbol = () => Clutter.KEY_Escape;
    e._handleFloatingCapturedEvent(event);
    assert.equal(e._floatingButton.visible, false);
});

for (const target of ['focus', 'overview', 'setting']) {
    test(`${target} change dismisses the popup`, async () => {
        const {extension: e, display, overview, settings} = setup();
        await e._handleSelectionChange();
        if (target === 'focus') {
            display.focus_window = null;
            display.emit('notify::focus-window');
        } else if (target === 'overview') overview.emit('showing');
        else {
            settings.enabled = false;
            settings.emit('changed::show-floating-button');
        }
        assert.equal(e._floatingButton.visible, false);
    });
}

test('disable removes signals/timers and cancels pending clipboard reads', async () => {
    const {extension: e, display, stage, window, overview, settings, selection, timers} = setup();
    await e._handleSelectionChange();
    const clipboard = deferred();
    e._getClipboardText = () => clipboard.promise;
    const pending = e._handleSelectionChange();
    await new Promise(setImmediate);
    e._destroyFloatingButton();
    clipboard.resolve('Late text');
    await pending;
    assert.equal(e._floatingButton, null);
    for (const obj of [display, stage, window, overview, settings, selection])
        assert.equal(obj.handlers.size, 0);
    assert.equal(timers.size, 0);
});


test('stale PRIMARY notifications do not keep renewing dismissal suppression', async () => {
    const {extension: e, activity, advance} = setup();
    await e._handleSelectionChange();
    activity();
    await e._handleSelectionChange();
    assert.equal(e._floatingButton.visible, false);
    advance(1300);
    activity();
    await e._handleSelectionChange();
    assert.equal(e._floatingButton.visible, true);
});
