import { Typography, TextField } from '@mui/material'
import CopyButton from '@/components/settings/CopyButton'

const ZFS_SETUP_COMMANDS = `# Create the hlm-zfs user:
sudo useradd --system --no-create-home --shell /usr/sbin/nologin hlm-zfs
sudo groupadd -f zfs
sudo usermod -aG zfs hlm-zfs

# Get the UID/GID (copy the numeric uid= value for HLM_ZFS_UID,
# and the numeric gid= of the zfs group for HLM_ZFS_GID):
id hlm-zfs`

interface ZfsSetupStepProps {
  docker: boolean
  hlmZfsUid: string
  hlmZfsGid: string
  dockerGid: string
  onHlmZfsUidChange: (value: string) => void
  onHlmZfsGidChange: (value: string) => void
  onDockerGidChange: (value: string) => void
}

export default function ZfsSetupStep({
  docker,
  hlmZfsUid,
  hlmZfsGid,
  dockerGid,
  onHlmZfsUidChange,
  onHlmZfsGidChange,
  onDockerGidChange,
}: ZfsSetupStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-zfs-setup">
      <Typography variant="body2" className="text-(--mui-palette-text-secondary)">
        Run these commands on the target host to create the ZFS user:
      </Typography>
      <div className="relative">
        <pre className="p-3 rounded text-xs overflow-x-auto bg-(--mui-palette-background-level1) text-(--mui-palette-text-primary)">
          {ZFS_SETUP_COMMANDS}
        </pre>
        <div className="absolute top-1 right-1">
          <CopyButton text={ZFS_SETUP_COMMANDS} label="ZFS setup commands" />
        </div>
      </div>
      <Typography variant="body2" className="text-(--mui-palette-text-secondary) mt-2">
        From the output above: copy the number after <code>uid=</code> into HLM_ZFS_UID, and the number after{' '}
        <code>gid=</code> in the <code>(zfs)</code> supplementary group into HLM_ZFS_GID.
      </Typography>
      <div className="flex gap-2">
        <TextField
          label="HLM_ZFS_UID"
          value={hlmZfsUid}
          onChange={(e) => onHlmZfsUidChange(e.target.value)}
          size="small"
          type="number"
          className="flex-1"
          slotProps={{ htmlInput: { 'aria-label': 'HLM_ZFS_UID', min: 0 } }}
        />
        <TextField
          label="HLM_ZFS_GID"
          value={hlmZfsGid}
          onChange={(e) => onHlmZfsGidChange(e.target.value)}
          size="small"
          type="number"
          className="flex-1"
          slotProps={{ htmlInput: { 'aria-label': 'HLM_ZFS_GID', min: 0 } }}
        />
      </div>
      {docker && (
        <TextField
          label="DOCKER_GID"
          value={dockerGid}
          onChange={(e) => onDockerGidChange(e.target.value)}
          size="small"
          type="number"
          helperText="GID of the docker group on the target host (run: getent group docker)"
          slotProps={{ htmlInput: { 'aria-label': 'DOCKER_GID', min: 0 } }}
        />
      )}
    </div>
  )
}
