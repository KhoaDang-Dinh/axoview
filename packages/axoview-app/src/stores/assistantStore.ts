import { create } from 'zustand';

/** Phase 1 only: in-memory mocked conversations. Never stores private prompts in localStorage. */
export interface AssistantMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

export interface BubblePosition {
  x: number;
  y: number;
}

export const AI_CONNECTORS = [
  { id: 'openai', label: 'OpenAI', clients: [
    { id: 'chatgpt', label: 'ChatGPT' },
    { id: 'codex', label: 'Codex' }
  ] },
  { id: 'anthropic', label: 'Anthropic', clients: [
    { id: 'claude', label: 'Claude' },
    { id: 'claude-code', label: 'Claude Code' }
  ] },
  { id: 'google', label: 'Google', clients: [
    { id: 'gemini', label: 'Gemini' },
    { id: 'gemini-cli', label: 'Gemini CLI' }
  ] }
] as const;

export function findAiConnector(id: string | undefined) {
  return AI_CONNECTORS.flatMap((family) =>
    family.clients.map((client) => ({ ...client, family: family.label }))
  ).find((client) => client.id === id);
}

const POSITION_KEY = 'axoview.ai.bubble-position';
export const BUBBLE_SIZE = 56;
export const EDGE_GAP = 12;

export function clampBubblePosition(position: BubblePosition, width: number, height: number): BubblePosition {
  return {
    x: Math.max(EDGE_GAP, Math.min(position.x, Math.max(EDGE_GAP, width - BUBBLE_SIZE - EDGE_GAP))),
    y: Math.max(EDGE_GAP, Math.min(position.y, Math.max(EDGE_GAP, height - BUBBLE_SIZE - EDGE_GAP)))
  };
}

export function initialBubblePosition(): BubblePosition {
  if (typeof window === 'undefined') return { x: 12, y: 12 };
  let candidate = { x: window.innerWidth - 76, y: window.innerHeight - 84 };
  try {
    const stored = window.sessionStorage.getItem(POSITION_KEY);
    if (stored) {
      const decoded: unknown = JSON.parse(stored);
      if (decoded && typeof decoded === 'object' &&
        Number.isFinite((decoded as BubblePosition).x) && Number.isFinite((decoded as BubblePosition).y)) {
        candidate = decoded as BubblePosition;
      }
    }
  } catch { /* Unavailable storage must never prevent editor boot. */ }
  return clampBubblePosition(candidate, window.innerWidth, window.innerHeight);
}

export function persistBubblePosition(position: BubblePosition) {
  try { window.sessionStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* optional */ }
}

interface AssistantState {
  open: boolean;
  view: 'chat' | 'connect';
  expandedFamily: string | null;
  identity: string | null;
  messages: AssistantMessage[];
  nextId: number;
  position: BubblePosition;
  openChat: () => void;
  minimize: () => void;
  showConnect: () => void;
  showChat: () => void;
  setExpandedFamily: (value: string | null) => void;
  setPosition: (value: BubblePosition) => void;
  activateIdentity: (value: string) => void;
  sendMockMessage: (message: string) => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  view: 'chat',
  expandedFamily: null,
  identity: null,
  messages: [],
  nextId: 1,
  position: initialBubblePosition(),
  openChat: () => set({ open: true, view: 'chat' }),
  minimize: () => set({ open: false, view: 'chat', expandedFamily: null }),
  showConnect: () => set({ view: 'connect' }),
  showChat: () => set({ view: 'chat' }),
  setExpandedFamily: (value) => set({ expandedFamily: value }),
  setPosition: (value) => set({ position: value }),
  activateIdentity: (value) => set((state) =>
    state.identity === value ? state : {
      identity: value, messages: [], nextId: 1, view: 'chat', expandedFamily: null, open: false
    }),
  sendMockMessage: (raw) => set((state) => {
    const message = raw.trim().slice(0, 2000);
    if (!message) return state;
    const response = 'Phase 1 preview: the chat interface works, but model responses and diagram analysis are not connected yet.';
    return {
      messages: [...state.messages.slice(-28),
        { id: state.nextId, role: 'user' as const, text: message },
        { id: state.nextId + 1, role: 'assistant' as const, text: response }],
      nextId: state.nextId + 2
    };
  })
}));
