const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createShell, root} = require('./helpers/shell.cjs');

const versions = [46, 47, 48, 49, 50, 51];
test('metadata declares exactly the tested GNOME versions', () => {
    const metadata = JSON.parse(readFileSync(resolve(root, 'metadata.json'), 'utf8'));
    assert.deepEqual(metadata['shell-version'], versions.map(String));
});

for (const version of versions) {
    const check = (name, run) => test(`GNOME ${version}: ${name}`, run);

    check('enable, disable and re-enable clean up shortcuts, signals, timers and actors', async () => {
        const shell = createShell(version);
        const e = shell.extension;
        for (let cycle = 0; cycle < 2; cycle++) {
            e.enable();
            assert.equal(e._keyboard, shell.keyboard);
            assert.deepEqual([...shell.bindings.keys()].sort(),
                ['actions-shortcut', 'ask-shortcut', 'correct-shortcut', 'rewrite-shortcut']);
            const calls = [];
            e._run = mode => calls.push(mode);
            shell.bindings.get('correct-shortcut')();
            assert.deepEqual(calls, ['correct']);
            e._showFeedback('Working', 'working', 1000);
            e._setIcon('emblem-ok-symbolic', 1000);
            const pendingDelay = e._delay(1000);
            assert.equal(e.disable(), undefined, 'disable must stay synchronous');
            assert.equal(await pendingDelay, false);
            assert.equal(e._settings, null);
            assert.equal(e._keyboard, null);
            shell.assertClean();
        }
    });

    check('copy, paste and undo produce balanced virtual key events', () => {
        const shell = createShell(version);
        const e = shell.extension;
        e.enable();
        for (const [method, key] of [['_copy', 'c'], ['_paste', 'v'], ['_sendUndo', 'z']]) {
            shell.keyEvents.length = 0;
            e[method]();
            assert.deepEqual(shell.keyEvents.map(({key, state}) => [key, state]),
                [['Control_L', 1], [key, 1], [key, 0], ['Control_L', 0]]);
        }
        e.disable();
        shell.assertClean();
    });

    check('toolbar builds quick actions and all feedback states with supported widget properties', () => {
        const shell = createShell(version);
        const e = shell.extension;
        e.enable();
        const toolbar = e._floatingButton;
        toolbar.toggleExpanded();
        assert.equal(toolbar.expanded, true);
        assert.equal(toolbar._actionsBox.children.length, 4);
        const actions = [];
        e._run = mode => actions.push(mode);
        toolbar._actionsBox.children[0].emit('clicked');
        assert.deepEqual(actions, ['ask']);
        assert.equal(toolbar.expanded, false);
        for (const state of ['working', 'success', 'error']) {
            toolbar.showFeedback(state, state);
            assert.equal(toolbar.showingFeedback, true);
            assert.equal(toolbar._logoButton.reactive, state !== 'working');
            assert.equal(toolbar._actionsBox.children[0].children[0].get_text(), state);
        }
        shell.values['floating-toolbar-scale'] = 1.5;
        shell.settings.emit('changed::floating-toolbar-scale');
        assert.ok(toolbar.classes.has('plyph-toolbar-scale-150'));
        shell.values['floating-toolbar-scale'] = 1.1;
        shell.settings.emit('changed::floating-toolbar-scale');
        assert.equal(toolbar.classes.size, 0);
        e.disable();
        shell.assertClean();
    });

    for (const position of ['disabled', 'near-pointer', 'monitor-center']) {
        check(`action palette opens, invokes custom actions and cleans up (${position})`, () => {
            const shell = createShell(version);
            const e = shell.extension;
            shell.values['action-palette-position'] = position;
            shell.values['custom-actions'] = JSON.stringify([
                {id: 'custom', name: 'Translate', prompt: 'Translate this', provider: 'ollama', model: 'test-model'},
                {id: 'hidden', name: 'Hidden', prompt: 'Hidden', enabled: false},
            ]);
            e.enable();
            const calls = [];
            e._run = (...args) => calls.push(args);
            e._openActions();
            if (position === 'disabled') {
                assert.equal(e._indicator.menu.isOpen, true);
                assert.equal(e._actionsSection.items.length, 1);
                e._actionsSection.items[0].emit('activate');
            } else if (position === 'near-pointer') {
                const palette = e._actionPalette;
                assert.equal(palette.isOpen, true);
                assert.equal(palette.items.length, 6);
                palette.items.at(-1).emit('activate');
                palette.close();
                assert.equal(e._actionPalette, null);
            } else {
                const palette = e._actionPalette;
                assert.equal(palette.isOpen, true);
                assert.equal(palette._buttons.length, 5);
                palette._select(4);
                palette.vfunc_key_press_event({get_key_symbol: () => shell.Clutter.KEY_Return});
                assert.equal(e._actionPalette, null);
            }
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0].slice(0, 3), ['custom', 'Translate this', 'Translate']);
            assert.equal(calls[0][3].provider, 'ollama');
            assert.equal(calls[0][3].model, 'test-model');
            e.disable();
            shell.assertClean();
        });
    }

    check('preview builds, wraps, expands, copies selection and replaces edited text once', () => {
        const shell = createShell(version);
        const calls = [];
        const dialog = new shell.ResultDialog('Original', text => calls.push(['replace', text]),
            text => calls.push(['copy', text]), text => calls.push(['selection', text]),
            () => calls.push(['cancel']), () => calls.push(['close']));
        dialog.open();
        const surface = dialog._scroll.children[0];
        assert.equal(version >= 48 ? surface.orientation : surface.vertical, version >= 48 ? 1 : true);
        const wrap = dialog.contentLayout.children[0].children[1];
        wrap.checked = false;
        wrap.emit('notify::checked');
        assert.equal(dialog._label.clutter_text.line_wrap, false);
        const initialWidth = dialog._scroll.width;
        const expand = dialog.contentLayout.children[0].children[2];
        expand.emit('clicked');
        assert.ok(dialog._scroll.width > initialWidth);
        expand.emit('clicked');
        assert.equal(dialog._scroll.width, initialWidth);
        dialog._label.clutter_text.text = 'Edited';
        const event = key => ({get_key_symbol: () => key, get_state: () => shell.Clutter.ModifierType.CONTROL_MASK});
        dialog.vfunc_key_press_event(event('a'));
        dialog.vfunc_key_press_event(event('c'));
        dialog.vfunc_key_press_event(event('Return'));
        dialog._finish(() => calls.push(['duplicate']));
        assert.deepEqual(calls, [['selection', 'Edited'], ['close'], ['replace', 'Edited']]);
        assert.equal(dialog.destroyed, true);
        shell.assertClean();
    });

    check('Ask submits once and cancels without submitting', () => {
        const shell = createShell(version);
        for (const cancel of [false, true]) {
            const calls = [];
            const dialog = new shell.AskDialog(text => calls.push(['ask', text]),
                () => calls.push(['cancel']), () => calls.push(['close']));
            dialog._entry.clutter_text.text = 'Explain this';
            if (cancel) dialog.buttons[0].action();
            else dialog._entry.clutter_text.emit('activate');
            dialog._finish(() => calls.push(['duplicate']));
            assert.deepEqual(calls, cancel ? [['close'], ['cancel']] : [['close'], ['ask', 'Explain this']]);
            assert.equal(dialog.destroyed, true);
        }
        shell.assertClean();
    });
}
