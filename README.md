# YouTube 视频字幕文章生成器


## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` 中需要配置：

```bash
GEMINI_API_KEY="your-gemini-key"
SUPADATA_API_KEY="your-supadata-key"
```

可选配置 Webshare 代理：

```bash
WEBSHARE_PROXY_HOSTS="ip1,ip2"
WEBSHARE_PROXY_PORTS="port1,port2"
WEBSHARE_PROXY_USERNAME="your-username"
WEBSHARE_PROXY_PASSWORD="your-password"
```

部署：

```bash
npm run typecheck
npm run deploy
```
