# Docker Setup Guide

## Prerequisites

- Docker Desktop installed (includes Docker Compose)
- `.env.local` file with required environment variables

## Quick Start

### Production Mode (with Neon Database)

1. **Build and start the application:**
```bash
docker-compose up --build
```

2. **Access the application:**
- Dashboard: http://localhost:3008

3. **Stop the application:**
```bash
docker-compose down
```

### Development Mode (with local PostgreSQL)

1. **Start local PostgreSQL and app:**
```bash
docker-compose -f docker-compose.dev.yml up --build
```

2. **Run migrations (in another terminal):**
```bash
# Install dependencies locally if not already done
npm install

# Run Drizzle migrations
npm run db:push
```

3. **Access services:**
- Dashboard: http://localhost:3008
- PostgreSQL: localhost:5432
  - Database: `sternmeister_dev`
  - User: `postgres`
  - Password: `postgres`

4. **Stop services:**
```bash
docker-compose -f docker-compose.dev.yml down
```

## Environment Variables

Create a `.env.local` file with the following variables:

```env
# Database (Neon PostgreSQL)
DATABASE_URL=postgresql://user:password@host/database?sslmode=require

# Optional: Add other API keys as needed
# KOMMO_CLIENT_ID=your_client_id
# KOMMO_CLIENT_SECRET=your_client_secret
```

## Docker Commands Reference

### Build Docker Image
```bash
docker build -t sternmeister-dashboard .
```

### Run Container Manually
```bash
docker run -p 3000:3008 --env-file .env.local sternmeister-dashboard
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f app
```

### Clean Up

```bash
# Stop and remove containers, networks
docker-compose down

# Remove volumes as well (WARNING: deletes database data)
docker-compose down -v

# Remove images
docker-compose down --rmi all
```

### Development with Hot Reload

For development with hot reload, it's recommended to run the app locally:

```bash
npm run dev
```

And use Docker Compose only for the database:

```bash
docker-compose -f docker-compose.dev.yml up postgres
```

## Troubleshooting

### Port Already in Use
If port 3008 is already in use:
```bash
# Find process using port 3008
lsof -ti:3008

# Kill the process
kill -9 <PID>
```

Or change the port in `docker-compose.yml`:
```yaml
ports:
  - "3001:3008"  # Map to different host port
```

### Database Connection Issues
- Ensure `.env.local` has correct `DATABASE_URL`
- For local PostgreSQL, wait for healthcheck to pass
- Check logs: `docker-compose logs postgres`

### Build Fails
```bash
# Clean build cache
docker-compose build --no-cache

# Or rebuild from scratch
docker system prune -a
docker-compose up --build
```

## Architecture

The Docker setup includes:

- **Multi-stage build** for optimized image size
- **Non-root user** for security
- **Standalone output** for faster cold starts
- **Health checks** for database readiness
- **Volume mounting** for development hot reload

## Production Deployment

For production deployment:

1. **Build the image:**
```bash
docker build -t sternmeister-dashboard:latest .
```

2. **Push to registry (e.g., Docker Hub, GitHub Container Registry):**
```bash
docker tag sternmeister-dashboard:latest ghcr.io/yourorg/sternmeister-dashboard:latest
docker push ghcr.io/yourorg/sternmeister-dashboard:latest
```

3. **Deploy to your hosting platform** (AWS, GCP, Azure, etc.)

## Notes

- The production `docker-compose.yml` uses Neon PostgreSQL (serverless)
- Local development setup includes PostgreSQL container
- Adjust memory limits if running on resource-constrained environments
- Consider using Docker secrets for sensitive environment variables in production
