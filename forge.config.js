module.exports = {
  make_targets: {
    win32: ['squirrel', 'zip']
  },
  electronPackagerConfig: {
    packageManager: 'npm',
    asar: true,
    icon: './img/logo.ico'
  },
  electronWinstallerConfig: {
    name: 'MTG Stream Tool',
    setupIcon: './img/logo.ico',
    loadingGif: './img/loading.gif'
  }
}