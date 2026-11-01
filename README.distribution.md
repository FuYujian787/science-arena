# Science Arena · 假说引力

多智能体科研假说辩论与方案修正平台。输入一句假说，或提供已有研究并聚焦一个具体问题，由五类角色独立评审、交叉质询，形成争议清单、创新潜力初评、修改建议与修正版方案。

输出属于模型辅助建议，来源标注不代表科学结论已验证。

## 下载使用

在本仓库 **Releases** 中查看实际发布的安装包：

- Windows x64：`Science-Arena-版本-Windows-x64.exe`。
- Mac：由 GitHub Actions 在 Mac 环境构建 x64 / arm64 的 DMG；请以 Releases 中实际存在的文件为准。
- 安卓：部署网页版至 HTTPS 域名后，在支持安装的浏览器中添加到主屏幕（PWA）。本项目目前不提供原生 APK。

首次打开点击「模型设置」，填写自己的 DeepSeek API Key，或 Dify 地址和 App Key；可先选择「离线演示」体验界面。真实调用使用你自己的模型额度。连接测试也会产生少量用量。

当前安装包没有开发者代码签名。Mac 构建成功不代表通过实机启动验证。请依据发行说明判断适用状态，不建议关闭系统安全保护。

## 数据与密钥

桌面版在系统个人应用目录保存会话，模型配置按需使用系统安全存储加密；可取消勾选保存，仅在当前窗口使用。系统安全存储不可用时不会降级为明文保存。API 请求与研究内容发往所选模型服务，文献查询发往 PubMed；不内置团队 API Key。

网页版采用浏览器访客凭证隔离历史。密钥在页面内存和本次后端任务中使用，不保存进研究记录；刷新后需重新填写。会话记录保存在部署者的服务器，清除浏览器数据可能失去访问入口。此版本不包含跨设备登录与账号恢复。

## 从源码运行

需要 Node.js 24 及以上。

```sh
# 浏览器本机运行：忽略本地配置文件，不需要安装开发依赖
node tools/start-personal.mjs

# 桌面开发 / 构建
npm ci
npm run desktop
npm run pack:win
# 在 Mac 上执行
npm run pack:mac
```

本地网页默认地址为 `http://127.0.0.1:3010`。源码模式的会话在 `data/sessions`；桌面版会话位于 Windows `%APPDATA%/science-arena/sessions`，Mac `~/Library/Application Support/science-arena/sessions`。

## 部署网页版

需要可运行 Docker Compose 的服务器，以及解析到服务器的域名。无需提供站点共用模型密钥，使用者自行填写。

在 `deploy` 下将 `public.env.example` 复制为 `.env`，设置 `DOMAIN`，再执行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.public.yml up -d --build
```

服务器开放 80/443，Caddy 自动处理 HTTPS；应用端口不直接公开。若域名和网络条件不满足，证书申请不会成功。数据存于 Docker volume `arena-data`（实际卷名含 Compose 项目前缀），删除卷会丢失历史。

公网版默认只允许 DeepSeek 官方模型地址。开放 Dify 时，由部署者配置唯一的 `ARENA_DIFY_ALLOWED_URL`，并确认服务器确实能访问。自定义模型地址建议使用桌面版。公网版同时最多四场辩论，每位访客同时一场；默认每个网络来源每小时最多十二次辩论或连接测试。在默认反向代理后此配额是站点共享的保守上限。

安卓安装入口依浏览器而异，通常在菜单中的「安装应用」或「添加到主屏幕」。PWA 缓存界面，不缓存 API、研究记录或导出文件；离线时不能运行真实模型。

GitHub Pages 仅提供介绍和下载入口，不能执行本项目的 Node 后端。下载入口页部署后由实际发布版本提供安装包链接。

## 校验与发布

```sh
npm test
node tools/test-dify-e2e.mjs
node tools/prepare-release.mjs
```

`prepare-release` 只复制白名单中的源码和文档到 `.release-stage/science-arena`，排除本地密钥、个人历史、论文、申报材料和旧压缩包。GitHub 上传应从该目录进行，不应整目录上传研究工作区。

推送 `v版本` 标签会触发 Windows、Mac 两种架构构建；全部构建通过后创建 **草稿 Release**。手动触发仅生成 Actions 安装包产物。初次发布前检查实际构建和测试结果，再发布草稿。

## 许可

当前尚未指定开源许可证；源码可见不自动授予修改、再分发等许可。团队确定许可证后再正式作为开源项目发布。仅参考其他项目的分发模式，未复制其源码。
