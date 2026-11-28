import { describe, it, expect } from 'bun:test'
import { ZodError } from 'zod'
import { createGitToken, listGitTokens } from '@/lib/mock/functions/git-tokens.functions'

async function rejectionIssues(label: string): Promise<string[]> {
  const err: unknown = await createGitToken({ data: { label } }).then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ZodError)
  return (err as ZodError).issues.map((issue) => issue.message)
}

describe('mock createGitToken', () => {
  it('refuses a label with the server rule and its wording', async () => {
    expect(await rejectionIssues('')).toEqual(['Enter a label for this token.'])
    expect(await rejectionIssues('a'.repeat(101))).toEqual(['Use 100 characters or fewer.'])
  })

  it('stores an accepted label as sent', async () => {
    await createGitToken({ data: { label: 'deploy-bot' } })
    expect((await listGitTokens())[0].label).toBe('deploy-bot')
  })
})
