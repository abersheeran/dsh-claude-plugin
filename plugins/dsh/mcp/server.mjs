#!/usr/bin/env node
/**
 * dsh-subagent — a Model Context Protocol server that runs DeepSeek Harness
 * (DSH) as a subagent for Claude Code.
 *
 * Claude Code starts this process over stdio. The single tool `dsh_delegate`
 * runs `dsh --profile headless` in a child process, feeds it one self-contained
 * task on stdin, and returns the final answer.
 *
 * The server has no npm dependencies: MCP's stdio transport is newline-delimited
 * JSON-RPC 2.0, which is implemented here directly.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const SERVER_NAME = 'dsh-subagent';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_FALLBACK = '2025-06-18';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_TIMEOUT_MS = 10 * 1000;
const MAX_TIMEOUT_MS = 55 * 60 * 1000;
const STDERR_LIMIT = 64 * 1024;
const ANSWER_LIMIT = 4 * 1024 * 1024;

const MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const DEFAULT_MODE = 'workspace-write';

/** Environment variables the parent DSH surface may set; they must not leak
 *  into a nested headless run. */
const SCRUBBED_ENV = ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_SHELL'];

const AUTH_HINT = [
  'DSH could not authenticate with the model provider.',
  '',
  'Do one of these, then retry:',
  '  • Sign in to the DeepSeek Harness desktop app — the plugin reuses the saved account.',
  '  • Export DEEPSEEK_API_KEY before starting Claude Code (for example in ~/.zshrc).',
  '  • Set DSH_SUBAGENT_PROVIDER (and optionally DSH_SUBAGENT_MODEL) to another configured DSH route.',
].join('\n');

const DSH_NOT_FOUND = [
  'DeepSeek Harness CLI not found.',
  '',
  'The plugin looks for:',
  '  1. the DSH_BIN environment variable,',
  '  2. an executable named `dsh` on PATH,',
  '  3. /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh (macOS).',
  '',
  'Install DeepSeek Harness, or set DSH_BIN to the path of its `dsh` launcher, then restart Claude Code.',
].join('\n');

const TOOL = {
  name: 'dsh_delegate',
  title: 'Delegate to DeepSeek Harness',
  description:
    'Run a self-contained task on a DeepSeek Harness subagent and return its final answer. ' +
    'DSH works autonomously in the given working directory with its own file, shell, and search tools. ' +
    'Use it to offload independent work, get a second implementation or review, or run several tasks in parallel. ' +
    'The subagent cannot ask questions and cannot see this conversation, so put every instruction and path it needs in `task`. ' +
    'Each call starts a fresh DSH session; its reasoning and tool activity are not returned.',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        minLength: 1,
        description:
          'Complete, standalone brief: the goal, relevant absolute paths, constraints, and the exact output needed. ' +
          'The subagent sees only this text, its working directory, and its own tools.',
      },
      cwd: {
        type: 'string',
        description:
          'Absolute working directory for the subagent. Defaults to the directory Claude Code was started in. ' +
          'DSH may create and edit files only under this directory unless mode is danger-full-access.',
      },
      mode: {
        type: 'string',
        enum: MODES,
        default: DEFAULT_MODE,
        description:
          'Permission boundary. `workspace-write` (default) edits files under cwd; `read-only` is for analysis; ' +
          '`danger-full-access` removes the sandbox and approval checks, including out-of-tree writes and network access.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
        description:
          'Maximum run time in milliseconds (10000–3300000). Default 900000 (15 minutes). ' +
          'The subagent is stopped when the limit is reached.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

/** @type {Map<string | number, {cancel: () => void}>} */
const jobs = new Map();

// ---------------------------------------------------------------------------
// Protocol I/O
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function debug(...args) {
  if (envString('DSH_SUBAGENT_DEBUG') === '1') {
    console.error('[dsh-subagent]', ...args);
  }
}

function envString(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function logProgress(progressToken, message, state) {
  if (progressToken === undefined || progressToken === null) return;
  state.progress += 1;
  send({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress: state.progress, message },
  });
}

// ---------------------------------------------------------------------------
// Locating DSH and its credentials
// ---------------------------------------------------------------------------

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveDshBin() {
  const explicit = envString('DSH_BIN');
  if (explicit) {
    if (explicit.includes('/') || explicit.includes('\\')) {
      if (isExecutableFile(explicit)) return explicit;
      throw new Error(`DSH_BIN is set to "${explicit}", but that is not an executable file.`);
    }
    const found = findOnPath([explicit]);
    if (found) return found;
    throw new Error(`DSH_BIN is set to "${explicit}", but no executable with that name is on PATH.`);
  }

  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  const onPath = findOnPath(names);
  if (onPath) return onPath;

  if (process.platform === 'darwin') {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      const candidate = join(
        base,
        'DeepSeek Harness.app',
        'Contents',
        'Resources',
        'runtime',
        'cli',
        'bin',
        'dsh',
      );
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  throw new Error(DSH_NOT_FOUND);
}

function dshHome() {
  return resolve(envString('DSH_HOME') ?? join(homedir(), '.dsh'));
}

function credentialsFile() {
  return join(dshHome(), '.credentials.yaml');
}

function hasSavedAccount() {
  try {
    // The desktop sign-in is stored as a `deepseek-account-platform/...` grant.
    return /^\s{0,8}deepseek-account-platform\//m.test(readFileSync(credentialsFile(), 'utf8'));
  } catch {
    return false;
  }
}

function envFileHasDeepseekKey(file) {
  try {
    return /^[ \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*=[ \t]*["']?[^\s"'#]+/m.test(
      readFileSync(file, 'utf8'),
    );
  } catch {
    return false;
  }
}

/** Whether the user's headless profile patch already selects a model route. */
function profilePinsModel() {
  try {
    const patch = readFileSync(join(dshHome(), 'profiles', 'headless', 'cordis.patch.yml'), 'utf8');
    return /agent-default-model/.test(patch);
  } catch {
    return false;
  }
}

/**
 * Decide which model route the headless run should use.
 *
 * - explicit DSH_SUBAGENT_PROVIDER wins;
 * - an API key in the environment or a .env file keeps DSH's default
 *   `deepseek-official` route;
 * - otherwise a signed-in desktop app is reused through `deepseek-account`.
 *
 * @returns {{provider: string, model?: string} | null} null means "leave the
 *   profile's agent-default-model untouched".
 */
function resolveModelSelection(cwd) {
  const provider = envString('DSH_SUBAGENT_PROVIDER');
  const model = envString('DSH_SUBAGENT_MODEL');
  if (provider) return { provider, model };

  if (envString('DEEPSEEK_API_KEY')) return null;
  if (envFileHasDeepseekKey(join(cwd, '.env'))) return null;
  if (envFileHasDeepseekKey(join(dshHome(), '.env'))) return null;

  if (envString('DSH_SUBAGENT_SAVED_AUTH') === 'off') return null;
  if (profilePinsModel()) return null;
  if (hasSavedAccount()) return { provider: 'deepseek-account', model: model ?? 'deepseek-flash' };
  return null;
}

// ---------------------------------------------------------------------------
// The headless profile overlay
// ---------------------------------------------------------------------------

function yamlScalar(value) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`Invalid DSH provider or model name: ${value}`);
  }
  return value;
}

function overlayContent(selection) {
  const lines = [
    '# Generated by the dsh-subagent plugin for Claude Code. Do not edit.',
    '# Re-enable stored credentials so a signed-in desktop app can be reused,',
    '# then optionally pin the model route.',
    '- id: credentials',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '- id: deepseek-account',
    '  disabled: false',
  ];
  if (selection) {
    lines.push(
      '- id: agent-default-model',
      '  config:',
      `    provider: ${yamlScalar(selection.provider)}`,
    );
    if (selection.model) lines.push(`    model: ${yamlScalar(selection.model)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Write an immutable, content-addressed overlay and return its path. */
function overlayPath(selection) {
  const directory = join(
    tmpdir(),
    `dsh-subagent-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const content = overlayContent(selection);
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const file = join(directory, `overlay-${digest}.yml`);
  if (!existsSync(file)) {
    try {
      writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return file;
}

// ---------------------------------------------------------------------------
// Running one delegation
// ---------------------------------------------------------------------------

function resolveCwd(input) {
  let value = typeof input === 'string' && input.trim() !== '' ? input.trim() : process.cwd();
  if (value === '~') value = homedir();
  else if (value.startsWith('~/')) value = join(homedir(), value.slice(2));
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new Error(`Working directory does not exist: ${absolute}`);
  }
  if (!stats.isDirectory()) throw new Error(`Working directory is not a directory: ${absolute}`);
  return absolute;
}

function resolveMode(input) {
  const mode = input === undefined || input === null
    ? envString('DSH_SUBAGENT_PERMISSION_MODE') ?? DEFAULT_MODE
    : input;
  if (!MODES.includes(mode)) {
    throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  }
  return mode;
}

function resolveTimeout(input) {
  const fallback = Number(envString('DSH_SUBAGENT_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS);
  const value = input === undefined || input === null ? fallback : Number(input);
  if (!Number.isFinite(value)) throw new Error('timeout_ms must be a number of milliseconds.');
  return Math.min(Math.max(Math.round(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function childEnvironment(mode) {
  const environment = { ...process.env };
  for (const key of SCRUBBED_ENV) delete environment[key];
  environment.DSH_HOME = dshHome();
  environment.DSH_PERMISSION_MODE = mode;
  environment.NO_COLOR = '1';
  return environment;
}

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    // The child is its own process-group leader (detached), so this also stops
    // the tools DSH itself spawned.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function lastDiagnostic(stderr) {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('dsh: '));
  return lines.length > 0 ? lines[lines.length - 1].slice('dsh: '.length).trim() : undefined;
}

function looksLikeAuthFailure(text) {
  return /MISSING_CREDENTIAL|no API key|unauthorized|\b401\b|invalid token|sign in/i.test(text);
}

function failureResult(message, details) {
  const parts = [`DSH subagent failed: ${message}`];
  if (looksLikeAuthFailure(`${message}\n${details ?? ''}`)) {
    parts.push('', AUTH_HINT);
  }
  if (details && details.trim() !== '') {
    const messageText = message.trim();
    const lines = details
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '' && !line.includes(messageText));
    if (lines.length > 0) {
      const bounded = lines.join('\n');
      parts.push('', 'Diagnostics:', bounded.length > 4000 ? `${bounded.slice(-4000)}\n…` : bounded);
    }
  }
  return { isError: true, text: parts.join('\n') };
}

/**
 * Run DSH headless and resolve with a tool result payload.
 *
 * @param {{task?: unknown, cwd?: unknown, mode?: unknown, timeout_ms?: unknown}} args
 * @param {string | number | undefined} requestId
 * @param {unknown} progressToken
 */
function delegate(args, requestId, progressToken) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const progressState = { progress: 0 };
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (requestId !== undefined) jobs.delete(requestId);
      resolvePromise(payload);
    };

    // --- validate arguments -------------------------------------------------
    if (typeof args.task !== 'string' || args.task.trim() === '') {
      return finish({
        isError: true,
        text: 'dsh_delegate requires a non-empty `task` string.',
      });
    }

    let dshBin;
    let cwd;
    let mode;
    let timeoutMs;
    let selection;
    let overlay;
    try {
      dshBin = resolveDshBin();
      cwd = resolveCwd(args.cwd);
      mode = resolveMode(args.mode);
      timeoutMs = resolveTimeout(args.timeout_ms);
      selection = resolveModelSelection(cwd);
      overlay = overlayPath(selection);
    } catch (error) {
      return finish({
        isError: true,
        text: error instanceof Error ? error.message : String(error),
      });
    }

    const provider = selection ? selection.provider : 'profile-default';
    let sessionId = null;

    debug(`starting ${dshBin} in ${cwd} (mode=${mode}, timeout=${timeoutMs}ms, provider=${provider})`);
    logProgress(progressToken, 'Starting DeepSeek Harness subagent…', progressState);

    // --- spawn ---------------------------------------------------------------
    let child;
    try {
      child = spawn(dshBin, ['--profile', 'headless', '--patch', overlay, '--json'], {
        cwd,
        env: childEnvironment(mode),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      return finish(failureResult(`could not start ${dshBin}: ${error.message}`));
    }

    let finalText;
    let errorEvent;
    let turnError;
    let timedOut = false;
    let cancelled = false;
    let stderr = '';

    const job = {
      cancel() {
        cancelled = true;
        killTree(child, 'SIGTERM');
        const hardKill = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
        hardKill.unref();
      },
    };
    if (requestId !== undefined) jobs.set(requestId, job);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      const hardKill = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
      hardKill.unref();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      finish(
        failureResult(`could not start ${dshBin}: ${error.message}`),
      );
    });

    child.stdin.on('error', () => {
      /* EPIPE when DSH exits before reading; the close path reports why */
    });
    // The whole task is sent on stdin: it preserves newlines and avoids argv
    // length and shell-quoting limits.
    child.stdin.end(args.task.endsWith('\n') ? args.task : `${args.task}\n`);

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      switch (event.type) {
        case 'session':
          if (typeof event.sessionId === 'string') sessionId = event.sessionId;
          break;
        case 'final':
          finalText = typeof event.text === 'string' ? event.text : '';
          break;
        case 'error':
          errorEvent = typeof event.message === 'string' ? event.message : 'DSH reported an error.';
          break;
        case 'status':
          if (event.phase === 'turn_end' && event.reason?.kind === 'error') {
            turnError = event.reason.error?.message ?? 'The model turn failed.';
          }
          break;
        case 'tool_call': {
          const tool = typeof event.tool === 'string' ? event.tool : 'a tool';
          const input = event.input ?? {};
          const detail =
            input.description ??
            input.file_path ??
            input.path ??
            input.command ??
            input.pattern ??
            input.query ??
            '';
          const suffix = detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 100)}` : '';
          logProgress(progressToken, `DSH is using ${tool}${suffix}`, progressState);
          break;
        }
        default:
          break;
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk;
      debug('dsh stderr:', String(chunk).trimEnd());
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startedAt;
      debug(`finished session=${sessionId ?? 'unknown'} exit=${code} duration=${formatDuration(duration)}`);

      if (timedOut) {
        return finish(
          failureResult(
            `timed out after ${formatDuration(timeoutMs)} and was stopped. ` +
              'Retry with a larger timeout_ms or a narrower task.',
          ),
        );
      }
      if (cancelled) {
        return finish({ isError: true, cancelled: true, text: 'DSH subagent was cancelled.' });
      }
      if (code === 0) {
        if (typeof finalText === 'string' && finalText.trim() !== '') {
          if (Buffer.byteLength(finalText, 'utf8') > ANSWER_LIMIT) {
            const clipped = Buffer.from(finalText, 'utf8').subarray(0, ANSWER_LIMIT).toString('utf8');
            finalText = `${clipped}\n\n[Answer truncated by the plugin at 4 MiB.]`;
          }
          logProgress(progressToken, 'DSH finished.', progressState);
          return finish({ isError: false, text: finalText });
        }
        return finish({
          isError: false,
          text: 'DSH finished without a final answer (the run may have ended before the model replied).',
        });
      }

      const diagnostic =
        errorEvent ??
        turnError ??
        lastDiagnostic(stderr) ??
        `DSH exited with code ${code}${signal ? ` (${signal})` : ''}.`;
      const details = stripAnsi(stderr)
        .split(/\r?\n/)
        .filter((line) => !/^\[llm-/.test(line))
        .join('\n')
        .trim();
      return finish(failureResult(stripAnsi(String(diagnostic)), details || undefined));
    });
  });
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return replyError(message?.id ?? null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;

  if (method === undefined) return; // a response from the client; this server sends no requests

  // Notifications never get a response.
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    if (method === 'notifications/cancelled') {
      const target = params?.requestId;
      if (target !== undefined) jobs.get(target)?.cancel();
    }
    return;
  }

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Use dsh_delegate to run a self-contained task on a DeepSeek Harness subagent. ' +
          'Each call is independent: the subagent cannot see this conversation and cannot ask questions.',
      });

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: [TOOL] });

    case 'tools/call': {
      const name = params?.name;
      if (name !== TOOL.name) {
        return replyError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      const args = params?.arguments ?? {};
      const outcome = await delegate(args, id, params?._meta?.progressToken);
      if (outcome.cancelled) {
        return replyError(id, -32800, 'Request cancelled');
      }
      const result = {
        content: [{ type: 'text', text: outcome.text }],
      };
      if (outcome.isError) result.isError = true;
      return reply(id, result);
    }

    case 'resources/list':
      return reply(id, { resources: [] });

    case 'prompts/list':
      return reply(id, { prompts: [] });

    default:
      return replyError(id, -32601, `Method not found: ${String(method)}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const job of jobs.values()) job.cancel();
  // Give children a moment to die, then leave; Claude Code treats a lingering
  // MCP server as a resource leak.
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('uncaughtException', (error) => {
  debug('uncaught exception:', error);
});
process.on('unhandledRejection', (error) => {
  debug('unhandled rejection:', error);
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  handleMessage(message).catch((error) => {
    debug('handler failed:', error);
    if (message && message.id !== undefined) {
      replyError(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  });
});
