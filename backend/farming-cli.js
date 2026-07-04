const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { buildMemoryReport, formatMemoryReport } = require('./agent-memory-report');
const { renderMainAgentSkills } = require('./main-agent-skills');

function usage() {
  return `Usage:
  farming skills
  farming memory report [--period today|yesterday|week] [--since <time>] [--until <time>] [--home <path>] [--json]
  farming list [--json] [--parent <agentId>]
  farming spawn [--workspace <path>] [--task <text>] [--parent <agentId>] [--json] -- <command...>
  farming output <agentId> [--tail <chars>]
  farming send <agentId> <text...>
  farming kill <agentId>

Examples:
  farming spawn --workspace /repo --task "Inspect this module for bugs" -- claude
  farming memory report --period today
  farming memory report --period week --json
  farming skills
  farming list --parent "$FARMING_AGENT_ID"
  farming output agent-123 --tail 2000
  farming send agent-123 "Please run the focused tests"`;
}

function readTokenFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function isAuthDisabled(options = {}) {
  if (options.authDisabled === true) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.FARMING_DISABLE_AUTH || '').toLowerCase());
}

function getToken(options = {}) {
  if (isAuthDisabled(options)) return '';
  if (options.token) return options.token;
  if (process.env.FARMING_TOKEN) return process.env.FARMING_TOKEN;

  const tokenFile = options.tokenFile
    || process.env.FARMING_TOKEN_FILE
    || path.join(process.env.FARMING_CONFIG_DIR || path.join(os.homedir(), '.farming'), '.session-token');
  return readTokenFile(tokenFile);
}

function normalizeBaseUrl(value) {
  const raw = value || process.env.FARMING_CONTROL_URL || `http://127.0.0.1:${process.env.PORT || 3000}${process.env.FARMING_BASE_PATH || ''}`;
  return raw.replace(/\/+$/, '');
}

function splitOptionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'skills') {
    if (rest.length > 0) {
      throw new Error('skills does not accept arguments');
    }
    return { command };
  }

  if (command === 'memory' || command === 'report') {
    const subcommand = command === 'memory' ? rest.shift() : 'report';
    if (subcommand !== 'report') {
      throw new Error('memory requires the report subcommand');
    }

    const options = {
      period: 'today',
      since: '',
      until: '',
      homeDir: '',
      json: false,
    };

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--period') {
        options.period = splitOptionValue(rest, i, '--period');
        i++;
      } else if (rest[i] === '--since') {
        options.since = splitOptionValue(rest, i, '--since');
        i++;
      } else if (rest[i] === '--until') {
        options.until = splitOptionValue(rest, i, '--until');
        i++;
      } else if (rest[i] === '--home') {
        options.homeDir = splitOptionValue(rest, i, '--home');
        i++;
      } else if (rest[i] === '--json') {
        options.json = true;
      } else {
        throw new Error(`Unknown option: ${rest[i]}`);
      }
    }

    return { command: 'memory-report', options };
  }

  if (command === 'list') {
    const options = { json: false, parent: '' };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') options.json = true;
      else if (rest[i] === '--parent') {
        options.parent = splitOptionValue(rest, i, '--parent');
        i++;
      } else {
        throw new Error(`Unknown option: ${rest[i]}`);
      }
    }
    return { command, options };
  }

  if (command === 'spawn') {
    const options = {
      workspace: '',
      task: '',
      parent: process.env.FARMING_AGENT_ID || '',
      json: false,
      dangerouslySkipPermissions: false,
      childCommand: '',
    };
    const childParts = [];
    let passthrough = false;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (passthrough) {
        childParts.push(arg);
      } else if (arg === '--') {
        passthrough = true;
      } else if (arg === '--workspace' || arg === '-w') {
        options.workspace = splitOptionValue(rest, i, arg);
        i++;
      } else if (arg === '--task' || arg === '-t') {
        options.task = splitOptionValue(rest, i, arg);
        i++;
      } else if (arg === '--parent') {
        options.parent = splitOptionValue(rest, i, '--parent');
        i++;
      } else if (arg === '--json') {
        options.json = true;
      } else if (arg === '--dangerously-skip-permissions') {
        options.dangerouslySkipPermissions = true;
      } else {
        childParts.push(arg);
      }
    }

    options.childCommand = childParts.join(' ').trim();
    if (!options.childCommand) {
      throw new Error('spawn requires a child command');
    }
    return { command, options };
  }

  if (command === 'output') {
    const agentId = rest[0] || '';
    if (!agentId) throw new Error('output requires an agent id');
    const options = { agentId, tail: 4000 };
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--tail') {
        options.tail = Number(splitOptionValue(rest, i, '--tail'));
        i++;
      } else {
        throw new Error(`Unknown option: ${rest[i]}`);
      }
    }
    return { command, options };
  }

  if (command === 'send') {
    const agentId = rest[0] || '';
    if (!agentId) throw new Error('send requires an agent id');
    const text = rest.slice(1).join(' ');
    if (!text) throw new Error('send requires input text');
    return {
      command,
      options: {
        agentId,
        input: (text.endsWith('\r') || text.endsWith('\n')) ? text : `${text}\r`,
      },
    };
  }

  if (command === 'kill') {
    const agentId = rest[0] || '';
    if (!agentId) throw new Error('kill requires an agent id');
    return { command, options: { agentId } };
  }

  throw new Error(`Unknown command: ${command}`);
}

async function request(pathname, options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = getToken(options);
  if (!token && !isAuthDisabled(options)) {
    throw new Error('Farming token not found. Start this command from a Farming agent session or set FARMING_TOKEN_FILE.');
  }

  const headers = {
    ...(options.headers || {}),
  };
  if (token) {
    headers.Cookie = `farming_token=${encodeURIComponent(token)}`;
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await httpRequest(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? '' : JSON.stringify(options.body),
  });

  const contentType = response.headers['content-type'] || '';
  const payload = contentType.includes('application/json')
    ? JSON.parse(response.body || 'null')
    : response.body;

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message = payload && typeof payload === 'object' ? payload.error : payload;
    throw new Error(message || `HTTP ${response.statusCode}`);
  }

  return payload;
}

function httpRequest(urlValue, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const body = options.body || '';
    const headers = {
      ...(options.headers || {}),
    };
    if (body && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out: ${urlValue}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function formatAgent(agent) {
  const marker = agent.isMain ? '*' : '-';
  const task = agent.task ? ` | task: ${agent.task}` : '';
  const parent = agent.parentAgentId ? ` | parent: ${agent.parentAgentId}` : '';
  return `${marker} ${agent.id} | ${agent.command} | ${agent.status} | ${agent.cwd}${parent}${task}`;
}

async function run(argv = process.argv.slice(2), io = process) {
  const parsed = parseArgs(argv);

  if (parsed.command === 'help') {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (parsed.command === 'skills') {
    io.stdout.write(`${renderMainAgentSkills()}\n`);
    return 0;
  }

  if (parsed.command === 'memory-report') {
    const report = buildMemoryReport({
      period: parsed.options.period,
      since: parsed.options.since,
      until: parsed.options.until,
      homeDir: parsed.options.homeDir || undefined,
    });
    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stdout.write(`${formatMemoryReport(report)}\n`);
    }
    return 0;
  }

  if (parsed.command === 'list') {
    const query = parsed.options.parent ? `?parent=${encodeURIComponent(parsed.options.parent)}` : '';
    const state = await request(`/api/control/agents${query}`);
    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      state.agents.forEach((agent) => io.stdout.write(`${formatAgent(agent)}\n`));
    }
    return 0;
  }

  if (parsed.command === 'spawn') {
    const result = await request('/api/control/agents', {
      method: 'POST',
      body: {
        command: parsed.options.childCommand,
        workspace: parsed.options.workspace || undefined,
        task: parsed.options.task || undefined,
        initialInput: parsed.options.task || undefined,
        parentAgentId: parsed.options.parent || undefined,
        dangerouslySkipPermissions: parsed.options.dangerouslySkipPermissions,
      },
    });

    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout.write(`Started ${result.agentId}\n`);
    }
    return 0;
  }

  if (parsed.command === 'output') {
    const output = await request(`/api/control/agents/${encodeURIComponent(parsed.options.agentId)}/output?tail=${parsed.options.tail}`);
    io.stdout.write(output);
    if (!String(output).endsWith('\n')) io.stdout.write('\n');
    return 0;
  }

  if (parsed.command === 'send') {
    await request(`/api/control/agents/${encodeURIComponent(parsed.options.agentId)}/input`, {
      method: 'POST',
      body: { input: parsed.options.input },
    });
    io.stdout.write('Sent\n');
    return 0;
  }

  if (parsed.command === 'kill') {
    await request(`/api/control/agents/${encodeURIComponent(parsed.options.agentId)}`, {
      method: 'DELETE',
    });
    io.stdout.write('Killed\n');
    return 0;
  }

  return 1;
}

module.exports = {
  formatAgent,
  getToken,
  httpRequest,
  isAuthDisabled,
  normalizeBaseUrl,
  parseArgs,
  request,
  run,
  usage,
};

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
