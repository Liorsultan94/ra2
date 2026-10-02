import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Splash screen support (see index.html and src/ui/splash.ts):
 *  - the emblem SVG (src/ui/emblem.svg, shared with the menu) is inlined into
 *    index.html so the animated splash paints before any JS has downloaded;
 *  - the build injects the list of game chunks (with their sizes) so the tiny
 *    entry can stream them with a real byte-progress bar before importing them.
 */
function splashPlugin(): Plugin[] {
  return [
    {
      name: 'ironfront-splash-emblem',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('<!--emblem-->', readFileSync(new URL('./src/ui/emblem.svg', import.meta.url), 'utf8').trim()),
      },
    },
    {
      name: 'ironfront-splash-preload',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler: (html, ctx) => {
          const bundle = ctx.bundle;
          if (!bundle) return html;
          const chunks = Object.values(bundle);
          const app = chunks.find((c) => c.type === 'chunk' && c.facadeModuleId?.replace(/\\/g, '/').endsWith('/src/app.ts'));
          if (!app || app.type !== 'chunk') return html;
          // the entry and its static imports are already loading via the HTML
          const entry = new Set<string>();
          for (const c of chunks) if (c.type === 'chunk' && c.isEntry) [c.fileName, ...c.imports].forEach((f) => entry.add(f));
          const files = new Map<string, number>();
          const visit = (name: string) => {
            if (files.has(name) || entry.has(name)) return;
            const c = bundle[name];
            if (!c) return;
            if (c.type === 'asset') {
              files.set(name, typeof c.source === 'string' ? Buffer.byteLength(c.source) : c.source.byteLength);
              return;
            }
            files.set(name, Buffer.byteLength(c.code));
            const meta = (c as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata;
            meta?.importedCss?.forEach(visit);
            c.imports.forEach(visit);
            c.dynamicImports.forEach(visit);
          };
          visit(app.fileName);
          const list = JSON.stringify([...files]);
          return html.replace('<script type="module"', `<script>window.__IF_PRELOAD=${list}</script>\n    <script type="module"`);
        },
      },
    },
  ];
}

// Relative base so the build works from any sub-path (e.g. GitHub Pages /ra2/).
export default defineConfig({
  base: './',
  plugins: splashPlugin(),
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
