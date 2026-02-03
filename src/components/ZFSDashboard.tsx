import { Box, Typography, Sheet } from '@mui/joy';
import ZFSPoolsTable from './zfs/ZFSPoolsTable';

export default function ZFSDashboard() {
  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography level="h2" sx={{ mb: 3 }}>
        ZFS Pools Dashboard
      </Typography>
      <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
        <ZFSPoolsTable />
      </Sheet>
    </Box>
  );
}
