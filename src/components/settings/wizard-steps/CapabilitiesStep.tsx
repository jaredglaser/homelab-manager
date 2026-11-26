import { useFormContext } from 'react-hook-form'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AddHostFormValues } from '@/components/settings/add-host-form'

const CAPABILITIES_ERROR_ID = 'wizard-capabilities-error'

export default function CapabilitiesStep() {
  const { register, setValue, trigger, watch, formState: { errors } } = useFormContext<AddHostFormValues>()
  const docker = watch('docker')
  const zfs = watch('zfs')
  const capabilitiesError = errors.zfs?.message

  // The "at least one" rule is reported on zfs, so both boxes re-check it.
  function setCapability(field: 'docker' | 'zfs', checked: boolean) {
    setValue(field, checked, { shouldDirty: true, shouldTouch: true })
    void trigger(['docker', 'zfs'])
  }

  return (
    <div className="flex flex-col gap-3" data-testid="step-capabilities">
      <Field
        id="wizard-host-name"
        label="Host Name"
        error={errors.name?.message}
        hint={<>Used as the agent's <code>AGENT_HOST_NAME</code>, so it goes into the files in the next steps.</>}
      >
        {(control) => <Input {...control} placeholder="dev-machine" autoComplete="off" {...register('name')} />}
      </Field>
      <p className="text-sm text-muted-foreground">
        Select the capabilities this host will provide:
      </p>
      <div className="flex items-center gap-2">
        <Checkbox
          id="capability-docker"
          checked={docker}
          onCheckedChange={(checked) => setCapability('docker', checked)}
          aria-label="Docker capability"
          aria-describedby={capabilitiesError ? CAPABILITIES_ERROR_ID : undefined}
        />
        <Label htmlFor="capability-docker" className="cursor-pointer">Docker</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="capability-zfs"
          checked={zfs}
          onCheckedChange={(checked) => setCapability('zfs', checked)}
          aria-label="ZFS capability"
          aria-describedby={capabilitiesError ? CAPABILITIES_ERROR_ID : undefined}
        />
        <Label htmlFor="capability-zfs" className="cursor-pointer">ZFS</Label>
      </div>
      {capabilitiesError && <FieldError id={CAPABILITIES_ERROR_ID}>{capabilitiesError}</FieldError>}
    </div>
  )
}
