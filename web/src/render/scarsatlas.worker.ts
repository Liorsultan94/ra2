import { scarAtlasData } from './scarsatlas';

// Battle-scar decal atlas off the main thread (scarsdecal.ts prefetchScarAtlas).
self.onmessage = (e: MessageEvent<{ tile: number }>) => {
  const data = scarAtlasData(e.data.tile);
  (self as unknown as Worker).postMessage({ tile: e.data.tile, data }, [data.buffer]);
};
