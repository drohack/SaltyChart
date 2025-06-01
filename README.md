# SaltyChart – Local Build & Unraid Deployment

These are the steps we use in development:

1. Build both images (backend & frontend) on your workstation
2. Bundle them into a single `.tar` archive
3. Copy the archive to the Unraid box
4. `docker load` the images and run the containers

---

## 1  Build locally

```powershell
# Backend – adapter-node output (listens on port 3000 **inside**)
docker build -t saltychart-backend:YYYYMMDD .

# Frontend – static assets served by Nginx (listens on port 80 **inside**)
cd frontend
docker build -t saltychart-frontend:YYYYMMDD .
cd ..

# Bundle both images into one archive
docker save -o saltychart_YYYYMMDD.tar \ 
  saltychart-backend:YYYYMMDD            \ 
  saltychart-frontend:YYYYMMDD
```

*Replace `YYYYMMDD` with the build date or a git commit SHA; unique tags make
versioning and rollback easy.*

Optionally test the production build locally:

```powershell
docker network create salty-net 2>$null | Out-Null

# Run backend
docker run -d --name saltychart-backend --network salty-net \
  -e DATABASE_URL=file:/data/data.db             \
  -v saltychart_db:/data                         \
  saltychart-backend:YYYYMMDD

# Run frontend on host-port 8085
docker run -d --name saltychart-frontend --network salty-net \
  -p 8085:80                                      \
  saltychart-frontend:YYYYMMDD

# Browse http://localhost:8085/ – should render the season page with data.
```

---

## 2  Copy to the Unraid server

Use any method (SCP, SMB, WinSCP) to place `saltychart_YYYYMMDD.tar` on the
Unraid box (for example `/mnt/user/tmp/`).

---

## 3  Load & run on Unraid

```bash
# SSH / WebTerminal on Unraid

# 1  Import both images
docker load -i /mnt/user/tmp/saltychart_YYYYMMDD.tar

# 2  Network (create once – no harm if it already exists)
docker network create salty-net 2>/dev/null || true

# 3  Backend
docker run -d --name saltychart-backend \
  --network salty-net \
  -v saltychart_db:/data \
  -e DATABASE_URL=file:/data/data.db \
  saltychart-backend:YYYYMMDD

# 4  Frontend – publish on 8085
docker run -d --name saltychart-frontend \
  --network salty-net \
  -p 8085:80 \
  saltychart-frontend:YYYYMMDD

# The site is now live at
#   http://<unraid-ip>:8085/
```

### Updating

1. Repeat the local build with a **new** tag.
2. `docker load` the new tar on Unraid.
3. `docker rm -f saltychart-frontend` (and/or backend) then run with the new tag.

Old images can be pruned later with `docker image rm` or `docker image prune`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Browser shows *Cannot GET /** | Frontend container started, but backend unreachable | Check `docker ps` – make sure backend is running and frontend env/proxy points to `saltychart-backend:3000` |
| `err_connection_refused` | Host-port not published | `-p 8085:80` (frontend) or `-p 8085:3000` for the Node build |
| Frontend blank but UI loads | `/api` proxy mis-configured | Ensure `nginx.conf` `proxy_pass http://saltychart-backend:3000;` (no trailing slash) |
| Container stops instantly | Look at `docker logs <container>` – usually a missing env var or wrong command | Provide required env-vars, fix CMD |

---

Happy charting!
