import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    target: ['es2022', 'node22'],
    platform: 'node',
    external: [
      '@myko/errors',
      '@myko/logger',
      '@myko/types',
      '@myko/config',
      '@supabase/supabase-js',
      '@nestjs/common',
      'ioredis',
      'pg',
      'pino',
      'drizzle-orm',
      'sanitize-html',
    ],
    splitting: false,
    minify: false,
    treeshake: true,
    keepNames: true,
    esbuildOptions(opts, context) {
      opts.charset = 'utf8';
      if (context.format === 'esm') {
        opts.packages = 'external';
      }
    },
  },

]);
