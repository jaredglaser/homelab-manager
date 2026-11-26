import { useFormContext } from 'react-hook-form'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import CopyButton from '@/components/settings/CopyButton'
import type { AddHostFormValues } from '@/components/settings/add-host-form'

const ZFS_SETUP_COMMANDS = `# Create the hlm-zfs user:
sudo useradd --system --no-create-home --shell /usr/sbin/nologin hlm-zfs
sudo groupadd -f zfs
sudo usermod -aG zfs hlm-zfs

# Get the UID/GID (copy the numeric uid= value for HLM_ZFS_UID,
# and the numeric gid= of the zfs group for HLM_ZFS_GID):
id hlm-zfs`

export default function ZfsSetupStep({ docker }: Readonly<{ docker: boolean }>) {
  const { register, formState: { errors } } = useFormContext<AddHostFormValues>()

  return (
    <div className="flex flex-col gap-3" data-testid="step-zfs-setup">
      <p className="text-sm text-muted-foreground">
        Run these commands on the target host to create the ZFS user:
      </p>
      <div className="relative">
        <pre className="p-3 rounded text-xs overflow-x-auto bg-level1 text-foreground">
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
        <Field id="hlm-zfs-uid" label="HLM_ZFS_UID" error={errors.hlmZfsUid?.message} className="flex-1">
          {(control) => <Input {...control} type="number" min={0} {...register('hlmZfsUid')} />}
        </Field>
        <Field id="hlm-zfs-gid" label="HLM_ZFS_GID" error={errors.hlmZfsGid?.message} className="flex-1">
          {(control) => <Input {...control} type="number" min={0} {...register('hlmZfsGid')} />}
        </Field>
      </div>
      {docker && (
        <Field
          id="docker-gid"
          label="DOCKER_GID"
          error={errors.dockerGid?.message}
          hint="GID of the docker group on the target host (run: getent group docker)"
        >
          {(control) => <Input {...control} type="number" min={0} {...register('dockerGid')} />}
        </Field>
      )}
    </div>
  )
}
