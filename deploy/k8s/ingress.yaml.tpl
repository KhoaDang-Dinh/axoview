apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: axoview-api
  namespace: axoview
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: __ALB_CERTIFICATE_ARN__
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/healthcheck-port: traffic-port
    alb.ingress.kubernetes.io/success-codes: "200"
    external-dns.alpha.kubernetes.io/hostname: __API_ORIGIN_HOST__
spec:
  ingressClassName: alb
  rules:
    - host: __API_ORIGIN_HOST__
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: axoview-api
                port:
                  name: http
          - path: /healthz
            pathType: Exact
            backend:
              service:
                name: axoview-api
                port:
                  name: http
