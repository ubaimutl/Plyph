const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

function loadI18n(context, root) {
    if (context._) return;
    context.Gettext = {dgettext: (_domain, message) => message,
        dngettext: (_domain, singular, plural, count) => count === 1 ? singular : plural};
    const source = readFileSync(resolve(root, 'i18n.js'), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => {${source}\nObject.assign(globalThis, {_, N_, ngettext, format});})();`, context);
}

function loadShellModules(context, root) {
    loadI18n(context, root);
    for (const name of ['clipboard', 'dialogs', 'actionPalette', 'floatingToolbar', 'selectionCapture']) {
        const file = resolve(root, 'shell', `${name}.js`);
        const source = readFileSync(file, 'utf8');
        const exports = [...source.matchAll(/^export (?:const|function|class) (\w+)/gm)].map(match => match[1]);
        const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
        vm.runInContext(`(() => {\n${body}\nObject.assign(globalThis, {${exports.join(', ')}});\n})();`, context, {filename: file});
    }
}

function loadProviders(context, root) {
    loadI18n(context, root);
    for (const file of ['actions.js', 'providers.js']) {
        const source = readFileSync(resolve(root, file), 'utf8');
        const exports = [...source.matchAll(/^export (?:async )?(?:const|function|class) (\w+)/gm)].map(match => match[1]);
        const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
        vm.runInContext(`(() => {\n${body}\nObject.assign(globalThis, {${exports.join(', ')}});\n})();`, context);
    }
}

module.exports = {loadShellModules, loadProviders, loadI18n};
