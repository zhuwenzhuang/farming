import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { killOwnedProcessGroup, registerConfigProcessGroup, unregisterConfigProcessGroup } from '../config-process-ownership.cjs';
import { readServerProcessIdentity } from '../server-process-identity.cjs';
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
  didAgyCurrentTurnCompleteCleanly,
  readAgyLatestUserStepIndex,
  ensureAgyConversationDatabase,
  hasAgyConversationDatabase,
  isSafeAgyConversationId,
  normalizeAgyToolArgs
} from '../agy-conversation-store.cjs';
import { fileURLToPath } from 'url';

type AgyModeId = 'bypassPermissions' | 'agent_decides' | 'plan';
type AgyEffortLevel = 'high' | 'medium' | 'low' | 'xhigh' | 'max';

interface AgyBridgeOptions {
  agyExecutable: string;
  agyHomePath: string;
  appendSystemPrompt: string;
}

interface AgyBridgeSessionState {
  sessionId: string;
  cwd: string;
  currentModeId: AgyModeId;
  currentModel: string;
  currentEffort: AgyEffortLevel;
  systemPromptInjected: boolean;
  activeChild: ChildProcess | null;
  cancelled: boolean;
  stopChild: (() => Promise<void>) | null;
  additionalDirectories: string[];
}

const DEFAULT_AGY_MODELS: Array<{ value: string; name: string; description?: string }> = [
  {
    value: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    description: 'Most capable Gemini model for complex reasoning and agentic coding'
  },
  {
    value: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Fast, lightweight Gemini model for everyday coding tasks'
  },
  {
    value: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    description: 'Anthropic flagship model for deep engineering tasks'
  },
  {
    value: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    description: 'Balanced Anthropic model for fast coding and analysis'
  },
  {
    value: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B',
    description: 'Open-weights reasoning model'
  }
];

function isValidAgyModelSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim());
}

function isValidAgyEffort(value: unknown): value is AgyEffortLevel {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

function readDefaultAgySettings(agyHomePath: string): { model: string; effort: AgyEffortLevel } {
  let model = 'gemini-4-argon';
  let effort: AgyEffortLevel = 'high';
  try {
    const settingsPath = path.join(agyHomePath, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      if (isValidAgyModelSlug(parsed?.model)) {
        model = parsed.model.trim();
      }
      const rawEffort = typeof parsed?.effort === 'string' ? parsed.effort.trim().toLowerCase() : '';
      if (isValidAgyEffort(rawEffort)) {
        effort = rawEffort;
      }
    }
  } catch {
    // Ignore missing or malformed settings.json and use defaults.
  }
  return { model, effort };
}

const DEFAULT_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: 'help', description: 'Show available Antigravity slash commands' },
  { name: 'model', description: 'Show or switch the active model' },
  { name: 'effort', description: 'Show or change reasoning effort (low, medium, high, xhigh, max)' },
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
        id: 'bypassPermissions',
        name: 'Bypass permissions',
        description: 'Bypass permission checks. Use only in a trusted environment.'
      },
      {
        id: 'agent_decides',
        name: 'Accept edits',
        description: 'Approve file edits automatically; interactive command approvals require Terminal.'
      },
      {
        id: 'plan',
        name: 'Plan',
        description: 'Plan and inspect without modifying files.'
      }
    ]
  };
}

function buildConfigOptions(session: AgyBridgeSessionState): SessionConfigOption[] {
  const modelOptions = DEFAULT_AGY_MODELS.some(option => option.value === session.currentModel)
    ? DEFAULT_AGY_MODELS
    : [
        { value: session.currentModel, name: session.currentModel },
        ...DEFAULT_AGY_MODELS
      ];
  return [
    {
      id: 'model',
      name: 'Model',
      description: 'Model for Antigravity',
      category: 'model',
      type: 'select',
      currentValue: session.currentModel,
      options: modelOptions
    },
    {
      id: 'effort',
      name: 'Reasoning Effort',
      description: 'Reasoning effort level for Antigravity',
      category: 'thought_level',
      type: 'select',
      currentValue: session.currentEffort,
      options: [
        { value: 'low', name: 'Low', description: 'Fast responses for straightforward tasks' },
        { value: 'medium', name: 'Medium', description: 'Balanced speed and reasoning depth' },
        { value: 'high', name: 'High', description: 'Deep reasoning for complex tasks' },
        { value: 'max', name: 'Max', description: 'Maximum reasoning depth for the hardest problems' }
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

function resolveMediaBlockPath(block: Record<string, unknown>): string {
  if (typeof block.path === 'string' && block.path.trim()) {
    return path.resolve(block.path.trim());
  }
  if (typeof block.uri === 'string' && block.uri.trim().startsWith('file://')) {
    try {
      return path.resolve(fileURLToPath(block.uri.trim()));
    } catch {
      return '';
    }
  }
  return '';
}

function flattenPromptBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const trimmed = block.text.trim();
      if (trimmed) parts.push(trimmed);
      continue;
    }
    if (block.type === 'image' || block.type === 'audio') {
      const label = block.type === 'audio' ? 'audio' : 'image';
      const attachmentPath = resolveMediaBlockPath(block as unknown as Record<string, unknown>);
      const name = attachmentPath ? path.basename(attachmentPath) : `attached ${label}`;
      const detail = attachmentPath
        ? `${label.charAt(0).toUpperCase()}${label.slice(1)} path: ${attachmentPath}`
        : `[Attached ${label}]`;
      parts.push(`Attached ${label}: ${name}\n\n${detail}`);
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
    queueMicrotask(() => {
      void client.closed.then(() => Promise.allSettled([...this.sessions.keys()].map(sessionId => this.closeSession({ sessionId }))));
    });
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'agy',
        title: 'Antigravity',
        version: '1'
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: {
          http: false,
          sse: false
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

  private ensureSession(sessionId: string, cwd: string, create = false): AgyBridgeSessionState {
    if (!isSafeAgyConversationId(sessionId)) throw new Error('Invalid Antigravity Session id');
    if (!path.isAbsolute(cwd)) throw new Error('Antigravity workspace must be absolute');
    const normalizedId = sessionId.trim();
    if (create) {
      if (!ensureAgyConversationDatabase(this.options.agyHomePath, normalizedId, cwd)) throw new Error('Cannot initialize Antigravity conversation database');
    } else if (!hasAgyConversationDatabase(this.options.agyHomePath, normalizedId)) {
      throw new Error(`Antigravity conversation not found: ${normalizedId}`);
    } else {
      ensureAgyConversationDatabase(this.options.agyHomePath, normalizedId, cwd);
    }
    const existing = this.sessions.get(normalizedId);
    if (existing) {
      if (existing.cwd !== cwd) throw new Error('Antigravity Session workspace cannot change');
      return existing;
    }
    const defaults = readDefaultAgySettings(this.options.agyHomePath);
    const created: AgyBridgeSessionState = {
      sessionId: normalizedId,
      cwd: cwd && path.isAbsolute(cwd) ? cwd : process.cwd(),
      currentModeId: 'bypassPermissions',
      currentModel: defaults.model,
      currentEffort: defaults.effort,
      systemPromptInjected: false,
      activeChild: null,
      stopChild: null,
      additionalDirectories: [],
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

  private setAdditionalDirectories(session: AgyBridgeSessionState, params: NewSessionRequest | LoadSessionRequest | ResumeSessionRequest): void {
    const directories = (params as typeof params & { additionalDirectories?: unknown }).additionalDirectories;
    if (directories === undefined) return;
    if (!Array.isArray(directories) || directories.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory))) {
      throw new Error('Antigravity additional directories must be absolute paths');
    }
    session.additionalDirectories = [...new Set(directories as string[])];
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (params.mcpServers?.length) throw new Error('Antigravity Chat does not support ACP MCP injection; configure integrations in its Agent Home');
    const session = this.ensureSession(crypto.randomUUID(), params.cwd, true);
    this.setAdditionalDirectories(session, params);
    this.scheduleAvailableCommandsUpdate(session.sessionId);
    return {
      sessionId: session.sessionId,
      modes: buildModeState(session),
      configOptions: buildConfigOptions(session)
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (params.mcpServers?.length) throw new Error('Antigravity Chat does not support ACP MCP injection; configure integrations in its Agent Home');
    const session = this.ensureSession(params.sessionId, params.cwd);
    await this.replayTranscriptHistory(session, false);
    this.setAdditionalDirectories(session, params);
    this.scheduleAvailableCommandsUpdate(session.sessionId);
    return {
      modes: buildModeState(session),
      configOptions: buildConfigOptions(session)
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (params.mcpServers?.length) throw new Error('Antigravity Chat does not support ACP MCP injection; configure integrations in its Agent Home');
    const session = this.ensureSession(params.sessionId, params.cwd);
    await this.replayTranscriptHistory(session);
    this.setAdditionalDirectories(session, params);
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
    const normalizedMode: AgyModeId | null =
      params.modeId === 'bypassPermissions' || params.modeId === 'auto'
        ? 'bypassPermissions'
        : params.modeId === 'agent_decides' || params.modeId === 'acceptEdits'
          ? 'agent_decides'
          : params.modeId === 'plan'
            ? 'plan'
            : null;
    if (!normalizedMode) {
      throw new Error(`Unsupported Antigravity mode: ${params.modeId}`);
    }
    if (session.activeChild) throw new Error('Cannot change mode during an active turn');
    session.currentModeId = normalizedMode;
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
    if (session.activeChild) throw new Error('Cannot change configuration during an active turn');
    if (params.configId === 'model') {
      if (!isValidAgyModelSlug(params.value)) {
        throw new Error('Unsupported Antigravity configuration');
      }
      session.currentModel = params.value.trim();
    } else if (params.configId === 'effort') {
      const normalized = typeof params.value === 'string' ? params.value.trim().toLowerCase() : '';
      if (!isValidAgyEffort(normalized)) {
        throw new Error('Unsupported Antigravity configuration');
      }
      session.currentEffort = normalized;
    } else {
      throw new Error('Unsupported Antigravity configuration');
    }
    return {
      configOptions: buildConfigOptions(session)
    };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    await session.stopChild?.();
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    this.sessions.delete(params.sessionId);
    if (session) {
      session.cancelled = true;
      await session.stopChild?.();
    }
    return {};
  }

  private resolveTranscriptPath(sessionId: string): string {
    const full = path.join(this.options.agyHomePath, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (fs.existsSync(full)) return full;
    return path.join(
      this.options.agyHomePath,
      'brain',
      sessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
  }

  private async replayTranscriptHistory(session: AgyBridgeSessionState, replay = true): Promise<void> {
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
        const prompt = this.options.appendSystemPrompt.trim();
        if (prompt && typeof entry.content === 'string' && entry.content.includes(prompt)) {
          session.systemPromptInjected = true;
        }
        if (!replay) continue;
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

      if (replay && stepType === 'PLANNER_RESPONSE') {
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
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session not found: ${params.sessionId}`);
    if (session.activeChild) throw new Error('Antigravity Session already has an active turn');
    session.cancelled = false;

    const userText = flattenPromptBlocks(params.prompt);
    if (!userText) {
      return { stopReason: 'end_turn' };
    }

    const isSlashCommand = userText.startsWith('/');
    const isCliDirect = isCliDirectSlashCommand(userText);
    if (userText.trim().toLowerCase().startsWith('/effort ')) {
      const requestedEffort = userText.trim().slice('/effort '.length).trim().toLowerCase();
      if (isValidAgyEffort(requestedEffort)) {
        session.currentEffort = requestedEffort;
      }
    } else if (userText.trim().toLowerCase().startsWith('/model ')) {
      const requestedModel = userText.trim().slice('/model '.length).trim();
      if (isValidAgyModelSlug(requestedModel)) {
        session.currentModel = requestedModel;
      }
    }

    let outgoingText = userText;
    const injectSystemPrompt = !isSlashCommand && !session.systemPromptInjected && Boolean(this.options.appendSystemPrompt.trim());
    if (injectSystemPrompt) {
      outgoingText = `${this.options.appendSystemPrompt.trim()}\n\n${userText}`;
    }

    const previousUserStepIndex = readAgyLatestUserStepIndex(this.options.agyHomePath, session.sessionId);
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
          ...(session.currentModel ? ['--model', session.currentModel] : []),
          '--effort',
          session.currentEffort,
          ...homeArgs
        ];
    if (!isCliDirect) {
      if (session.currentModeId === 'bypassPermissions') {
        cliArgs.push('--dangerously-skip-permissions');
      } else if (session.currentModeId === 'agent_decides') {
        cliArgs.push('--mode', 'accept-edits');
      } else if (session.currentModeId === 'plan') {
        cliArgs.push('--mode', 'plan');
      }
    }

    for (const directory of session.additionalDirectories) cliArgs.push('--add-dir', directory);
    cliArgs.push('--print-timeout', '60m');
    const child = spawn(this.options.agyExecutable, cliArgs, {
      cwd: session.cwd,
      env: {
        ...process.env,
        AGY_HOME: this.options.agyHomePath
      },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    session.activeChild = child;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Attach rejection handling immediately, including spawn failure before stream consumption.
    void exit.catch(() => {});
    const identity = child.pid ? readServerProcessIdentity(child.pid) : null;
    const configDir = process.env.FARMING_CONFIG_DIR;
    const killTurn = async () => {
      if (identity) {
        const result = await killOwnedProcessGroup(identity);
        if (result.identityMismatch || result.identityUnavailable || result.unsupported) throw new Error('Cannot prove Antigravity turn process ownership');
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    };
    // A provider can exit while its tools still hold stdout open. Kill its owned
    // group on parent exit as well as cancellation, before waiting for close.
    child.once('exit', () => { void killTurn().catch(() => {}); });
    session.stopChild = async () => {
      await killTurn();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exit.catch(() => {}),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Antigravity process did not close after hard stop')), 5000); })
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const turnDeadline = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Antigravity turn exceeded its deadline')), 3_660_000);
      deadline.unref();
    });

    const seenToolCalls = new Set<string>();
    let emittedAssistantText = false;
    let stderrText = '';
    let resultFailure = '';
    let resultReceived = false;

    child.stderr?.on('data', chunk => {
      stderrText = (stderrText + String(chunk)).slice(-65_536);
    });

    child.stdin?.on('error', () => {});
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

        if (typeof event.conversation_id === 'string' && (event.conversation_id || !isCliDirect) && event.conversation_id !== session.sessionId) throw new Error('Antigravity returned a different conversation identity');

        if (eventKind === 'step_update') {
          const stepUpdate =
            event.step_update && typeof event.step_update === 'object'
              ? (event.step_update as Record<string, unknown>)
              : event;
          if (typeof stepUpdate.conversation_id === 'string' && stepUpdate.conversation_id !== session.sessionId) throw new Error('Antigravity returned a different conversation identity');
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
          resultReceived = true;
          const resultStatus = String(resultObj.status || '').toUpperCase();
          const topLevelError = typeof event.error === 'string' ? event.error.trim() : '';
          const nestedError = typeof resultObj.error === 'string' ? resultObj.error.trim() : '';
          if (!['SUCCESS', 'OK', 'COMPLETED'].includes(resultStatus)) {
            const recoveredCleanTurn =
              !topLevelError &&
              resultStatus === 'ERROR' &&
              nestedError === 'The stream was interrupted. Please continue the task you were working on.' &&
              didAgyCurrentTurnCompleteCleanly(this.options.agyHomePath, session.sessionId, previousUserStepIndex);
            if (!recoveredCleanTurn) {
              resultFailure = topLevelError || nestedError || `Antigravity turn failed: ${resultStatus}`;
            }
          }
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
              normalizedEffort === 'low' || normalizedEffort === 'xhigh' || normalizedEffort === 'max'
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

    void processStreamPromise.catch(() => { void session.stopChild?.().catch(() => {}); });
    try {
      if (identity && configDir) registerConfigProcessGroup(configDir, 'agy-turn', identity);
      const [{ code, signal }] = await Promise.race([Promise.all([exit, processStreamPromise]), turnDeadline]);
      if (session.cancelled) return { stopReason: 'cancelled' };
      if (code !== 0 || signal || resultFailure || !resultReceived) {
        throw new Error(resultFailure || stderrText.trim() || `Antigravity CLI did not complete successfully (${signal || code}); ${resultReceived ? 'result received' : 'missing final result'}`);
      }
      if (injectSystemPrompt) session.systemPromptInjected = true;
      return { stopReason: 'end_turn' };
    } finally {
      clearTimeout(deadline);
      try {
        await session.stopChild?.();
        // A failed turn may still have persisted its input. Reconcile that
        // evidence before deciding whether the next turn needs the bootstrap.
        if (injectSystemPrompt && !session.systemPromptInjected) await this.replayTranscriptHistory(session, false);
        if (identity && configDir) unregisterConfigProcessGroup(configDir, 'agy-turn', identity);
      } finally {
        session.activeChild = null;
        session.stopChild = null;
        rl.close();
      }
    }
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
