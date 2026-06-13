import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
      <p className="text-sm text-muted-foreground">
        Run these commands on the target host to create the ZFS user:
      </p>
      <div className="relative">
        <pre className="p-3 rounded text-xs overflow-x-auto bg-(--level1) text-(--foreground)">
          {ZFS_SETUP_COMMANDS}
        </pre>
        <div className="absolute top-1 right-1">
          <CopyButton text={ZFS_SETUP_COMMANDS} label="ZFS setup commands" />
        </div>
      </div>
      <p className="text-sm text-muted-foreground mt-2">
        From the output above: copy the number after <code>uid=</code> into HLM_ZFS_UID, and the number after{' '}
        <code>gid=</code> in the <code>(zfs)</code> supplementary group into HLM_ZFS_GID.
      </p>
      <div className="flex gap-2">
        <div className="flex flex-col gap-1 flex-1">
          <Label htmlFor="hlm-zfs-uid">HLM_ZFS_UID</Label>
          <Input
            id="hlm-zfs-uid"
            value={hlmZfsUid}
            onChange={(e) => onHlmZfsUidChange(e.target.value)}
            type="number"
            min={0}
            aria-label="HLM_ZFS_UID"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <Label htmlFor="hlm-zfs-gid">HLM_ZFS_GID</Label>
          <Input
            id="hlm-zfs-gid"
            value={hlmZfsGid}
            onChange={(e) => onHlmZfsGidChange(e.target.value)}
            type="number"
            min={0}
            aria-label="HLM_ZFS_GID"
          />
        </div>
      </div>
      {docker && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="docker-gid">DOCKER_GID</Label>
          <Input
            id="docker-gid"
            value={dockerGid}
            onChange={(e) => onDockerGidChange(e.target.value)}
            type="number"
            min={0}
            aria-label="DOCKER_GID"
          />
          <p className="text-xs text-muted-foreground">
            GID of the docker group on the target host (run: getent group docker)
          </p>
        </div>
      )}
    </div>
  )
}
