import { defineConfig, searchForWorkspaceRoot } from 'vite';

export default defineConfig({
  // Load .env from the monorepo root (two levels up from packages/frontend/)
  envDir: '../..',
  server: {
    // Headers needed for bb WASM to work in multithreaded mode
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Allow vite to serve WASM files from hoisted node_modules
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        '../../node_modules/@noir-lang/noirc_abi/web',
        '../../node_modules/@noir-lang/acvm_js/web',
      ],
    },
  },
  build: {
    target: 'esnext',
    // Output to dist/ (Vite default)
    outDir: 'dist',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    // Exclude WASM packages from optimization to avoid MIME type issues
    exclude: ['@noir-lang/noirc_abi', '@noir-lang/acvm_js', '@aztec/bb.js'],
  },
  // Ensure WASM files are served with correct MIME type
  assetsInclude: ['**/*.wasm'],
});
