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
        assert.match(dialog.contentLayout.get_parent().style, /padding: 16px/);
        assert.match(dialog.contentLayout.style, /padding: 0/);
        assert.equal(dialog.contentLayout.y_expand, false);
        assert.equal(dialog.buttonLayout.x_align, shell.Clutter.ActorAlign.END);
        assert.equal(dialog.buttonLayout.x_expand, false);
        assert.equal(dialog.buttonLayout.layout_manager.homogeneous, false);
        for (const button of dialog.buttonLayout.get_children()) {
            assert.equal(button.x_expand, false);
            assert.equal(button.y_expand, false);
            assert.match(button.style, /padding: 6px 14px/);
        }
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
        dialog._label.clutter_text.grab_key_focus();
        const event = key => ({get_key_symbol: () => key, get_state: () => shell.Clutter.ModifierType.CONTROL_MASK});
        dialog.vfunc_key_press_event(event('a'));
        dialog.vfunc_key_press_event(event('c'));
        dialog.vfunc_key_press_event(event('Return'));
        dialog._finish(() => calls.push(['duplicate']));
        assert.equal(shell.clipboard.get(1), 'Edited');
        assert.deepEqual(calls, [['close'], ['replace', 'Edited']]);
        assert.equal(dialog.destroyed, true);
        shell.assertClean();
    });

    check('preview starts roomy and grows with measured result and diff content up to screen space', () => {
        const shell = createShell(version);
        const dialog = new shell.ResultDialog('Short', () => {}, () => {}, () => {}, null, null, 'Original');
        assert.equal(dialog._scroll.height, 260);
        assert.ok(dialog._scroll.width >= 600);
        let measuredWidth;
        dialog._label.get_preferred_height = width => { measuredWidth = width; return [0, 560]; };
        dialog._label.clutter_text.emit('text-changed');
        assert.equal(dialog._scroll.height, 584);
        assert.equal(measuredWidth, dialog._scroll.width - 40);
        dialog._diffLabel.get_preferred_height = () => [0, 700];
        dialog._changesButton.checked = true;
        dialog._changesButton.emit('notify::checked');
        assert.equal(dialog._scroll.height, 704);
        dialog._diffLabel.get_preferred_height = () => [0, 10000];
        dialog._resizePreview();
        assert.equal(dialog._scroll.height, 704);
        dialog._changesButton.checked = false;
        dialog._label.get_preferred_height = () => [0, 40];
        dialog._changesButton.emit('notify::checked');
        assert.equal(dialog._scroll.height, 260);
        dialog.destroy();
        shell.assertClean();
    });

    check('preview change preference and labels reflect actual differences', () => {
        const shell = createShell(version);
        for (const enabled of [false, true]) {
            const dialog = new shell.ResultDialog('new', () => {}, () => {}, () => {}, null, null, 'old', enabled);
            assert.equal(dialog._showChanges, enabled);
            assert.equal(dialog._changesButton.label, enabled ? 'Show result' : 'Show changes');
            dialog._changesButton.checked = !enabled;
            dialog._changesButton.emit('notify::checked');
            assert.equal(dialog._changesButton.label, enabled ? 'Show changes' : 'Show result');
            dialog._label.clutter_text.text = 'old';
            dialog._label.clutter_text.emit('text-changed');
            assert.equal(dialog._changesButton.label, 'No changes');
            assert.equal(dialog._changesButton.reactive, false);
            assert.equal(dialog._showChanges, false);
            assert.equal(dialog._label.visible, true);
            dialog._label.clutter_text.text = 'edited';
            dialog._label.clutter_text.emit('text-changed');
            assert.equal(dialog._changesButton.label, 'Show changes');
            assert.equal(dialog._changesButton.reactive, true);
            dialog.destroy();
        }
        const identical = new shell.ResultDialog('same', () => {}, () => {}, () => {}, null, null, 'same', true);
        assert.equal(identical._changesButton.label, 'No changes');
        assert.equal(identical._showChanges, false);
        identical.destroy();
        const prompt = new shell.ResultDialog('answer', () => {}, () => {}, () => {}, null, null, null, true);
        assert.equal(prompt._showChanges, false);
        assert.equal(prompt._changesButton, undefined);
        prompt.destroy();
        shell.assertClean();
    });

    check('preview diff is read-only and Copy and Replace use the edited final text', () => {
        const shell = createShell(version);
        for (const operation of ['copy', 'replace']) {
            const calls = [];
            const dialog = new shell.ResultDialog('The dog sleeps.', text => calls.push(['replace', text]),
                text => calls.push(['copy', text]), () => {}, null, null, 'The cat sleeps.');
            assert.equal(dialog._scroll.height, 260);
            assert.equal(dialog.styleClass, 'plyph-preview-dialog');
            dialog._changesButton.checked = true;
            dialog._changesButton.emit('notify::checked');
            assert.equal(dialog._label.visible, false);
            assert.equal(dialog._diffLabel.visible, true);
            assert.equal(dialog._diffLabel.clutter_text.editable, false);
            assert.match(dialog._diffLabel.clutter_text.markup, /strikethrough="true">cat/);
            dialog._changesButton.checked = false;
            dialog._changesButton.emit('notify::checked');
            assert.equal(dialog._label.visible, true);
            dialog._label.clutter_text.text = 'The bird sleeps.';
            dialog._changesButton.checked = true;
            dialog._changesButton.emit('notify::checked');
            assert.match(dialog._diffLabel.clutter_text.markup, /underline="single">bird/);
            dialog.buttons[operation === 'copy' ? 1 : 2].action();
            assert.deepEqual(calls, [[operation, 'The bird sleeps.']]);
        }
        const prompt = new shell.ResultDialog('Generated answer', () => {}, () => {}, () => {}, null, null);
        assert.equal(prompt._changesButton, undefined);
        assert.equal(prompt._scroll.height, 260);
        prompt.destroy();
        shell.assertClean();
    });

    check('long errors remain readable, copyable and clean up on close or disable', () => {
        const shell = createShell(version);
        const e = shell.extension;
        e.enable();
        const message = 'A detailed error\n' + 'LongWord'.repeat(500) + '\nEnd of error';
        shell.values['pointer-feedback'] = false;
        e._showFeedback(message, 'error', 3500);
        const dialog = e._errorDialog;
        assert.equal(dialog.isOpen, true);
        assert.equal(e._feedbackId, null);
        const scroll = dialog.contentLayout.children[1];
        const label = scroll.children[0].children[0];
        assert.equal(label.get_text(), message);
        assert.equal(label.clutter_text.line_wrap, true);
        assert.equal(label.clutter_text.ellipsize, 0);
        assert.equal(label.clutter_text.selectable, true);
        assert.equal(scroll.hscrollbar_policy, 2);
        dialog.buttons[0].action();
        assert.equal(shell.clipboard.get(1), message);
        assert.equal(dialog.isOpen, true);
        dialog.buttons[1].action();
        assert.equal(e._errorDialog, null);
        e._showFeedback('Another error', 'error');
        const replaced = e._errorDialog;
        e._showFeedback(message, 'error');
        assert.equal(replaced.destroyed, true);
        const active = e._errorDialog;
        e.disable();
        assert.equal(active.destroyed, true);
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

    check('personalization opt-out reaches custom actions from every entry point', () => {
        const shell = createShell(version);
        const e = shell.extension;
        shell.values['custom-actions'] = JSON.stringify([
            {id: 'code', name: 'Fix code', prompt: 'Fix code', usePersonalPreferences: false},
        ]);
        e.enable();
        const action = e._getAvailableActions().find(item => item.id === 'code');
        const calls = [];
        e._run = (...args) => calls.push(args);
        e._runAction(action);
        e._runAvailableAction(action);
        e._rebuildActions();
        e._actionsSection.items[0].emit('activate');
        assert.equal(calls.length, 3);
        for (const call of calls) assert.equal(call[3].usePersonalPreferences, false);
        e.disable();
        shell.assertClean();
    });


    check('follow-up editing preserves original diffs, manual edits and revision history', async () => {
        const shell = createShell(version);
        const calls = [];
        let destroyed = 0;
        const dialog = new shell.ResultDialog('First result', text => calls.push(['replace', text]),
            () => {}, () => {}, null, null, 'Original', true, {
                run: async (text, instruction) => { calls.push([text, instruction]); return 'Refined result'; },
                destroy: () => destroyed++,
            });
        assert.equal(dialog._refineRow.visible, false);
        assert.equal(dialog._resultCount.visible, false);
        assert.equal(dialog.initialFocus, dialog._replaceButton);
        assert.equal(dialog.buttonLayout.get_children()[0], dialog._refineToggle);
        dialog._toggleRefinement();
        assert.equal(dialog._refineRow.visible, true);
        dialog._label.clutter_text.set_text('Manually edited');
        dialog._refineEntry.set_text('Shorter');
        await dialog._refine();
        assert.deepEqual(calls, [['Manually edited', 'Shorter']]);
        assert.equal(dialog._original, 'Original');
        assert.equal(dialog._label.get_text(), 'Refined result');
        assert.equal(dialog._refineEntry.get_text(), '');
        assert.equal(dialog._previousButton.reactive, true);
        dialog._refineEntry.set_text('More formal');
        await dialog._refine();
        assert.equal(dialog._revisions.length, 3);
        dialog._switchResult(-1);
        assert.equal(dialog._label.get_text(), 'Refined result');
        dialog._switchResult(-1);
        assert.equal(dialog._label.get_text(), 'Manually edited');
        assert.equal(dialog._previousButton.reactive, false);
        assert.equal(dialog._resultCount.text, '1/3');
        assert.equal(dialog._nextButton.reactive, true);
        dialog._label.clutter_text.set_text('Edited earlier version');
        dialog._switchResult(1);
        assert.equal(dialog._resultCount.text, '2/3');
        dialog._switchResult(1);
        assert.equal(dialog._nextButton.reactive, false);
        dialog._switchResult(1);
        assert.equal(dialog._resultCount.text, '3/3');
        dialog._switchResult(-1);
        dialog._switchResult(-1);
        assert.equal(dialog._label.get_text(), 'Edited earlier version');
        dialog._refineEntry.set_text('Another version');
        await dialog._refine();
        assert.equal(dialog._resultCount.text, '4/4');
        assert.equal(dialog._revisions.length, 4);
        dialog._switchResult(-1);
        dialog._switchResult(-1);
        dialog._switchResult(-1);
        dialog._toggleRefinement();
        assert.equal(dialog._refineRow.visible, false);
        dialog.buttons.find(button => button.label === 'Replace').action();
        assert.deepEqual(calls.at(-1), ['replace', 'Edited earlier version']);
        assert.equal(destroyed, 1);
        shell.assertClean();
    });

    check('follow-up failures preserve result and instruction, and closing ignores late responses', async () => {
        const shell = createShell(version);
        let resolve;
        let requests = 0;
        let destroyed = 0;
        let applied = false;
        const dialog = new shell.ResultDialog('Keep me', () => { applied = true; },
            () => {}, () => {}, null, null, 'Original', false, {
                run: () => { requests++; return new Promise(done => { resolve = done; }); },
                destroy: () => destroyed++,
            });
        await dialog._refine();
        assert.equal(requests, 0);
        dialog._refineEntry.set_text('Shorter');
        const pending = dialog._refine();
        await dialog._refine();
        assert.equal(requests, 1);
        assert.equal(dialog._label.clutter_text.editable, false);
        dialog.buttons.find(button => button.label === 'Replace').action();
        assert.equal(applied, false);
        resolve('');
        await pending;
        assert.equal(dialog._label.get_text(), 'Keep me');
        assert.equal(dialog._refineEntry.get_text(), 'Shorter');
        assert.equal(dialog._statusScroll.visible, true);
        assert.equal(dialog._revisions.length, 1);
        const run = dialog._refinement.run;
        dialog._refinement.run = async () => { throw new Error('Network unavailable'); };
        await dialog._refine();
        assert.equal(dialog._refineStatus.text, 'Network unavailable');
        assert.equal(dialog._label.get_text(), 'Keep me');
        dialog._refinement.run = run;
        const late = dialog._refine();
        dialog.buttons.find(button => button.label === 'Cancel').action();
        resolve('Late result');
        await late;
        assert.equal(destroyed, 1);
        assert.equal(applied, false);
        shell.assertClean();
    });

    check('refinement entry owns Enter and text selection shortcuts', async () => {
        const shell = createShell(version);
        let calls = 0;
        let replaced = false;
        const dialog = new shell.ResultDialog('Draft', () => { replaced = true; },
            () => {}, () => {}, null, null, 'Original', false, {
                run: async () => { calls++; return 'Refined'; }, destroy: () => {},
            });
        dialog._refineEntry.set_text('Shorter');
        dialog._refineEntry.grab_key_focus();
        const event = (key, modifiers = 0) => ({get_key_symbol: () => key, get_state: () => modifiers});
        assert.equal(dialog.vfunc_key_press_event(event(shell.Clutter.KEY_a, 4)), false);
        assert.equal(dialog._label.clutter_text.selection, undefined);
        assert.equal(dialog.vfunc_key_press_event(event(shell.Clutter.KEY_Return)), true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls, 1);
        assert.equal(replaced, false);
        assert.equal(dialog._label.get_text(), 'Refined');
        dialog.destroy();
        shell.assertClean();
    });

    check('preview refinement retains provider options and destroys its independent client', async () => {
        const shell = createShell(version);
        const e = shell.extension;
        e.enable();
        e._showPreview('Draft', null, 'Selected', 'Original',
            {provider: 'ollama', model: 'chosen-model', outputLimit: 1000}, 'Original context');
        const client = shell.clients.at(-1);
        let request;
        client.transform = async (...args) => { request = args; return 'New draft'; };
        const dialog = e._previewDialog;
        dialog._refineEntry.set_text('Keep the opening');
        await dialog._refine();
        assert.equal(request[3].provider, 'ollama');
        assert.equal(request[3].model, 'chosen-model');
        assert.equal(request[3].outputLimit, 1000);
        assert.equal(request[3].inputMode, 'prompt');
        assert.deepEqual(JSON.parse(request[0]), {original: 'Original context', currentResult: 'Draft', instruction: 'Keep the opening'});
        e.disable();
        assert.equal(client.destroyed, true);
        shell.assertClean();
    });


    check('preview follow-ups retain the action personalization choice', async () => {
        const shell = createShell(version);
        const e = shell.extension;
        e.enable();
        shell.values['preview-results'] = true;
        e._readSelection = async () => ({text: 'Selected code', primaryText: 'Selected code'});
        const calls = [];
        for (const client of shell.clients) client.transform = async (...args) => { calls.push(args); return 'Draft'; };
        await e._run('custom', 'Fix code', 'Fix code', {usePersonalPreferences: false});
        assert.equal(calls[0][3].usePersonalPreferences, false);
        const dialog = e._previewDialog;
        shell.clients.at(-1).transform = async (...args) => { calls.push(args); return 'Reply'; };
        dialog._refineEntry.set_text('Fix the loop');
        await dialog._refine();
        assert.equal(calls.at(-1)[3].usePersonalPreferences, false);
        dialog._toggleRefinement(true);
        dialog._refineEntry.set_text('Why?');
        await dialog._refine();
        assert.equal(calls.at(-1)[3].usePersonalPreferences, false);
        e.disable();
        shell.assertClean();
    });

    check('discussion stays collapsed, preserves drafts and sends result snapshots with history', async () => {
        const shell = createShell(version);
        const e = shell.extension;
        e.enable();
        e._showPreview('Draft', null, 'Selection', 'Source',
            {provider: 'ollama', model: 'chosen-model', inputLimit: 5000}, 'Source context',
            {mode: 'custom', instructions: 'Summarize'});
        const dialog = e._previewDialog;
        const client = shell.clients.at(-1);
        const requests = [];
        client.transform = async (...args) => { requests.push(args); return '**Explanation**'; };
        assert.equal(dialog._discussionScroll.visible, false);
        assert.equal(dialog._refineRow.visible, false);
        dialog._toggleRefinement();
        dialog._refineEntry.set_text('Shorter');
        dialog._toggleRefinement(true);
        assert.equal(dialog._refineEntry.get_text(), '');
        dialog._label.clutter_text.set_text('Edited draft');
        dialog._refineEntry.set_text('Why this wording?');
        dialog._refineEntry.grab_key_focus();
        const event = {get_key_symbol: () => shell.Clutter.KEY_Return, get_state: () => 0};
        assert.equal(dialog.vfunc_key_press_event(event), true);
        await new Promise(resolve => setImmediate(resolve));
        const payload = JSON.parse(requests[0][0]);
        assert.equal(payload.original, 'Source context');
        assert.equal(payload.initialResult, 'Draft');
        assert.equal(payload.action.instructions, 'Summarize');
        assert.deepEqual(payload.conversation, [{role: 'user', content: 'Why this wording?', currentResult: 'Edited draft', revision: 1}]);
        assert.equal(requests[0][3].model, 'chosen-model');
        assert.equal(requests[0][3].provider, 'ollama');
        assert.equal(requests[0][3].inputLimit, 5000);
        assert.equal(requests[0][3].inputMode, 'prompt');
        assert.equal(dialog._discussionScroll.visible, true);
        assert.equal(dialog._discussionMessages.get_children().length, 2);
        assert.equal(dialog._discussionMessages.get_children()[1]._body.clutter_text.markup, '<b>Explanation</b>');
        assert.equal(dialog._discussionLoading, null);
        assert.equal(dialog._discussionLoadingId, null);
        assert.equal(dialog._label.get_text(), 'Edited draft');
        assert.equal(dialog._revisions.length, 1);
        dialog._toggleRefinement(true);
        assert.equal(dialog._discussionScroll.visible, false);
        dialog._toggleRefinement();
        assert.equal(dialog._refineEntry.get_text(), 'Shorter');
        dialog._toggleRefinement(true);
        dialog._label.clutter_text.set_text('Another edit');
        dialog._refineEntry.set_text('And now?');
        await dialog._refine();
        const followup = JSON.parse(requests[1][0]);
        assert.equal(followup.conversation.length, 3);
        assert.equal(followup.conversation[1].content, '**Explanation**');
        assert.equal(followup.conversation[2].currentResult, 'Another edit');
        e.disable();
        assert.equal(client.destroyed, true);
        shell.assertClean();
    });

    check('discussion failure permits retry and closing cancels a pending reply', async () => {
        const shell = createShell(version);
        let complete;
        let destroyed = false;
        let calls = 0;
        const dialog = new shell.ResultDialog('Draft', () => {}, () => {}, () => {}, null, null, 'Source', false, {
            discuss: async () => { calls++; throw new Error('Offline'); },
            destroy: () => { destroyed = true; },
        });
        dialog._toggleRefinement(true);
        dialog._refineEntry.set_text('Explain');
        await dialog._refine();
        assert.equal(dialog._refineEntry.get_text(), 'Explain');
        assert.equal(dialog._refineStatus.text, 'Offline');
        assert.equal(dialog._discussion.length, 0);
        assert.equal(dialog._discussionMessages.get_children().length, 0);
        dialog._refinement.discuss = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
        const pending = dialog._refine();
        await dialog._refine();
        assert.equal(calls, 2);
        assert.equal(dialog._discussToggle.reactive, false);
        assert.equal(dialog._nextButton.reactive, false);
        assert.equal(dialog._discussionLoading._body.get_text(), 'Replying…');
        assert.ok(dialog._discussionLoadingId);
        assert.equal(dialog._discussionMessages.get_children().length, 2);
        dialog.buttons.find(button => button.label === 'Cancel').action();
        assert.equal(dialog._discussionLoadingId, null);
        complete('Late reply');
        await pending;
        assert.equal(destroyed, true);
        shell.assertClean();
    });


    check('larger preview stays bounded on wide and scaled monitors and prioritizes discussion', () => {
        for (const [width, height, scale] of [[3440, 1440, 1], [3840, 2160, 2], [1366, 768, 1], [1600, 1200, 1.5]]) {
            const shell = createShell(version);
            shell.layoutManager.currentMonitor = {x: 0, y: 0, width, height};
            shell.values['test-scale'] = scale;
            const dialog = new shell.ResultDialog('Short result', () => {}, () => {}, () => {}, null, null, 'Source', false,
                {destroy: () => {}});
            const compactWidth = dialog._scroll.width;
            dialog._toggleExpanded({});
            assert.ok(dialog._scroll.width / scale <= 1000);
            assert.ok(dialog._scroll.width <= width - 96);
            assert.equal(dialog._scroll.height / scale, 260, 'Short results must not stretch to fill the screen');
            dialog._label.get_preferred_height = () => [0, 10000];
            dialog._resizePreview();
            assert.ok(dialog._scroll.height / scale + 160 <= height / scale * 0.8 + 0.01);
            dialog._label.get_preferred_height = () => [0, 40 * scale];
            dialog._toggleRefinement(true);
            dialog._discussion.push({role: 'assistant', content: 'Reply'});
            dialog._addDiscussionMessage('assistant', 'Reply');
            dialog._discussionScroll.visible = true;
            dialog._resizePreview();
            assert.equal(dialog._divider.visible, true);
            assert.ok(dialog._scroll.height < dialog._discussionScroll.height);
            const total = (dialog._scroll.height + dialog._discussionScroll.height) / scale;
            assert.ok(total + 28 + 220 <= height / scale * 0.8 + 0.01);
            dialog._statusScroll.visible = true;
            dialog._resizePreview();
            assert.ok((dialog._scroll.height + dialog._discussionScroll.height) / scale + 28 + 300 <= height / scale * 0.8 + 0.01);
            dialog._statusScroll.visible = false;
            dialog._toggleExpanded({});
            assert.equal(dialog._scroll.width, compactWidth);
            dialog._toggleRefinement(true);
            assert.equal(dialog._divider.visible, false);
            assert.equal(dialog._discussionScroll.visible, false);
            assert.equal(dialog._scroll.height / scale, 260);
            dialog.destroy();
            shell.assertClean();
        }
    });

    check('discussion divider clamps dragging, supports keyboard reset and cleans up pointer capture', () => {
        const shell = createShell(version);
        shell.values['test-scale'] = 2;
        shell.layoutManager.currentMonitor = {x: 0, y: 0, width: 3840, height: 2160};
        const dialog = new shell.ResultDialog('Result', () => {}, () => {}, () => {}, null, null, 'Source', false,
            {destroy: () => {}});
        dialog._toggleRefinement(true);
        dialog._discussion.push({role: 'assistant', content: 'Reply'});
        dialog._discussionScroll.visible = true;
        dialog._toggleExpanded({});
        const total = dialog._scroll.height + dialog._discussionScroll.height;
        const pointer = (type, y, button = 1) => ({type: () => type, get_coords: () => [300, y], get_button: () => button});
        const press = pointer(null, 400);
        assert.equal(dialog._beginDividerDrag(pointer(null, 400, 3)), false);
        const begin = () => {
            if (version >= 51) {
                dialog._dividerPan.startY = 400;
                dialog._dividerPan.emit('recognize');
            } else assert.equal(dialog._beginDividerDrag(press), true);
            assert.ok(dialog._dividerGrab);
        };
        const motion = y => {
            if (version >= 51) {
                dialog._dividerPan.y = y;
                dialog._dividerPan.emit('pan-update');
            } else shell.stage.emit('captured-event', pointer(shell.Clutter.EventType.MOTION, y));
        };
        const keypress = symbol => {
            if (version >= 51) {
                dialog._dividerKeys.symbol = symbol;
                dialog._dividerKeys.emit('key-press');
            } else dialog._divider.emit('key-press-event', {get_key_symbol: () => symbol});
        };
        begin();
        motion(600);
        assert.equal(dialog._scroll.height / 2, 200, 'Pointer movement must respect stage scale');
        motion(100000);
        assert.ok(dialog._discussionScroll.height / 2 >= 160);
        assert.equal(dialog._scroll.height + dialog._discussionScroll.height, total);
        motion(-100000);
        assert.equal(dialog._scroll.height / 2, 100);
        if (version >= 51) dialog._dividerPan.emit('end');
        else shell.stage.emit('captured-event', pointer(shell.Clutter.EventType.BUTTON_RELEASE, 0));
        assert.equal(dialog._dividerGrab, null);
        keypress(shell.Clutter.KEY_Down);
        assert.equal(dialog._scroll.height / 2, 132);
        keypress(shell.Clutter.KEY_Home);
        assert.equal(dialog._splitRatio, null);
        assert.equal(dialog._scroll.height / 2, 100);
        begin();
        keypress(shell.Clutter.KEY_Escape);
        assert.equal(dialog._dividerGrab, null);
        assert.equal(dialog._finished, false);
        begin();
        dialog._toggleRefinement(true);
        assert.equal(dialog._dividerGrab, null, 'Hiding discussion must end a drag');
        dialog._toggleRefinement(true);
        begin();
        dialog.destroy();
        shell.assertClean();
    });


    check('clipboard shortcuts target each text field and replace Unicode selections correctly', () => {
        const shell = createShell(version);
        const dialog = new shell.ResultDialog('Before', () => {}, () => {}, () => {}, null, null, 'Source', false,
            {destroy: () => {}});
        const ask = new shell.AskDialog(() => {}, () => {}, () => {});
        const control = shell.Clutter.ModifierType.CONTROL_MASK;
        const shift = shell.Clutter.ModifierType.SHIFT_MASK;
        for (const field of [dialog._label, dialog._refineEntry, ask._entry]) {
            field.clutter_text.set_text('a🌍bc');
            field.clutter_text.set_selection(1, 3);
            shell.sendTextKey(field, shell.Clutter.KEY_c, control);
            assert.equal(shell.clipboard.get(1), '🌍b');
            shell.sendTextKey(field, shell.Clutter.KEY_x, control);
            assert.equal(field.get_text(), 'ac');
            assert.equal(shell.clipboard.get(1), '🌍b');
            shell.clipboard.set(1, 'Hi\n🌍');
            shell.sendTextKey(field, shell.Clutter.KEY_v, control);
            assert.equal(field.get_text(), 'aHi\n🌍c');
            shell.sendTextKey(field, shell.Clutter.KEY_a, control);
            shell.clipboard.set(1, 'Replacement');
            shell.sendTextKey(field, shell.Clutter.KEY_Insert, shift);
            assert.equal(field.get_text(), 'Replacement');
            shell.sendTextKey(field, shell.Clutter.KEY_a, control);
            shell.sendTextKey(field, shell.Clutter.KEY_Insert, control);
            assert.equal(shell.clipboard.get(1), 'Replacement');
            shell.sendTextKey(field, shell.Clutter.KEY_Delete, shift);
            assert.equal(field.get_text(), '');
        }
        dialog._label.clutter_text.set_text('First line');
        shell.sendTextKey(dialog._label, shell.Clutter.KEY_Return);
        assert.equal(dialog._label.get_text(), 'First line\n');
        assert.equal(dialog._finished, false, 'Enter must edit the result rather than Replace');
        dialog._label.clutter_text.set_text('Current result');
        dialog._refineEntry.set_text('Different field');
        shell.sendTextKey(dialog._refineEntry, shell.Clutter.KEY_a, control);
        shell.sendTextKey(dialog._refineEntry, shell.Clutter.KEY_c, control);
        assert.equal(shell.clipboard.get(1), 'Different field');
        assert.equal(dialog._label.get_text(), 'Current result');
        dialog.destroy();ask.destroy();shell.assertClean();
    });

    check('read-only text copies the visible selection and never cuts or pastes', () => {
        const shell = createShell(version);
        const dialog = new shell.ResultDialog('Result', () => {}, () => {}, () => {}, null, null, 'Source', true,
            {destroy: () => {}});
        const error = new shell.ErrorDialog('Error details', () => {});
        dialog._addDiscussionMessage('assistant', '**Readable reply**');
        dialog._refineStatus.set_text('Status details');
        const reply = dialog._discussionMessages.get_children()[0]._body;
        const errorText = error.contentLayout.get_children()[1].get_children()[0].get_children()[0];
        for (const field of [dialog._diffLabel, reply, dialog._refineStatus, errorText]) {
            const original = field.get_text();
            shell.sendTextKey(field, shell.Clutter.KEY_a, 4);
            shell.sendTextKey(field, shell.Clutter.KEY_c, 4);
            assert.equal(shell.clipboard.get(1), original);
            shell.clipboard.set(1, 'Do not insert');
            shell.sendTextKey(field, shell.Clutter.KEY_v, 4);
            shell.sendTextKey(field, shell.Clutter.KEY_x, 4);
            assert.equal(field.get_text(), original);
            assert.equal(shell.clipboard.get(1), 'Do not insert');
        }
        assert.equal(reply.get_text(), 'Readable reply');
        assert.equal(reply.clutter_text.reactive, true);
        assert.equal(reply.clutter_text.selectable, true);
        assert.equal(reply.clutter_text.editable, false);
        assert.equal(reply.clutter_text.cursor_visible, true, 'Selection painting must remain enabled');
        assert.equal(reply.clutter_text.cursor_size, 0, 'Read-only replies do not show an editing caret');
        reply.emit('style-changed');
        assert.equal(reply.clutter_text.selection_color, dialog._refineEntry.clutter_text.get_selection_color());
        assert.equal(reply.clutter_text.selected_text_color, dialog._refineEntry.clutter_text.get_selected_text_color());
        dialog._refineEntry.clutter_text.set_selection_color('new theme highlight');
        reply.emit('style-changed');
        assert.equal(reply.clutter_text.selection_color, 'new theme highlight');
        dialog.destroy();error.destroy();shell.assertClean();
    });

    check('delayed pastes cannot edit a different, busy or destroyed field', () => {
        const shell = createShell(version);
        shell.values['test-delay-clipboard'] = true;
        const dialog = new shell.ResultDialog('Draft', () => {}, () => {}, () => {}, null, null, 'Source', false,
            {destroy: () => {}});
        shell.clipboard.set(1, 'Paste');
        shell.sendTextKey(dialog._label, shell.Clutter.KEY_v, 4);
        dialog._refineEntry.grab_key_focus();
        shell.clipboardReads.shift()();
        assert.equal(dialog._label.get_text(), 'Draft');
        shell.sendTextKey(dialog._label, shell.Clutter.KEY_v, 4);
        dialog._setRefining(true);
        shell.clipboardReads.shift()();
        assert.equal(dialog._label.get_text(), 'Draft');
        shell.sendTextKey(dialog._label, shell.Clutter.KEY_x, 4);
        assert.equal(dialog._label.get_text(), 'Draft');
        dialog._setRefining(false);
        shell.sendTextKey(dialog._label, shell.Clutter.KEY_v, 4);
        dialog.destroy();
        assert.doesNotThrow(() => shell.clipboardReads.shift()());
        shell.assertClean();
    });


    check('empty Ask stays open with feedback and supports a later valid submission or cancellation', () => {
        const shell = createShell(version);
        const calls = [];
        const ask = new shell.AskDialog(text => calls.push(text), () => calls.push('cancel'), () => calls.push('close'));
        ask.buttons[1].action();
        assert.equal(ask._finished, false);
        assert.equal(ask._inputError.visible, true);
        assert.equal(shell.stage.get_key_focus(), ask._entry);
        ask._entry.set_text('   ');
        ask._entry.clutter_text.emit('activate');
        assert.equal(ask._finished, false);
        assert.deepEqual(calls, []);
        ask._entry.set_text('  Explain this  ');
        assert.equal(ask._inputError.visible, false);
        ask.buttons[1].action();
        assert.deepEqual(calls, ['close', 'Explain this']);
        const cancel = new shell.AskDialog(() => calls.push('unexpected'), () => calls.push('cancel'), () => {});
        cancel.buttons[1].action();
        cancel.buttons[0].action();
        assert.equal(calls.at(-1), 'cancel');
        shell.assertClean();
    });

}
