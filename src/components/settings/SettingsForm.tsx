import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Divider,
  Typography,
  CircularProgress,
} from '@mui/joy';
import { Save, Check } from 'lucide-react';
import { dockerFormSchema, zfsFormSchema } from '@/lib/validation/settings-schemas';
import { getSettings, saveSettings } from '@/data/settings.functions';
import type { SettingsSaved } from '@/types/settings';
import DockerSettingsSection from './DockerSettingsSection';
import ZFSSettingsSection from './ZFSSettingsSection';

interface FormState {
  docker: {
    host: string;
    port: string;
    protocol: 'http' | 'https';
  };
  zfs: {
    host: string;
    port: string;
    username: string;
    authType: 'password' | 'privateKey';
    password: string;
    keyPath: string;
    passphrase: string;
  };
}

function createInitialFormState(saved: SettingsSaved | null): FormState {
  return {
    docker: {
      host: saved?.docker.host ?? '',
      port: saved?.docker.port?.toString() ?? '2375',
      protocol: saved?.docker.protocol ?? 'http',
    },
    zfs: {
      host: saved?.zfs.host ?? '',
      port: saved?.zfs.port?.toString() ?? '22',
      username: saved?.zfs.username ?? 'root',
      authType: saved?.zfs.authType ?? 'password',
      password: '',
      keyPath: saved?.zfs.keyPath ?? '',
      passphrase: '',
    },
  };
}

export default function SettingsForm() {
  const [formState, setFormState] = useState<FormState>(
    createInitialFormState(null),
  );
  const [savedState, setSavedState] = useState<SettingsSaved | null>(null);
  const [errors, setErrors] = useState<{
    docker: Record<string, string>;
    zfs: Record<string, string>;
  }>({ docker: {}, zfs: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((saved) => {
        setSavedState(saved);
        setFormState(createInitialFormState(saved));
      })
      .catch(() => {
        setSaveError('Failed to load settings');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleDockerChange = useCallback((field: string, value: string) => {
    setFormState((prev) => ({
      ...prev,
      docker: { ...prev.docker, [field]: value },
    }));
    setErrors((prev) => ({
      ...prev,
      docker: { ...prev.docker, [field]: '' },
    }));
    setSaveSuccess(false);
  }, []);

  const handleZFSChange = useCallback((field: string, value: string) => {
    setFormState((prev) => ({
      ...prev,
      zfs: { ...prev.zfs, [field]: value },
    }));
    setErrors((prev) => ({
      ...prev,
      zfs: { ...prev.zfs, [field]: '' },
    }));
    setSaveSuccess(false);
  }, []);

  const validate = useCallback((): boolean => {
    const dockerResult = dockerFormSchema.safeParse(formState.docker);
    const zfsInput = { ...formState.zfs };

    // If a password was previously saved and the field is blank, use a placeholder
    // so validation passes (server will keep the existing value)
    if (
      savedState?.zfs.hasPassword &&
      zfsInput.authType === 'password' &&
      !zfsInput.password
    ) {
      zfsInput.password = '********';
    }

    const zfsResult = zfsFormSchema.safeParse(zfsInput);

    const dockerErrors: Record<string, string> = {};
    const zfsErrors: Record<string, string> = {};

    if (!dockerResult.success) {
      for (const issue of dockerResult.error.issues) {
        const field = issue.path[0]?.toString();
        if (field) dockerErrors[field] = issue.message;
      }
    }

    if (!zfsResult.success) {
      for (const issue of zfsResult.error.issues) {
        const field = issue.path[0]?.toString();
        if (field) zfsErrors[field] = issue.message;
      }
    }

    setErrors({ docker: dockerErrors, zfs: zfsErrors });
    return dockerResult.success && zfsResult.success;
  }, [formState, savedState]);

  const handleSave = useCallback(async () => {
    if (!validate()) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const dockerPort = parseInt(formState.docker.port, 10);
      const zfsPort = parseInt(formState.zfs.port, 10);

      // Build ZFS settings, preserving existing password/passphrase if fields left blank
      const zfsPassword =
        formState.zfs.password ||
        (savedState?.zfs.hasPassword ? '********' : '');
      const zfsPassphrase =
        formState.zfs.passphrase ||
        (savedState?.zfs.hasPassphrase ? '********' : '');

      const result = await saveSettings({
        data: {
          docker: {
            host: formState.docker.host,
            port: dockerPort,
            protocol: formState.docker.protocol,
          },
          zfs: {
            host: formState.zfs.host,
            port: zfsPort,
            username: formState.zfs.username,
            authType: formState.zfs.authType,
            password: formState.zfs.authType === 'password' ? zfsPassword : undefined,
            keyPath: formState.zfs.authType === 'privateKey' ? formState.zfs.keyPath : undefined,
            passphrase: formState.zfs.authType === 'privateKey' ? zfsPassphrase : undefined,
          },
        },
      });

      setSavedState(result);
      // Clear sensitive fields after save
      setFormState((prev) => ({
        ...prev,
        zfs: {
          ...prev.zfs,
          password: '',
          passphrase: '',
        },
      }));
      setSaveSuccess(true);
    } catch {
      setSaveError('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [formState, savedState, validate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <CircularProgress size="lg" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-4">
      <Typography level="h3" className="mb-4">
        Settings
      </Typography>
      <Typography level="body-md" textColor="text.secondary" className="mb-6">
        Configure connections for Docker and ZFS monitoring.
      </Typography>

      <div className="flex flex-col gap-4">
        <Card variant="outlined">
          <CardContent>
            <DockerSettingsSection
              values={formState.docker}
              errors={errors.docker}
              saved={savedState?.docker ?? null}
              onChange={handleDockerChange}
            />
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <ZFSSettingsSection
              values={formState.zfs}
              errors={errors.zfs}
              saved={savedState?.zfs ?? null}
              onChange={handleZFSChange}
            />
          </CardContent>
        </Card>

        <Divider />

        {saveError && (
          <Alert variant="soft" color="danger" size="sm">
            {saveError}
          </Alert>
        )}

        {saveSuccess && (
          <Alert
            variant="soft"
            color="success"
            size="sm"
            startDecorator={<Check size={16} />}
          >
            Settings saved successfully.
          </Alert>
        )}

        <div className="flex justify-end">
          <Button
            startDecorator={
              saving ? <CircularProgress size="sm" /> : <Save size={16} />
            }
            loading={saving}
            onClick={handleSave}
          >
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}
