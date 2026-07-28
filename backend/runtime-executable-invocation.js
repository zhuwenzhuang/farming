function runtimeExecutableInvocation(
  executablePath,
  args = [],
  env = process.env,
  platform = process.platform,
) {
  if (
    platform === 'linux'
    && env.FARMING_NODE_LD
    && env.FARMING_NODE_LIBRARY_PATH
  ) {
    return {
      command: env.FARMING_NODE_LD,
      args: ['--library-path', env.FARMING_NODE_LIBRARY_PATH, executablePath, ...args],
    };
  }
  return { command: executablePath, args };
}

module.exports = { runtimeExecutableInvocation };
