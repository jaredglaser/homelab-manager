/**
 * Shared error-event name for the three `StatsPollService`-backed channels
 * (docker-stats, zfs-stats, proxmox-stats): they funnel through the same
 * poll service and historically shared one hardcoded default, duplicated
 * between `useEventSource`'s client-side default and the server route. One
 * constant here keeps that shared identity structural instead of three
 * independently-typed literals that happen to still match.
 */
export const STATS_ERROR_EVENT = 'stats_error';
