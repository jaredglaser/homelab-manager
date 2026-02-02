import { createFileRoute } from '@tanstack/react-router'
import '../App.css'
import { CssVarsProvider } from '@mui/joy/styles';
import CssBaseline from '@mui/joy/CssBaseline';
import { Box } from '@mui/joy';
import DockerDashboard from '../components/DockerDashboard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const queryClient = new QueryClient();

export const Route = createFileRoute('/')({ ssr: false, component: App })

export default function App() {
  return (
    <CssVarsProvider>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
      <Box sx={{ minHeight: '100vh' }}>
        <DockerDashboard />
      </Box>
      </QueryClientProvider>
    </CssVarsProvider>
  );
}