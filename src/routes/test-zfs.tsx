import { createFileRoute } from '@tanstack/react-router';
import ThemeProvider from '../components/ThemeProvider';
import Header from '../components/Header';
import ZFSDashboard from '../components/ZFSDashboard';

export const Route = createFileRoute('/test-zfs')({
  component: TestZFS,
});

function TestZFS() {
  return (
    <ThemeProvider>
      <Header />
      <ZFSDashboard />
    </ThemeProvider>
  );
}
