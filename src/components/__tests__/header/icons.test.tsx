import { describe, it, expect } from 'bun:test'
import { render } from '@testing-library/react'
import { DockerIcon, ProxmoxIcon } from '@/components/header/icons'

describe('DockerIcon', () => {
  it('renders an svg with aria-hidden', () => {
    const { container } = render(<DockerIcon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses the correct viewBox', () => {
    const { container } = render(<DockerIcon />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('-23 -23 558 558')
  })

  it('uses default size of 18', () => {
    const { container } = render(<DockerIcon />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('18')
    expect(svg?.getAttribute('height')).toBe('18')
  })

  it('honors the size prop', () => {
    const { container } = render(<DockerIcon size={24} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })
})

describe('ProxmoxIcon', () => {
  it('renders an svg with aria-hidden', () => {
    const { container } = render(<ProxmoxIcon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses the correct viewBox', () => {
    const { container } = render(<ProxmoxIcon />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('-22 -22 557 557')
  })

  it('uses default size of 18', () => {
    const { container } = render(<ProxmoxIcon />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('18')
    expect(svg?.getAttribute('height')).toBe('18')
  })

  it('honors the size prop', () => {
    const { container } = render(<ProxmoxIcon size={24} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })
})
