const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {test} = require('node:test');

test('native preferences migrate memory settings and add, rename and delete providers', {
    skip: process.env.PLYPH_NATIVE_SHELL_TEST !== '1', timeout: 60000,
}, () => {
    const root = resolve(__dirname, '..');
    const temporary = mkdtempSync(join(tmpdir(), 'plyph-native-prefs-'));
    try {
        for (const directory of ['source', 'schemas', 'data', 'config', 'cache', 'runtime'])
            mkdirSync(join(temporary, directory), {mode: 0o700});
        for (const file of readdirSync(root).filter(name => name.endsWith('.js')))
            cpSync(join(root, file), join(temporary, 'source', file));
        writeFileSync(join(temporary, 'source/secrets.js'), `
import {migrateProviders, removeProvider} from './providers.js';
const keys = new Map();
export async function getApiKey(_settings, id) { return keys.get(id) ?? ''; }
export async function setApiKey(_settings, id, value) { keys.set(id, value); }
export async function deleteProvider(settings, id) { removeProvider(settings, id); keys.delete(id); }
export async function migrateProviderSettings(settings) { migrateProviders(settings, [...keys.keys()], true); }
`);
        cpSync(join(root, 'schemas/org.gnome.shell.extensions.ai-autocorrect.gschema.xml'), join(temporary, 'schemas/org.gnome.shell.extensions.ai-autocorrect.gschema.xml'));
        execFileSync('glib-compile-schemas', ['--strict', join(temporary, 'schemas')]);
        const log = join(temporary, 'result.log');
        try {
            writeFileSync(log, execFileSync('dbus-run-session', ['--', 'xvfb-run', '-a', 'gjs', '-m',
                join(__dirname, 'native/providers.mjs')], {
                env: {...process.env, GI_TYPELIB_PATH: '/usr/lib64/gnome-shell/girepository-1.0:/usr/lib/gnome-shell/girepository-1.0',
                    LD_LIBRARY_PATH: '/usr/lib64/gnome-shell:/usr/lib/gnome-shell', ADW_DISABLE_PORTAL: '1',
                    GTK_A11Y: 'none', GIO_USE_VFS: 'local', GSETTINGS_BACKEND: 'memory',
                    XDG_DATA_HOME: join(temporary, 'data'), XDG_CONFIG_HOME: join(temporary, 'config'),
                    XDG_CACHE_HOME: join(temporary, 'cache'), XDG_RUNTIME_DIR: join(temporary, 'runtime'),
                    PLYPH_TEST_SOURCE: join(temporary, 'source'), PLYPH_TEST_SCHEMA: join(temporary, 'schemas')},
                timeout: 50000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            }));
        } catch (error) {
            assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
        }
        assert.match(readFileSync(log, 'utf8'), /ALL PROVIDER UI CHECKS PASSED/);
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});
