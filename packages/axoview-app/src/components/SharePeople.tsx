/**
 * "Add people" in the Share dropdown, under the link (ADR 0057 §5, owner
 * decisions 2026-11-09/10): type an email, press Add (or Enter). If an
 * Axoview account with that verified email exists, the diagram appears on
 * their side and they can edit it. Feedback is a pop-up message: green on
 * success, red on any failure (no account, already shared, yourself, a
 * network error). The field keeps the email after a red message so it can be
 * corrected, and clears after a green one. The people it is shared with are
 * listed below, each with a remove button. Owner only: the server refuses
 * everyone else.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import { Close as RemoveIcon } from '@mui/icons-material';
import { notificationStore } from '../stores/notificationStore';
import type { DiagramMember, StorageProvider } from '../services/storage/types';

/** The storage calls this needs (optional on providers without sharing). */
export type SharePeopleStorage = Pick<StorageProvider, 'listMembers' | 'addMember' | 'removeMember'>;

/** The red message for a failed add (reason codes from the server). */
export function addFailureMessage(
  reason: string,
  email: string,
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (reason) {
    case 'no-account':
      return t('share.people.noAccount', 'No Axoview account uses that email');
    case 'already-shared':
      return t('share.people.alreadyShared', { email, defaultValue: `Already shared with ${email}` });
    case 'self':
      return t('share.people.self', "You can't share a diagram with yourself");
    case 'invalid-email':
      return t('share.people.invalidEmail', 'Enter a valid email address');
    case 'rate-limited':
      return t('share.people.rateLimited', 'Too many attempts: try again in a minute');
    default:
      return t('share.people.failed', "Couldn't share: try again");
  }
}

export function SharePeople({ diagramId, storage }: { diagramId: string; storage: SharePeopleStorage }) {
  const { t } = useTranslation('app');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<DiagramMember[]>([]);

  useEffect(() => {
    let live = true;
    if (!storage.listMembers) return undefined;
    storage.listMembers(diagramId).then(
      (members) => { if (live) setPeople(members); },
      () => { /* the list is a convenience; adding still works */ }
    );
    return () => { live = false; };
  }, [diagramId, storage]);

  const add = useCallback(async () => {
    const typed = email.trim();
    if (!typed || busy) return;
    setBusy(true);
    try {
      const result = storage.addMember
        ? await storage.addMember(diagramId, typed)
        : { ok: false as const, reason: 'error', message: 'Sharing is not available here' };
      if (result.ok) {
        notificationStore.push({
          severity: 'success',
          message: t('share.people.added', { email: result.member.email, defaultValue: `Shared with ${result.member.email}` })
        });
        setPeople((current) => [...current.filter((p) => p.sub !== result.member.sub), result.member]);
        setEmail('');
      } else {
        notificationStore.push({ severity: 'error', message: addFailureMessage(result.reason, typed, t) });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, diagramId, email, storage, t]);

  const remove = useCallback(async (person: DiagramMember) => {
    try {
      if (!storage.removeMember) throw new Error('Sharing is not available here');
      await storage.removeMember(diagramId, person.sub);
      setPeople((current) => current.filter((p) => p.sub !== person.sub));
      notificationStore.push({
        severity: 'success',
        message: t('share.people.removed', { email: person.email, defaultValue: `No longer shared with ${person.email}` })
      });
    } catch {
      notificationStore.push({
        severity: 'error',
        message: t('share.people.removeFailed', { email: person.email, defaultValue: `Couldn't remove ${person.email}: try again` })
      });
    }
  }, [diagramId, storage, t]);

  return (
    <Stack spacing={1} data-axoview-id="share-people">
      <Typography variant="body2" color="text.secondary">
        {t('share.people.hint', 'Add people by email. They can open and edit this diagram.')}
      </Typography>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          fullWidth
          type="email"
          placeholder={t('share.people.placeholder', 'name@example.com')}
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
          inputProps={{
            'data-axoview-id': 'share-email-input',
            'aria-label': t('share.people.emailLabel', 'Email address to share with')
          }}
        />
        <Button
          variant="contained"
          size="small"
          onClick={() => void add()}
          disabled={busy || !email.trim()}
          data-axoview-id="share-email-add"
          sx={{ textTransform: 'none', minWidth: 64 }}
        >
          {t('share.people.add', 'Add')}
        </Button>
      </Stack>
      {people.length > 0 && (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {people.map((person) => (
            <Box
              component="li"
              key={person.sub}
              data-axoview-id="share-person"
              data-email={person.email}
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.25 }}
            >
              <Typography variant="body2" noWrap title={person.email}>
                {person.email}
              </Typography>
              <Tooltip title={t('share.people.remove', 'Remove')}>
                <IconButton
                  size="small"
                  onClick={() => void remove(person)}
                  aria-label={t('share.people.removeLabel', { email: person.email, defaultValue: `Remove ${person.email}` })}
                  data-axoview-id="share-person-remove"
                >
                  <RemoveIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
        </Box>
      )}
    </Stack>
  );
}
