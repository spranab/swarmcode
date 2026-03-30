#!/bin/bash
set -e

echo "Deploying Agent Bridge to Kubernetes..."

kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/redis.yml
kubectl apply -f k8s/agent-bridge.yml
kubectl apply -f k8s/ingress.yml

echo ""
echo "Waiting for pods..."
kubectl -n mcp rollout status deployment/redis
kubectl -n mcp rollout status deployment/agent-bridge

echo ""
echo "Status:"
kubectl -n mcp get pods
kubectl -n mcp get ingress

echo ""
echo "Done! Update your Claude Code MCP config to point to your ingress host."
