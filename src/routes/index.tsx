import { createFileRoute } from '@tanstack/react-router'
import '../App.css'
import { Box } from '@mui/joy';
import ThemeProvider from '../components/ThemeProvider';
import DockerDashboard from '../components/DockerDashboard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const queryClient = new QueryClient();

export const Route = createFileRoute('/')({ ssr: false, component: App })

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Box sx={{ minHeight: '100vh' }}>
          <DockerDashboard />
        </Box>
      </QueryClientProvider>
    </ThemeProvider>
  );
}