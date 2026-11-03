'use strict';

function electronEnvironment(source = process.env) {
  const env = { ...source };
  // Electron's Windows entry checks presence, so an empty value still selects
  // Node mode. Windows environment names are case-insensitive. Delete every
  // spelling rather than overwriting one key with an empty string.
  for (const name of Object.keys(env)) {
    if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(name.toUpperCase())) delete env[name];
  }
  return env;
}

module.exports = { electronEnvironment };
