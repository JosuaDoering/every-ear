# $LIVEKIT_API_KEY / $LIVEKIT_API_SECRET come from .env (overmind loads it).
# The webhook env vars let LiveKit push participant/track events to the backend,
# which keeps the stats collector cheap at scale (see backend/src/stats.ts).
livekit: LIVEKIT_WEBHOOK_API_KEY=$LIVEKIT_API_KEY LIVEKIT_WEBHOOK_URLS=http://127.0.0.1:$BACKEND_PORT/api/livekit/webhook livekit-server --config livekit.yaml --node-ip $LIVEKIT_NODE_IP --keys "$LIVEKIT_API_KEY: $LIVEKIT_API_SECRET"
backend: cd backend && npm run dev
frontend: cd frontend && npm run dev -- --host 0.0.0.0
caddy: caddy run --config Caddyfile --adapter caddyfile
