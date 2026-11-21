/**
 * The typed query sites under src and server. A test pins the scan to exactly this number, so a PR that adds a site
 * raises it and a PR that lowers it shows the edit: a drop means statements are hidden from the scan.
 */
export const MIN_QUERY_SITES = 64;
