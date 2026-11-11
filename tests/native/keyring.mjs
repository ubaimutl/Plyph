import System from 'system';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
const root = GLib.getenv('PLYPH_TEST_ROOT');
const {getApiKey, setApiKey, migrateProviderSettings, saveProviderConnection, getProviderHeaders} = await import(GLib.filename_to_uri(`${root}/secrets.js`, null));
const {readProviders} = await import(GLib.filename_to_uri(`${root}/providers.js`, null));
const source = Gio.SettingsSchemaSource.new_from_directory(GLib.getenv('PLYPH_TEST_SCHEMA'), Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.ai-autocorrect', false)});
function assert(value, message) {if (!value) throw new Error(message); print(`PASS ${message}`);}
if (GLib.getenv('PLYPH_KEYRING_PHASE') === 'seed') {
    await setApiKey(settings, 'openai', 'private-keyring-test-value');
    assert(await getApiKey(settings, 'openai', null, true) === 'private-keyring-test-value', 'real Secret Service stores and retrieves a provider key');
    const advanced = {id: 'custom:real-headers', name: 'Secure headers', url: 'https://example.com/v1', model: 'm'};
    await saveProviderConnection(settings, advanced,
        {apiKey: 'private-advanced-key', headers: {'X-Private-Key': 'private-header-value'}}, new Gio.Cancellable());
    const saved = readProviders(settings).find(profile => profile.id === advanced.id);
    assert((await getProviderHeaders(saved, null, true))['X-Private-Key'] === 'private-header-value',
        'real keyring stores and retrieves custom authentication headers');
    assert(!settings.get_string('custom-providers').includes('private-header-value'), 'custom header values never enter GSettings');
    Gio.Settings.sync();
    System.exit(0);
}
const service = await new Promise((resolve, reject) => Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null, (_s, result) => {
    try {resolve(Secret.Service.get_finish(result));} catch(error) {reject(error);}
}));
const collection = await new Promise((resolve, reject) => Secret.Collection.for_alias(service, Secret.COLLECTION_DEFAULT, Secret.CollectionFlags.NONE, null, (_s, result) => {
    try {resolve(Secret.Collection.for_alias_finish(result));} catch(error) {reject(error);}
}));
await new Promise((resolve, reject) => service.lock([collection], null, (_s, result) => {
    try {resolve(service.lock_finish(result));} catch(error) {reject(error);}
}));
let locked = false;
try {await getApiKey(settings, 'openai');} catch(error) {locked = error.message.includes('saved API key is locked');}
assert(locked, 'locked key is reported as locked instead of missing');
await migrateProviderSettings(settings, new Gio.Cancellable());
assert(settings.get_int('provider-migration-version') === 0, 'migration stays retryable while a freshly locked collection hides its saved items');
const input = Gio.Subprocess.new(['sh', '-c', `
for attempt in $(seq 1 100); do
    window=$(xdotool search --onlyvisible --name 'Unlock.*[Kk]eyring' 2>/dev/null | head -n 1)
    if [ -n "$window" ]; then
        sleep 0.5
        xdotool windowfocus --sync "$window"
        xdotool type --clearmodifiers --delay 5 'plyph-private-test-password'
        xdotool key --clearmodifiers Return
        exit 0
    fi
    sleep 0.1
done
exit 1
`], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
const unlockedKey = await getApiKey(settings, 'openai', null, true);
await new Promise((resolve, reject) => input.wait_check_async(null, (_s, result) => {
    try {resolve(input.wait_check_finish(result));} catch(error) {reject(error);}
}));
assert(unlockedKey === 'private-keyring-test-value', 'an actual unlock prompt retrieves the original key after daemon restart without opening Settings or saving a new provider');
await migrateProviderSettings(settings, new Gio.Cancellable());
assert(readProviders(settings).some(p => p.id === 'openai'), 'migration discovers the original key after unlocking');
await new Promise((resolve, reject) => service.lock([collection], null, (_s, result) => {
    try {resolve(service.lock_finish(result));} catch(error) {reject(error);}
}));
const cancellable = new Gio.Cancellable();
let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {timer = 0; cancellable.cancel(); return GLib.SOURCE_REMOVE;});
let unlockFailed = false;
try {await getApiKey(settings, 'openai', cancellable, true);} catch(error) {
    unlockFailed = error.message.includes('Unlock Passwords and Keys') ||
        (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
} finally {if (timer) GLib.Source.remove(timer);}
assert(unlockFailed, 'canceling or declining the real unlock request never returns an empty API key');
print('ALL REAL KEYRING CHECKS PASSED');
