# PostgreSQL 到 MySQL 数据迁移工具

## 环境变量

```bash
# PostgreSQL 源数据库
PG_DATABASE_URL=postgresql://user:password@localhost:5432/aigc

# MySQL 目标数据库（通过 Prisma）
DATABASE_URL=mysql://user:password@localhost:3306/aigc
```

## 使用方法

```bash
# 安装依赖
pnpm install

# 开发环境运行（热重载）
pnpm dev

# 生产环境运行
pnpm build
pnpm start
```

## 注意事项

- 迁移前请确保 MySQL 数据库已通过 Prisma 迁移创建
- 建议在测试环境先运行，验证数据完整性后再执行生产迁移
- 大表迁移使用批次处理，避免内存溢出