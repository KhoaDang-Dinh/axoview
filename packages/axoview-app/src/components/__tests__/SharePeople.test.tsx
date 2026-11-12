/**
 * The email field under the share link (ADR 0057 §5, owner decisions
 * 2026-11-09/10): a permission level for each person (Read only by default,
 * or Full admin; agents are not members), green pop-up and
 * a cleared field on success; red pop-up and the email kept on every failure;
 * the people list with level changes and remove.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string'
        ? fallback
        : typeof fallback === 'object' && fallback && 'defaultValue' in fallback
          ? (fallback as { defaultValue: string }).defaultValue
          : key,
    i18n: { language: 'en' }
  })
}));

const pushes: Array<{ severity: string; message: string }> = [];
jest.mock('../../stores/notificationStore', () => ({
  notificationStore: { push: (n: { severity: string; message: string }) => pushes.push(n) }
}));

import { SharePeople } from '../SharePeople';
import type { AddMemberResult, DiagramMember, MemberRole } from '../../services/storage/types';

const BOB: DiagramMember = { sub: 'bob', email: 'bob@example.com', role: 'viewer', addedAt: '2026-11-10T00:00:00Z' };

function storage(overrides: Partial<{
  listMembers: (id: string) => Promise<DiagramMember[]>;
  addMember: (id: string, email: string, role?: MemberRole) => Promise<AddMemberResult>;
  setMemberRole: (id: string, sub: string, role: MemberRole) => Promise<AddMemberResult>;
  removeMember: (id: string, sub: string) => Promise<void>;
}> = {}) {
  return {
    listMembers: jest.fn(async () => [] as DiagramMember[]),
    addMember: jest.fn(async (_id: string, _email: string, role: MemberRole = 'viewer'): Promise<AddMemberResult> => ({ ok: true, member: { ...BOB, role } })),
    setMemberRole: jest.fn(async (_id: string, _sub: string, role: MemberRole): Promise<AddMemberResult> => ({ ok: true, member: { ...BOB, role } })),
    removeMember: jest.fn(async () => {}),
    ...overrides
  };
}

const input = () => document.querySelector('[data-axoview-id="share-email-input"]') as HTMLInputElement;
const addButton = () => document.querySelector('[data-axoview-id="share-email-add"]') as HTMLButtonElement;
const people = () => Array.from(document.querySelectorAll('[data-axoview-id="share-person"]')).map((el) => el.getAttribute('data-email'));

beforeEach(() => {
  pushes.length = 0;
});

async function type(value: string) {
  await act(async () => { fireEvent.change(input(), { target: { value } }); });
}

/** Pick an option in an MUI Select by its visible label. */
async function choose(select: HTMLElement, label: string) {
  await act(async () => { fireEvent.mouseDown(select); });
  await act(async () => { fireEvent.click(within(screen.getByRole('listbox')).getByText(label)); });
}
const levelPicker = () => screen.getByLabelText('Permission level');

it('success: Read only by default, a green pop-up, the field clears, and the person is listed', async () => {
  const s = storage();
  render(<SharePeople diagramId="d1" storage={s} />);
  await type('Bob@Example.com');
  await act(async () => { fireEvent.click(addButton()); });
  expect(s.addMember).toHaveBeenCalledWith('d1', 'Bob@Example.com', 'viewer');
  expect(pushes).toEqual([{ severity: 'success', message: 'Shared with bob@example.com (Read only)' }]);
  expect(input().value).toBe('');
  expect(people()).toEqual(['bob@example.com']);
});

it.each([
  ['no-account', 'No Axoview account uses that email'],
  ['already-shared', 'Already shared with bob@example.com'],
  ['self', "You can't share a diagram with yourself or its owner"],
  ['invalid-email', 'Enter a valid email address'],
  ['rate-limited', 'Too many attempts: try again in a minute'],
  ['error', "Couldn't share: try again"]
])('failure (%s): a red pop-up, and the email stays to be corrected', async (reason, message) => {
  const s = storage({ addMember: jest.fn(async (): Promise<AddMemberResult> => ({ ok: false, reason, message: 'server text' })) });
  render(<SharePeople diagramId="d1" storage={s} />);
  await type('bob@example.com');
  await act(async () => { fireEvent.click(addButton()); });
  expect(pushes).toEqual([{ severity: 'error', message }]);
  expect(input().value).toBe('bob@example.com');
  expect(people()).toEqual([]);
});

it('Enter adds too; an empty field adds nothing', async () => {
  const s = storage();
  render(<SharePeople diagramId="d1" storage={s} />);
  expect(addButton().disabled).toBe(true);
  await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }); });
  expect(s.addMember).not.toHaveBeenCalled();
  await type('bob@example.com');
  await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }); });
  expect(s.addMember).toHaveBeenCalledTimes(1);
});

it('lists the people it is already shared with, and removes one (green)', async () => {
  const s = storage({ listMembers: jest.fn(async () => [BOB]) });
  render(<SharePeople diagramId="d1" storage={s} />);
  await waitFor(() => expect(people()).toEqual(['bob@example.com']));
  await act(async () => { fireEvent.click(screen.getByLabelText('Remove bob@example.com')); });
  expect(s.removeMember).toHaveBeenCalledWith('d1', 'bob');
  expect(people()).toEqual([]);
  expect(pushes).toEqual([{ severity: 'success', message: 'No longer shared with bob@example.com' }]);
});

it('a failed remove: red, and the person stays listed', async () => {
  const s = storage({
    listMembers: jest.fn(async () => [BOB]),
    removeMember: jest.fn(async () => { throw new Error('offline'); })
  });
  render(<SharePeople diagramId="d1" storage={s} />);
  await waitFor(() => expect(people()).toEqual(['bob@example.com']));
  await act(async () => { fireEvent.click(screen.getByLabelText('Remove bob@example.com')); });
  expect(pushes).toEqual([{ severity: 'error', message: "Couldn't remove bob@example.com: try again" }]);
  expect(people()).toEqual(['bob@example.com']);
});

it('the level picker offers people Read only and Full admin; Full admin is sent', async () => {
  const s = storage();
  render(<SharePeople diagramId="d1" storage={s} />);
  await act(async () => { fireEvent.mouseDown(levelPicker()); });
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Read only', 'Full admin']);
  await act(async () => { fireEvent.click(within(screen.getByRole('listbox')).getByText('Full admin')); });
  await type('bob@example.com');
  await act(async () => { fireEvent.click(addButton()); });
  expect(s.addMember).toHaveBeenCalledWith('d1', 'bob@example.com', 'admin');
  expect(pushes).toEqual([{ severity: 'success', message: 'Shared with bob@example.com (Full admin)' }]);
});

it("changing a person's level: green, and the row shows the new level (people only: Read only or Full admin)", async () => {
  const s = storage({ listMembers: jest.fn(async () => [BOB]) });
  render(<SharePeople diagramId="d1" storage={s} />);
  await waitFor(() => expect(people()).toEqual(['bob@example.com']));
  await act(async () => { fireEvent.mouseDown(screen.getByLabelText('Access for bob@example.com')); });
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Read only', 'Full admin']);
  await act(async () => { fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' }); });
  await choose(screen.getByLabelText('Access for bob@example.com'), 'Full admin');
  expect(s.setMemberRole).toHaveBeenCalledWith('d1', 'bob', 'admin');
  expect(document.querySelector('[data-axoview-id="share-person"]')?.getAttribute('data-role')).toBe('admin');
  expect(pushes).toEqual([{ severity: 'success', message: 'bob@example.com is now Full admin' }]);
});
