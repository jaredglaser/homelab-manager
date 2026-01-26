import { Box, Typography, Sheet } from '@mui/joy';
import { mockContainers } from '../data/mock-docker-containers';
import ContainerTable from './docker/ContainerTable';

export default function DockerDashboard() {
  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography level="h2" sx={{ mb: 3 }}>
        Docker Containers Dashboard
      </Typography>
      <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
        <ContainerTable containers={mockContainers} />
      </Sheet>
    </Box>
  );
}
