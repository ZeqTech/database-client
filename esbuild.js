const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode", "pg-native"],
    loader: { ".txt": "text" },
    minify: production,
    sourcemap: !production,
    logLevel: "info",
  });
  // sql.js loads its wasm at runtime from next to the bundle.
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(
    path.join("node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join("dist", "sql-wasm.wasm")
  );
  if (watch) await ctx.watch();
  else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
