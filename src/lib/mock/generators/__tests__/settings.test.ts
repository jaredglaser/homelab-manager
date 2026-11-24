import { describe, it, expect } from 'bun:test';
import { generateDefaultSettings, seedDemoLayout } from '../settings';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { BROWSER_LAYOUT_KEYS, browserLayoutStorageKey } from '@/hooks/browserLayout';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';

const EXPANDED_CONTAINERS_KEY = browserLayoutStorageKey(BROWSER_LAYOUT_KEYS.dockerExpandedContainers);

describe('seedDemoLayout', () => {
  it('opens the Home Assistant container on a first visit', () => {
    seedDemoLayout();
    const homeassistant = DOCKER_ENTITIES.find(e => e.serviceKey === 'homeassistant')!;
    expect(JSON.parse(localStorage.getItem(EXPANDED_CONTAINERS_KEY)!)).toEqual([`${homeassistant.host}/${homeassistant.containerId}`]);
  });

  it('leaves a layout the visitor already has alone', () => {
    localStorage.setItem(EXPANDED_CONTAINERS_KEY, '[]');
    seedDemoLayout();
    expect(localStorage.getItem(EXPANDED_CONTAINERS_KEY)).toBe('[]');
  });
});

describe('generateDefaultSettings', () => {
  it('returns a non-empty object', () => {
    const settings = generateDefaultSettings();
    expect(Object.keys(settings).length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = generateDefaultSettings();
    const b = generateDefaultSettings();
    expect(a).toEqual(b);
  });

  it('includes exactly the canonical settings keys', () => {
    const settings = generateDefaultSettings();

    // Flatten all keys from SETTINGS_KEYS
    const expectedKeys = new Set<string>();
    for (const group of Object.values(SETTINGS_KEYS)) {
      for (const key of Object.values(group as Record<string, string | Record<string, string>>)) {
        if (typeof key === 'string') {
          expectedKeys.add(key);
        } else {
          for (const subKey of Object.values(key)) {
            expectedKeys.add(subKey);
          }
        }
      }
    }

    expect(new Set(Object.keys(settings))).toEqual(expectedKeys);
  });

  it('all values are strings', () => {
    const settings = generateDefaultSettings();
    for (const [key, value] of Object.entries(settings)) {
      expect(typeof value).toBe('string');
      // Verify key is a non-empty string
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
