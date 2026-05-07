import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 加载环境变量配置
config({ path: path.resolve(__dirname, '../../../.env') })
config({ path: path.resolve(__dirname, '../../../prompts.env'), override: false })

import { buildApp } from './app.js'

async function main() {
  const app = await buildApp()

  // 读取 host/port 配置，默认 0.0.0.0:3001
  const host = process.env.API_HOST ?? '0.0.0.0'
  const port = parseInt(process.env.API_PORT ?? '3001', 10)

  await app.listen({ host, port })

  // Fastify 5 兼容的优雅关闭
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})