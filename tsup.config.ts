import { defineConfig } from 'tsup';
import { version } from './package.json';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    __CLI_VERSION__: JSON.stringify(version),
  },
});
