import { describe, it, expect } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { DemoBanner } from '../../header/DemoBanner'

describe('DemoBanner', () => {
  it('renders the Self-host guide link with correct attributes', () => {
    render(<DemoBanner />)
    const link = screen.getByText('Self-host guide')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders the GitHub link with correct attributes', () => {
    render(<DemoBanner />)
    const link = screen.getByText('GitHub')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('hides the banner when the close button is clicked', () => {
    render(<DemoBanner />)
    const closeButton = screen.getByRole('button')
    expect(screen.getByText('Self-host guide')).not.toBeNull()
    fireEvent.click(closeButton)
    expect(screen.queryByText('Self-host guide')).toBeNull()
  })

  it('renders demo mode text', () => {
    render(<DemoBanner />)
    expect(screen.getByText('Demo mode')).not.toBeNull()
  })
})
