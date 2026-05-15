import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import LoginPage from '@/components/auth/LoginPage';

export const Route = createFileRoute('/login')({
  ssr: false,
  validateSearch: z.object({ prompt: z.string().optional() }),
  component: function LoginRoute() {
    const { prompt } = Route.useSearch();
    return <LoginPage prompt={prompt} />;
  },
});
