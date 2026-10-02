/*
 * Entry point: deliberately tiny. index.html already shows the animated
 * splash; this chunk streams the game chunks with real progress, imports the
 * game (src/app.ts) and lets it boot behind the splash.
 */
import { Splash } from './ui/splash';

const splash = new Splash();
splash.stage('Loading engine', 0.02, 0.55, 'Establishing uplink');
try {
  const { boot } = await splash.loadModule(() => import('./app'));
  await boot(splash);
} catch (e) {
  console.error('[boot] failed', e);
  splash.fail('Loading failed');
}
