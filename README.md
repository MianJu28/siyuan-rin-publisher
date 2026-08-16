# siyuan-plugin-rin-publisher

将思源笔记（SiYuan）中打开的文档一键发布到 [Rin](https://docs.openrin.org/) 博客。

- 支持思源笔记全平台部署（桌面端、移动端、浏览器端、Docker 等）。
- 基于 Rin 官方 REST API 实现，无需第三方中间服务。
- 支持新建发布与更新发布，发布后自动记录文章 ID，可再次一键更新。

## 功能特性

- **一键发布**：将当前打开的文档发布为 Rin 文章（`POST /api/feed`）。
- **自动更新**：已发布过的文档再次发布会自动更新（`POST /api/feed/:id`），通过文档自定义属性记录文章 ID。
- **发布选项对话框**：发布/更新前弹出对话框，可输入文章别名、标签和简介（均选填，留空使用默认值）；开启"自定义别名"后别名输入框可编辑。
- **标签与别名**：支持从文档自定义属性 `custom-tags`、`custom-alias`、`custom-summary` 读取默认值，也可在发布对话框中覆盖。
- **复制链接**：一键复制已发布文章的访问链接。
- **草稿 / 公开控制**：发布时可选择存为草稿或公开。
- **全平台**：基于思源官方插件 API，兼容桌面端、移动端与浏览器端。

## 安装

1. 下载 `package.zip`（从 Release 或本仓库构建产物获取）。
2. 在思源笔记中：`设置 → 集市 → 插件`，点击"导入"并选择压缩包。
3. 启用插件，在 `插件设置` 中填写 Rin 站点地址、用户名与密码。

> 手动开发模式安装：将本项目克隆到 `工作空间/data/plugins/siyuan-plugin-rin-publisher`，然后执行 `pnpm install && pnpm run dev`。

## 使用

1. 打开一篇思源文档。
2. 点击顶部工具栏的 Rin 图标（或使用命令面板 `⇧⌘P`）。
3. 选择"发布到 Rin"，确认后即完成发布。

发布成功后，插件会将 Rin 文章 ID 和链接写入文档自定义属性：

- `custom-rin-id`：Rin 文章 ID
- `custom-rin-url`：Rin 文章访问链接

后续再次点击发布会自动更新该文章，无需新建。

## 配置项

| 配置 | 说明 |
| ---- | ---- |
| Rin 站点地址 | Rin 部署地址，如 `https://your-blog.example.com` |
| 用户名 | Rin 登录用户名（通常为管理员） |
| 密码 | Rin 登录密码 |
| 默认标签 | 发布时附加的默认标签，逗号分隔 |
| 公开文章 | 是否在首页列表展示 |
| 存为草稿 | 是否存为草稿 |
| 使用文档自定义属性 | 是否读取 `custom-tags`、`custom-alias`、`custom-created` |
| 自定义别名 | 是否使用 `custom-alias` 作为 URL 别名 |

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（监听文件变化）
pnpm run dev

# 生产构建（生成 dist/ 与 package.zip）
pnpm run build
```

### 项目结构

```
├── src/
│   ├── index.ts        # 插件主入口
│   ├── rin.ts          # Rin API 客户端
│   ├── index.scss      # 样式
│   └── i18n/           # 国际化
├── plugin.json         # 插件清单
├── webpack.config.js   # 构建配置
└── package.json
```

## 工作原理

1. 通过监听 `switch-protyle` / `click-editorcontent` 事件维护当前激活的文档，确保多标签场景下始终操作正确文档。
2. 通过思源内核 API `getBlockInfo` 获取文档标题（`rootTitle`）。
2. 通过 `getBlockKramdown` 获取当前文档的 Markdown（Kramdown）内容，并自动清理思源块级 IAL 元数据（形如 `{: id="..." updated="..."}` 的属性行），保证发布的是干净的 Markdown。
3. 读取文档自定义属性，解析标签、别名、创建时间。
4. 调用 Rin `/api/auth/login` 登录获取 JWT。
5. 调用 `/api/feed` 创建文章或 `/api/feed/:id` 更新文章。
6. 将 Rin 文章 ID / 链接写回文档自定义属性。

## License

[MIT](LICENSE)
