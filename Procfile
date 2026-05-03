livekit: livekit-server --config livekit.yaml --node-ip $LIVEKIT_NODE_IP --keys "$LIVEKIT_API_KEY: 318f9bd5f1eb74f3f73d390c0103e161c4c9088642dda464532cba715dae8368"
backend: cd backend && npm run dev
frontend: cd frontend && npm run dev -- --host 0.0.0.0
caddy: caddy run --config Caddyfile --adapter caddyfile
