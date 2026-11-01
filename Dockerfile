# Science Arena —— 生产镜像
#
# 这个项目零依赖（没有任何 npm 包），所以镜像构建就是"拷贝文件 + 跑 node"，
# 没有 npm install、没有 node_modules、不需要构建步骤。
#
# 构建：docker build -t science-arena .
# 运行：docker run -d --name arena -p 3010:3010 --env-file .env -v arena-data:/app/data science-arena

FROM node:24-alpine

# tini 处理信号转发，让 Ctrl+C / docker stop 能干净地关掉 Node
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production

# 只拷贝运行时真正需要的东西。注意：绝不 COPY .env（密钥通过环境变量注入）
COPY server.mjs cli.mjs ./
COPY src ./src
COPY public ./public
COPY prompts ./prompts
COPY dify ./dify

# 会话落盘目录：用 volume 挂载，否则容器重建后历史全丢
RUN mkdir -p /app/data/sessions \
 && addgroup -S arena \
 && adduser -S arena -G arena \
 && chown -R arena:arena /app/data

# 不用 root 跑
USER arena

EXPOSE 3010

# 健康检查用 Node 自带 fetch，不额外装 curl
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]
