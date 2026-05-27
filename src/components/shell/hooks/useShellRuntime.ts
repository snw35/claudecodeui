import { useCallback, useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { UseShellRuntimeOptions, UseShellRuntimeResult } from '../types/types';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { useShellConnection } from './useShellConnection';
import { useShellTerminal } from './useShellTerminal';

export function useShellRuntime({
  selectedProject,
  selectedSession,
  initialCommand,
  isPlainShell,
  minimal,
  autoConnect,
  isRestarting,
  onProcessComplete,
  onOutputRef,
}: UseShellRuntimeOptions): UseShellRuntimeResult {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [authUrl, setAuthUrl] = useState('');
  const [authUrlVersion, setAuthUrlVersion] = useState(0);

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const initialCommandRef = useRef(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef(onProcessComplete);
  const authUrlRef = useRef('');
  const lastProjectPathRef = useRef<string | null>(
    selectedProject?.fullPath || selectedProject?.path || null,
  );
  const lastSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);

  // Keep mutable values in refs so websocket handlers always read current data.
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    initialCommandRef.current = initialCommand;
    isPlainShellRef.current = isPlainShell;
    onProcessCompleteRef.current = onProcessComplete;
  }, [selectedProject, selectedSession, initialCommand, isPlainShell, onProcessComplete]);

  const setCurrentAuthUrl = useCallback((nextAuthUrl: string) => {
    authUrlRef.current = nextAuthUrl;
    setAuthUrl(nextAuthUrl);
    setAuthUrlVersion((previous) => previous + 1);
  }, []);

  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    if (
      activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING
    ) {
      activeSocket.close();
    }

    wsRef.current = null;
  }, []);

  const openAuthUrlInBrowser = useCallback((url = authUrlRef.current) => {
    if (!url) {
      return false;
    }

    const popup = window.open(url, '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        // Ignore cross-origin restrictions when trying to null opener.
      }
      return true;
    }

    return false;
  }, []);

  const copyAuthUrlToClipboard = useCallback(async (url = authUrlRef.current) => {
    if (!url) {
      return false;
    }

    return copyTextToClipboard(url);
  }, []);

  const { isInitialized, clearTerminalScreen, disposeTerminal } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject,
    minimal,
    isRestarting,
    initialCommandRef,
    isPlainShellRef,
    authUrlRef,
    copyAuthUrlToClipboard,
    closeSocket,
  });

  const { isConnected, isConnecting, wasTakenOver, connectToShell, disconnectFromShell, reattach } = useShellConnection({
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
    setAuthUrl: setCurrentAuthUrl,
    onOutputRef,
  });

  useEffect(() => {
    if (!isRestarting) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, isRestarting]);

  // Single (project, session) reconciliation: one disconnect per navigation,
  // not two effects racing ~30 ms apart and producing paired server inits.
  useEffect(() => {
    const projectPath = selectedProject?.fullPath || selectedProject?.path || null;
    const sessionId = selectedSession?.id ?? null;

    if (!selectedProject) {
      if (lastProjectPathRef.current !== null) {
        disconnectFromShell();
        disposeTerminal();
      }
      lastProjectPathRef.current = null;
      lastSessionIdRef.current = null;
      return;
    }

    if (!isInitialized) {
      lastProjectPathRef.current = projectPath;
      lastSessionIdRef.current = sessionId;
      return;
    }

    const projectChanged = lastProjectPathRef.current !== projectPath;
    const sessionChanged = lastSessionIdRef.current !== sessionId;

    if (projectChanged || sessionChanged) {
      disconnectFromShell();
    }

    lastProjectPathRef.current = projectPath;
    lastSessionIdRef.current = sessionId;
  }, [
    disconnectFromShell,
    disposeTerminal,
    isInitialized,
    selectedProject,
    selectedSession?.id,
  ]);

  return {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    wasTakenOver,
    authUrl,
    authUrlVersion,
    connectToShell,
    disconnectFromShell,
    reattach,
    openAuthUrlInBrowser,
    copyAuthUrlToClipboard,
  };
}
