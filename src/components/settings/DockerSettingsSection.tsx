import {
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Option,
  Select,
  Typography,
} from '@mui/joy';
import type { DockerSettingsSaved } from '@/types/settings';

interface DockerSettingsSectionProps {
  values: {
    host: string;
    port: string;
    protocol: 'http' | 'https';
  };
  errors: Record<string, string>;
  saved: DockerSettingsSaved | null;
  onChange: (field: string, value: string) => void;
}

export default function DockerSettingsSection({
  values,
  errors,
  onChange,
}: DockerSettingsSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <Typography level="title-lg">Docker Connection</Typography>
      <Typography level="body-sm" textColor="text.tertiary">
        Configure the Docker API endpoint for container monitoring.
      </Typography>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormControl error={!!errors.protocol}>
          <FormLabel>Protocol</FormLabel>
          <Select
            value={values.protocol}
            onChange={(_, val) => {
              if (val) onChange('protocol', val);
            }}
          >
            <Option value="http">HTTP</Option>
            <Option value="https">HTTPS</Option>
          </Select>
          {errors.protocol && (
            <FormHelperText>{errors.protocol}</FormHelperText>
          )}
        </FormControl>

        <FormControl error={!!errors.host}>
          <FormLabel>Host</FormLabel>
          <Input
            placeholder="e.g. 192.168.1.100"
            value={values.host}
            onChange={(e) => onChange('host', e.target.value)}
          />
          {errors.host && <FormHelperText>{errors.host}</FormHelperText>}
        </FormControl>

        <FormControl error={!!errors.port}>
          <FormLabel>Port</FormLabel>
          <Input
            type="number"
            placeholder="2375"
            value={values.port}
            onChange={(e) => onChange('port', e.target.value)}
            slotProps={{ input: { min: 1, max: 65535 } }}
          />
          {errors.port && <FormHelperText>{errors.port}</FormHelperText>}
        </FormControl>
      </div>
    </div>
  );
}
