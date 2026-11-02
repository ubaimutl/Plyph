const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {test} = require('node:test');

test('native Shell clipboard, text selection, divider dragging and Ask validation', {
    skip: process.env.PLYPH_NATIVE_SHELL_TEST !== '1', timeout: 60000,
}, async () => {
    const root = resolve(__dirname, '..');
    const version = execFileSync('gnome-shell', ['--version'], {encoding: 'utf8'}).match(/\d+/)[0];
    const temporary = mkdtempSync(join(tmpdir(), 'plyph-native-'));
    try {
        const extension = join(temporary, 'data/gnome-shell/extensions/plyph-native@local');
        mkdirSync(extension, {recursive: true});
        for (const directory of ['config', 'cache', 'runtime'])
            mkdirSync(join(temporary, directory), {mode: 0o700});
        for (const file of readdirSync(root).filter(name => name.endsWith('.js') && name !== 'extension.js'))
            cpSync(join(root, file), join(extension, file));
        cpSync(join(root, 'icons'), join(extension, 'icons'), {recursive: true});
        cpSync(join(root, 'shell'), join(extension, 'shell'), {recursive: true});
        cpSync(join(root, 'stylesheet.css'), join(extension, 'stylesheet.css'));
        writeFileSync(join(extension, 'metadata.json'), JSON.stringify({
            uuid: 'plyph-native@local', name: 'Plyph native test',
            description: 'Isolated test harness', 'shell-version': [version],
        }));
        writeFileSync(join(extension, 'subject.js'), readFileSync(join(root, 'extension.js'), 'utf8'));
        cpSync(join(__dirname, 'native/extension.js'), join(extension, 'extension.js'));
        const script = join(temporary, 'run.sh');
        const log = join(temporary, 'shell.log');
        writeFileSync(script, `
set -eu
gsettings set org.gnome.shell enabled-extensions "['plyph-native@local']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '${version}'
gsettings set org.gnome.desktop.interface enable-animations false
exec gnome-shell --headless --wayland --no-x11 --virtual-monitor=1280x1024 >"$PLYPH_NATIVE_LOG" 2>&1
`);
        execFileSync('dbus-run-session', ['--', 'sh', script], {
            env: {...process.env, XDG_DATA_HOME: join(temporary, 'data'),
                XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache'),
                XDG_RUNTIME_DIR: join(temporary, 'runtime'), GSETTINGS_BACKEND: 'keyfile',
                GNOME_SHELL_SESSION_MODE: 'user', LIBGL_ALWAYS_SOFTWARE: '1', PLYPH_NATIVE_LOG: log},
            timeout: 45000, stdio: 'ignore',
        });
        const output = readFileSync(log, 'utf8');
        assert.doesNotMatch(output, /PLYPH-NATIVE: FAIL|already disposed/, output.slice(-5000));
        assert.match(output, /PLYPH-NATIVE: ALL CHECKS PASSED/, output.slice(-5000));
    } finally {
        for (let attempt = 0; ; attempt++) {
            try {
                rmSync(temporary, {recursive: true, force: true, maxRetries: 2, retryDelay: 100});
                break;
            } catch (error) {
                if (attempt >= 9) throw error;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
    }
});
