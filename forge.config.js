const { VitePlugin } = require('@electron-forge/plugin-vite');

module.exports = {
  packagerConfig: {
    executableName: 'mtg-stream-tool',
    icon: './app/logo.ico',
    ignore: [
      '.gitignore',
      'regions.json',
      'changelog.txt',
      'README.md',
      'scoreboard.json',
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'mtg-stream-tool',
        title: 'MTG Stream Tool',
        setupIcon: './app/logo.ico',
        loadingGif: 'img/loading.gif',
      },
    },
    {
      name: '@electron-forge/maker-zip',
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'app/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};
