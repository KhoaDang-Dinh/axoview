import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Button, Checkbox, FormControlLabel, IconButton, Paper, TextField, Typography } from '@mui/material';
import { diagramAgent } from 'axoview';
import { AutoAwesome, Add, KeyboardArrowDown, ArrowBack, OpenInNew, Send, SmartToy } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStorage } from '../../providers/AppStorageContext';
import { apiFetch } from '../../services/apiFetch';
import { useCognitoSessionStore } from '../../stores/cognitoSessionStore';
import { useAssistantPageStore } from '../../stores/assistantPageStore';
import { SuggestionChecklist } from './SuggestionChecklist';
import {
  AI_CONNECTORS, BUBBLE_SIZE, clampBubblePosition,
  persistBubblePosition, useAssistantStore
} from '../../stores/assistantStore';

type PlanStep = diagramAgent.PlanStep;

interface LiveMessage {
  role: 'user' | 'assistant';
  text: string;
  sources?: { id: string; title: string }[];
  /** Raw suggestions from the API, and the page they were checked against. */
  suggestions?: unknown[];
  viewId?: string;
  plan?: PlanStep[];
}

const isSource = (value: unknown): value is { id: string; title: string } =>
  typeof value === 'object' && value !== null &&
  typeof (value as { id?: unknown }).id === 'string' && typeof (value as { title?: unknown }).title === 'string';

export function AssistantWidget() {
  const { runtimeConfig, isInitialized } = useAppStorage();
  const signedIn = useCognitoSessionStore((state) => !!state.user);
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = isInitialized && runtimeConfig?.ai?.chatEnabled === true;
  const guestAllowed = runtimeConfig?.ai?.guestEnabled === true;
  const isGuest = !signedIn;
  const isShared = location.pathname.startsWith('/display/p/') || location.pathname.startsWith('/display/drive/');
  const open = useAssistantStore((state) => state.open);
  const view = useAssistantStore((state) => state.view);
  const position = useAssistantStore((state) => state.position);
  const setPosition = useAssistantStore((state) => state.setPosition);
  const openChat = useAssistantStore((state) => state.openChat);
  const minimize = useAssistantStore((state) => state.minimize);
  const showConnect = useAssistantStore((state) => state.showConnect);
  const showChat = useAssistantStore((state) => state.showChat);
  const expandedFamily = useAssistantStore((state) => state.expandedFamily);
  const setExpandedFamily = useAssistantStore((state) => state.setExpandedFamily);
  const messages = useAssistantStore((state) => state.messages);
  const sendMockMessage = useAssistantStore((state) => state.sendMockMessage);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);
  const [includePage, setIncludePage] = useState(false);
  const readPage = useAssistantPageStore((state) => state.readPage);
  // Real replies only when the server says live chat is fully configured;
  // otherwise the preview keeps its mock replies instead of failing every send.
  const liveEnabled = runtimeConfig?.ai?.liveChat === true && signedIn;
  // "Include this page": only where the deployment allows diagram context and
  // there is an editable diagram open (never on a shared, view-only link).
  const pageOption = liveEnabled && runtimeConfig?.ai?.diagramContextEnabled === true && !isShared && !!readPage;
  const pointer = useRef<{ id: number; x: number; y: number; initialX: number; initialY: number; dragged: boolean } | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () => {
      const p = useAssistantStore.getState().position;
      useAssistantStore.getState().setPosition(clampBubblePosition(p, window.innerWidth, window.innerHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => { listEndRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length, liveMessages.length]);

  // Never let a feature flag or shared route leak a former user's mock draft.
  useEffect(() => {
    setDraft('');
    setSendError(null);
    setLiveMessages([]);
    setConversationId(null);
    setIncludePage(false);
  }, [signedIn, location.pathname]);

  if (!enabled || (isGuest && !guestAllowed)) return null;

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (open || event.button !== 0) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
      initialX: position.x, initialY: position.y, dragged: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = pointer.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (Math.hypot(dx, dy) > 6) state.dragged = true;
    if (!state.dragged) return;
    setPosition(clampBubblePosition({ x: state.initialX + dx, y: state.initialY + dy },
      window.innerWidth, window.innerHeight));
  };
  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    const moved = pointer.current.dragged;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (moved) persistBubblePosition(useAssistantStore.getState().position);
    else openChat();
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    if (!liveEnabled) {
      sendMockMessage(message);
      setDraft('');
      return;
    }
    // Read the page at send time, and only if the user asked for it.
    const page = pageOption && includePage ? readPage?.() ?? null : null;
    if (pageOption && includePage && !page) {
      setSendError('Open a diagram first, or untick “Include this page”.');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const diagram = page ? diagramAgent.describeDiagram(page.model, { viewId: page.viewId }) : undefined;
      const response = await apiFetch('/api/ai/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}), ...(diagram ? { diagram } : {}) })
      });
      // A proxy or CDN error page is not JSON: show the generic message, not a parser error.
      const body: { error?: unknown; conversationId?: unknown; reply?: unknown; sources?: unknown; suggestions?: unknown } =
        await response.json().catch(() => ({}));
      if (!response.ok || typeof body.reply !== 'string' || typeof body.conversationId !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : 'AI chat is unavailable');
      }
      const reply = body.reply;
      const sources = Array.isArray(body.sources) ? body.sources.filter(isSource).slice(0, 3) : [];
      const suggestions = page && Array.isArray(body.suggestions) ? body.suggestions : [];
      // Each suggestion is checked against the live page before it is shown.
      const plan = page && suggestions.length
        ? diagramAgent.planOperations(page.model, page.viewId ?? diagram?.page.id, suggestions)
        : undefined;
      setConversationId(body.conversationId);
      setLiveMessages((current) => [
        ...current,
        { role: 'user' as const, text: message },
        { role: 'assistant' as const, text: reply, sources,
          ...(plan ? { suggestions, viewId: page?.viewId ?? diagram?.page.id, plan } : {}) }
      ].slice(-12));
      setDraft('');
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'AI chat is unavailable');
    } finally {
      setSending(false);
    }
  };
  const recheck = (index: number) => {
    const page = readPage?.();
    setLiveMessages((current) => current.map((entry, i) => (i === index && entry.suggestions && page
      ? { ...entry, plan: diagramAgent.planOperations(page.model, entry.viewId, entry.suggestions) }
      : entry)));
  };
  const chat = (
    <Box data-axoview-id="ai-assistant-root" sx={{ position: 'fixed', zIndex: 1400, pointerEvents: 'none', inset: 0 }}>
      {!open ? (
        <button
          type="button"
          aria-label="Open Axoview AI"
          data-axoview-id="ai-bubble"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={() => { pointer.current = null; }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(); } }}
          style={{ position: 'absolute', left: position.x, top: position.y, width: BUBBLE_SIZE,
            height: BUBBLE_SIZE, borderRadius: '50%', border: 'none', background: '#2563eb',
            color: '#fff', display: 'grid', placeItems: 'center', cursor: 'grab',
            touchAction: 'none', pointerEvents: 'auto', boxShadow: '0 8px 24px #0003' }}
        ><AutoAwesome /></button>
      ) : (
        <Paper
          data-axoview-id="ai-chat-window"
          elevation={8}
          sx={{ position: 'absolute', right: { xs: 8, sm: 16 }, bottom: { xs: 8, sm: 16 },
            width: { xs: 'calc(100vw - 16px)', sm: 380 }, height: { xs: 'min(75dvh, 560px)', sm: 520 },
            maxHeight: 'calc(100dvh - 16px)', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', borderRadius: 2, pointerEvents: 'auto', bgcolor: 'background.paper' }}
          role="region" aria-label="Axoview AI assistant"
        >
          <Box sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 1, borderBottom: 1, borderColor: 'divider' }}>
            {view === 'connect' ? (
              <IconButton aria-label="Back to chat" onClick={showChat} size="small"><ArrowBack /></IconButton>
            ) : <SmartToy color="primary" fontSize="small" />}
            <Typography sx={{ flexGrow: 1, fontWeight: 600 }} variant="subtitle2">
              {view === 'connect' ? 'Connect your AI' : 'Axoview AI'}
            </Typography>
            {view === 'chat' && <IconButton aria-label="Add AI connection" data-axoview-id="ai-connect-plus" onClick={showConnect} size="small"><Add /></IconButton>}
            <IconButton aria-label="Minimize assistant" data-axoview-id="ai-minimize" onClick={minimize} size="small"><KeyboardArrowDown /></IconButton>
          </Box>
          {view === 'chat' ? (
            <>
              <Box sx={{ p: 2, overflowY: 'auto', overflowX: 'hidden', flex: 1 }} aria-live="polite">
                <Typography variant="caption" color="text.secondary">{liveEnabled
                  ? (pageOption
                    ? 'Nova chat · Sees your page only when “Include this page” is ticked · History kept 30 days'
                    : 'Nova chat · No diagram access · History retained for 30 days')
                  : 'Guest preview only — no model or diagram data is sent.'}</Typography>
                {isShared && <Typography sx={{ mt: 1 }} variant="caption" display="block" color="text.secondary">View-only diagram: no editing access.</Typography>}
                {(liveEnabled ? liveMessages.map((message, id) => ({ ...message, id })) : messages).map((message) => {
                  const live = message as LiveMessage & { id: number };
                  return (
                    <Box key={message.id} sx={{ display: 'flex', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start', my: 1 }}>
                      <Box sx={{ p: 1.25, borderRadius: 2, maxWidth: '90%', minWidth: 0,
                        bgcolor: message.role === 'user' ? 'primary.main' : 'action.hover',
                        color: message.role === 'user' ? 'primary.contrastText' : 'text.primary' }}>
                        <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message.text}</Typography>
                        {live.plan && <SuggestionChecklist steps={live.plan} onRecheck={readPage ? () => recheck(live.id) : undefined} />}
                        {live.sources && live.sources.length > 0 && (
                          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}
                            data-axoview-id="ai-sources">
                            From the manual: {live.sources.map((source) => source.title).join(' · ')}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  );
                })}
                {sendError && <Typography role="alert" variant="body2" color="error">{sendError}</Typography>}
                {sending && <Typography variant="caption" color="text.secondary">Nova is responding…</Typography>}
                <div ref={listEndRef} />
              </Box>
              <Box component="form" onSubmit={submit} sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
                {pageOption && (
                  <FormControlLabel sx={{ ml: 0, mb: 0.5 }} data-axoview-id="ai-include-page"
                    control={<Checkbox size="small" checked={includePage} onChange={(e) => setIncludePage(e.target.checked)} />}
                    label={<Typography variant="caption">Include this page (item names, connections and text) for suggestions</Typography>} />
                )}
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <TextField fullWidth size="small" label="Message" value={draft} onChange={(e) => setDraft(e.target.value)}
                    inputProps={{ maxLength: 2000 }} />
                  <IconButton type="submit" color="primary" aria-label="Send message" disabled={!draft.trim() || sending}><Send /></IconButton>
                </Box>
              </Box>
            </>
          ) : (
            <Box sx={{ p: 2, overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Choose a client. Setup is informational until the remote MCP server and OAuth flow are deployed.
              </Typography>
              {AI_CONNECTORS.map((family) => (
                <Box key={family.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 2, mb: 1 }}>
                  <Button fullWidth sx={{ justifyContent: 'space-between', textTransform: 'none', p: 1.5 }}
                    onClick={() => setExpandedFamily(expandedFamily === family.id ? null : family.id)}>
                    {family.label} <Typography variant="caption" color="text.secondary">{family.clients.map(c => c.label).join(' / ')}</Typography>
                  </Button>
                  {expandedFamily === family.id && family.clients.map((client) => (
                    <Button key={client.id} fullWidth endIcon={<OpenInNew />} sx={{ justifyContent: 'space-between', textTransform: 'none' }}
                      data-axoview-id={`ai-client-${client.id}`}
                      onClick={() => navigate(`/ai/connect/${client.id}`, { state: { returnTo: location.pathname } })}>
                      {client.label}
                    </Button>
                  ))}
                </Box>
              ))}
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
  return createPortal(chat, document.body);
}
