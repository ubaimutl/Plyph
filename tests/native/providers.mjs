import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const directory = GLib.getenv('PLYPH_TEST_SOURCE');
const moduleUrl = file => GLib.filename_to_uri(`${directory}/${file}`, null);
const {default: Preferences} = await import(moduleUrl('prefs.js'));
const providers = await import(moduleUrl('providers.js'));
const secrets = await import(moduleUrl('secrets.js'));
Adw.init();
const app = new Adw.Application({application_id: 'dev.ubai.Plyph.ProviderTest', flags: Gio.ApplicationFlags.NON_UNIQUE});
let runPromise;
function assert(value, message) { if (!value) throw new Error(message); print(`PASS ${message}`); }
function widgets(widget, result = []) {
    result.push(widget);
    for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling())
        widgets(child, result);
    return result;
}
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));
async function run() {
    const source = Gio.SettingsSchemaSource.new_from_directory(GLib.getenv('PLYPH_TEST_SCHEMA'), Gio.SettingsSchemaSource.get_default(), false);
    const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.ai-autocorrect', false)});
    settings.set_string('provider', 'openai-compatible');
    settings.set_string('openai-compatible-url', 'http://127.0.0.1:9999/custom/v1');
    settings.set_string('groq-model', 'old-groq-model');
    await secrets.setApiKey(settings, 'openai', 'test-only-key');
    const window = new Adw.PreferencesWindow({application: app});
    const prefs = new Preferences({uuid: 'ai-autocorrect@ubai.dev', name: 'Plyph', path: directory, dir: Gio.File.new_for_path(directory)});
    prefs.getSettings = () => settings;
    assert(settings.get_boolean('show-floating-button'), 'selection toolbar defaults to enabled');
    settings.set_boolean('show-floating-button', false);
    const filling = prefs.fillPreferencesWindow(window);
    assert(Boolean(window.get_visible_page()), 'preferences expose a visible page before asynchronous migration');
    assert(widgets(window).some(w => w instanceof Adw.ComboRow && w.title === 'Active provider'),
        'General settings are populated before asynchronous migration');
    await filling;
    window.present();
    await wait(180);
    assert(!settings.get_boolean('show-floating-button'), 'explicit toolbar opt-out survives startup');
    assert(settings.get_int('provider-migration-version') === 1, 'real GSettings migration completes');
    assert(providers.readProviders(settings).length === 3, 'configured and keyring-only providers imported');
    assert(await secrets.getApiKey(settings, 'openai') === 'test-only-key', 'existing credential ID remains accessible through the test store');
    prefs._editProvider(settings);
    await wait(120);
    const editor = Gtk.Window.get_toplevels().get_item(0) === window ? Gtk.Window.get_toplevels().get_item(1) : Gtk.Window.get_toplevels().get_item(0);
    const all = widgets(editor);
    const field = title => all.find(w => w instanceof Adw.EntryRow && w.title === title);
    assert(Boolean(field('Name')), 'native provider editor opens');
    const presets = all.find(w => w instanceof Adw.ComboRow && w.title === 'Start with');
    const localIndex = providers.PROVIDER_PRESETS.findIndex(p => p.name === 'LM Studio (local)');
    assert(localIndex >= 0, 'LM Studio preset appears in Add provider');
    presets.selected = localIndex + 1;
    assert(field('Name').text === 'LM Studio (local)' && field('Base URL').text === 'http://127.0.0.1:1234/v1',
        'LM Studio preset fills its name and local base URL');
    presets.selected = 0;
    assert(field('Name').text === '' && field('Base URL').text === '', 'Custom connection remains blank');
    field('Name').text = 'Local test provider';
    field('Base URL').text = 'http://localhost:4321/custom/v1';
    const advanced = all.find(w => w instanceof Adw.ExpanderRow && w.title === 'Advanced');
    assert(Boolean(advanced) && !advanced.expanded, 'Advanced controls are collapsed by default');
    advanced.expanded = true;
    field('Temperature (optional)').text = '0.4';
    all.find(w => w instanceof Adw.ComboRow && w.title === 'Reasoning effort').selected = 3;
    const headers = all.find(w => w instanceof Adw.PreferencesRow && w.title === 'Custom headers (JSON)');
    const parameters = all.find(w => w instanceof Adw.PreferencesRow && w.title === 'Extra request parameters (JSON)');
    headers._buffer.set_text('{"X-Test-Key":"native-secret"}', -1);
    parameters._buffer.set_text('{"stream":true}', -1);
    all.find(w => w instanceof Gtk.Button && w.label === 'Save').emit('clicked');
    await wait(80);
    assert(!providers.readProviders(settings).some(p => p.name === 'Local test provider'), 'reserved request fields fail validation before saving');
    parameters._buffer.set_text('{"top_p":0.8}', -1);
    all.find(w => w instanceof Gtk.Button && w.label === 'Save').emit('clicked');
    await wait(180);
    const custom = providers.readProviders(settings).find(p => p.name === 'Local test provider');
    assert(Boolean(custom), 'native Save creates a custom profile');
    assert(prefs._providerChoices.some(p => p.id === custom.id), 'open provider selectors refresh');
    assert(custom.model === '', 'native Save accepts a connection without a model');
    assert(custom.advanced.temperature === 0.4 && custom.advanced.reasoningEffort === 'low' &&
        custom.advanced.parameters.top_p === 0.8, 'native Save persists advanced request controls');
    assert(!settings.get_string('custom-providers').includes('native-secret'), 'custom header values stay out of GSettings');
    assert((await secrets.getProviderHeaders(custom))['X-Test-Key'] === 'native-secret', 'custom headers use the credential store');
    const active = widgets(window).find(w => w instanceof Adw.ComboRow && w.title === 'Active provider');
    active.selected = prefs._providerChoices.findIndex(p => p.id === custom.id);
    await wait(100);
    const modelRow = prefs._modelRow;
    const models = [{id: 'first-model', name: 'First model'}, {id: 'second-model', name: 'Second model'}];
    prefs._cacheModels(settings, custom.id, models);
    prefs._setModelOptions(modelRow, settings, custom.id, models);
    assert(modelRow._modelIds[modelRow.selected] === '', 'model list awaits an explicit choice');
    modelRow.selected = 1;
    assert(providers.providerModel(settings, custom.id) === 'first-model', 'first fetched model can be selected');
    assert(prefs._modelRow === modelRow, 'model selection preserves the model selector');
    modelRow.selected = 2;
    assert(prefs._modelRow === modelRow, 'another model choice keeps the same selector');
    providers.setProviderModel(settings, custom.id, 'external-model');
    assert(prefs._modelRow === modelRow && modelRow._modelIds[modelRow.selected] === 'external-model',
        'external model changes update the existing selector');
    active.selected = prefs._providerChoices.findIndex(p => p.id === 'openai-compatible');

    prefs._editProvider(settings, providers.resolveProvider(settings, custom.id));
    await wait(180);
    const edit = Array.from({length: Gtk.Window.get_toplevels().get_n_items()}, (_, i) => Gtk.Window.get_toplevels().get_item(i)).find(w => w !== window);
    const editWidgets = widgets(edit);
    assert(!editWidgets.find(w => w instanceof Adw.ExpanderRow && w.title === 'Advanced').expanded,
        'existing advanced settings reopen collapsed');
    assert(editWidgets.find(w => w instanceof Adw.EntryRow && w.title === 'Temperature (optional)').text === '0.4',
        'advanced values survive editing and model changes');
    editWidgets.find(w => w instanceof Adw.EntryRow && w.title === 'Name').text = 'Renamed test';
    editWidgets.find(w => w instanceof Gtk.Button && w.label === 'Save').emit('clicked');
    await wait(150);
    assert(providers.resolveProvider(settings, custom.id).name === 'Renamed test', 'native edit keeps stable ID');
    prefs._editProvider(settings, providers.resolveProvider(settings, custom.id));
    await wait(150);
    const deletion = Array.from({length: Gtk.Window.get_toplevels().get_n_items()}, (_, i) => Gtk.Window.get_toplevels().get_item(i)).find(w => w !== window);
    widgets(deletion).find(w => w instanceof Gtk.Button && w.label === 'Delete provider').emit('clicked');
    await wait(100);
    const confirmation = () => Array.from({length: Gtk.Window.get_toplevels().get_n_items()},
        (_, i) => Gtk.Window.get_toplevels().get_item(i)).find(w => w instanceof Adw.MessageDialog);
    assert(Boolean(confirmation()), 'provider deletion requests confirmation');
    widgets(confirmation()).find(w => w instanceof Gtk.Button && w.label === 'Cancel').emit('clicked');
    await wait(100);
    assert(providers.readProviders(settings).some(p => p.id === custom.id), 'canceling deletion preserves the provider');
    widgets(deletion).find(w => w instanceof Gtk.Button && w.label === 'Delete provider').emit('clicked');
    await wait(100);
    widgets(confirmation()).find(w => w instanceof Gtk.Button && w.label === 'Delete').emit('clicked');
    await wait(180);
    assert(!providers.readProviders(settings).some(p => p.id === custom.id), 'native Delete removes unreferenced profile');
    await secrets.setApiKey(settings, 'gemini', 'locked-test-key');
    secrets.setTestLocked(true);
    active.selected = prefs._providerChoices.findIndex(p => p.id === 'gemini');
    await wait(100);
    const password = widgets(window).find(w => w instanceof Adw.PasswordEntryRow && w.title === 'API key');
    assert(Boolean(password) && !password.editable, 'locked credentials cannot be overwritten by an unloaded empty field');
    const unlock = widgets(password).find(w => w instanceof Gtk.Button && w.label === 'Unlock');
    assert(Boolean(unlock) && unlock.visible, 'locked credential row offers an explicit Unlock action');
    unlock.emit('clicked');
    await wait(100);
    assert(password.editable && password.text === 'locked-test-key', 'Unlock restores the saved key for editing');
    window.close();
    await wait(60);
    print('ALL PROVIDER UI CHECKS PASSED');
}
app.connect('activate', () => { runPromise = run(); });
app.register(null);
app.activate();
await runPromise;
