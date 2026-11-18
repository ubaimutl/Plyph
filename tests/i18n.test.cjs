const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const vm = require('node:vm');
const {loadI18n} = require('./helpers/modules.cjs');
const root = resolve(__dirname, '..');

test('translated placeholders can reorder values without treating user text as a format string', () => {
    const context = vm.createContext({});
    loadI18n(context, root);
    assert.equal(context.format('%2$s: %1$s (%%)', '50% $&', 'Model'), 'Model: 50% $& (%)');
    assert.equal(context.ngettext('One', 'Many', 1), 'One');
    assert.equal(context.ngettext('One', 'Many', 2), 'Many');
});

test('packaging compiles PO catalogs and real GJS loads translated UI and errors', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'plyph-i18n-'));
    try {
        const po = join(temporary, 'po');
        const output = join(temporary, 'output');
        mkdirSync(po); mkdirSync(output);
        writeFileSync(join(po, 'de.po'), `msgid ""
msgstr ""
"Project-Id-Version: Plyph\\n"
"Report-Msgid-Bugs-To: https://github.com/ubaimutl/Plyph/issues\\n"
"PO-Revision-Date: 2026-11-12 00:00+0000\\n"
"Last-Translator: Plyph tests\\n"
"Language-Team: German\\n"
"Language: de\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "General"
msgstr "Allgemein"

#, javascript-format
msgid "%s could not find model “%s”."
msgstr "Modell %2$s fehlt bei %1$s."

msgid "One item"
msgid_plural "Many items"
msgstr[0] "Ein Element"
msgstr[1] "Mehrere Elemente"
`);
        execFileSync('msgfmt', ['--check', '--check-format', '-o', join(temporary, 'test.mo'), join(po, 'de.po')]);
        execFileSync('gnome-extensions', ['pack', '--force', `--podir=${po}`, `--out-dir=${output}`,
            '--extra-source=i18n.js', root]);
        const uuid = JSON.parse(readFileSync(join(root, 'metadata.json'))).uuid;
        const bundle = join(output, `${uuid}.shell-extension.zip`);
        const entries = execFileSync('unzip', ['-Z1', bundle], {encoding: 'utf8'});
        assert.match(entries, /locale\/de\/LC_MESSAGES\/plyph\.mo/);
        assert.doesNotMatch(entries, /\.po(?:t)?\n/);
        execFileSync('unzip', ['-q', bundle, 'locale/*', '-d', temporary]);
        const script = join(temporary, 'check.mjs');
        writeFileSync(script, `
import Gettext from 'gettext';
import {_, N_, ngettext, format} from ${JSON.stringify(pathToFileURL(join(root, 'i18n.js')).href)};
import {readProviders} from ${JSON.stringify(pathToFileURL(join(root, 'providers.js')).href)};
Gettext.setlocale(Gettext.LocaleCategory.ALL, '');
Gettext.bindtextdomain('plyph', ${JSON.stringify(join(temporary, 'locale'))});
if (_('General') !== 'Allgemein') throw Error('UI did not translate');
if (format(_('%s could not find model “%s”.'), 'Groq', 'm') !== 'Modell m fehlt bei Groq.') throw Error('Reordered placeholders failed');
if (_('No text was returned. Try another instruction.') !== 'No text was returned. Try another instruction.') throw Error('English fallback failed');
if (N_('General') !== 'General') throw Error('Static names were translated');
if (ngettext('One item', 'Many items', 2) !== 'Mehrere Elemente') throw Error('Plural failed');
const raw = JSON.stringify([{id: 'custom:translation-test', name: 'My saved connection', url: 'https://example.com/v1', model: 'm'}]);
const settings = {get_string: () => raw};
if (readProviders(settings)[0].name !== 'My saved connection' || settings.get_string() !== raw) throw Error('Saved names changed');
print('passed');
`);
        const result = execFileSync('gjs', ['-m', script], {
            encoding: 'utf8', env: {...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LANGUAGE: 'de'},
        });
        assert.equal(result.trim(), 'passed');
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});
