# Namespace `axoview` is created by the infrastructure repository; the deploy
# role is scoped to it and cannot create namespaces.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: axoview-api
  namespace: axoview
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: axoview-api
  namespace: axoview
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: axoview-api
  template:
    metadata:
      labels:
        app: axoview-api
      annotations:
        axoview/config-revision: "__CONFIG_REVISION__"
    spec:
      serviceAccountName: axoview-api
      containers:
        - name: api
          image: __BACKEND_IMAGE__
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 3001
          envFrom:
            - configMapRef:
                name: axoview-runtime-config
          env:
            - name: NODE_ENV
              value: production
            - name: BACKEND_PORT
              value: "3001"
            - name: ENABLE_SERVER_STORAGE
              value: "false"
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 15
            periodSeconds: 20
            timeoutSeconds: 3
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      securityContext:
        seccompProfile:
          type: RuntimeDefault
---
apiVersion: v1
kind: Service
metadata:
  name: axoview-api
  namespace: axoview
spec:
  type: NodePort
  selector:
    app: axoview-api
  ports:
    - name: http
      port: 80
      targetPort: http
      nodePort: 30080
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: axoview-api
  namespace: axoview
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: axoview-api
  minReplicas: 2
  maxReplicas: 6
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
