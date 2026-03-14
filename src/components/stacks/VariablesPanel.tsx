import { Paper, Typography, TextField, Chip } from '@mui/material';
import { Key } from 'lucide-react';

interface VariablesPanelProps {
  variables: string[];
}

/**
 * Side panel showing `${VAR}` references detected in a compose file.
 * Displays variable names. When OpenBao is enabled (separate plan),
 * this will include secret value inputs.
 */
export default function VariablesPanel({ variables }: VariablesPanelProps) {
  if (variables.length === 0) {
    return (
      <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
        <Typography variant="body2" className="opacity-50">
          No variables detected.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
      <div className="flex items-center gap-2 mb-3">
        <Key size={16} className="opacity-60" />
        <Typography variant="subtitle2">Variables</Typography>
        <Chip size="small" label={variables.length} className="!text-xs !h-5" />
      </div>
      <div className="space-y-2">
        {variables.map((varName) => (
          <div key={varName} className="flex items-center gap-2">
            <code className="text-xs font-mono min-w-[120px] opacity-80">${'{'}${varName}{'}'}</code>
            <TextField
              size="small"
              placeholder="Value (managed by OpenBao)"
              disabled
              fullWidth
              className="!text-xs"
              slotProps={{
                input: { className: '!text-xs' },
              }}
            />
          </div>
        ))}
      </div>
      <Typography variant="caption" className="!mt-2 block opacity-50">
        Variable values are managed via OpenBao (when configured).
      </Typography>
    </Paper>
  );
}
