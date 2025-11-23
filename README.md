# OVH 服务器抢购系统

一个用于监控和自动抢购 OVH 服务器的应用。以下为精简版部署说明，保留必要信息，便于快速上手。
基于 https://github.com/coolci/OVH-BUY 项目1112分支，进行了一些OVH多账户的支持，并添加了一些新的功能以及优化。

## 系统要求
- Docker 20.10+
- Docker Compose 2.0+

## 快速部署（Docker Compose）
```yaml
version: "3.8"
services:
  ovh-app:
    image: iniwex/ovh:latest
    container_name: OVH
    pull_policy: always
    ports:
      - "20000:80"
    environment:
      - DEBUG=false
      - VITE_API_URL=/api
      - API_SECRET_KEY=请替换为你自己的访问密钥
      - ENABLE_API_KEY_AUTH=true
    volumes:
      - ./data:/app/backend/data
      - ./logs:/app/backend/logs
      - ./cache:/app/backend/cache
    restart: unless-stopped
```

## 环境变量说明
- `API_SECRET_KEY`：后端 API 访问密钥（前后端需一致）
- `VITE_API_URL`：前端调用后端的基础路径（容器内默认 `/api`）
- `ENABLE_API_KEY_AUTH`：是否启用 API 密钥校验（生产环境建议 `true`）
- `TZ`：容器时区，已在镜像中默认设置为 `Asia/Shanghai` (可选，若需自定义时区请指定)


## 许可证
MIT License
