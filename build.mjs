import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const command = process.argv[2] ?? "build";

if (command !== "build") {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: {
    index: path.join(root, "index.ts"),
    "provider-discovery": path.join(root, "provider-discovery.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["openclaw", "openclaw/*"],
  banner: {
    js: 'import { createRequire as __xyCreateRequire } from "node:module"; const require = __xyCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const declarationBuild = spawnSync(
  process.execPath,
  [tsc, "--project", path.join(root, "tsconfig.json"), "--emitDeclarationOnly"],
  { cwd: root, stdio: "inherit" },
);

if (declarationBuild.status !== 0) {
  process.exit(declarationBuild.status ?? 1);
}

for (const directory of ["safe_exec", "script"]) {
  const source = path.join(root, directory);
  if (existsSync(source)) {
    cpSync(source, path.join(dist, directory), { recursive: true, force: true });
  }
}
