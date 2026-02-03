import { createFileRoute } from '@tanstack/react-router';
import { CssVarsProvider } from '@mui/joy/styles';
import CssBaseline from '@mui/joy/CssBaseline';
import ZFSDashboard from '../components/ZFSDashboard';

export const Route = createFileRoute('/test-zfs')({
  component: TestZFS,
});

function TestZFS() {
  return (
    <CssVarsProvider>
      <CssBaseline />
      <ZFSDashboard />
    </CssVarsProvider>
  );
}
