export interface ImageUpdateChangedEvent {
  stack: string;
  host: string;
  image: string;
  updateAvailable: boolean | null;
  latestMatchingTag: string | null;
}

type ImageUpdateChangedCallback = (event: ImageUpdateChangedEvent) => void;

/**
 * In-process pub/sub for update-state changes detected by the refresher.
 * The refresher is the only writer, so no LISTEN/NOTIFY round trip is needed.
 */
export class ImageUpdateBroadcastService {
  private subscribers = new Set<ImageUpdateChangedCallback>();

  subscribe(callback: ImageUpdateChangedCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  publish(events: ImageUpdateChangedEvent[]): void {
    for (const event of events) {
      for (const callback of this.subscribers) {
        callback(event);
      }
    }
  }
}

export const imageUpdateBroadcastService = new ImageUpdateBroadcastService();
