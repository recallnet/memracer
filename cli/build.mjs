import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cjsCreateRequire } from 'node:module';\nconst require = __cjsCreateRequire(import.meta.url);",
  },
});
