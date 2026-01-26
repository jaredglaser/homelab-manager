import { createFileRoute } from '@tanstack/react-router'
import '../App.css'
import { CssVarsProvider } from '@mui/joy/styles';
import CssBaseline from '@mui/joy/CssBaseline';
import { Box } from '@mui/joy';
import DockerDashboard from '../components/DockerDashboard';

export const Route = createFileRoute('/')({ component: App })

export default function App() {
  return (
    <CssVarsProvider>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh' }}>
        <DockerDashboard />
      </Box>
    </CssVarsProvider>
  );
}
