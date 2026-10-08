// Bundles everything (MCP SDK included) into one dependency-free file so `npx -y jotbus` starts fast.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/index.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { __VERSION__: JSON.stringify(version) },
});
console.log(`built jotbus ${version}`);
