import { createFileRoute } from '@tanstack/react-router';
import FindingsFeed from '@/components/findings/FindingsFeed';

export const Route = createFileRoute('/log-analysis')({
  ssr: false,
  component: FindingsFeed,
});
