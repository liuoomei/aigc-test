# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`apps/docs` 是 Toby.AI 企业版 AIGC 创作平台的**文档站点**，基于 Nextra（Next.js 13 + MDX）构建，托管产品使用手册。

---

## 常用命令

```bash
pnpm dev      # 开发模式（端口 3001）
pnpm build    # 生产构建（输出静态文件）
pnpm start    # 生产环境预览
```

---

## 技术架构

### 框架选型

- **Nextra 2.x**：基于 Next.js 13 的文档框架，主题组件（`nextra-theme-docs`）提供侧边栏、搜索、TOC 等开箱即用的文档 UI
- **MDX**：文档内容以 `.mdx` 格式编写，支持在 Markdown 中嵌入 React 组件

### 目录结构

```
apps/docs/
  pages/           # MDX 文档页面（路由对应文件路径）
    index.mdx      # 平台简介
    01-login.mdx   # 登录与账户
    02-workspace.mdx # 工作台
    03-image-generation.mdx # 图片生成
    04-video-generation.mdx # 视频生成
    05-asset-library.mdx # 资产库
    06-ai-assistant.mdx # AI 助手
  theme.config.tsx # Nextra 主题配置（导航、Logo、页脚、TOC 等）
  next.config.js   # Next.js 配置，使用 nextra 插件
  public/images/   # 文档中引用的截图资源
```

### 文档路由

Nextra 的文件路由直接映射 URL：`pages/01-login.mdx` → `/01-login`，无需额外配置。

### 静态导出

`next.config.js` 中 `output: 'export'` 启用静态 HTML 导出，构建产物可直接部署到任意静态托管服务（Vercel、Netlify、自建 Nginx 等）。

---

## 注意事项

- 文档中的 `{/* TODO: 截图 - ... */}` 注释标记了尚待补充的截图占位符
- 截图资源统一放在 `public/images/` 目录，MDX 中引用路径为 `/images/xxx.png`
- 修改 `theme.config.tsx` 会影响所有页面的导航结构、搜索、TOC 等全局 UI