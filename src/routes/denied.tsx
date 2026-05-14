import { createFileRoute } from '@tanstack/react-router';
import DeniedPage from '@/components/auth/DeniedPage';

export const Route = createFileRoute('/denied')({
  ssr: false,
  component: DeniedPage,
});
