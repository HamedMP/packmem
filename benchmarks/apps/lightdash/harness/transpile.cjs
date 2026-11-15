// Transpile one backend file the way Lightdash's build does (packages/backend/tsconfig.json: isolatedModules, so a
// file compiles on its own; module resolution does not change a single file's output). setup.sh first checks that the unpatched file comes out as the image's copy.
// usage: node transpile.cjs <in.ts> <out.js>
const ts = require("typescript");
const fs = require("fs");

const [src, out] = process.argv.slice(2);
const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(src, "utf8"), {
  fileName: src,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    importHelpers: true,
    isolatedModules: true,
    experimentalDecorators: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.React,
    jsxFactory: "xmlBuilder",
    noImplicitAny: true,
    useUnknownInCatchVariables: true,
  },
});
if (diagnostics.length) {
  for (const d of diagnostics) console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  process.exit(1);
}
fs.writeFileSync(out, outputText);
