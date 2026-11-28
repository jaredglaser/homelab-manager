import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import '@/lib/test/testing-library';
import ZFSEntityCell from '../ZFSEntityCell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { findOpenTooltip } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';

const W4 = '3 read, 0 write and 12 checksum errors since the counters were last cleared.';

describe('ZFSEntityCell', () => {
  it('opens the error counts from the disk state chip', async () => {
    const user = setupUser();
    render(
      <TooltipProvider>
        <ZFSEntityCell name="sda" entityType="disk" indent={0} health={{ label: 'Faulted', tone: 'error', tooltip: W4 }} />
      </TooltipProvider>,
    );
    await user.hover(screen.getByText('Faulted'));
    expect(await findOpenTooltip()).toBe(W4);
  });

  it('shows the state chip, then the badge, then the scrub line', () => {
    render(
      <ZFSEntityCell
        name="tank"
        entityType="pool"
        indent={0}
        badge={{ label: 'mirror-0' }}
        health={{ label: 'Online', tone: 'ok' }}
        detail="Scrub running, 42% done"
      />,
    );
    const texts = [screen.getByText('Online'), screen.getByText('mirror-0'), screen.getByText('Scrub running, 42% done')];
    for (let i = 1; i < texts.length; i++) {
      expect(texts[i - 1].compareDocumentPosition(texts[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByText('Scrub running, 42% done').getAttribute('title')).toBe('Scrub running, 42% done');
  });
});
