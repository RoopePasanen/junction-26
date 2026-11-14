import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCustomAreaCameraPlan } from './src/server/rambollCustomPlanner.ts';
import { registerLiveEventRoutes } from './src/server/liveEvents.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(): Promise<void> {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  // Live events from the roadside units (before the global JSON parser: own size limit).
  registerLiveEventRoutes(app, path.join(__dirname, 'data'));

  app.use(express.json());

  app.get('/api/custom-area-plan', async (req, res) => {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      const radiusKm = Number(req.query.radiusKm);
      const label = typeof req.query.label === 'string' ? req.query.label : undefined;

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusKm)) {
        res.status(400).json({
          error: 'Valid numeric lat, lng, and radiusKm query parameters are required.',
        });
        return;
      }

      const plan = await buildCustomAreaCameraPlan({
        lat,
        lng,
        radiusKm,
        label,
      });

      res.json(plan);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to generate custom 100-camera wildlife deployment plan.';
      res.status(422).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`SuomiKartta server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
