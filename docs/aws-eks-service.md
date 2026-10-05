# AWS service application contract

Infrastructure for the production service lives in a separate repository. This repository owns Axoview application code, build artifacts, and the runtime contract that the infrastructure repository consumes.

## Repository boundary

This repository owns:

- the Axoview frontend source and production static build under `packages/axoview-app/build`;
- the Axoview API source;
- `Dockerfile.backend`, which packages only the Node/Express API for a container platform;
- application authentication, tenant context, storage adapters, and OpenTelemetry instrumentation as they are added;
- tests that verify the frontend and API contracts.

The infrastructure repository owns:

- VPCs, subnets, NAT/endpoints, security groups, and IAM;
- EKS cluster, node groups, add-ons, namespaces, Deployments/Services/Ingress resources, HPA policy, and Pod Identity associations;
- ECR repositories;
- S3 frontend hosting bucket;
- CloudFront distribution, functions/behaviors, Origin Access Control, and origin restriction;
- Route 53 records;
- ACM certificates and TLS configuration;
- Cognito infrastructure;
- DynamoDB/S3 data resources and their IAM policies;
- observability infrastructure such as the OpenTelemetry Collector and LGTM stack;
- GitHub OIDC roles and deployment workflows that operate AWS infrastructure.

## Production frontend artifact

Build the frontend with:

```bash
npm ci
npm run build
```

The deployable static artifact is:

```text
packages/axoview-app/build/
```

The production frontend already calls the backend with relative `/api/*` URLs. The infrastructure layer can therefore expose one public origin and route:

```text
/ and /app/*  -> static frontend origin
/api/*        -> Axoview API origin
```

Axoview's editor is a SPA rooted at `/app`. The edge/static-host configuration must make `/app` and client-side `/app/*` routes return `app.html`.

## Backend image

Build the API-only image with:

```bash
docker build -f Dockerfile.backend -t axoview-backend:local .
```

It runs the Express backend directly on:

```text
3001/tcp
```

Health endpoint:

```text
GET /healthz
```

Public runtime configuration endpoint:

```text
GET /api/config
```

The container runs as the unprivileged Node user and does not contain the static frontend or nginx.

## Current EKS safety boundary

The upstream filesystem adapter is not safe as horizontally scaled multi-user storage. It uses a single filesystem namespace and process-local locks.

For a multi-replica deployment, keep:

```text
ENABLE_SERVER_STORAGE=false
```

until the distributed tenant-aware adapter is implemented.

This lets an infrastructure repository run multiple stateless API replicas safely while Axoview continues to support browser/session and Google Drive storage.

## Planned multi-user application changes

The multi-user service requires application changes in this repository, not only infrastructure variables:

1. Cognito/OIDC login integration using Authorization Code + PKCE.
2. Backend JWT verification.
3. A trusted `UserContext` whose tenant id comes from the verified identity `sub`.
4. A tenant-aware AWS storage adapter.
5. S3-backed diagram bodies.
6. DynamoDB-backed metadata, ownership, folders, sharing state, and optimistic concurrency/version checks.
7. OpenTelemetry instrumentation for HTTP, AWS SDK calls, errors, and application spans.

The application must never trust a tenant/user id supplied by a URL, query parameter, or request body.

## Runtime configuration

The infrastructure deployment should inject at least:

```text
NODE_ENV=production
BACKEND_PORT=3001
PUBLIC_BASE_URL=https://<public-domain>
ENABLE_SERVER_STORAGE=false
```

Authentication/storage variables will be added as those application features land.

## Observability contract

Infrastructure can collect container stdout/stderr, Kubernetes CPU/memory/restarts, node metrics, and load-balancer metrics without modifying Axoview.

Application-level traces require OpenTelemetry code in this repository. The intended boundary is:

```text
Axoview API
   |
  OTLP
   v
OpenTelemetry Collector
   |
   +--> logs/metrics/traces backends
```

The application should emit standard OTLP and remain independent of the concrete backend (LGTM, CloudWatch/X-Ray, or another collector pipeline).
