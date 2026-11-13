/** One wording for every site that can find no keypair for a host: the keypair dialog and remove-and-re-add are the only fixes. */
export function missingAgentKeypairMessage(hostName: string): string {
  return `The manager has no keypair for host "${hostName}", so it cannot sign requests to it. `
    + "Rotate the keypair from this host's keypair dialog, or remove and re-add the host.";
}
