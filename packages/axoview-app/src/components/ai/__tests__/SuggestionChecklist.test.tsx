import { fireEvent, render, screen } from '@testing-library/react';
import { SuggestionChecklist } from '../SuggestionChecklist';

// Steps as axoview-lib planOperations returns them.
const steps = [
  {
    index: 0, status: 'ready' as const, summary: 'Connect “Web” to “Database”, named “SQL”',
    reason: 'The web tier queries the database.', howTo: 'Press C, click the first item, then click the second.',
    manualSection: 'connectors-connecting-two-items', nodeIds: ['n1', 'n2']
  },
  {
    index: 1, status: 'not_applicable' as const, summary: 'Remove “Legacy FTP” and its connections',
    problem: 'There is no item called “Legacy FTP” on this page.', howTo: 'Select the item and press Delete.',
    manualSection: 'nodes-deleting-an-item', nodeIds: []
  },
  { index: 2, status: 'invalid' as const, summary: 'Unrecognised suggestion', howTo: '', manualSection: '', nodeIds: [] }
];

describe('SuggestionChecklist', () => {
  test('shows each usable step with its reason and how-to, and why the others do not apply', () => {
    render(<SuggestionChecklist steps={steps} />);
    expect(screen.getByText(/nothing is changed automatically/)).toBeTruthy();
    expect(screen.getByText('Connect “Web” to “Database”, named “SQL”')).toBeTruthy();
    expect(screen.getByText('The web tier queries the database.')).toBeTruthy();
    expect(screen.getByText(/Press C/)).toBeTruthy();
    expect(screen.getByText('Not applicable: There is no item called “Legacy FTP” on this page.')).toBeTruthy();
    expect(screen.queryByText('Unrecognised suggestion')).toBeNull();
  });

  test('ticking a step crosses it out; a step that does not apply cannot be ticked', () => {
    render(<SuggestionChecklist steps={steps} />);
    const ready = screen.getByLabelText('Done: Connect “Web” to “Database”, named “SQL”') as HTMLInputElement;
    fireEvent.click(ready);
    expect(ready.checked).toBe(true);
    expect(screen.getByText('Connect “Web” to “Database”, named “SQL”').getAttribute('data-done')).toBe('true');
    expect((screen.getByLabelText('Done: Remove “Legacy FTP” and its connections') as HTMLInputElement).disabled).toBe(true);
  });

  test('re-checks on request and renders nothing when there is nothing to show', () => {
    const onRecheck = jest.fn();
    const { container, rerender } = render(<SuggestionChecklist steps={steps} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByText('Check again against the page'));
    expect(onRecheck).toHaveBeenCalled();
    rerender(<SuggestionChecklist steps={[steps[2]]} />);
    expect(container.textContent).toBe('');
  });

  describe('"Changes need my approval"', () => {
    const second = { ...steps[0], index: 3, summary: 'Add “Cache”', nodeIds: [] };

    test('each step that applies can be approved, alone or all at once; no tick boxes or how-to', () => {
      const onApprove = jest.fn();
      render(<SuggestionChecklist steps={[...steps, second]} onApprove={onApprove} />);
      expect(screen.getByText(/nothing changes until you approve/)).toBeTruthy();
      expect(screen.queryByLabelText(/^Done:/)).toBeNull();
      expect(screen.queryByText(/Press C/)).toBeNull();
      expect(screen.queryByLabelText('Approve: Remove “Legacy FTP” and its connections')).toBeNull();
      fireEvent.click(screen.getByLabelText('Approve: Connect “Web” to “Database”, named “SQL”'));
      expect(onApprove).toHaveBeenLastCalledWith([0]);
      fireEvent.click(screen.getByText('Approve all 2'));
      expect(onApprove).toHaveBeenLastCalledWith([0, 3]);
    });

    test('an approved step shows as done, with nothing left to approve on it', () => {
      render(<SuggestionChecklist steps={[steps[1], second]} applied={[steps[0]]} onApprove={jest.fn()} />);
      const done = document.querySelector('[data-axoview-id="ai-suggestion-0"]')!;
      expect(done.getAttribute('data-status')).toBe('applied');
      expect(done.textContent).toContain('Approved and done');
      expect(screen.queryByLabelText('Approve: Connect “Web” to “Database”, named “SQL”')).toBeNull();
      // One step left to approve: no "Approve all".
      expect(screen.queryByText(/Approve all/)).toBeNull();
    });
  });
});
