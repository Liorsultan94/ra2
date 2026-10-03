// temporary (PS agent testing): no HMR / file watching
import base from './vite.config.ts';
export default { ...base, server: { hmr: false, watch: null } };
