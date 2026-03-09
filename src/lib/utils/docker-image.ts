export interface ParsedDockerImage {
  registry: string | null;
  repository: string;
  tag: string;
}

export function parseDockerImage(image: string): ParsedDockerImage {
  let remaining = image;
  let tag = 'latest';

  // Handle digest
  const digestIdx = remaining.indexOf('@');
  if (digestIdx !== -1) {
    tag = remaining.substring(digestIdx + 1);
    remaining = remaining.substring(0, digestIdx);
  } else {
    const colonIdx = remaining.lastIndexOf(':');
    if (colonIdx !== -1 && colonIdx > remaining.lastIndexOf('/')) {
      tag = remaining.substring(colonIdx + 1);
      remaining = remaining.substring(0, colonIdx);
    }
  }

  // First segment is a registry if it contains a dot or colon, or is 'localhost'
  const parts = remaining.split('/');
  let registry: string | null = null;
  let repository: string;

  if (
    parts.length >= 3 ||
    (parts.length >= 2 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost'))
  ) {
    registry = parts[0];
    repository = parts.slice(1).join('/');
  } else {
    repository = remaining;
  }

  return { registry, repository, tag };
}
