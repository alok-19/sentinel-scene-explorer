# Sentinel Scene Explorer

Sentinel Scene Explorer is a browser-only React + TypeScript app for searching recent Sentinel-2 L2A scenes from the free Element84 Earth Search STAC API. A user enters a place name, the app geocodes it with Nominatim, queries the last 90 days of Sentinel-2 scenes, filters by cloud cover, and renders summary stats plus scene cards with preview imagery and direct data links.

## Features

- Browser-only architecture with no backend and no API keys
- Free-form location search via Nominatim
- Sentinel-2 L2A scene discovery via Element84 Earth Search STAC
- Adjustable cloud cover threshold
- Result summary bar with scene count, average cloud cover, and date range
- Responsive dark UI optimized for desktop and mobile
- Request timeout handling and clearer public-API failure states

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## Deployment

The repository includes a GitHub Actions workflow for GitHub Pages. After pushing to `main`, enable Pages in the repository settings with **Build and deployment** set to **GitHub Actions**.

## Notes

- The app relies on public APIs. Nominatim may rate-limit anonymous browser traffic.
- Asset selection is heuristic because STAC items can expose multiple preview and raster assets with different conventions.
