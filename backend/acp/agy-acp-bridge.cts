import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { Readable, Writable } from 'stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AvailableCommand,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ToolKind
} from '@agentclientprotocol/sdk';
import {
  agyExplicitHomeCliArgs,
  cleanAgyUserInputText,
  ensureAgyConversationDatabase,
  isSafeAgyConversationId,
  normalizeAgyToolArgs
} from '../agy-conversation-store.cjs';

type AgyModeId = 'auto' | 'agent_decides' | 'ask_every_time';
type AgyEffortLevel = 'high' | 'medium' | 'low';

interface AgyBridgeOptions {
  agyExecutable: string;
  agyHomePath: string;
  appendSystemPrompt: string;
}

interface AgyBridgeSessionState {
  sessionId: string;
  cwd: string;
  currentModeId: AgyModeId;
  currentEffort: AgyEffortLevel;
  systemPromptInjected: boolean;
  activeChild: ChildProcess | null;
  cancelled: boolean;
}

const DEFAULT_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: 'help', description: 'Show available Antigravity slash commands' },
  { name: 'model', description: 'Show or switch the active model' },
  { name: 'effort', description: 'Show or change reasoning effort (high, medium, low)' },
  { name: 'quota', description: 'Inspect current model quota and reset windows' },
  { name: 'credits', description: 'Inspect AI credits balance' },
  { name: 'skills', description: 'List available Antigravity skills' },
  { name: 'agents', description: 'List available custom agents' },
  { name: 'plugin', description: 'Manage, discover, and configure plugins' },
  { name: 'compact', description: 'Compact the current conversation context' }
];

const CLI_DIRECT_SLASH_COMMANDS = new Set([
  '/agents',
  '/changelog',
  '/config',
  '/settings',
  '/credits',
  '/effort',
  '/help',
  '/hooks',
  '/model',
  '/permissions',
  '/plugin',
  '/skills',
  '/usage',
  '/quota'
]);

function isCliDirectSlashCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() || '';
  return CLI_DIRECT_SLASH_COMMANDS.has(firstToken);
}

function parseBridgeArgs(argv: string[]): AgyBridgeOptions {
  let agyExecutable = process.env.FARMING_AGY_COMMAND || 'agy';
  let agyHomePath = process.env.AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity');
  let appendSystemPrompt = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--farming-agy-command' && typeof argv[index + 1] === 'string') {
      agyExecutable = argv[index + 1].trim() || agyExecutable;
      index += 1;
      continue;
    }
    if (arg === '--farming-agy-home' && typeof argv[index + 1] === 'string') {
      agyHomePath = argv[index + 1].trim() || agyHomePath;
      index += 1;
      continue;
    }
    if (arg === '--farming-append-system-prompt' && typeof argv[index + 1] === 'string') {
      appendSystemPrompt = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return {
    agyExecutable,
    agyHomePath: path.resolve(agyHomePath),
    appendSystemPrompt
  };
}

function buildModeState(session: AgyBridgeSessionState): SessionModeState {
  return {
    currentModeId: session.currentModeId,
    availableModes: [
      {
        id: 'auto',
        name: 'Auto',
        description: 'Execute tool calls automatically without interactive confirmation'
      },
      {
        id: 'agent_decides',
        name: 'Agent Decides',
        description: 'Let Antigravity decide when confirmation is required'
      },
      {
        id: 'ask_every_time',
        name: 'Ask Every Time',
        description: 'Require explicit approval for privileged actions'
      }
    ]
  };
}

function buildConfigOptions(session: AgyBridgeSessionState): SessionConfigOption[] {
  return [
    {
      id: 'effort',
      name: 'Reasoning Effort',
      description: 'Reasoning effort level for Antigravity',
      category: 'thought_level',
      type: 'select',
      currentValue: session.currentEffort,
      options: [
        { value: 'high', name: 'High', description: 'Deep reasoning for complex tasks' },
        { value: 'medium', name: 'Medium', description: 'Balanced speed and reasoning depth' },
        { value: 'low', name: 'Low', description: 'Fast responses for straightforward tasks' }
      ]
    }
  ];
}

function inferToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes('view_file') ||
    normalized.includes('read_url') ||
    normalized.includes('read_file') ||
    normalized.includes('read_')
  ) {
    return 'read';
  }
  if (
    normalized.includes('write_to_file') ||
    normalized.includes('replace_file') ||
    normalized.includes('edit')
  ) {
    return 'edit';
  }
  if (normalized.includes('run_command') || normalized.includes('manage_task')) {
    return 'execute';
  }
  if (normalized.includes('search') || normalized.includes('grep') || normalized.includes('find')) {
    return 'search';
  }
  return 'other';
}

function formatToolTitle(toolName: string, toolArgs: Record<string, unknown> | undefined): string {
  if (toolArgs) {
    if (typeof toolArgs.toolAction === 'string' && toolArgs.toolAction.trim()) {
      return `${toolName}: ${toolArgs.toolAction.trim()}`;
    }
    if (typeof toolArgs.toolSummary === 'string' && toolArgs.toolSummary.trim()) {
      return `${toolName}: ${toolArgs.toolSummary.trim()}`;
    }
    if (typeof toolArgs.CommandLine === 'string' && toolArgs.CommandLine.trim()) {
      return `${toolName}: ${toolArgs.CommandLine.trim()}`;
    }
    if (typeof toolArgs.AbsolutePath === 'string' && toolArgs.AbsolutePath.trim()) {
      return `${toolName}: ${toolArgs.AbsolutePath.trim()}`;
    }
    if (typeof toolArgs.TargetFile === 'string' && toolArgs.TargetFile.trim()) {
      return `${toolName}: ${toolArgs.TargetFile.trim()}`;
    }
  }
  return toolName || 'tool';
}

function flattenPromptBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'resource_link' && typeof block.uri === 'string') {
      parts.push(block.uri);
      continue;
    }
    if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const resource = block.resource as { text?: string; uri?: string };
      if (typeof resource.text === 'string' && resource.text.trim()) {
        parts.push(resource.text);
      } else if (typeof resource.uri === 'string' && resource.uri.trim()) {
        parts.push(resource.uri);
      }
    }
  }
  return parts.join('\n\n').trim();
}

function formatSlashResultData(
  data: Record<string, unknown>,
  fallbackResponse = ''
): string {
  if (Array.isArray(data.commands)) {
    const lines = ['**Available Slash Commands**'];
    for (const entry of data.commands) {
      if (!entry || typeof entry !== 'object') continue;
      const cmd = entry as {
        name?: string;
        aliases?: string[];
        description?: string;
        argument_hint?: string;
      };
      if (!cmd.name) continue;
      const aliases =
        Array.isArray(cmd.aliases) && cmd.aliases.length > 0
          ? ` (${cmd.aliases.map(alias => `/${alias}`).join(', ')})`
          : '';
      const hint = cmd.argument_hint ? ` \`${cmd.argument_hint}\`` : '';
      lines.push(`- \`/${cmd.name}\`${aliases}${hint}: ${cmd.description || ''}`);
    }
    return lines.join('\n');
  }
  if (Array.isArray(data.groups)) {
    const lines = ['**Antigravity Quota & Models**'];
    for (const groupEntry of data.groups) {
      if (!groupEntry || typeof groupEntry !== 'object') continue;
      const group = groupEntry as {
        name?: string;
        description?: string;
        buckets?: Array<{
          name?: string;
          window?: string;
          remaining_fraction?: number;
          reset_time?: string;
        }>;
      };
      const groupName = group.name || 'Model Group';
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      const bucketSummaries = buckets.map(bucket => {
        const pct =
          typeof bucket.remaining_fraction === 'number'
            ? `${Math.round(bucket.remaining_fraction * 100)}% remaining`
            : 'available';
        return `${bucket.name || bucket.window || 'Limit'}: ${pct}`;
      });
      lines.push(
        `- **${groupName}**: ${bucketSummaries.length > 0 ? bucketSummaries.join(' · ') : group.description || ''}`
      );
    }
    return lines.join('\n');
  }
  if (Array.isArray(data.models)) {
    const lines = ['**Antigravity Quota & Models**'];
    for (const entry of data.models) {
      if (!entry || typeof entry !== 'object') continue;
      const model = entry as {
        label?: string;
        model_id?: string;
        remaining_percentage?: number;
        is_exhausted?: boolean;
      };
      const pct = typeof model.remaining_percentage === 'number'
        ? `${model.remaining_percentage}% remaining`
        : model.is_exhausted
          ? 'exhausted'
          : 'available';
      lines.push(`- **${model.label || model.model_id || 'model'}**: ${pct}`);
    }
    return lines.join('\n');
  }
  if (fallbackResponse.trim()) {
    return fallbackResponse.trim();
  }
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

class AgyAcpAgent implements Agent {
  private readonly client: AgentSideConnection;
  private readonly options: AgyBridgeOptions;
  private readonly sessions = new Map<string, AgyBridgeSessionState>();

  constructor(client: AgentSideConnection, options: AgyBridgeOptions) {
    this.client = client;
    this.options = options;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'agy',
        title: 'Antigravity',
        version: '1.3.5'
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: {
          http: true,
          sse: true
        },
        sessionCapabilities: {
          resume: {},
          close: {}
        }
      },
      authMethods: []
    };
  }

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  private ensureSession(sessionId: string, cwd: string): AgyBridgeSessionState {
    const normalizedId = isSafeAgyConversationId(sessionId) ? sessionId.trim() : crypto.randomUUID();
    ensureAgyConversationDatabase(this.options.agyHomePath, normalizedId, cwd);
    const existing = this.sessions.get(normalizedId);
    if (existing) {
      if (cwd && path.isAbsolute(cwd)) {
        existing.cwd = cwd;
      }
      return existing;
    }
    const created: AgyBridgeSessionState = {
      sessionId: normalizedId,
      cwd: cwd && path.isAbsolute(cwd) ? cwd : process.cwd(),
      currentModeId: 'auto',
      currentEffort: 'high',
      systemPromptInjected: false,
      activeChild: null,
      cancelled: false
    };
    this.sessions.set(normalizedId, created);
    return created;
  }

  private scheduleAvailableCommandsUpdate(sessionId: string): void {
    setImmediate(() => {
      void this.client
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: DEFAULT_AVAILABLE_COMMANDS
          }
        })
        .catch(() => {
          // Ignore notifications after disconnect.
        });
    });
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const session = this.ensureSession(crypto.randomUUID(), params.cwd);
    this.scheduleAvailableCommandsUpdate(session.sessionId);
    return {
      sessionId: session.sessionId,
      modes: buildModeState(session),
      configOptions: buildConfigOptions(session)
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const session = this.ensureSession(params.sessionId, params.cwd);
    const transcriptPath = this.resolveTranscriptPath(session.sessionId);
    if (fs.existsSync(transcriptPath)) {
      session.systemPromptInjected = true;
    }
    this.scheduleAvailableCommandsUpdate(session.sessionId);
    return {
      modes: buildModeState(session),
      configOptions: buildConfigOptions(session)
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const session = this.ensureSession(params.sessionId, params.cwd);
    await this.replayTranscriptHistory(session);
    this.scheduleAvailableCommandsUpdate(session.sessionId);
    return {
      modes: buildModeState(session),
      configOptions: buildConfigOptions(session)
    };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (
      params.modeId !== 'auto' &&
      params.modeId !== 'agent_decides' &&
      params.modeId !== 'ask_every_time'
    ) {
      throw new Error(`Unsupported Antigravity mode: ${params.modeId}`);
    }
    session.currentModeId = params.modeId;
    await this.client.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: session.currentModeId
      }
    });
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (params.configId === 'effort' && typeof params.value === 'string') {
      const normalized = params.value.trim().toLowerCase();
      if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
        session.currentEffort = normalized;
      }
    }
    return {
      configOptions: buildConfigOptions(session)
    };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    if (session.activeChild && !session.activeChild.killed) {
      try {
        session.activeChild.kill('SIGTERM');
      } catch {
        // Ignore kill error.
      }
    }
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session?.activeChild && !session.activeChild.killed) {
      try {
        session.activeChild.kill('SIGTERM');
      } catch {
        // Ignore kill error.
      }
    }
    this.sessions.delete(params.sessionId);
    return {};
  }

  private resolveTranscriptPath(sessionId: string): string {
    return path.join(
      this.options.agyHomePath,
      'brain',
      sessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
  }

  private async replayTranscriptHistory(session: AgyBridgeSessionState): Promise<void> {
    const transcriptPath = this.resolveTranscriptPath(session.sessionId);
    if (!fs.existsSync(transcriptPath)) return;

    let raw = '';
    try {
      raw = await fs.promises.readFile(transcriptPath, 'utf8');
    } catch {
      return;
    }

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const stepType = typeof entry.type === 'string' ? entry.type : '';
      const stepIndex = typeof entry.step_index === 'number' ? entry.step_index : 0;

      if (stepType === 'USER_INPUT') {
        session.systemPromptInjected = true;
        const cleaned = cleanAgyUserInputText(entry.content);
        if (cleaned) {
          await this.client.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: cleaned }
            }
          });
        }
        continue;
      }

      if (stepType === 'PLANNER_RESPONSE') {
        const thinking = typeof entry.thinking === 'string' ? entry.thinking.trim() : '';
        if (thinking) {
          await this.client.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: thinking }
            }
          });
        }
        const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
        for (let idx = 0; idx < toolCalls.length; idx += 1) {
          const tc = toolCalls[idx];
          if (!tc || typeof tc !== 'object') continue;
          const record = tc as {
            id?: string;
            name?: string;
            args?: Record<string, unknown>;
          };
          const toolName = typeof record.name === 'string' ? record.name : 'tool';
          const normalizedArgs = normalizeAgyToolArgs(record.args);
          const toolCallId =
            typeof record.id === 'string' && record.id.trim()
              ? record.id.trim()
              : `agy-replay-${stepIndex}-${idx}`;
          await this.client.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: formatToolTitle(toolName, normalizedArgs),
              kind: inferToolKind(toolName),
              status: 'completed',
              rawInput: normalizedArgs || {}
            }
          });
        }
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (content) {
          await this.client.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: content }
            }
          });
        }
      }
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.ensureSession(params.sessionId, process.cwd());
    session.cancelled = false;

    const userText = flattenPromptBlocks(params.prompt);
    if (!userText) {
      return { stopReason: 'end_turn' };
    }

    const isSlashCommand = userText.startsWith('/');
    const isCliDirect = isCliDirectSlashCommand(userText);
    if (userText.trim().toLowerCase().startsWith('/effort ')) {
      const requestedEffort = userText.trim().slice('/effort '.length).trim().toLowerCase();
      if (
        requestedEffort === 'high' ||
        requestedEffort === 'medium' ||
        requestedEffort === 'low'
      ) {
        session.currentEffort = requestedEffort;
      }
    }

    let outgoingText = userText;
    if (!isSlashCommand && !session.systemPromptInjected && this.options.appendSystemPrompt.trim()) {
      outgoingText = `${this.options.appendSystemPrompt.trim()}\n\n${userText}`;
      session.systemPromptInjected = true;
    } else if (!isSlashCommand) {
      session.systemPromptInjected = true;
    }

    const homeArgs = agyExplicitHomeCliArgs(this.options.agyHomePath);
    const cliArgs = isCliDirect
      ? [
          '-p',
          userText.trim(),
          '--conversation',
          session.sessionId,
          '--output-format',
          'json',
          ...homeArgs
        ]
      : [
          '-p',
          outgoingText,
          '--conversation',
          session.sessionId,
          '--output-format',
          'stream-json',
          '--effort',
          session.currentEffort,
          ...homeArgs
        ];
    if (!isCliDirect) {
      if (session.currentModeId === 'auto') {
        cliArgs.push('--dangerously-skip-permissions');
      } else if (session.currentModeId === 'agent_decides') {
        cliArgs.push('--mode', 'accept-edits');
      } else if (session.currentModeId === 'ask_every_time') {
        cliArgs.push('--mode', 'plan');
      }
    }

    const child = spawn(this.options.agyExecutable, cliArgs, {
      cwd: session.cwd,
      env: {
        ...process.env,
        AGY_HOME: this.options.agyHomePath
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    session.activeChild = child;

    const seenToolCalls = new Set<string>();
    let emittedAssistantText = false;
    let stderrText = '';

    child.stderr?.on('data', chunk => {
      stderrText += String(chunk);
    });

    const inputPayload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: outgoingText }]
      }
    });
    child.stdin?.write(`${inputPayload}\n`);
    child.stdin?.end();

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });

    const processStreamPromise = (async () => {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        const eventKind =
          typeof event.event === 'string'
            ? event.event
            : typeof event.type === 'string'
              ? event.type
              : '';

        if (eventKind === 'step_update') {
          const stepUpdate =
            event.step_update && typeof event.step_update === 'object'
              ? (event.step_update as Record<string, unknown>)
              : event;
          const stepType = typeof stepUpdate.step_type === 'string' ? stepUpdate.step_type : '';
          if (stepType === 'agent_response') {
            const rawThinking =
              typeof stepUpdate.thinking_delta === 'string'
                ? stepUpdate.thinking_delta
                : typeof stepUpdate.thinking === 'string'
                  ? stepUpdate.thinking
                  : '';
            const thinking = rawThinking.trim();
            if (thinking) {
              await this.client.sessionUpdate({
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: rawThinking }
                }
              });
            }
            const text =
              typeof stepUpdate.text_delta === 'string'
                ? stepUpdate.text_delta
                : typeof stepUpdate.text === 'string'
                  ? stepUpdate.text
                  : '';
            if (text) {
              emittedAssistantText = true;
              await this.client.sessionUpdate({
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text }
                }
              });
            }
            continue;
          }

          if (stepType === 'tool') {
            const toolInfo =
              stepUpdate.tool_info && typeof stepUpdate.tool_info === 'object'
                ? (stepUpdate.tool_info as Record<string, unknown>)
                : undefined;
            const toolName =
              typeof stepUpdate.tool_name === 'string' && stepUpdate.tool_name
                ? stepUpdate.tool_name
                : typeof toolInfo?.name === 'string' && toolInfo.name
                  ? toolInfo.name
                  : 'tool';
            const stepIndex =
              typeof stepUpdate.step_index === 'number' ? stepUpdate.step_index : 0;
            const rawToolCallId =
              typeof stepUpdate.tool_call_id === 'string' && stepUpdate.tool_call_id.trim()
                ? stepUpdate.tool_call_id.trim()
                : `agy-tool-${stepIndex}-${toolName}`;
            const toolArgs =
              stepUpdate.tool_args && typeof stepUpdate.tool_args === 'object'
                ? (stepUpdate.tool_args as Record<string, unknown>)
                : toolInfo?.parameters && typeof toolInfo.parameters === 'object'
                  ? (toolInfo.parameters as Record<string, unknown>)
                  : undefined;
            const toolOutput =
              typeof stepUpdate.tool_output === 'string'
                ? stepUpdate.tool_output
                : typeof toolInfo?.output === 'string'
                  ? toolInfo.output
                  : undefined;
            const rawStatus =
              typeof stepUpdate.state === 'string'
                ? stepUpdate.state.toUpperCase()
                : typeof stepUpdate.status === 'string'
                  ? stepUpdate.status.toUpperCase()
                  : '';
            const status =
              rawStatus === 'DONE'
                ? 'completed'
                : rawStatus === 'ERROR'
                  ? 'failed'
                  : 'in_progress';

            if (!seenToolCalls.has(rawToolCallId)) {
              seenToolCalls.add(rawToolCallId);
              await this.client.sessionUpdate({
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: rawToolCallId,
                  title: formatToolTitle(toolName, toolArgs),
                  kind: inferToolKind(toolName),
                  status,
                  rawInput: toolArgs || {},
                  ...(toolOutput !== undefined ? { rawOutput: { output: toolOutput } } : {})
                }
              });
            } else {
              await this.client.sessionUpdate({
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: rawToolCallId,
                  status,
                  rawOutput: toolOutput !== undefined ? { output: toolOutput } : undefined
                }
              });
            }
          }
          continue;
        }

        if (
          eventKind === 'result' ||
          (!eventKind && typeof event.status === 'string')
        ) {
          const resultObj =
            event.result && typeof event.result === 'object'
              ? (event.result as Record<string, unknown>)
              : event;
          const commandObj =
            resultObj.command && typeof resultObj.command === 'object'
              ? (resultObj.command as Record<string, unknown>)
              : event.command && typeof event.command === 'object'
                ? (event.command as Record<string, unknown>)
                : null;
          const data =
            resultObj.data && typeof resultObj.data === 'object'
              ? (resultObj.data as Record<string, unknown>)
              : commandObj?.data && typeof commandObj.data === 'object'
                ? (commandObj.data as Record<string, unknown>)
                : null;
          const responseText =
            typeof resultObj.response === 'string'
              ? resultObj.response
              : typeof event.result === 'string'
                ? event.result
                : typeof event.response === 'string'
                  ? event.response
                  : '';

          if (data && typeof data.effort === 'string') {
            const normalizedEffort = data.effort.trim().toLowerCase();
            if (
              normalizedEffort === 'high' ||
              normalizedEffort === 'medium' ||
              normalizedEffort === 'low'
            ) {
              session.currentEffort = normalizedEffort;
            }
          }
          if (!emittedAssistantText && data && Object.keys(data).length > 0) {
            emittedAssistantText = true;
            await this.client.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: formatSlashResultData(data, responseText) }
              }
            });
          } else if (!emittedAssistantText && responseText.trim()) {
            emittedAssistantText = true;
            await this.client.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: responseText }
              }
            });
          }
        }
      }
    })();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });

    await processStreamPromise;
    session.activeChild = null;

    if (session.cancelled) {
      return { stopReason: 'cancelled' };
    }

    if (exitCode && exitCode !== 0 && !emittedAssistantText) {
      const detail = stderrText.trim() || `Antigravity CLI exited with code ${exitCode}`;
      throw new Error(detail);
    }

    return { stopReason: 'end_turn' };
  }
}

export function runAgyAcpBridge(argv: string[] = process.argv.slice(2)): void {
  const options = parseBridgeArgs(argv);
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);
  new AgentSideConnection(client => new AgyAcpAgent(client, options), stream);
}

if (require.main === module) {
  runAgyAcpBridge(process.argv.slice(2));
}
