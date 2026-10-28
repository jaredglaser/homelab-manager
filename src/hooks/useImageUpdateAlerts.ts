import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMuxChannel } from '@/lib/mux/use-mux-channel';
import { imageUpdatesChannel, type ImageUpdateWireMessage } from '@/lib/channels/image-updates';
import { useToast } from '@/hooks/toastAtom';
import { IMAGE_UPDATE_INFO_QUERY_KEY } from '@/lib/constants/stacks-keys';

export function updateToastMessage(image: string, latestMatchingTag: string | null): string {
  return latestMatchingTag
    ? `Update available for ${image}: ${latestMatchingTag}`
    : `Update available for ${image}`;
}

/**
 * Live update-state alerts: toasts when the refresher detects a new update and
 * refetches the panel query so the icon recolors without a reload.
 */
export function useImageUpdateAlerts(): void {
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const onData = useCallback(
    (data: ImageUpdateWireMessage) => {
      if (data.update_available === true) {
        showToast(updateToastMessage(data.image, data.latest_matching_tag), 'info');
      }
      void queryClient.invalidateQueries({ queryKey: [...IMAGE_UPDATE_INFO_QUERY_KEY] });
    },
    [showToast, queryClient],
  );

  useMuxChannel(imageUpdatesChannel, {
    onData,
    serviceErrorMessage: 'Image update alerts unavailable',
  });
}
