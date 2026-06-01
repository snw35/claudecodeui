import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { Project } from '../../../types/app';
import {
  CODEX_DEVICE_AUTH_URL,
  TERMINAL_INIT_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_RESIZE_DELAY_MS,
} from '../constants/constants';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { isCodexLoginCommand } from '../utils/auth';
import { sendSocketMessage } from '../utils/socket';
import { ensureXtermFocusStyles } from '../utils/terminalStyles';

type UseShellTerminalOptions = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  selectedProject: Project | null | undefined;
  minimal: boolean;
  isRestarting: boolean;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  authUrlRef: MutableRefObject<string>;
  copyAuthUrlToClipboard: (url?: string) => Promise<boolean>;
  closeSocket: () => void;
};

type UseShellTerminalResult = {
  isInitialized: boolean;
  clearTerminalScreen: () => void;
  disposeTerminal: () => void;
};

export function useShellTerminal({
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
}: UseShellTerminalOptions): UseShellTerminalResult {
  const [isInitialized, setIsInitialized] = useState(false);
  const resizeTimeoutRef = useRef<number | null>(null);
  const selectedProjectKey = selectedProject?.fullPath || selectedProject?.path || '';

  // S1 mobile-input reconciliation state.
  // pendingCompositionRef: the text already mirrored to the PTY for the current composition.
  // suppressCompositionDataRef: when non-null, the next onData call matching this string is
  //   dropped — it is xterm's deferred composition-commit (setTimeout(0) after compositionend)
  //   which would otherwise duplicate what reconcile() already sent incrementally.
  const pendingCompositionRef = useRef<string>('');
  const suppressCompositionDataRef = useRef<string | null>(null);
  const hasSelectedProject = Boolean(selectedProject);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  const clearTerminalScreen = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.clear();
    terminalRef.current.write('\x1b[2J\x1b[H');
  }, [terminalRef]);

  const disposeTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    setIsInitialized(false);
  }, [fitAddonRef, terminalRef]);

  useEffect(() => {
    if (!terminalContainerRef.current || !hasSelectedProject || isRestarting || terminalRef.current) {
      return;
    }

    const nextTerminal = new Terminal(TERMINAL_OPTIONS);
    terminalRef.current = nextTerminal;

    const nextFitAddon = new FitAddon();
    fitAddonRef.current = nextFitAddon;
    nextTerminal.loadAddon(nextFitAddon);

    // Avoid wrapped partial links in compact login flows.
    if (!minimal) {
      nextTerminal.loadAddon(new WebLinksAddon());
    }

    try {
      nextTerminal.loadAddon(new WebglAddon());
    } catch {
      console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
    }

    nextTerminal.open(terminalContainerRef.current);

    // Defeat mobile predictive/autocorrect composition so the soft keyboard
    // emits discrete keystrokes (including a real backspace → \x7f) instead
    // of routing input through IME composition commits.  xterm sets
    // autocorrect/autocapitalize/spellcheck in open(), but omits autocomplete
    // and uses autocapitalize="off" instead of the spec-correct "none".  We
    // re-apply the full standard set here after open() so our values win.
    // These attributes are safe: they do NOT disable compositionstart/
    // compositionend events, so deliberate CJK IME input is unaffected.
    if (nextTerminal.textarea) {
      nextTerminal.textarea.setAttribute('autocorrect', 'off');
      nextTerminal.textarea.setAttribute('autocapitalize', 'none');
      nextTerminal.textarea.setAttribute('autocomplete', 'off');
      nextTerminal.textarea.setAttribute('spellcheck', 'false');
    }

    // DIAG S1 TRACE — remove after capture
    // Attach passive DOM-event listeners on the xterm textarea to capture the exact
    // event sequence Firefox-Android fires for typing and backspace.  Each event is
    // shipped to the server via a 'diag_input_trace' WS message for server-log capture.
    //
    // S1 mobile-input composition-delta reconciliation is folded directly into these handlers
    // (Firefox-Android + predictive keyboard).
    //
    // Problem: on Android/Firefox every soft-key is keyCode 229 routed through IME composition.
    // xterm's CompositionHelper sends NOTHING during compositionupdate and sends the whole
    // composed word once in a setTimeout(0) after compositionend.  Backspace-in-composition
    // re-enters composition with the existing word and shrinks it — xterm sends NOTHING for any
    // of this.  Net effect: backspace never reaches the PTY.
    //
    // Fix: drive the PTY ourselves from composition/input events via reconcile(prev, next).
    // reconcile computes the common prefix, sends one \x7f per deleted character, then sends
    // the new suffix.  This handles both growth (typing) and shrink (backspace-in-composition).
    //
    // Suppression: xterm still sends the full composed string in its deferred setTimeout(0)
    // after compositionend (see CompositionHelper._finalizeComposition).  We suppress that call
    // by storing the committed string in suppressCompositionDataRef; the onData handler below
    // drops the first matching call and clears the ref.  Desktop keyboard, paste, and
    // prompt-button sends never hold a value in suppressCompositionDataRef so they are unaffected.
    const diagTextarea = nextTerminal.textarea;
    const diagListeners: Array<[string, EventListener]> = [];
    if (diagTextarea) {
      const sendTrace = (eventName: string, detail: Record<string, unknown>) => {
        sendSocketMessage(wsRef.current, {
          type: 'diag_input_trace',
          event: eventName,
          detail,
        });
      };

      // reconcile: diff prev vs next and send the minimal PTY bytes.
      const reconcile = (prev: string, next: string) => {
        let c = 0;
        const minLen = Math.min(prev.length, next.length);
        while (c < minLen && prev[c] === next[c]) {
          c++;
        }
        const deleteCount = prev.length - c;
        const insert = next.slice(c);
        const bytes = '\x7f'.repeat(deleteCount) + insert;
        if (bytes.length > 0) {
          sendSocketMessage(wsRef.current, { type: 'input', data: bytes });
        }
      };

      const onKeydown = (e: Event) => {
        const ke = e as KeyboardEvent;
        sendTrace('keydown', { key: ke.key, keyCode: ke.keyCode, code: ke.code, isComposing: ke.isComposing });
      };
      const onKeyup = (e: Event) => {
        const ke = e as KeyboardEvent;
        sendTrace('keyup', { key: ke.key, keyCode: ke.keyCode, code: ke.code, isComposing: ke.isComposing });
      };
      const onCompositionstart = (e: Event) => {
        const ce = e as CompositionEvent;
        sendTrace('compositionstart', { data: ce.data });
        // When Firefox re-enters composition on backspace it provides the existing word as
        // compositionstart.data — treat it as already-mirrored so reconcile() computes deltas
        // against it rather than sending the whole word again.
        pendingCompositionRef.current = ce.data ?? '';
      };
      const onCompositionupdate = (e: Event) => {
        const ce = e as CompositionEvent;
        const next = ce.data ?? '';
        sendTrace('compositionupdate', { data: next });
        reconcile(pendingCompositionRef.current, next);
        pendingCompositionRef.current = next;
      };
      const onCompositionend = (e: Event) => {
        const ce = e as CompositionEvent;
        const next = ce.data ?? '';
        sendTrace('compositionend', { data: next });
        reconcile(pendingCompositionRef.current, next);
        // Store the committed string so the onData handler below can suppress xterm's
        // deferred composition commit (setTimeout(0) in CompositionHelper._finalizeComposition).
        // An empty string means the composition was deleted entirely; nothing to suppress.
        suppressCompositionDataRef.current = next.length > 0 ? next : null;
        pendingCompositionRef.current = '';
      };
      const onBeforeinput = (e: Event) => {
        const ie = e as InputEvent;
        sendTrace('beforeinput', { inputType: ie.inputType, data: ie.data, isComposing: ie.isComposing });
      };
      const onInput = (e: Event) => {
        const ie = e as InputEvent;
        sendTrace('input', { inputType: ie.inputType, data: ie.data, isComposing: ie.isComposing });
        if (!ie.isComposing && ie.inputType === 'deleteContentBackward') {
          // Non-composing backspace: xterm sends nothing for keyCode 229 on mobile; send \x7f.
          sendSocketMessage(wsRef.current, { type: 'input', data: '\x7f' });
        }
        // insertText (space, punctuation, etc.) is left to xterm's normal onData path.
        // Composing input is handled by compositionupdate; nothing to do here.
      };

      const diagEntries: Array<[string, EventListener]> = [
        ['keydown', onKeydown],
        ['keyup', onKeyup],
        ['compositionstart', onCompositionstart],
        ['compositionupdate', onCompositionupdate],
        ['compositionend', onCompositionend],
        ['beforeinput', onBeforeinput],
        ['input', onInput],
      ];
      for (const [name, handler] of diagEntries) {
        diagTextarea.addEventListener(name, handler, { capture: false, passive: true });
        diagListeners.push([name, handler]);
      }
    }
    // END DIAG S1 TRACE

    const copyTerminalSelection = async () => {
      const selection = nextTerminal.getSelection();
      if (!selection) {
        return false;
      }

      return copyTextToClipboard(selection);
    };

    const handleTerminalCopy = (event: ClipboardEvent) => {
      if (!nextTerminal.hasSelection()) {
        return;
      }

      const selection = nextTerminal.getSelection();
      if (!selection) {
        return;
      }

      event.preventDefault();

      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', selection);
        return;
      }

      void copyTextToClipboard(selection);
    };

    terminalContainerRef.current.addEventListener('copy', handleTerminalCopy);

    nextTerminal.attachCustomKeyEventHandler((event) => {
      const activeAuthUrl = isCodexLoginCommand(initialCommandRef.current)
        ? CODEX_DEVICE_AUTH_URL
        : authUrlRef.current;

      if (
        event.type === 'keydown' &&
        minimal &&
        isPlainShellRef.current &&
        activeAuthUrl &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key?.toLowerCase() === 'c'
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyAuthUrlToClipboard(activeAuthUrl);
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'c' &&
        nextTerminal.hasSelection()
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyTerminalSelection();
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'v'
      ) {
        // Block native paste so data is only injected after clipboard-read resolves.
        event.preventDefault();
        event.stopPropagation();

        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              sendSocketMessage(wsRef.current, {
                type: 'input',
                data: text,
              });
            })
            .catch(() => {});
        }

        return false;
      }

      return true;
    });

    window.setTimeout(() => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;
      const currentContainer = terminalContainerRef.current;
      if (!currentFitAddon || !currentTerminal || !currentContainer) {
        return;
      }

      // Skip fit while container is hidden; see resize observer below.
      if (currentContainer.clientWidth === 0 || currentContainer.clientHeight === 0) {
        return;
      }

      currentFitAddon.fit();
      sendSocketMessage(wsRef.current, {
        type: 'resize',
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
    }, TERMINAL_INIT_DELAY_MS);

    setIsInitialized(true);

    const dataSubscription = nextTerminal.onData((data) => {
      // S1 suppression: xterm fires onData in a setTimeout(0) after compositionend
      // (CompositionHelper._finalizeComposition) with the full composed string.  Our
      // reconciliation handlers already sent those characters incrementally, so we drop
      // the first onData that exactly matches the pending commit string.  Clearing the ref
      // immediately means only one call is suppressed per composition; any subsequent onData
      // (desktop keys, paste, prompt buttons) flows through normally.
      if (suppressCompositionDataRef.current !== null && data === suppressCompositionDataRef.current) {
        suppressCompositionDataRef.current = null;
        return;
      }
      sendSocketMessage(wsRef.current, {
        type: 'input',
        data,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        const currentFitAddon = fitAddonRef.current;
        const currentTerminal = terminalRef.current;
        const currentContainer = terminalContainerRef.current;
        if (!currentFitAddon || !currentTerminal || !currentContainer) {
          return;
        }

        // Skip fit while the tab is hidden (MainContent's block/hidden
        // pattern leaves the container at 0×0 instead of unmounting).
        // fit() would collapse cols/rows and ship a tiny SIGWINCH to
        // the PTY, corrupting claude's render until the next visible
        // refit. The display:none → block transition triggers another
        // ResizeObserver tick that refits cleanly.
        if (currentContainer.clientWidth === 0 || currentContainer.clientHeight === 0) {
          return;
        }

        currentFitAddon.fit();
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      }, TERMINAL_RESIZE_DELAY_MS);
    });

    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      // DIAG S1 TRACE — remove after capture
      if (diagTextarea) {
        for (const [name, handler] of diagListeners) {
          diagTextarea.removeEventListener(name, handler, { capture: false });
        }
      }
      // END DIAG S1 TRACE
      pendingCompositionRef.current = '';
      suppressCompositionDataRef.current = null;
      terminalContainerRef.current?.removeEventListener('copy', handleTerminalCopy);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      dataSubscription.dispose();
      closeSocket();
      disposeTerminal();
    };
  }, [
    authUrlRef,
    closeSocket,
    copyAuthUrlToClipboard,
    disposeTerminal,
    fitAddonRef,
    initialCommandRef,
    isPlainShellRef,
    isRestarting,
    minimal,
    hasSelectedProject,
    selectedProjectKey,
    terminalContainerRef,
    terminalRef,
    wsRef,
  ]);

  return {
    isInitialized,
    clearTerminalScreen,
    disposeTerminal,
  };
}
