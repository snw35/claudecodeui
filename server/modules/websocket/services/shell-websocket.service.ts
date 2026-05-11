import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { sessionFileEvents, type SessionFileEventPayload } from '@/modules/providers/index.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  // Current map key; mutated by `handleSessionFileEvent` on re-key.
  key: string;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const DEFAULT_PTY_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const PTY_SESSION_TIMEOUT = (() => {
  const raw = process.env.PTY_SESSION_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_PTY_SESSION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[shell-websocket] Ignoring invalid PTY_SESSION_TIMEOUT_MS=${raw}; using default ${DEFAULT_PTY_SESSION_TIMEOUT_MS}ms`,
    );
    return DEFAULT_PTY_SESSION_TIMEOUT_MS;
  }
  return parsed;
})();
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const CLAUDE_PROJECT_NAME_PATTERN = /[^a-zA-Z0-9-]/g;

/**
 * A new claude session is initially keyed `<projectPath>_default` because
 * no UUID is known at init time. When claude writes the transcript file
 * `<UUID>.jsonl`, the central session watcher fires this event. Re-key the
 * project's `_default` PTY entry to the UUID-keyed slot so a later click
 * on that session in the sidebar reattaches instead of spawning a fresh
 * `--resume` wrapper (which would orphan the original PTY along with any
 * in-process agent state it owns).
 *
 * Disambiguation is conservative: if a project has more than one
 * `_default` PTY (the precondition fixed by Bug B in a later patch), we
 * refuse rather than risk attaching the wrong session.
 */
function handleSessionFileEvent(payload: SessionFileEventPayload): void {
  if (payload.provider !== 'claude' || payload.eventType !== 'add' || !payload.sessionId) {
    return;
  }

  const transcriptDir = path.basename(path.dirname(payload.filePath));

  let candidateKey: string | null = null;
  let candidateEntry: PtySessionEntry | null = null;
  let candidateCount = 0;

  for (const [key, entry] of ptySessionsMap) {
    if (entry.sessionId !== null) {
      continue;
    }
    const encodedProject = entry.projectPath.replace(CLAUDE_PROJECT_NAME_PATTERN, '-');
    if (encodedProject !== transcriptDir) {
      continue;
    }
    candidateCount += 1;
    candidateKey = key;
    candidateEntry = entry;
  }

  if (candidateCount !== 1 || !candidateKey || !candidateEntry) {
    if (candidateCount > 1) {
      console.warn(
        '[shell-websocket] Refusing to promote _default PTY: multiple candidates for project',
        { transcriptDir, sessionId: payload.sessionId, candidateCount }
      );
    }
    return;
  }

  const expectedDefaultPrefix = `${candidateEntry.projectPath}_default`;
  if (!candidateKey.startsWith(expectedDefaultPrefix)) {
    return;
  }
  const commandSuffix = candidateKey.slice(expectedDefaultPrefix.length);
  if (commandSuffix !== '') {
    return;
  }

  const newKey = `${candidateEntry.projectPath}_${payload.sessionId}`;
  ptySessionsMap.delete(candidateKey);
  candidateEntry.sessionId = payload.sessionId;
  candidateEntry.key = newKey;
  ptySessionsMap.set(newKey, candidateEntry);
}

// Deferred past module evaluation: shell-websocket and sessions-watcher
// participate in an import cycle (shell-websocket → providers/index →
// sessions-watcher → websocket/index → websocket-server → shell-websocket),
// so subscribing synchronously at top-level can hit TDZ on `sessionFileEvents`.
// queueMicrotask runs after all module top-level bodies have finished, by
// which point the EventEmitter binding is fully initialized.
queueMicrotask(() => {
  sessionFileEvents.on('session-file', handleSessionFileEvent);
});

type ShellWebSocketDependencies = {
  getSessionById: (sessionId: string) => { cliSessionId?: string } | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId) {
      return `cursor-agent --resume="${sessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (hasSession && sessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${sessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = sessionId;
    if (hasSession && sessionId) {
      try {
        const existingSession = dependencies.getSessionById(sessionId);
        if (existingSession && existingSession.cliSessionId) {
          resumeId = existingSession.cliSessionId;
          if (!safeSessionIdPattern.test(resumeId)) {
            resumeId = '';
          }
        }
      } catch (error) {
        console.error('Failed to get Gemini CLI session ID:', error);
      }
    }

    if (hasSession && resumeId) {
      return `${command} --resume "${resumeId}"`;
    }
    return command;
  }

  const command = initialCommand || 'claude';
  if (hasSession && sessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
    }
    return `claude --resume "${sessionId}" || claude`;
  }
  return command;
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  let shellProcess: IPty | null = null;
  // Connection handlers close over the entry reference, never the map key.
  // The session-file watcher may re-key the entry (e.g. `_default` →
  // `_<UUID>`) while this connection is live. Going through the map by
  // key would miss after re-key; going through `entry` directly is
  // immune. `entry.key` carries the current map key for cleanup paths.
  let entry: PtySessionEntry | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        const lookupKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        if (isLoginCommand) {
          const oldSession = ptySessionsMap.get(lookupKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(oldSession.key);
          }
        }

        const existingSession = isLoginCommand ? null : ptySessionsMap.get(lookupKey);
        if (existingSession) {
          entry = existingSession;
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
            existingSession.timeoutId = null;
          }

          // The previous ws (if any) is being abandoned — the new connection
          // takes over this PTY slot. Close the old socket so the frontend's
          // close-handler runs and doesn't keep a half-dead connection alive.
          const previousWs = existingSession.ws;
          if (previousWs && previousWs !== ws && previousWs.readyState === WebSocket.OPEN) {
            try {
              previousWs.close();
            } catch {
              // best effort
            }
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = buildShellCommand(data, dependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);

        shellProcess = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        });

        const newEntry: PtySessionEntry = {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          key: lookupKey,
        };
        ptySessionsMap.set(lookupKey, newEntry);
        entry = newEntry;

        shellProcess.onData((chunk) => {
          const session = entry;
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          const session = entry;
          if (!session) {
            return;
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session.timeoutId) {
            clearTimeout(session.timeoutId);
            session.timeoutId = null;
          }

          // `session.key` is current — the watcher updates it on re-key,
          // so we always delete the right map entry.
          ptySessionsMap.delete(session.key);
          shellProcess = null;
          entry = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'gemini'
                  ? 'Gemini'
                  : 'Claude';
          welcomeMsg = hasSession
            ? `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    const session = entry;
    if (!session) {
      return;
    }

    // A newer connection may have already taken over this PTY entry by
    // assigning its own ws — in that case our close should not tear the
    // entry down or strand the new connection without an output sink.
    if (session.ws !== ws) {
      return;
    }

    session.ws = null;
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    session.timeoutId = setTimeout(() => {
      session.pty.kill();
      ptySessionsMap.delete(session.key);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
