import { z } from 'zod';
import { agentUrlSchema, hostCapabilitiesSchema, hostNameSchema } from '@/data/hosts/schemas';

const WHOLE_NUMBER_PATTERN = /^\d+$/;
const AGENT_HOST_PATTERN = /^[a-zA-Z0-9._-]+$/;
const AGENT_HOST_IPV6_PATTERN = /^\[[0-9a-fA-F:.]+\]$/;

export interface AddHostFormValues {
  name: string;
  docker: boolean;
  zfs: boolean;
  hlmZfsUid: string;
  hlmZfsGid: string;
  dockerGid: string;
  agentHost: string;
  agentPort: string;
}

export type AddHostField = keyof AddHostFormValues;

const DEFAULT_AGENT_PORT = '9090';

export const ADD_HOST_FORM_DEFAULTS: AddHostFormValues = {
  name: '',
  docker: true,
  zfs: false,
  hlmZfsUid: '',
  hlmZfsGid: '',
  dockerGid: '',
  agentHost: '',
  agentPort: DEFAULT_AGENT_PORT,
};

export const ADD_HOST_STEP_FIELDS = {
  Capabilities: ['name', 'docker', 'zfs'],
  'ZFS Setup': ['hlmZfsUid', 'hlmZfsGid', 'dockerGid'],
  'Verify Connection': ['agentHost', 'agentPort'],
} as const satisfies Record<string, readonly AddHostField[]>;

function isValidPort(port: string): boolean {
  return WHOLE_NUMBER_PATTERN.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

// First contact is always plain HTTP: the scheme is not an operator choice, so the URL is composed here.
// Bracketed IPv6 literals stay bracketed so the URL parser reads them as a host.
export function firstContactAgentUrl(values: Pick<AddHostFormValues, 'agentHost' | 'agentPort'>): string {
  return `http://${values.agentHost.trim()}:${Number(values.agentPort.trim())}`;
}

export const addHostFormSchema = z.object({
  name: z.string().trim().pipe(hostNameSchema),
  docker: z.boolean(),
  zfs: z.boolean(),
  hlmZfsUid: z.string().trim(),
  hlmZfsGid: z.string().trim(),
  dockerGid: z.string().trim(),
  agentHost: z.string().trim(),
  agentPort: z.string().trim(),
}).superRefine((values, ctx) => {
  const reject = (field: AddHostField, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });

  const capabilities = hostCapabilitiesSchema.safeParse({ docker: values.docker, zfs: values.zfs });
  if (!capabilities.success) reject('zfs', capabilities.error.issues[0].message);

  if (values.zfs) {
    if (!WHOLE_NUMBER_PATTERN.test(values.hlmZfsUid)) reject('hlmZfsUid', 'Enter the number after uid= in the command output.');
    if (!WHOLE_NUMBER_PATTERN.test(values.hlmZfsGid)) reject('hlmZfsGid', 'Enter the number before (zfs) in the command output.');
    if (values.docker && !WHOLE_NUMBER_PATTERN.test(values.dockerGid)) reject('dockerGid', 'Enter the number after docker:x: in the output of getent group docker.');
  }

  if (!isValidPort(values.agentPort)) reject('agentPort', 'Enter a port from 1 to 65535.');

  // The last check uses a fixed port, so editing the port never changes the host's verdict: the form re-checks only the field being edited.
  if (values.agentHost === '') {
    reject('agentHost', 'Enter the host name or IP address of the agent.');
  } else if (!AGENT_HOST_PATTERN.test(values.agentHost) && !AGENT_HOST_IPV6_PATTERN.test(values.agentHost)) {
    reject('agentHost', 'Enter only a host name or IP address, without http:// or a port.');
  } else if (!agentUrlSchema.safeParse(firstContactAgentUrl({ agentHost: values.agentHost, agentPort: DEFAULT_AGENT_PORT })).success) {
    reject('agentHost', 'This is not a valid host name or IP address.');
  }
});

export interface AddHostStepIssue {
  field: AddHostField;
  message: string;
}

export function addHostStepIssues(step: string, values: AddHostFormValues): AddHostStepIssue[] {
  const fields: readonly AddHostField[] | undefined = ADD_HOST_STEP_FIELDS[step as keyof typeof ADD_HOST_STEP_FIELDS];
  if (!fields) return [];
  const result = addHostFormSchema.safeParse(values);
  if (result.success) return [];
  return fields.flatMap((field) => {
    const issue = result.error.issues.find((candidate) => candidate.path[0] === field);
    return issue ? [{ field, message: issue.message }] : [];
  });
}
