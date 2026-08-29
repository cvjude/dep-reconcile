import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import type { ImportSite } from "../types.js";
import { listSourceFiles, pkgNameFromSpecifier } from "../util.js";

// @babel/traverse ships as CJS; the callable lives on `.default` under ESM interop.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

function parseFile(code: string) {
  return parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: ["typescript", "jsx", "decorators-legacy", "importAttributes"],
  });
}

/**
 * Statically scan every source file in a project and record each reference to
 * an external package: static imports, require(), dynamic import(), re-exports,
 * and type-only imports. The `style` is preserved because it changes how the
 * agent should judge a candidate (a type-only import of @types/x, a dynamic
 * require of a computed path, etc.).
 */
export function scanImports(projectDir: string): ImportSite[] {
  const sites: ImportSite[] = [];
  const push = (pkg: string | null, file: string, line: number, style: ImportSite["style"]) => {
    if (pkg) sites.push({ pkg, file, line, style });
  };

  for (const file of listSourceFiles(projectDir)) {
    let ast: ReturnType<typeof parseFile>;
    try {
      ast = parseFile(readFileSync(file, "utf8"));
    } catch {
      continue; // unparseable file — skip rather than fail the whole run
    }
    const rel = file.slice(projectDir.length + 1);

    traverse(ast, {
      ImportDeclaration(path) {
        const line = path.node.loc?.start.line ?? 0;
        const isType = path.node.importKind === "type";
        push(pkgNameFromSpecifier(path.node.source.value), rel, line, isType ? "import-type" : "import");
      },
      ExportNamedDeclaration(path) {
        if (path.node.source) {
          push(pkgNameFromSpecifier(path.node.source.value), rel, path.node.loc?.start.line ?? 0, "export-from");
        }
      },
      ExportAllDeclaration(path) {
        push(pkgNameFromSpecifier(path.node.source.value), rel, path.node.loc?.start.line ?? 0, "export-from");
      },
      CallExpression(path) {
        const callee = path.node.callee;
        const arg = path.node.arguments[0];
        const line = path.node.loc?.start.line ?? 0;
        // require("pkg")
        if (callee.type === "Identifier" && callee.name === "require") {
          if (arg && arg.type === "StringLiteral") {
            push(pkgNameFromSpecifier(arg.value), rel, line, "require");
          }
        }
        // import("pkg")
        if (callee.type === "Import") {
          if (arg && arg.type === "StringLiteral") {
            push(pkgNameFromSpecifier(arg.value), rel, line, "dynamic-import");
          }
        }
      },
    });
  }
  return sites;
}
