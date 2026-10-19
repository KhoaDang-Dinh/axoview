# AWS service application contract

> **AWS runner requirement:** the AWS dev deployment workflow runs on the trusted self-hosted EC2 GitHub runner. The runner's EC2 instance profile is used only to read the bootstrap SSM contract. The workflow then assumes the Axoview dev deployer through GitHub OIDC before changing S3, ECR, EKS, or CloudFront.

The Axoview repository needs only the AWS region as local discovery configuration:

```text
AWS_REGION=ap-southeast-1
```

The deployer role ARN is discovered from `/axoview/bootstrap/deployer_dev_role_arn`; do not copy that ARN into a GitHub secret or variable.

The root domain and dev viewer CIDRs are owned by the infrastructure repository. The viewer CIDRs represent the **human/browser public egress IPs**, not the EC2 runner IP.

## Public repository CI/CD security

Axoview is public, so CI/CD must treat pull requests from forks as untrusted code.

- Fork pull requests do not run Axoview CI jobs.
- No pull-request workflow uses the self-hosted EC2 runner.
- AWS deployment runs only from the canonical `KhoaDang-Dinh/axoview` repository, on `dev`, and only when the actor is `KhoaDang-Dinh`.
- AWS mutation uses GitHub OIDC after SSM discovery; the EC2 instance profile is not the deployment identity.
- Semantic release only chains from a successful trusted `push` workflow run in the canonical repository.
- Dependabot remains an explicit bot exception for its own auto-merge workflow.

This is intentional: public contributors may submit code for review, but they cannot trigger the private AWS deployment path or execute arbitrary fork code on the EC2 runner.



Infrastructure for the production service lives in a separate repository. This repository owns Axoview application code, build artifacts, and the runtime contract that the infrastructure repository consumes.

## Repository boundary

This repository owns:

- the Axoview frontend source and production static build under `packages/axoview-app/build`;
- the Axoview API source;
- `Dockerfile.backend`, which packages only the Node/Express API for a container platform;
- application authentication, personal-workspace isolation, storage adapters, and OpenTelemetry instrumentation as they are added;
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

The AWS production boundary is intentionally split:

```text
packages/axoview-app/build/
  -> S3
  -> CloudFront

Dockerfile.backend
  -> ECR
  -> EKS
```

The repository's root `Dockerfile`, `nginx.conf`, `docker-entrypoint.sh`, and `compose.dev.yml` remain only for upstream/local compatibility. They are not production deployment artifacts for the AWS service.

The default npm Docker commands now follow the AWS runtime:

```bash
npm run docker:build
npm run docker:run
```

The old combined nginx + frontend + backend image remains available explicitly as:

```bash
npm run docker:legacy:build
npm run docker:legacy:run
```

## Multi-user application contract

The API supports Cognito Authorization Code + PKCE sign-in, verifies Cognito access-token signatures and claims, and derives a private personal workspace from the verified `sub`. User IDs in request data are ignored. AWS mode stores diagram bodies in S3 and metadata in DynamoDB, with conditional version writes; stale editor saves return `409` and saves without a version return `428`.

Each Cognito user currently gets a separate personal workspace. Cross-user team workspaces, invitations, and workspace roles are not part of this change. Public share links remain readable anonymously and can only be revoked by their owning workspace.

For EKS, configure the API with:

```text
NODE_ENV=production
AUTH_MODE=cognito
COGNITO_REGION=<AWS region>
COGNITO_USER_POOL_ID=<pool id>
COGNITO_CLIENT_ID=<SPA app client id>
COGNITO_ISSUER=https://cognito-idp.<region>.amazonaws.com/<pool id>
COGNITO_DOMAIN=https://<user-pool-domain>.auth.<region>.amazoncognito.com
PUBLIC_BASE_URL=https://<public-domain>
STORAGE_ADAPTER=aws
ENABLE_SERVER_STORAGE=true
AXOVIEW_DATA_BUCKET=<workspace data bucket>
AXOVIEW_DYNAMODB_TABLE=<workspace metadata table>
```

The EKS Pod Identity role needs access to the configured S3 bucket and DynamoDB table. The Cognito SPA client must enable authorization-code grant, PKCE, and the exact callback `https://<public-domain>/app/auth/callback`; set its sign-out URL to `https://<public-domain>/`. The frontend reads these public values from `/api/config`; do not bake tokens or secrets into the static build.

The API defaults to the filesystem adapter for local/demo use. That adapter is namespaced by verified user identity when Cognito auth is enabled, but it is not shared across replicas. Use the AWS adapter for a multi-replica EKS deployment. Keep `ENABLE_SERVER_STORAGE=false` until the AWS bucket, table, IAM role, and runtime variables above are present.

## Runtime configuration

The infrastructure deployment should inject the values in the multi-user application contract above, plus `BACKEND_PORT=3001`.

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
