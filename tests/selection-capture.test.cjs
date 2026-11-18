const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const {loadI18n} = require('./helpers/modules.cjs');

const root = resolve(__dirname, '..');
const MIME = 'text/plain;charset=utf-8';
const encode = value => typeof value === 'string' ? new TextEncoder().encode(value) : value;
function fixture(initial = {[MIME]: 'Original clipboard'}) {
    let formats = new Map(Object.entries(initial).map(([type, value]) => [type, encode(value)]));
    class MemorySource {}
    let currentSource = {is_active: () => true};
    let current = true;
    let copies = 0;
    let reads = 0;
    let failRead = 0;
    const pending = [];
    const timers = new Map();
    const signals = new Map();
    const limits = [];
    const streams = [];
    let next = 1;
    class IOError extends Error {
        constructor(_domain, code, message) {super(message); this.code = code;}
        matches(_domain, code) {return this.code === code;}
    }
    class Bytes {
        constructor(data) {this.data = data;}
        get_data() {return this.data;}
        get_size() {return this.data.length;}
    }
    class Stream {
        data = new Uint8Array(); closed = false;
        close() {this.closed = true;}
        is_closed() {return this.closed;}
        steal_as_bytes() {assert(this.closed); return new Bytes(this.data);}
    }
    const selection = {
        connect(_name, fn) {const id = next++; signals.set(id, fn); return id;},
        disconnect(id) {assert(signals.delete(id));},
        get_mimetypes() {return [...formats.keys()];},
        transfer_async(_type, mime, limit, stream, cancel, callback) {
            const number = ++reads;
            limits.push(limit);
            const data = formats.get(mime);
            const complete = () => {
                stream.data = (data ?? new Uint8Array()).slice(0, limit);
                callback(selection, {cancel, number});
            };
            if (number === holdRead) pending.push(complete);
            else queueMicrotask(complete);
        },
        transfer_finish(result) {
            if (result.cancel.is_cancelled()) throw new IOError(0, 1, 'Cancelled');
            if (result.number === failRead) throw new Error('Read failed');
            return true;
        },
        unset_owner(_type, owner) {assert.equal(owner, currentSource); replace({});},
    };
    let holdRead = 0;
    let cacheEnabled = true;
    function replace(data, memory = false) {
        formats = new Map(Object.entries(data).map(([type, value]) => [type, encode(value)]));
        const previous = currentSource;
        previous.is_active = () => false;
        currentSource = Object.assign(memory ? new MemorySource() : {}, {is_active: () => true});
        for (const fn of [...signals.values()]) fn(selection, 1, currentSource);
    }
    const clipboard = {
        set_text(_type, text) {replace({[MIME]: text});},
        set_content(_type, mime, bytes) {replace({[mime]: bytes.get_data()});},
    };
    const context = vm.createContext({TextDecoder, Gio: {
        Cancellable: class {cancelled = false; cancel() {this.cancelled = true;} is_cancelled() {return this.cancelled;}},
        IOErrorEnum: {CANCELLED: 1}, MemoryOutputStream: {new_resizable: () => {
            const stream = new Stream(); streams.push(stream); return stream;
        }},
    }, GLib: {Error: IOError, PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add(_priority, _ms, fn) {const id = next++; timers.set(id, fn); return id;},
        Source: {remove(id) {assert(timers.delete(id));}},
    }, Meta: {SelectionSourceMemory: MemorySource, SelectionSource: class {constructor(...args) {this._init(...args);} _init() {}}, SelectionType: {SELECTION_CLIPBOARD: 1}}, St: {ClipboardType: {CLIPBOARD: 1}}});
    loadI18n(context, root);
    vm.runInContext(readFileSync(resolve(root, 'shell/selectionCapture.js'), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class SelectionCapture', 'globalThis.SelectionCapture = class SelectionCapture'), context);
    const capture = new context.SelectionCapture();
    return {capture, timers, pending, limits, replace, streams, clipboard,
        paste(run = async owned => {assert(owned());}, strict = true) {
            return capture.paste({selection, clipboard, text: 'Corrected output', run, strict, isCurrent: () => current});
        },
        watch() {capture.watchImages(selection, () => cacheEnabled);},
        cacheEnabled(value) {cacheEnabled = value; if (!value) capture.clearImageCache();},
        emptyPayload(mime) {formats.set(mime, new Uint8Array());},
        data: () => formats,
        release() {
            currentSource.is_active = () => false;
            for (const fn of [...signals.values()]) fn(selection, 1, null);
        },
        hold(number) {holdRead = number;}, fail(number) {failRead = number;},
        focus(value) {current = value;}, copies: () => copies,
        start(copy = () => replace({[MIME]: 'Selected text'}), strict = true, preserve = true) {
            return capture.capture({selection, clipboard, isCurrent: () => current, strict, preserve,
                copy() {copies++; copy();}});
        },
        timeout() {const [id, fn] = [...timers][0]; timers.delete(id); fn();},
        clean() {assert.equal(signals.size, 0); assert.equal(timers.size, 0); assert.equal(capture._active, null);},
    };
}
const settle = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
const text = f => new TextDecoder().decode(f.data().get(MIME));

for (const [name, initial] of [
    ['text', {[MIME]: 'Original 🌍'}], ['empty text', {[MIME]: ''}], ['no clipboard owner', {}],
    ['PNG', {'image/png': new Uint8Array([137,80,78,71,0,255])}],
    ['single file format', {'x-special/gnome-copied-files': 'copy\nfile:///tmp/example'}],
]) {
    test(`${name}: successful capture restores the original content`, async () => {
        const f = fixture(initial);
        assert.equal(await f.start(), 'Selected text');
        if (Object.keys(initial).length)
            assert.deepEqual(f.data(), new Map(Object.entries(initial).map(([type,value]) => [type,encode(value)])));
        else
            assert.equal(text(f), '');
        f.clean();
    });
}

test('text aliases restore Unicode text', async () => {
    const f = fixture({[MIME]: 'Original 🌍', 'UTF8_STRING': 'Original 🌍', STRING: 'Original'});
    assert.equal(await f.start(), 'Selected text');
    assert.equal(text(f), 'Original 🌍'); assert.equal(f.data().size, 1); f.clean();
});

for (const initial of [
    {[MIME]: 'Formatted', 'text/html': '<b>Formatted</b>'},
    {'text/uri-list': 'file:///tmp/a', 'x-special/gnome-copied-files': 'copy\nfile:///tmp/a'},
]) {
    test('strict mode rejects rich data before copying', async () => {
        const f = fixture(initial); const before = f.data();
        await assert.rejects(f.start(), /multiple formats/);
        assert.equal(f.copies(), 0); assert.equal(f.data(), before); f.clean();
    });
}

test('the transfer is bounded and an oversized snapshot is rejected before copying', async () => {
    const f = fixture({'image/png': new Uint8Array(8*1024*1024+2)});
    await assert.rejects(f.start(), /too large/);
    assert.deepEqual(f.limits, [8*1024*1024+1]);
    assert.equal(f.copies(), 0); f.clean();
});

test('capture does not need to clear the clipboard or compare text to detect a new copy', async () => {
    const f = fixture({[MIME]: 'Selected text'});
    assert.equal(await f.start(), 'Selected text'); assert.equal(text(f), 'Selected text'); f.clean();
});

test('a failed copy cannot return the old clipboard as selected text', async () => {
    const f = fixture(); const running = f.start(() => {});
    await settle(); f.timeout();
    await assert.rejects(running, /Could not capture/);
    assert.equal(text(f), 'Original clipboard'); f.clean();
});

test('changes while snapshotting abort before Ctrl+C and preserve the newer clipboard', async () => {
    const f = fixture(); f.hold(1); const running = f.start();
    f.replace({[MIME]: 'New user copy'}); f.pending.shift()();
    await assert.rejects(running, /cancel|Could not capture/i);
    assert.equal(f.copies(), 0); assert.equal(text(f), 'New user copy'); f.clean();
});

for (const newer of ['New user copy', 'Selected text']) {
    test('a newer clipboard owner is never overwritten, even with identical text', async () => {
        const f = fixture(); f.hold(2); const running = f.start();
        await settle(); f.replace({[MIME]: newer}); f.pending.shift()();
        await assert.rejects(running, /cancel|Could not capture/i);
        assert.equal(text(f), newer); f.clean();
    });
}

test('read failures after copying restore the original clipboard', async () => {
    const f = fixture(); f.fail(2);
    await assert.rejects(f.start(), /Read failed/);
    assert.equal(text(f), 'Original clipboard'); f.clean();
});

test('destroy restores an owned temporary copy and removes sources immediately', async () => {
    const f = fixture(); f.hold(2); const running = f.start(); await settle();
    f.capture.destroy(); assert.equal(text(f), 'Original clipboard'); f.clean();
    f.pending.shift()(); await assert.rejects(running, /cancel|Could not capture/i);
    await assert.rejects(f.start(), /cancel|Could not capture/i); f.clean();
});

test('timeout during a transfer restores the clipboard and returns useful feedback', async () => {
    const f = fixture(); f.hold(2); const running = f.start(); await settle();
    f.timeout(); f.pending.shift()();
    await assert.rejects(running, /Could not capture/);
    assert.equal(text(f), 'Original clipboard'); f.clean();
});

test('overlapping requests cannot replace the active capture', async () => {
    const f = fixture(); f.hold(2); const running = f.start(); await settle();
    await assert.rejects(f.start(), /already in progress/);
    f.pending.shift()(); assert.equal(await running, 'Selected text'); f.clean();
});

test('a focus change cancels capture without touching the newer clipboard context', async () => {
    const f = fixture(); f.hold(2); const running = f.start(); await settle();
    f.focus(false); f.pending.shift()(); await assert.rejects(running, /cancel|Could not capture/i); f.clean();
});


test('opaque portal tokens are not treated as restorable byte payloads', async () => {
    const f = fixture({'application/vnd.portal.filetransfer': 'opaque-token'});
    await assert.rejects(f.start(), /format cannot be preserved/);
    assert.equal(f.copies(), 0); f.clean();
});

test('snapshot read failures leave the original content untouched', async () => {
    const f = fixture(); f.fail(1); const before = f.data();
    await assert.rejects(f.start(), /Read failed/);
    assert.equal(f.data(), before); assert.equal(f.copies(), 0); f.clean();
});

for (const [initial, mime] of [
    [{[MIME]: 'Browser text', 'text/html': '<b>Browser text</b>'}, MIME],
    [{'image/jpeg': new Uint8Array([255,216]), 'image/png': new Uint8Array([137,80,78,71])}, 'image/png'],
]) {
    test('non-strict mode restores the preferred representation without blocking', async () => {
        const f = fixture(initial);
        assert.equal(await f.start(undefined, false), 'Selected text');
        assert.deepEqual(f.data().get(mime), encode(initial[mime]));
        f.clean();
    });
}
test('non-strict mode allows an unsupported clipboard without returning its content', async () => {
    const f = fixture({'application/unknown': 'data'});
    assert.equal(await f.start(undefined, false), 'Selected text');
    assert.equal(text(f), 'Selected text'); f.clean();
});

for (const read of [1, 2]) {
    test(`timeout ends a stalled transfer without waiting for its callback (${read})`, async () => {
        const f = fixture(); f.hold(read);
        const running = f.start(); await settle(); f.timeout();
        await assert.rejects(running, /Could not capture/);
        f.clean();
        f.pending.shift()(); await settle(); f.clean();
    });
}

for (const read of [1, 2]) {
    test(`destroy settles a stalled transfer without a callback (${read})`, async () => {
        const f = fixture(); f.hold(read);
        const running = f.start(); await settle();
        f.capture.destroy();
        await assert.rejects(running, /cancel|Could not capture/i);
        assert(f.streams.every(stream => stream.closed));
        assert.equal(text(f), 'Original clipboard');
        f.clean();
    });
}

test('a timed out capture can be retried before its old callback arrives', async () => {
    const f = fixture(); f.hold(2);
    const first = f.start(); await settle(); f.timeout();
    await assert.rejects(first, /Could not capture/);
    assert(f.streams.every(stream => stream.closed));
    const second = f.start();
    f.pending.shift()();
    assert.equal(await second, 'Selected text');
    assert.equal(text(f), 'Original clipboard'); f.clean();
});

test('owner changes cancel a stalled snapshot without waiting for its callback', async () => {
    const f = fixture(); f.hold(1); const running = f.start();
    f.replace({[MIME]: 'A new user copy'});
    await assert.rejects(running, /cancel|Could not capture/i);
    assert.equal(text(f), 'A new user copy'); assert.equal(f.copies(), 0);
    assert(f.streams.every(stream => stream.closed)); f.clean();
});

test('focus changes still restore the temporary copy when no newer owner exists', async () => {
    const f = fixture(); f.hold(2); const running = f.start(); await settle();
    f.focus(false); f.pending.shift()();
    await assert.rejects(running, /cancel|Could not capture/i);
    assert.equal(text(f), 'Original clipboard'); f.clean();
});

for (const captured of [{[MIME]: '  '}, {'image/png': new Uint8Array([137])}, {[MIME]: new Uint8Array([255])}]) {
    test('empty, non-text and invalid UTF-8 copies restore the original on failure', async () => {
        const f = fixture();
        await assert.rejects(f.start(() => f.replace(captured)));
        assert.equal(text(f), 'Original clipboard'); f.clean();
    });
}

for (const changesOwner of [false, true]) {
    test(`a copy exception cleans up and allows retry (owner changed: ${changesOwner})`, async () => {
        const f = fixture();
        await assert.rejects(f.start(() => {
            if (changesOwner) f.replace({[MIME]: 'Temporary selection'});
            throw new Error('Copy failed');
        }), /Copy failed/);
        assert.equal(text(f), 'Original clipboard'); f.clean();
        assert.equal(await f.start(), 'Selected text'); f.clean();
    });
}

test('a restore failure releases state and cannot block a subsequent capture', async () => {
    const f = fixture();
    const set = f.clipboard.set_content;
    f.clipboard.set_content = () => { throw new Error('Restore failed'); };
    await assert.rejects(f.start(), /Restore failed/);
    f.clean();
    f.clipboard.set_content = set;
    assert.equal(await f.start(), 'Selected text'); f.clean();
});

 test('preservation can be disabled without snapshotting an unsupported clipboard', async () => {
    const f = fixture({'application/unknown': 'Original'});
    f.fail(1);
    await assert.rejects(f.start(undefined, true, false), /Read failed/);
    assert.equal(f.copies(), 1);
    assert.equal(text(f), 'Selected text'); f.clean();
 });

test('preservation disabled captures normally and leaves the selected text on the clipboard', async () => {
    const f = fixture({'image/png': new Uint8Array([137,80])});
    assert.equal(await f.start(undefined, false, false), 'Selected text');
    assert.equal(text(f), 'Selected text'); assert.equal(f.limits.length, 1); f.clean();
});

test('Firefox release, GNOME memory fallback and new offer count as one copy', async () => {
    const f = fixture();
    assert.equal(await f.start(() => {
        f.release();
        f.replace({[MIME]: 'GNOME saved copy'}, true);
        f.replace({[MIME]: 'Fresh Firefox selection'});
    }), 'Fresh Firefox selection');
    assert.equal(text(f), 'Original clipboard'); f.clean();
});
test('a release without a new application offer times out without restoring over GNOME fallback', async () => {
    const f = fixture();
    const run = f.start(() => {f.release(); f.replace({[MIME]: 'GNOME saved copy'}, true);});
    await settle(); f.timeout();
    await assert.rejects(run, /Could not capture/);
    assert.equal(text(f), 'GNOME saved copy'); f.clean();
});

for (const initial of [{[MIME]:'ubaida'}, {}, {'image/png':new Uint8Array([137,80])}]) {
    test('replacement restores the clipboard after the paste window', async () => {
        const f=fixture(initial);const before=f.data();
        await f.paste(async owned=>{assert(owned());assert.equal(text(f),'Corrected output');});
        if (Object.keys(initial).length) assert.deepEqual(f.data(),before);
        else assert.equal(text(f),'');
        f.clean();
    });
}
test('replacement never restores over a new user copy', async () => {
    const f=fixture();
    await f.paste(async owned=>{f.replace({[MIME]:'New user copy'});assert.equal(owned(),false);}).catch(()=>{});
    assert.equal(text(f),'New user copy');f.clean();
});
test('disable during replacement restores the original and releases pending work', async () => {
    const f=fixture();const run=f.paste(async()=>{f.capture.destroy();});
    await assert.rejects(run,/cancel|Could not capture/i);
    assert.equal(text(f),'Original clipboard');f.clean();
});

test('Firefox image cache preserves pixels when the advertised image stream later becomes empty', async () => {
    const f=fixture();f.watch();
    const png=new Uint8Array([137,80,78,71,13,10]);
    f.replace({'image/png':png,'text/html':'<img>'});await settle();
    f.emptyPayload('image/png');
    assert.equal(await f.start(undefined,false),'Selected text');
    assert.deepEqual(f.data().get('image/png'),png);
    f.capture.destroy();await settle();f.clean();
});
test('a newer clipboard entry invalidates the image cache', async () => {
    const f=fixture();f.watch();f.replace({'image/png':new Uint8Array([137])});await settle();
    f.replace({[MIME]:'New clipboard text'});
    assert.equal(await f.start(),'Selected text');
    assert.equal(text(f),'New clipboard text');f.capture.destroy();await settle();f.clean();
});
test('disabling preservation discards cached images and stops background reads', async () => {
    const f=fixture();f.watch();f.replace({'image/png':new Uint8Array([137])});await settle();
    f.cacheEnabled(false);assert.equal(f.capture._cachedImage,null);
    const reads=f.limits.length;f.replace({'image/png':new Uint8Array([138])});await settle();
    assert.equal(f.limits.length,reads);f.capture.destroy();f.clean();
});
test('destroy cancels a stalled image cache read and removes its signal and timeout', async () => {
    const f=fixture();f.watch();f.hold(1);f.replace({'image/png':new Uint8Array([137])});
    f.capture.destroy();await settle();f.clean();
    assert(f.streams.every(stream=>stream.closed));
    f.pending.shift()();await settle();f.clean();
});
test('empty image payloads are never restored as valid images', async () => {
    const f=fixture({'image/png':new Uint8Array()});
    await assert.rejects(f.start(),/could not be read safely/);assert.equal(f.copies(),0);f.clean();
});
