function runtimeExecutableInvocation(
  executablePath: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | string = process.platform,
): { command: string; args: string[] } {
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

export { runtimeExecutableInvocation };
