const path = require('path');
const { parseCommand } = require('./cli-agents');
const {
  createProviderSessionId,
  createTemporaryProviderSessionId,
  isSafeProviderSessionId,
} = require('./provider-session-id');

const CODING_SESSION_PROVIDERS = new Set(['codex', 'claude', 'opencode', 'qoder']);
const CODEX_VALUE_OPTIONS = new Set([
  '-a',
  '-c',
  '-C',
  '-m',
  '-s',
  '--ask-for-approval',
  '--cd',
  '--config',
  '--config-profile',
  '--model',
  '--profile',
  '--sandbox',
]);

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return CODING_SESSION_PROVIDERS.has(value) ? value : '';
}

function providerForProgram(program) {
  const basename = path.basename(String(program || '').trim());
  if (basename === 'qodercli') return 'qoder';
  return normalizeProvider(basename);
}

function sessionFromExactResumeSource(source) {
  const match = String(source || '').match(/^(codex|claude|opencode|qoder)-history:(?:home:([A-Za-z0-9._-]+):)?([A-Za-z0-9._:-]+)$/);
  if (!match) return null;
  if (!isSafeProviderSessionId(match[3])) return null;
  return {
    provider: match[1],
    providerHomeId: match[2] || 'default',
    sessionId: match[3],
  };
}

function optionTakesValue(option, valueOptions) {
  if (!option || option.includes('=')) return false;
  return valueOptions.has(option);
}

function firstCodexSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg, CODEX_VALUE_OPTIONS)) index += 1;
      continue;
    }
    return { value: arg, index };
  }
  return null;
}

function codexSessionIdAfterSubcommand(args, subcommandIndex) {
  const positional = [];
  for (let index = subcommandIndex + 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg, CODEX_VALUE_OPTIONS)) index += 1;
      continue;
    }
    positional.push(arg);
  }
  const sessionId = positional.at(-1) || '';
  return isSafeProviderSessionId(sessionId) ? sessionId : '';
}

function argValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of names) {
      if (arg === name) return args[index + 1] || '';
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return '';
}

function hasArg(args, names) {
  return args.some(arg => names.includes(arg) || names.some(name => arg.startsWith(`${name}=`)));
}

function codexProviderSessionPlan(rawArgs) {
  const subcommand = firstCodexSubcommand(rawArgs);
  if (subcommand && subcommand.value === 'resume') {
    const sessionId = codexSessionIdAfterSubcommand(rawArgs, subcommand.index);
    if (sessionId) {
      return {
        id: sessionId,
        temporary: false,
        source: 'resume',
      };
    }
  }

  if (subcommand && subcommand.value === 'fork') {
    return {
      id: createTemporaryProviderSessionId(),
      temporary: true,
      source: 'codex-fork-temporary',
      forkedFromProviderSessionId: codexSessionIdAfterSubcommand(rawArgs, subcommand.index),
    };
  }

  if (subcommand && subcommand.value) {
    return null;
  }

  return {
    id: createTemporaryProviderSessionId(),
    temporary: true,
    source: 'codex-temporary',
  };
}

function claudeProviderSessionPlan(rawArgs, launchArgs) {
  const explicitSessionId = argValue(rawArgs, ['--session-id']);
  const resumeSessionId = argValue(rawArgs, ['--resume']);
  const isFork = hasArg(rawArgs, ['--fork-session']);
  const isContinue = hasArg(rawArgs, ['--continue', '-c']);

  if (explicitSessionId && isSafeProviderSessionId(explicitSessionId)) {
    return {
      id: explicitSessionId,
      temporary: false,
      source: 'launch-session-id',
      forkedFromProviderSessionId: isFork && isSafeProviderSessionId(resumeSessionId) ? resumeSessionId : '',
    };
  }

  if (resumeSessionId && isSafeProviderSessionId(resumeSessionId) && !isFork) {
    return {
      id: resumeSessionId,
      temporary: false,
      source: 'resume',
    };
  }

  if (isContinue) {
    return null;
  }

  const sessionId = createProviderSessionId();
  return {
    id: sessionId,
    temporary: false,
    source: isFork ? 'claude-fork-session-id' : 'claude-session-id',
    forkedFromProviderSessionId: isFork && isSafeProviderSessionId(resumeSessionId) ? resumeSessionId : '',
    args: ['--session-id', sessionId, ...launchArgs],
  };
}

function qoderProviderSessionPlan(rawArgs, launchArgs) {
  const explicitSessionId = argValue(rawArgs, ['--session-id']);
  const resumeSessionId = argValue(rawArgs, ['--resume']);
  const isFork = hasArg(rawArgs, ['--fork-session']);
  const isContinue = hasArg(rawArgs, ['--continue']);

  if (explicitSessionId && isSafeProviderSessionId(explicitSessionId)) {
    return {
      id: explicitSessionId,
      temporary: false,
      source: 'launch-session-id',
      forkedFromProviderSessionId: isFork && isSafeProviderSessionId(resumeSessionId) ? resumeSessionId : '',
    };
  }

  if (resumeSessionId && isSafeProviderSessionId(resumeSessionId) && !isFork) {
    return {
      id: resumeSessionId,
      temporary: false,
      source: 'resume',
    };
  }

  if (isContinue) {
    return null;
  }

  const sessionId = createProviderSessionId();
  return {
    id: sessionId,
    temporary: false,
    source: isFork ? 'qoder-fork-session-id' : 'qoder-session-id',
    forkedFromProviderSessionId: isFork && isSafeProviderSessionId(resumeSessionId) ? resumeSessionId : '',
    args: ['--session-id', sessionId, ...launchArgs],
  };
}

function openCodeProviderSessionPlan(rawArgs) {
  const sessionId = argValue(rawArgs, ['--session', '-s']);
  if (!sessionId || !isSafeProviderSessionId(sessionId)) return null;
  if (hasArg(rawArgs, ['--fork'])) {
    return {
      id: createTemporaryProviderSessionId(),
      temporary: true,
      source: 'opencode-fork-temporary',
      forkedFromProviderSessionId: sessionId,
    };
  }
  return {
    id: sessionId,
    temporary: false,
    source: 'resume',
  };
}

function buildAgentProviderSessionPlan({ command, program, args, source } = {}) {
  const sourceSession = sessionFromExactResumeSource(source);
  const rawParts = parseCommand(command);
  const rawProgram = rawParts[0] || program || '';
  const provider = sourceSession ? sourceSession.provider : providerForProgram(rawProgram || program);
  if (!provider) {
    return {
      provider: '',
      id: '',
      key: '',
      temporary: false,
      source: '',
      forkedFromProviderSessionId: '',
      args: Array.isArray(args) ? args : [],
    };
  }

  const launchArgs = Array.isArray(args) ? args : [];
  if (sourceSession) {
    return {
      provider,
      id: sourceSession.sessionId,
      providerHomeId: sourceSession.providerHomeId || 'default',
      temporary: false,
      source: 'resume-source',
      forkedFromProviderSessionId: '',
      args: launchArgs,
    };
  }

  const rawArgs = rawParts.slice(1);
  let plan = null;
  if (provider === 'codex') {
    plan = codexProviderSessionPlan(rawArgs);
  } else if (provider === 'claude') {
    plan = claudeProviderSessionPlan(rawArgs, launchArgs);
  } else if (provider === 'qoder') {
    plan = qoderProviderSessionPlan(rawArgs, launchArgs);
  } else if (provider === 'opencode') {
    plan = openCodeProviderSessionPlan(rawArgs);
  }

  if (!plan || !plan.id) {
    return {
      provider: '',
      id: '',
      temporary: false,
      source: '',
      forkedFromProviderSessionId: '',
      args: launchArgs,
    };
  }

  return {
    provider,
    id: plan.id,
    temporary: plan.temporary === true,
    source: plan.source || '',
    forkedFromProviderSessionId: plan.forkedFromProviderSessionId || '',
    args: Array.isArray(plan.args) ? plan.args : launchArgs,
  };
}

module.exports = {
  buildAgentProviderSessionPlan,
  providerForProgram,
  sessionFromExactResumeSource,
};
