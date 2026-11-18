import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {_} from '../i18n.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FORMATS = 32;
const TEXT_FORMATS = ['text/plain;charset=utf-8', 'text/plain;charset=UTF-8', 'UTF8_STRING', 'text/plain'];
const TEXT_ALIASES = new Set([...TEXT_FORMATS, 'TEXT', 'STRING', 'COMPOUND_TEXT']);
const SINGLE_FORMATS = new Set([...TEXT_ALIASES, 'image/png', 'image/jpeg', 'image/gif',
    'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml', 'text/uri-list', 'x-special/gnome-copied-files']);
const IMAGE_FORMATS = ['image/png', 'image/svg+xml', 'image/tiff', 'image/bmp', 'image/webp', 'image/gif', 'image/jpeg'];
const PROTOCOL_FORMATS = new Set(['TARGETS', 'TIMESTAMP', 'MULTIPLE', 'SAVE_TARGETS']);

export class SelectionCapture {
    constructor() {
        this._active = null;
        this._destroyed = false;
    }

    watchImages(selection, enabled) {
        this._imageWatch = {selection, enabled, pending: null};
        this._imageWatch.signal = selection.connect('owner-changed', (_selection, type, source) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                return;
            this.clearImageCache();
            if (!enabled() || !source)
                return;
            const formats = this._formats(selection);
            if (formats.length > MAX_FORMATS)
                return;
            const images = IMAGE_FORMATS.filter(type => formats.includes(type));
            if (!images.length)
                return;
            const state = {selection, cancellable: new Gio.Cancellable(),
                isCurrent: () => !this._destroyed && enabled() && source.is_active()};
            state.failure = new Promise((_resolve, reject) => {state.reject = reject;});
            state.failure.catch(() => {});
            this._imageWatch.pending = state;
            state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                state.timer = null;
                state.cancellable.cancel();
                state.reject(this._cancelled());
                return GLib.SOURCE_REMOVE;
            });
            state.ready = (async () => {
                try {
                    for (const mime of images) {
                        try {
                            const bytes = await this._read(state, mime);
                            this._check(state);
                            if (bytes.get_size() > 0 && this._imageWatch?.pending === state) {
                                this._cachedImage = {source, kind: 'binary', mime, bytes};
                                return;
                            }
                        } catch (_error) {
                            if (state.cancellable.is_cancelled())
                                return;
                        }
                    }
                } finally {
                    if (state.timer)
                        GLib.Source.remove(state.timer);
                    state.timer = null;
                    if (this._imageWatch?.pending === state)
                        this._imageWatch.pending = null;
                }
            })();
        });
    }

    clearImageCache() {
        this._cachedImage = null;
        const state = this._imageWatch?.pending;
        if (state) {
            this._imageWatch.pending = null;
            state.cancellable.cancel();
            state.reject(this._cancelled());
            if (state.timer)
                GLib.Source.remove(state.timer);
            state.timer = null;
        }
    }

    async capture({selection, clipboard, copy, isCurrent, strict = true, preserve = true}) {
        if (this._destroyed)
            throw this._cancelled();
        if (this._active)
            throw new Error(_('A selection capture is already in progress. Try again.'));
        const state = {selection, clipboard, isCurrent, cancellable: new Gio.Cancellable(),
            phase: 'snapshot', changes: 0, armed: false, source: null, snapshot: null, cleaned: false};
        this._active = state;
        state.failure = new Promise((_resolve, reject) => {
            state.reject = reject;
        });
        state.failure.catch(() => {});
        const owner = new Promise(resolve => {
            state.resolve = resolve;
        });
        state.signal = selection.connect('owner-changed', (_selection, type, source) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                return;
            if (state.armed && !state.source) {
                if (!source) {
                    state.awaitingOffer = true;
                    return;
                }
                if (state.awaitingOffer && Meta.SelectionSourceMemory && source instanceof Meta.SelectionSourceMemory)
                    return;
            }
            state.changes++;
            if (!state.armed || state.changes !== 1 || !source || !isCurrent()) {
                state.cancellable.cancel();
                state.reject(new Error(_('Could not capture selected text. Select it and try again.')));
                return;
            }
            state.source = source;
            state.resolve();
        });
        state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            state.timer = null;
            state.timedOut = true;
            state.cancellable.cancel();
            state.reject(new Error(_('Could not capture selected text. Select it and try again.')));
            return GLib.SOURCE_REMOVE;
        });
        try {
            this._check(state);
            try {
                if (preserve)
                    state.snapshot = await this._snapshot(state, strict);
            } catch (error) {
                this._check(state);
                if (strict)
                    throw error;
            }
            this._check(state);
            state.phase = 'copy';
            state.armed = true;
            copy();
            await Promise.race([owner, state.failure]);
            this._check(state);
            const formats = this._formats(selection);
            const mime = TEXT_FORMATS.find(type => formats.includes(type));
            if (!mime)
                throw new Error(_('Could not capture selected text. Select it and try again.'));
            state.phase = 'read-selection';
            const bytes = await this._read(state, mime);
            this._check(state);
            const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.get_data());
            if (!text.trim())
                throw new Error(_('Could not capture selected text. Select it and try again.'));
            return text;
        } catch (error) {
            if (!this._destroyed)
                console.warn(`Plyph capture failed: phase=${state.phase}, owner-changes=${state.changes}, timed-out=${Boolean(state.timedOut)}, focus-current=${Boolean(state.isCurrent())}`);
            if (state.timedOut)
                throw new Error(_('Could not capture selected text. Select it and try again.'));
            throw error;
        } finally {
            this._cleanup(state);
        }
    }

    async paste({selection, clipboard, text, run, isCurrent, strict = false}) {
        if (this._destroyed)
            throw this._cancelled();
        if (this._active)
            throw new Error(_('A selection capture is already in progress. Try again.'));
        const state = {selection, clipboard, isCurrent, cancellable: new Gio.Cancellable(),
            changes: 0, source: null, snapshot: null, cleaned: false};
        this._active = state;
        state.failure = new Promise((_resolve, reject) => {state.reject = reject;});
        state.failure.catch(() => {});
        state.signal = selection.connect('owner-changed', (_selection, type, source) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                return;
            state.changes++;
            if (state.armed && state.changes === 1 && source)
                state.source = source;
            else {
                state.cancellable.cancel();
                state.reject(this._cancelled());
            }
        });
        state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            state.timer = null;
            state.cancellable.cancel();
            state.reject(new Error(_('The clipboard could not be read safely. Try again.')));
            return GLib.SOURCE_REMOVE;
        });
        try {
            try {
                state.snapshot = await this._snapshot(state, strict);
            } catch (error) {
                this._check(state);
                if (strict)
                    throw error;
            }
            this._check(state);
            if (state.timer)
                GLib.Source.remove(state.timer);
            state.timer = null;
            state.armed = true;
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            const owned = () => !state.cleaned && state.changes === 1 && Boolean(state.source?.is_active()) && isCurrent();
            await Promise.race([run(owned), state.failure]);
        } finally {
            this._cleanup(state);
        }
    }

    _formats(selection) {
        return [...new Set(selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [])]
            .filter(type => !PROTOCOL_FORMATS.has(type));
    }

    async _snapshot(state, strict) {
        const formats = this._formats(state.selection);
        if (!formats.length)
            return {kind: 'empty'};
        if (formats.length > MAX_FORMATS)
            throw new Error(_('The clipboard has too many formats to preserve safely. Copy your selection manually and try again.'));
        const text = TEXT_FORMATS.find(type => formats.includes(type));
        if (strict && formats.length > 1 && formats.some(type => !TEXT_ALIASES.has(type)))
            throw new Error(_('The clipboard contains multiple formats Plyph cannot preserve safely. Copy your selection manually and try again.'));
        const images = IMAGE_FORMATS.filter(type => formats.includes(type));
        if (images.length) {
            const pending = this._imageWatch?.pending;
            if (pending)
                await Promise.race([pending.ready, state.failure]);
            this._check(state);
            const cached = this._cachedImage;
            if (cached && cached.source.is_active() && formats.includes(cached.mime))
                return cached;
            let error;
            for (const mime of images) {
                try {
                    const bytes = await this._read(state, mime);
                    this._check(state);
                    if (bytes.get_size() > 0)
                        return {kind: 'binary', mime, bytes};
                } catch (failure) {
                    this._check(state);
                    error = failure;
                }
            }
            throw error ?? new Error(_('The clipboard could not be read safely. Try again.'));
        }
        const mime = text ?? formats.find(type => SINGLE_FORMATS.has(type));
        if (!mime)
            throw new Error(_('The clipboard format cannot be preserved safely. Copy your selection manually and try again.'));
        return {kind: 'binary', mime, bytes: await this._read(state, mime)};
    }

    async _read(state, mime) {
        const stream = Gio.MemoryOutputStream.new_resizable();
        const transfer = new Promise((resolve, reject) => {
            state.selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD, mime,
                MAX_BYTES + 1, stream, state.cancellable, (_selection, result) => {
                    try {
                        if (!state.selection.transfer_finish(result))
                            throw new Error(_('The clipboard could not be read safely. Try again.'));
                        stream.close(null);
                        const bytes = stream.steal_as_bytes();
                        if (bytes.get_size() > MAX_BYTES)
                            throw new Error(_('The clipboard is too large to preserve safely. Copy your selection manually and try again.'));
                        resolve(bytes);
                    } catch (error) {
                        reject(error);
                    } finally {
                        if (!stream.is_closed())
                            stream.close(null);
                    }
                });
        });
        try {
            return await Promise.race([transfer, state.failure]);
        } finally {
            if (!stream.is_closed())
                stream.close(null);
        }
    }

    _check(state) {
        if (state.cleaned || this._destroyed)
            throw this._cancelled();
        if (state.cancellable.is_cancelled() || !state.isCurrent())
            throw new Error(_('Could not capture selected text. Select it and try again.'));
    }

    _cancelled() {
        return new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, _('Selection capture cancelled.'));
    }

    _cleanup(state) {
        if (state.cleaned)
            return;
        state.cleaned = true;
        state.cancellable.cancel();
        if (state.timer)
            GLib.Source.remove(state.timer);
        state.timer = null;
        if (state.signal)
            state.selection.disconnect(state.signal);
        state.signal = null;
        if (this._active === state)
            this._active = null;
        const snapshot = state.snapshot;
        try {
            if (snapshot && state.source && state.changes === 1 && state.source.is_active()) {
                if (snapshot.kind === 'empty')
                    state.clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
                else
                    state.clipboard.set_content(St.ClipboardType.CLIPBOARD, snapshot.mime, snapshot.bytes);
            }
        } finally {
            state.snapshot = null;
            state.source = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this.clearImageCache();
        if (this._imageWatch) {
            this._imageWatch.selection.disconnect(this._imageWatch.signal);
            this._imageWatch = null;
        }
        if (this._active) {
            const state = this._active;
            state.reject(this._cancelled());
            this._cleanup(state);
        }
    }
}
