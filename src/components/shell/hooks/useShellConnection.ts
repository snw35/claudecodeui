import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

// How long to wait for a WS open before giving up and letting onclose reset state.
// Mobile browsers (especially iOS Safari) can silently kill a socket and delay
// onclose by 60s+; this timeout ensures the connecting state never spins indefinitely.
const WS_OPEN_TIMEOUT_MS = 15_000;

// After this many ms of isConnecting, a tab-visible event will force a clean retry.
// Shorter than WS_OPEN_TIMEOUT_MS so that the visibilitychange path fires first on
// iOS when the tab is brought back to the foreground while a stale connect is pending.
const VISIBILITY_RECONNECT_THRESHOLD_MS = 5_000;

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  terminalContainerRef: RefObject<HTMLDivElement>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  wasTakenOver: boolean;
  closeSocket: () => void;
  connectToShell: () => void;
  disconnectFromShell: () => void;
  reattach: () => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  terminalContainerRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  setAuthUrl,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [wasTakenOver, setWasTakenOver] = useState(false);
  const connectingRef = useRef(false);
  // Ref mirrors wasTakenOver for synchronous reads inside close handler
  // (state updates are async; the close handler fires immediately after the message).
  const wasTakenOverRef = useRef(false);
  // Timestamp (Date.now()) when the most recent connectToShell call started.
  // Read by the visibilitychange handler to decide if a pending connect is stale.
  const connectStartTimeRef = useRef<number | null>(null);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'auth_url' || message.type === 'url_open') {
        const nextAuthUrl = typeof message.url === 'string' ? message.url : '';
        if (nextAuthUrl) {
          setAuthUrl(nextAuthUrl);
        }
        return;
      }

      if (message.type === 'session_taken_over') {
        wasTakenOverRef.current = true;
        setWasTakenOver(true);
      }
    },
    [handleProcessCompletion, onOutputRef, setAuthUrl, terminalRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        // Guard against mobile browsers that silently kill the socket and delay
        // onclose by 60s+. If the socket has not opened after WS_OPEN_TIMEOUT_MS,
        // force-close it so onclose fires, resets isConnecting, and autoConnect
        // retriggers a fresh attempt.
        const openTimeoutId = window.setTimeout(() => {
          if (wsRef.current !== socket) {
            return; // already superseded
          }
          try {
            socket.close();
          } catch {
            // ignore
          }
        }, WS_OPEN_TIMEOUT_MS);

        socket.onopen = () => {
          window.clearTimeout(openTimeoutId);
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;
          connectStartTimeRef.current = null;
          setAuthUrl('');
          wasTakenOverRef.current = false;
          setWasTakenOver(false);

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            const currentContainer = terminalContainerRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            // Skip fit while container is hidden; see useShellTerminal.
            if (
              currentContainer &&
              currentContainer.clientWidth > 0 &&
              currentContainer.clientHeight > 0
            ) {
              currentFitAddon.fit();
            }

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          window.clearTimeout(openTimeoutId);
          // Only the *current* socket may reset connection state. A stale
          // socket firing onclose after it's been superseded (e.g. server
          // closed it because a newer ws took over the PTY entry) would
          // otherwise flip isConnected/isConnecting back to false and
          // re-trigger the autoConnect effect — producing an unbounded
          // disconnect/reconnect cycle.
          if (wsRef.current !== socket) {
            return;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          connectStartTimeRef.current = null;
          // Preserve the terminal snapshot when kicked by another device.
          if (!wasTakenOverRef.current) {
            clearTerminalScreen();
          }
        };

        socket.onerror = () => {
          window.clearTimeout(openTimeoutId);
          if (wsRef.current !== socket) {
            return;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          connectStartTimeRef.current = null;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      setAuthUrl,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback(() => {
    // Check ref synchronously — wasTakenOver state may not yet be true if the
    // message and close events land in separate React render cycles.
    if (!isInitialized || isConnected || isConnecting || connectingRef.current || wasTakenOverRef.current) {
      return;
    }

    connectingRef.current = true;
    connectStartTimeRef.current = Date.now();
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback(() => {
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    connectStartTimeRef.current = null;
    setAuthUrl('');
    wasTakenOverRef.current = false;
    setWasTakenOver(false);
  }, [clearTerminalScreen, closeSocket, setAuthUrl]);

  useEffect(() => {
    if (!autoConnect || !isInitialized || isConnecting || isConnected || wasTakenOver) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized, wasTakenOver]);

  // iOS Safari can deliver onclose 60s+ after the socket dies. If the tab is
  // backgrounded while a connect is in flight, onclose/onerror may not arrive
  // until the tab returns to the foreground — by which time the open timeout
  // may still be pending. The visibilitychange handler catches the complementary
  // case: the tab becomes visible with a stale pending connect (no open timeout
  // fired yet, e.g. the user backgrounds and foregrounds within 15s). Force a
  // clean disconnect + reconnect in that scenario so the overlay doesn't spin.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      const startTime = connectStartTimeRef.current;
      if (
        startTime !== null &&
        connectingRef.current &&
        !isConnected &&
        Date.now() - startTime > VISIBILITY_RECONNECT_THRESHOLD_MS
      ) {
        disconnectFromShell();
        connectToShell();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [connectToShell, disconnectFromShell, isConnected]);

  const reattach = useCallback(() => {
    wasTakenOverRef.current = false;
    setWasTakenOver(false);
    clearTerminalScreen();
    connectToShell();
  }, [clearTerminalScreen, connectToShell]);

  return {
    isConnected,
    isConnecting,
    wasTakenOver,
    closeSocket,
    connectToShell,
    disconnectFromShell,
    reattach,
  };
}
