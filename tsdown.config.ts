import { defineConfig } from 'tsdown'

/**
 * Host build: emit `lib/index.js` so an installed package runs as plain ESM
 * under the DSH Loader. `zod` is ESM and stays external, resolving through the
 * package's own `node_modules`. The plugin has no CommonJS dependency, so DSH
 * HMR re-evaluates ES modules only (`scripts/verify-host-loader.mjs` checks it).
 */
export default defineConfig({
  name: 'dsh-openviking/host',
  entry: { index: 'src/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: ['zod'],
})
