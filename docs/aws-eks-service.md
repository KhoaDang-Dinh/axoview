# AWS EKS service deployment

This fork adds an AWS production path that separates the static Axoview frontend from the dynamic API.

## Target architecture

```text
Route 53
   |
   v
CloudFront + ACM (viewer TLS, certificate in us-east-1)
   |-------------------------------|
   |                               |
   v                               v
private S3                    /api/* -> HTTPS
frontend                           ALB
                                    |
                                    v
                               EKS Service
                              /            \
                         API Pod          API Pod
```

The browser keeps one public origin, `https://<domain>`. Axoview already uses relative `/api/*` URLs in production, so CloudFront can route static paths to S3 and API paths to the ALB without adding frontend CORS plumbing.

## What this first AWS layer does

- builds the existing React/static frontend and publishes it to a private S3 bucket;
- uses CloudFront Origin Access Control so S3 is not public;
- rewrites `/app` and client-side `/app/*` routes to `app.html` at the edge;
- routes `/api/*` to a TLS-enabled ALB origin;
- builds a backend-only Node image rather than running nginx/static assets in the EKS pod;
- runs two stateless API replicas with probes, resource requests/limits, rolling updates, and an HPA;
- keeps the existing local Docker deployment unchanged.

## Important storage boundary

The upstream Docker backend's filesystem adapter is deliberately **disabled** in the EKS deployment:

```text
ENABLE_SERVER_STORAGE=false
```

This is not cosmetic. The current route layer uses in-process locks and the filesystem adapter has one shared namespace. Mounting EFS under two pods would not create safe multi-user storage and can lose concurrent updates.

Until the tenant-aware AWS adapter lands, the EKS service is safe/stateless and users can still use Axoview's browser/session or Google Drive storage modes.

The next service layer should add:

1. Cognito Authorization Code + PKCE login in the frontend.
2. JWT verification in the Express backend.
3. A request `UserContext` whose tenant id comes from verified Cognito `sub`, never from a request parameter.
4. S3 for diagram bodies, namespaced by tenant.
5. DynamoDB for metadata, ownership, folders, sharing metadata, and conditional-version writes.
6. EKS Pod Identity for S3/DynamoDB access.
7. OpenTelemetry instrumentation and export to the existing LGTM observability stack.

Only after the distributed storage adapter is in place should `ENABLE_SERVER_STORAGE` be replaced by the AWS storage backend.

## CloudFront / S3 Terraform

The module under `infra/aws/frontend` creates:

- a private versioned S3 frontend bucket;
- CloudFront OAC;
- the CloudFront distribution;
- a viewer certificate in `us-east-1`;
- Route 53 A and AAAA aliases for the public domain;
- a no-cache `/api/*` behavior to the EKS ALB origin.

Example:

```hcl
aws_region          = "ap-southeast-1"
domain_name         = "example.com"
route53_zone_id     = "Z0123456789"
api_origin_host     = "origin.example.com"
frontend_bucket_name = "example-axoview-frontend"
```

The API origin hostname must resolve to the ALB and its ALB listener certificate must cover that hostname. The Kubernetes ingress contains an ExternalDNS annotation; if ExternalDNS is not installed in the cluster, create the Route 53 alias for the origin manually after the ALB is created.

## EKS prerequisites

The cluster is expected to provide:

- AWS Load Balancer Controller;
- Metrics Server for the HPA;
- optionally ExternalDNS;
- at least two worker nodes/AZ capacity if you want the two replicas to provide real node/AZ resilience.

The application manifests are under `deploy/k8s`.

## GitHub Actions variables

The manual `Deploy AWS service` workflow uses GitHub OIDC and expects these repository/environment variables:

```text
AWS_REGION
AWS_ROLE_ARN
ECR_REPOSITORY
EKS_CLUSTER_NAME
FRONTEND_BUCKET
CLOUDFRONT_DISTRIBUTION_ID
DOMAIN_NAME
API_ORIGIN_HOST
ALB_CERTIFICATE_ARN
```

`AWS_ROLE_ARN` should be an IAM role trusted by this repository's GitHub OIDC subject. Do not store long-lived AWS access keys in GitHub.

## TLS path

Viewer TLS:

```text
browser --TLS--> CloudFront
```

Origin TLS:

```text
CloudFront --TLS--> ALB --HTTP--> EKS Service --HTTP--> Node
```

The CloudFront viewer certificate must be in `us-east-1`. The ALB certificate is regional and must cover `API_ORIGIN_HOST`.

## Observability boundary

This first change intentionally does not pretend environment variables alone create tracing. Kubernetes and AWS can already provide pod CPU, memory, restarts, ALB request/latency/5xx metrics, and container stdout logs. Application traces require adding OpenTelemetry packages/instrumentation to the Node backend.

The desired next flow is:

```text
Axoview API pods
     |
    OTLP
     v
OpenTelemetry Collector
  |       |       |
  v       v       v
 Loki    Mimir   Tempo
     \    |    /
        Grafana
```

That lets the existing observability lab correlate ALB latency, pod saturation, application spans, S3/DynamoDB calls, and logs for the same request.
