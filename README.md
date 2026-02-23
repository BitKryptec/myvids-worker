# myVids Remote Worker

Service FFmpeg distant pour myVids.

## Prérequis

- Node.js 18+
- `ffmpeg` installé et disponible dans le PATH

## Installation

```bash
npm install
```

## Lancement

```bash
npm start
```

Variables d'environnement:

- `PORT` (défaut: `8787`)
- `WORKER_TOKEN` (recommandé)
- `WORKER_TOKEN_HEADER` (défaut: `x-worker-token`)
- `BASE_PUBLIC_URL` (ex: `https://myvids-worker-ipv4.domain-worker.com`)
- `JOBS_DIR` (défaut: `./jobs`)
- `TMP_DIR` (défaut: `./tmp`)
- `VERIFY_TLS` (`1` par défaut; `0` pour ignorer TLS en dev uniquement)

## API

- `POST /jobs`
- `GET /jobs/:id`
- `POST /jobs/:id/cancel`
- `GET /artifacts/:jobId/:file`
- `GET /health`

Exemple `POST /jobs`:

```json
{
  "type": "trim",
  "source": {
    "url": "https://domain-myvids.com/myvids/index.php?stream=video.mp4",
    "headers": {
      "Authorization": "Basic base64..."
    }
  },
  "options": {
    "start": 10,
    "end": 120,
    "mode": "reencode"
  },
  "output": {
    "filename_hint": "video__trim_10_120"
  }
}
```

## Déploiement Coolify

- Build command: `npm install`
- Start command: `npm start`
- Exposer le port `8787` (ou `PORT`)
- Ajouter les variables d'environnement ci-dessus
- Si tu utilises Dockerfile (GitHub App), sélectionne `remote_worker/Dockerfile`
