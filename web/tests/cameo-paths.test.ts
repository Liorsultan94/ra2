import { describe, expect, it } from 'vitest';
import { CUSTOM_CAMEOS } from '../src/render/cameo';

const base = import.meta.env.BASE_URL;
const files = new Set(Object.keys(import.meta.glob('../public/ui/cameos/*.jpg', { query: '?url' })).map((k) => k.replace('../public/', '')));

describe('custom cameo images', () => {
  it('are the site base plus a path (a hard-coded /ui/... breaks under /ra2/ on GitHub Pages) and exist on disk', () => {
    for (const [id, url] of Object.entries(CUSTOM_CAMEOS)) {
      expect(url.startsWith(base), `${id}: ${url} must start with the site base ${base}`).toBe(true);
      expect(files.has(url.slice(base.length)), `${id}: ${url}`).toBe(true);
    }
  });
});
