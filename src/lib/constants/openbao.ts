/** Shared pattern for safe path segments (stack names, secret keys). Used by both the OpenBao client and server function Zod validators. */
export const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;
