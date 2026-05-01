import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    rollupOptions: {
      external: [
        'electron',
        '@electron/remote',
        /^node:/,
        /^@seald-io/,
        /^@parry-gg/,
        'bonjour',
        'express',
        'express-ws',
        'mana-font',
        'obs-websocket-js',
        'rxjs',
        'ws',
        'fs-extra',
        'path',
        'fs',
        'os',
        'child_process',
        'google-protobuf',
        'grpc-web',
        'object-watcher',
      ],
    },
  },
});
