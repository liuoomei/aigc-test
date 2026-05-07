import type { NextConfig } from 'next'

// Next.js 15 配置
const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@aigc/types'],
  // 服务端组件外部包优化
  experimental: {
    serverComponentsExternalPackages: ['sharp', 'fluent-ffmpeg'],
  },
  // 图片远程匹配
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: process.env.NEXT_PUBLIC_STORAGE_HOST ?? 'localhost',
        port: process.env.NEXT_PUBLIC_STORAGE_PORT ?? '9000',
      },
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  // API 代理到内部 API 服务
  async rewrites() {
    const apiUrl = process.env.INTERNAL_API_URL ?? 'http://localhost:7001'
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ]
  },
  // 安全头部
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
        ],
      },
    ]
  },
}

export default nextConfig