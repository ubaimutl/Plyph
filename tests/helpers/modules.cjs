const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

function loadShellModules(context, root) {
    for (const name of ['clipboard', 'dialogs', 'actionPalette', 'floatingToolbar']) {
        const file = resolve(root, 'shell', `${name}.js`);
        const source = readFileSync(file, 'utf8');
        const exports = [...source.matchAll(/^export (?:const|function|class) (\w+)/gm)].map(match => match[1]);
        const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
        vm.runInContext(`(() => {\n${body}\nObject.assign(globalThis, {${exports.join(', ')}});\n})();`, context, {filename: file});
    }
}

module.exports = {loadShellModules};
