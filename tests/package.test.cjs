const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {mkdtempSync, readFileSync, readdirSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {test} = require('node:test');

const root = resolve(__dirname, '..');
const modules = ['extension.js', 'prefs.js', 'actions.js', 'ai.js', 'models.js', 'secrets.js'];
const schema = 'org.gnome.shell.extensions.ai-autocorrect.gschema.xml';
const metadata = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));

test('all shipped JavaScript modules parse', () => {
    for (const file of modules)
        execFileSync(process.execPath, ['--input-type=module', '--check'], {
            input: readFileSync(join(root, file)), stdio: ['pipe', 'pipe', 'pipe'],
        });
});

test('GSettings schema passes strict validation', () => {
    execFileSync('glib-compile-schemas', ['--strict', '--dry-run', join(root, 'schemas')]);
});

test('upload bundle contains current sources, imports, icons and compilable settings', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'plyph-package-'));
    try {
        execFileSync('gnome-extensions', [
            'pack', '--force', `--out-dir=${temporary}`,
            ...['actions.js', 'ai.js', 'models.js', 'secrets.js', 'stylesheet.css', 'icons', 'LICENSE']
                .map(file => `--extra-source=${file}`),
            `--schema=schemas/${schema}`, root,
        ], {cwd: root});
        const bundle = join(temporary, `${metadata.uuid}.shell-extension.zip`);
        const entries = execFileSync('unzip', ['-Z1', bundle], {encoding: 'utf8'})
            .trim().split('\n').filter(file => !file.endsWith('/'));
        const expected = [
            ...modules, 'metadata.json', 'stylesheet.css', 'LICENSE',
            `schemas/${schema}`,
            ...readdirSync(join(root, 'icons')).map(file => `icons/${file}`),
        ];
        assert.deepEqual(entries.filter(file => file !== 'schemas/gschemas.compiled').sort(), expected.sort());
        for (const file of expected) {
            const packed = execFileSync('unzip', ['-p', bundle, file]);
            assert.deepEqual(packed, readFileSync(join(root, file)), `${file} is stale`);
        }
        for (const file of modules) {
            const source = execFileSync('unzip', ['-p', bundle, file], {encoding: 'utf8'});
            for (const [, dependency] of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g))
                assert.ok(entries.includes(dependency), `Missing import ${dependency} from ${file}`);
        }
        const unpacked = join(temporary, 'unpacked');
        execFileSync('unzip', ['-q', bundle, '-d', unpacked]);
        const schemaDirectory = join(unpacked, 'schemas');
        execFileSync('glib-compile-schemas', ['--strict', schemaDirectory]);
        const schemas = execFileSync('gsettings', ['--schemadir', schemaDirectory, 'list-schemas'], {
            encoding: 'utf8', env: {...process.env, GSETTINGS_BACKEND: 'memory'},
        });
        assert.ok(schemas.split('\n').includes(metadata['settings-schema']));
        const scale = execFileSync('gsettings', [
            '--schemadir', schemaDirectory, 'get', metadata['settings-schema'], 'floating-toolbar-scale',
        ], {encoding: 'utf8', env: {...process.env, GSETTINGS_BACKEND: 'memory'}});
        assert.equal(Number(scale), 1);
        const plainText = execFileSync('gsettings', [
            '--schemadir', schemaDirectory, 'get', metadata['settings-schema'], 'prefer-plain-text',
        ], {encoding: 'utf8', env: {...process.env, GSETTINGS_BACKEND: 'memory'}});
        assert.equal(plainText.trim(), 'true', 'Plain text guidance must be enabled for new and existing installs');
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});
