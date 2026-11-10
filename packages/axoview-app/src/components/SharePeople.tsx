/**
 * "Add people" in the Share dropdown, under the link (ADR 0057 §5, owner
 * decisions 2026-11-09/10): type an email, pick a permission level, press Add
 * (or Enter). If an Axoview account with that verified email exists, the
 * diagram appears on their side.
 *
 * Levels (owner decision 2026-11-10):
 *   - Read only: they open it in the read-only viewer, the same one a public
 *     link shows;
 *   - Full admin: everything the owner can do;
 *   - Change needs approval: for AI agents, whose saves wait for the owner's
 *     or an admin's approval. Offered on agent rows only, for now.
 *
 * Feedback is a pop-up message: green on success, red on any failure (no
 * account, already shared, yourself, a network error). The field keeps the
 * email after a red message so it can be corrected, and clears after a green
 * one. Everyone it is shared with is listed below with their level, which can
 * be changed, and a remove button. For the owner and Full admins: the server
 * refuses everyone else.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import { Close as RemoveIcon, SmartToyOutlined as AgentIcon } from '@mui/icons-material';
import { notificationStore } from '../stores/notificationStore';
import type { DiagramMember, MemberRole, StorageProvider } from '../services/storage/types';

/** The storage calls this needs (optional on providers without sharing). */
export type SharePeopleStorage = Pick<StorageProvider, 'listMembers' | 'addMember' | 'setMemberRole' | 'removeMember'>;

type T = ReturnType<typeof useTranslation>['t'];

/** A level's name as the dropdown shows it. */
export function roleLabel(role: MemberRole, t: T): string {
  switch (role) {
    case 'viewer':
      return t('share.people.roleViewer', 'Read only');
    case 'proposer':
      return t('share.people.roleProposer', 'Change needs approval');
    default:
      return t('share.people.roleAdmin', 'Full admin');
  }
}

/** The levels a member of this kind can be given (agents: never Full admin). */
export function rolesFor(member: Pick<DiagramMember, 'kind' | 'role'>): MemberRole[] {
  if (member.kind === 'agent') return ['viewer', 'proposer'];
  // People get Read only or Full admin; "needs approval" stays visible on the
  // rare person who was given it through the API.
  return member.role === 'proposer' ? ['viewer', 'proposer', 'admin'] : ['viewer', 'admin'];
}

/** The red message for a failed add or change (reason codes from the server). */
export function addFailureMessage(reason: string, email: string, t: T): string {
  switch (reason) {
    case 'no-account':
      return t('share.people.noAccount', 'No Axoview account uses that email');
    case 'already-shared':
      return t('share.people.alreadyShared', { email, defaultValue: `Already shared with ${email}` });
    case 'self':
      return t('share.people.self', "You can't share a diagram with yourself or its owner");
    case 'invalid-email':
      return t('share.people.invalidEmail', 'Enter a valid email address');
    case 'agent-not-admin':
      return t('share.people.agentNotAdmin', 'An AI agent can be Read only or Change needs approval, never Full admin');
    case 'rate-limited':
      return t('share.people.rateLimited', 'Too many attempts: try again in a minute');
    default:
      return t('share.people.failed', "Couldn't share: try again");
  }
}

const memberName = (person: DiagramMember, t: T): string =>
  person.email || (person.kind === 'agent' ? t('share.people.agent', 'AI agent') : person.sub);

export function SharePeople({ diagramId, storage }: { diagramId: string; storage: SharePeopleStorage }) {
  const { t } = useTranslation('app');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');
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
        ? await storage.addMember(diagramId, typed, role)
        : { ok: false as const, reason: 'error', message: 'Sharing is not available here' };
      if (result.ok) {
        notificationStore.push({
          severity: 'success',
          message: t('share.people.added', {
            email: result.member.email,
            level: roleLabel(result.member.role, t),
            defaultValue: `Shared with ${result.member.email} (${roleLabel(result.member.role, t)})`
          })
        });
        setPeople((current) => [...current.filter((p) => p.sub !== result.member.sub), result.member]);
        setEmail('');
      } else {
        notificationStore.push({ severity: 'error', message: addFailureMessage(result.reason, typed, t) });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, diagramId, email, role, storage, t]);

  const changeRole = useCallback(async (person: DiagramMember, next: MemberRole) => {
    if (next === person.role) return;
    const result = storage.setMemberRole
      ? await storage.setMemberRole(diagramId, person.sub, next)
      : { ok: false as const, reason: 'error', message: '' };
    const name = memberName(person, t);
    if (result.ok) {
      setPeople((current) => current.map((p) => (p.sub === person.sub ? result.member : p)));
      notificationStore.push({
        severity: 'success',
        message: t('share.people.roleChanged', {
          name,
          level: roleLabel(next, t),
          defaultValue: `${name} is now ${roleLabel(next, t)}`
        })
      });
    } else {
      notificationStore.push({
        severity: 'error',
        message: result.reason === 'agent-not-admin'
          ? addFailureMessage(result.reason, name, t)
          : t('share.people.roleFailed', { name, defaultValue: `Couldn't change ${name}'s access: try again` })
      });
    }
  }, [diagramId, storage, t]);

  const remove = useCallback(async (person: DiagramMember) => {
    const name = memberName(person, t);
    try {
      if (!storage.removeMember) throw new Error('Sharing is not available here');
      await storage.removeMember(diagramId, person.sub);
      setPeople((current) => current.filter((p) => p.sub !== person.sub));
      notificationStore.push({
        severity: 'success',
        message: t('share.people.removed', { email: name, defaultValue: `No longer shared with ${name}` })
      });
    } catch {
      notificationStore.push({
        severity: 'error',
        message: t('share.people.removeFailed', { email: name, defaultValue: `Couldn't remove ${name}: try again` })
      });
    }
  }, [diagramId, storage, t]);

  return (
    <Stack spacing={1} data-axoview-id="share-people">
      <Typography variant="body2" color="text.secondary">
        {t('share.people.hint', 'Add people by email.')}
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
        <Select
          size="small"
          value={role}
          onChange={(event) => setRole(event.target.value as MemberRole)}
          inputProps={{
            'data-axoview-id': 'share-role-select',
            'aria-label': t('share.people.roleLabel', 'Permission level')
          }}
          sx={{ minWidth: 118, fontSize: 13 }}
        >
          {(['viewer', 'admin'] as MemberRole[]).map((level) => (
            <MenuItem key={level} value={level} data-axoview-id={`share-role-${level}`} sx={{ fontSize: 13 }}>
              {roleLabel(level, t)}
            </MenuItem>
          ))}
        </Select>
        <Button
          variant="contained"
          size="small"
          onClick={() => void add()}
          disabled={busy || !email.trim()}
          data-axoview-id="share-email-add"
          sx={{ textTransform: 'none', minWidth: 56 }}
        >
          {t('share.people.add', 'Add')}
        </Button>
      </Stack>
      {people.length > 0 && (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {people.map((person) => {
            const name = memberName(person, t);
            return (
              <Box
                component="li"
                key={person.sub}
                data-axoview-id="share-person"
                data-email={person.email ?? undefined}
                data-role={person.role}
                data-kind={person.kind}
                sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}
              >
                {person.kind === 'agent' && <AgentIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
                <Typography variant="body2" noWrap title={name} sx={{ flex: 1, minWidth: 0 }}>
                  {name}
                </Typography>
                <Select
                  size="small"
                  variant="standard"
                  disableUnderline
                  value={person.role}
                  onChange={(event) => void changeRole(person, event.target.value as MemberRole)}
                  inputProps={{
                    'data-axoview-id': 'share-person-role',
                    'aria-label': t('share.people.personRoleLabel', { name, defaultValue: `Access for ${name}` })
                  }}
                  sx={{ fontSize: 13 }}
                >
                  {rolesFor(person).map((level) => (
                    <MenuItem key={level} value={level} sx={{ fontSize: 13 }}>
                      {roleLabel(level, t)}
                    </MenuItem>
                  ))}
                </Select>
                <Tooltip title={t('share.people.remove', 'Remove')}>
                  <IconButton
                    size="small"
                    onClick={() => void remove(person)}
                    aria-label={t('share.people.removeLabel', { email: name, defaultValue: `Remove ${name}` })}
                    data-axoview-id="share-person-remove"
                  >
                    <RemoveIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Box>
      )}
    </Stack>
  );
}
