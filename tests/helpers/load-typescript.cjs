const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real TypeScript module with explicit I/O adapters. No source-text
// assertions: tests below exercise the exported production functions.
exports.loadTypeScript = function loadTypeScript(filename, mocks = {}, cache = new Map()) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  }));
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
    if (id.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      if (resolved) return loadTypeScript(resolved, mocks, cache);
    }
    return require(id);
  };
  const compiled = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${result.outputText}\n})`, { filename });
  compiled(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
};
