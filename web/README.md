# Gekkoworks UI

Simple read-only web interface for monitoring the Gekkoworks trading engine.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Install Tailwind CSS (if not already installed):
```bash
npm install -D tailwindcss postcss autoprefixer
```

3. Create `.env` file (already created with default API URL):
```env
VITE_API_BASE_URL=https://gekkoworks-api.kevin-mcgovern.workers.dev
```

## Development

```bash
npm run dev
```

Visit `http://localhost:5173`

## Build

```bash
npm run build
```

Output will be in `dist/` directory.

## Deploy to Cloudflare Pages

```bash
wrangler pages deploy dist --project-name gekkoworks-ui
```

Or connect via GitHub in Cloudflare dashboard with:
- Build command: `npm run build`
- Output directory: `web/dist`
- Environment variable: `VITE_API_BASE_URL=https://gekkoworks-api.kevin-mcgovern.workers.dev`
