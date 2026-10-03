// temporary (PS agent testing): the project config without HMR / file watching, so other agents' edits don't reload the page mid-test
import base from './vite.config.ts';
export default { ...base, server: { hmr: false, watch: null } };
