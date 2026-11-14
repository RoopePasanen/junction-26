import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCustomAreaCameraPlan,
  buildPolygonAreaCameraPlan,
} from './src/server/rambollCustomPlanner.ts';
import { getLocalRambollDatasetStats } from './src/server/rambollLocalStore.ts';
import { registerLiveEventRoutes } from './src/server/liveEvents.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(): Promise<void> {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  // Live events from the roadside units (before the global JSON parser: own size limit).
  registerLiveEventRoutes(app, path.join(__dirname, 'data'));

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/ramboll-dataset', (_req, res) => {
    try {
      res.json(getLocalRambollDatasetStats());
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load local Ramboll dataset.',
      });
    }
  });

  app.post('/api/plot-cameras', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        polygon?: Array<{ lat: number; lng: number }>;
        cameraCount?: number;
        rangeMeters?: number;
        fovDeg?: number;
        label?: string;
        areaId?: string;
        cameraPrefix?: string;
      };

      if (!Array.isArray(body.polygon) || body.polygon.length < 3) {
        res.status(400).json({
          error: 'Draw an area with at least 3 vertices on the map before placing cameras.',
        });
        return;
      }

      const cameraCount = Number(body.cameraCount);
      if (!Number.isFinite(cameraCount) || cameraCount < 1) {
        res.status(400).json({
          error: 'Enter a valid number of cameras to add (at least 1).',
        });
        return;
      }

      const plan = await buildPolygonAreaCameraPlan({
        polygon: body.polygon,
        cameraCount,
        rangeMeters: body.rangeMeters,
        fovDeg: body.fovDeg,
        label: typeof body.label === 'string' ? body.label : undefined,
        areaId: typeof body.areaId === 'string' ? body.areaId : undefined,
        cameraPrefix: typeof body.cameraPrefix === 'string' ? body.cameraPrefix : undefined,
      });

      res.json(plan);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to plot roadside cameras inside the drawn area.';
      res.status(422).json({ error: message });
    }
  });

  app.get('/api/custom-area-plan', async (req, res) => {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      const radiusKm = Number(req.query.radiusKm);
      const cameraCount =
        req.query.cameraCount !== undefined ? Number(req.query.cameraCount) : 100;
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
        cameraCount,
        label,
      });

      res.json(plan);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to generate custom wildlife camera deployment plan.';
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
