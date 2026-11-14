<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/60aa0a1b-3a87-41a8-bf86-fe4d0e61204c

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

With npm (not bun), install with `npm install --legacy-peer-deps` (a peer-dependency conflict).

## Live units (the UNO Q board)

The server also receives live events from the roadside unit (`src/server/liveEvents.ts`) and
the map shows them (`src/components/LiveUnitsLayer.tsx`): a marker per unit that pulses red
while its beacon is on, an alert banner, and a live feed with the uploaded photo thumbnails.

- The board POSTs to `http://<this-laptop-ip>:3000/api/events` (set `DASHBOARD_URL` on the board,
  see `arduino/wildlife-beacon/deploy.sh`). The server listens on all interfaces.
- Pull mode instead: `BOARD_URL=http://<board-ip>:7000 npm run dev`.
- `GET /api/events` lists events, `GET /api/events/stream` streams them (SSE),
  `DELETE /api/events` clears them between demo runs. Finished events are kept in `data/`.
