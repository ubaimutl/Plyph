const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {test} = require('node:test');

test('fresh private keyring restart unlocks and recovers existing credentials without Settings', {
    skip: process.env.PLYPH_NATIVE_SHELL_TEST !== '1', timeout: 35000,
}, () => {
    const root = resolve(__dirname, '..');
    const temporary = mkdtempSync(join(tmpdir(), 'plyph-native-keyring-'));
    try {
        for (const directory of ['schemas', 'data', 'config', 'cache', 'runtime'])
            mkdirSync(join(temporary, directory), {mode: 0o700});
        cpSync(join(root, 'schemas/org.gnome.shell.extensions.ai-autocorrect.gschema.xml'),
            join(temporary, 'schemas/org.gnome.shell.extensions.ai-autocorrect.gschema.xml'));
        execFileSync('glib-compile-schemas', ['--strict', join(temporary, 'schemas')]);
        const runner = join(temporary, 'run.sh');
        writeFileSync(runner, `
set -eu
printf 'plyph-private-test-password' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL"
gnome-keyring-daemon --start --components=secrets --control-directory="$GNOME_KEYRING_CONTROL"
dbus-update-activation-environment DISPLAY XAUTHORITY
PLYPH_KEYRING_PHASE=seed gjs -m "$PLYPH_KEYRING_FIXTURE"
gnome-keyring-daemon --replace --daemonize --components=secrets --control-directory="$GNOME_KEYRING_CONTROL"
timeout 18s gjs -m "$PLYPH_KEYRING_FIXTURE"
`);
        let output;
        try {
            output = execFileSync('xvfb-run', ['-a', 'dbus-run-session', '--', 'sh', runner], {
                env: {...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', GSETTINGS_BACKEND: 'keyfile',
                    XDG_DATA_HOME: join(temporary, 'data'), XDG_CONFIG_HOME: join(temporary, 'config'),
                    XDG_CACHE_HOME: join(temporary, 'cache'), XDG_RUNTIME_DIR: join(temporary, 'runtime'),
                    GNOME_KEYRING_CONTROL: join(temporary, 'runtime/keyring'),
                    PLYPH_TEST_ROOT: root, PLYPH_TEST_SCHEMA: join(temporary, 'schemas'),
                    PLYPH_KEYRING_FIXTURE: join(__dirname, 'native/keyring.mjs')},
                timeout: 25000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
        }
        assert.match(output, /ALL REAL KEYRING CHECKS PASSED/);
    } finally {
        rmSync(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    }
});
