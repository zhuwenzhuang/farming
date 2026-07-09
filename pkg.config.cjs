const entry = process.env.FARMING_PKG_ENTRY || 'backend/farming-code-cli.js';
const workerEntry = process.env.FARMING_PKG_WORKER_ENTRY || '';

module.exports = {
  name: 'farming-code',
  bin: entry,
  pkg: {
    scripts: [
      ...(process.env.FARMING_PKG_ENTRY ? [entry] : ['backend/*.js']),
      ...(workerEntry ? [workerEntry] : []),
    ],
    assets: [
      'dist/**/*',
      'backend/data/**/*.json',
      'frontend/*.js',
      'frontend/skins/**/*',
      'frontend/vendor/**/*',
      'frontend/themes/**/*',
      'node_modules/material-icon-theme/icons/**/*.svg',
      'node_modules/@xterm/xterm/lib/xterm.js',
      'node_modules/@xterm/xterm/css/xterm.css',
      'node_modules/@xterm/addon-fit/lib/addon-fit.js',
      'node_modules/ripgrep/package.json',
      'node_modules/ripgrep/lib/**/*',
      'node_modules/node-pty/lib/**/*.js',
      'node_modules/node-pty/package.json',
      'node_modules/node-pty/prebuilds/**/*',
    ],
    bytecode: true,
    fallbackToSource: false,
  },
};
