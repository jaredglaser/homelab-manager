import {
  Alert,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Option,
  Select,
  Typography,
} from '@mui/joy';
import { Info } from 'lucide-react';
import type { ZFSSettingsSaved } from '@/types/settings';

interface ZFSSettingsSectionProps {
  values: {
    host: string;
    port: string;
    username: string;
    authType: 'password' | 'privateKey';
    password: string;
    keyPath: string;
    passphrase: string;
  };
  errors: Record<string, string>;
  saved: ZFSSettingsSaved | null;
  onChange: (field: string, value: string) => void;
}

export default function ZFSSettingsSection({
  values,
  errors,
  saved,
  onChange,
}: ZFSSettingsSectionProps) {
  const showPasswordSavedHint =
    saved?.hasPassword && values.authType === 'password' && !values.password;
  const showPassphraseSavedHint =
    saved?.hasPassphrase && values.authType === 'privateKey' && !values.passphrase;

  return (
    <div className="flex flex-col gap-3">
      <Typography level="title-lg">ZFS SSH Connection</Typography>
      <Typography level="body-sm" textColor="text.tertiary">
        Configure the SSH connection used for ZFS pool monitoring.
      </Typography>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormControl error={!!errors.host}>
          <FormLabel>Host</FormLabel>
          <Input
            placeholder="e.g. 192.168.1.200"
            value={values.host}
            onChange={(e) => onChange('host', e.target.value)}
          />
          {errors.host && <FormHelperText>{errors.host}</FormHelperText>}
        </FormControl>

        <FormControl error={!!errors.port}>
          <FormLabel>Port</FormLabel>
          <Input
            type="number"
            placeholder="22"
            value={values.port}
            onChange={(e) => onChange('port', e.target.value)}
            slotProps={{ input: { min: 1, max: 65535 } }}
          />
          {errors.port && <FormHelperText>{errors.port}</FormHelperText>}
        </FormControl>

        <FormControl error={!!errors.username}>
          <FormLabel>Username</FormLabel>
          <Input
            placeholder="root"
            value={values.username}
            onChange={(e) => onChange('username', e.target.value)}
          />
          {errors.username && (
            <FormHelperText>{errors.username}</FormHelperText>
          )}
        </FormControl>

        <FormControl error={!!errors.authType}>
          <FormLabel>Authentication Type</FormLabel>
          <Select
            value={values.authType}
            onChange={(_, val) => {
              if (val) onChange('authType', val);
            }}
          >
            <Option value="password">Password</Option>
            <Option value="privateKey">Private Key</Option>
          </Select>
          {errors.authType && (
            <FormHelperText>{errors.authType}</FormHelperText>
          )}
        </FormControl>
      </div>

      {values.authType === 'password' && (
        <div className="flex flex-col gap-3">
          <FormControl error={!!errors.password}>
            <FormLabel>Password</FormLabel>
            <Input
              type="password"
              placeholder={showPasswordSavedHint ? '••••••••' : 'Enter password'}
              value={values.password}
              onChange={(e) => onChange('password', e.target.value)}
            />
            {errors.password && (
              <FormHelperText>{errors.password}</FormHelperText>
            )}
          </FormControl>
          {showPasswordSavedHint && (
            <Alert
              variant="soft"
              color="neutral"
              size="sm"
              startDecorator={<Info size={16} />}
            >
              A password is already saved. Leave blank to keep the current password, or enter a new one to replace it.
            </Alert>
          )}
        </div>
      )}

      {values.authType === 'privateKey' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormControl error={!!errors.keyPath} className="sm:col-span-2">
            <FormLabel>Private Key Path</FormLabel>
            <Input
              placeholder="/home/user/.ssh/id_rsa"
              value={values.keyPath}
              onChange={(e) => onChange('keyPath', e.target.value)}
            />
            {errors.keyPath && (
              <FormHelperText>{errors.keyPath}</FormHelperText>
            )}
          </FormControl>

          <FormControl error={!!errors.passphrase} className="sm:col-span-2">
            <FormLabel>Passphrase (optional)</FormLabel>
            <Input
              type="password"
              placeholder={showPassphraseSavedHint ? '••••••••' : 'Enter passphrase if key is encrypted'}
              value={values.passphrase}
              onChange={(e) => onChange('passphrase', e.target.value)}
            />
            {errors.passphrase && (
              <FormHelperText>{errors.passphrase}</FormHelperText>
            )}
          </FormControl>
          {showPassphraseSavedHint && (
            <Alert
              variant="soft"
              color="neutral"
              size="sm"
              startDecorator={<Info size={16} />}
              className="sm:col-span-2"
            >
              A passphrase is already saved. Leave blank to keep the current passphrase, or enter a new one to replace it.
            </Alert>
          )}
        </div>
      )}

      <Alert
        variant="outlined"
        color="warning"
        size="sm"
        startDecorator={<Info size={16} />}
      >
        Passwords and passphrases are never displayed after saving. You will need to re-enter them if you want to change them.
      </Alert>
    </div>
  );
}
