/* Execute real TypeScript modules with explicit infrastructure doubles.
 * Uses the project's existing TypeScript dependency; no extra test framework.
 * This is unit/model verification, NOT a PostgreSQL/Redis/browser integration test.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { builtinModules, createRequire } = require('node:module');
const ts = require('typescript');
function createSourceLoader(root, mocks = {}, globals = {}) {
  const cache = new Map();
  const replacements = new Map(Object.entries(mocks).map(([key, value]) => [key.startsWith('src/') ? path.resolve(root, key).replace(/\.(tsx?|jsx?)$/, '') : key, value]));
  function load(name, parent = path.join(root, '__entry__.ts')) {
    let resolved = name.startsWith('@/') ? path.resolve(root, name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(parent), name) : name.startsWith('src/') ? path.resolve(root, name) : name;
    const key = resolved.replace(/\.(tsx?|jsx?)$/, '');
    if (replacements.has(key)) return replacements.get(key);
    if (replacements.has(name)) return replacements.get(name);
    if (builtinModules.includes(name) || name.startsWith('node:')) return require(name);
    if (!path.isAbsolute(resolved)) return createRequire(parent)(name);
    if (!fs.existsSync(resolved)) resolved = [resolved + '.ts', resolved + '.tsx', path.join(resolved, 'index.ts')].find(fs.existsSync);
    if (!resolved) throw new Error(`Unresolved source dependency ${name} from ${parent}; add an explicit fixture.`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} }; cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), { fileName: resolved,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
    const syntaxErrors = (output.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
    if (syntaxErrors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(syntaxErrors, { getCurrentDirectory: () => root, getCanonicalFileName: p => p, getNewLine: () => '\n' }));
    const names = Object.keys(globals);
    const factory = new vm.Script(`(function(require,module,exports,__filename,__dirname,${names.join(',')}){\n${output.outputText}\n})`, { filename: resolved }).runInThisContext();
    factory(n => load(n, resolved), module, module.exports, resolved, path.dirname(resolved), ...Object.values(globals));
    return module.exports;
  }
  return load;
}
module.exports = { createSourceLoader };
