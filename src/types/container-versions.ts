/** Lightweight version info for preload (no changelog bodies) */
export interface ContainerVersionSummary {
  image: string;
  current_tag: string | null;
  latest_tag: string | null;
  update_available: boolean;
  github_repo: string | null;
  github_repo_source: string | null;
}

/** Single GitHub release entry stored in container_versions.releases JSONB */
export interface GitHubRelease {
  tag: string;
  name: string;
  body: string;
  published_at: string;
  url: string;
}

/** Full container details from Docker inspect */
export interface ContainerDetails {
  containerId: string;
  containerName: string;
  image: string;
  status: string;
  created: string;
  restartPolicy: string;
  currentTag: string | null;
  currentVersion: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
  githubRepo: string | null;
  githubRepoSource: string | null;
  ports: ContainerPort[];
  volumes: ContainerVolume[];
}

export interface ContainerPort {
  containerPort: number;
  hostPort: number | null;
  protocol: string;
  hostIp: string;
}

export interface ContainerVolume {
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}
