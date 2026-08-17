# siyuan-rin-publisher

将思源笔记（SiYuan）中打开的文档一键发布到 [Rin](https://docs.openrin.org/) 博客。

- 支持思源笔记全平台部署（桌面端、移动端、浏览器端、Docker 等）。
- 基于 Rin 官方 REST API 实现，无需第三方中间服务。
- 支持新建发布、更新发布与取消发布（从 Rin 删除），发布后自动记录文章 ID，可再次一键更新。
- 若已发布的文章在 Rin 上被删除，再次发布时会提醒选择重新发布或取消发布。

## 功能特性

- **一键发布**：将当前打开的文档发布为 Rin 文章（`POST /api/feed`）。
- **自动更新**：已发布过的文档再次发布会自动更新（`POST /api/feed/:id`），通过文档自定义属性记录文章 ID。
- **自定义发布**：开启后，发布前弹出对话框，可设置文章的公开状态、是否存为草稿、标签（空格分隔）、简介与别名。
- **图片自动上传**：发布前检测文档中的本地图片，自动上传到 Rin（`POST /api/storage`）并替换为线上链接；并发上传加快速度。
- **文档图片同步替换**：发布成功后，将思源文档中的本地图片一并替换为上传后的线上链接。
- **标签与别名**：支持从文档自定义属性 `custom-tags`、`custom-alias`、`custom-summary` 读取默认值，可在发布对话框中覆盖。
- **取消发布**：一键从 Rin 删除已发布的文章，并清除文档中的发布记录（自定义属性）。
- **删除检测提醒**：已发布的文章在 Rin 上被删除后，再次发布会提醒选择重新发布（新建）或取消发布（清除本地记录）。
- **复制链接**：一键复制已发布文章的访问链接。
- **全平台**：基于思源官方插件 API，兼容桌面端、移动端与浏览器端。

## 安装

1. 下载 `siyuan-rin-publisher-<版本号>.zip`（从 Release 或本仓库构建产物获取）。
2. 在思源笔记中：`设置 → 集市 → 插件`，点击"导入"并选择压缩包。
3. 启用插件，在 `插件设置` 中填写 Rin 站点地址、用户名（管理员）、密码，并按需开启"自定义发布"。

> 手动开发模式安装：将本项目克隆到 `工作空间/data/plugins/siyuan-rin-publisher`，然后执行 `npm install && npm run dev`。

## 使用

1. 打开一篇思源文档。
2. 点击顶部工具栏的 Rin 图标（或使用命令面板 `⇧⌘P`）。
3. 选择"发布到 Rin"。

- 若开启了"自定义发布"，会弹出对话框让你选择：
  - **公开文章**（默认开启）：是否在首页列表展示
  - **存为草稿**（默认关闭）：是否存为草稿
  - **标签**：可输入多个，空格分隔
  - **简介**、**别名**：选填
- 若未开启"自定义发布"，则直接公开、非草稿发布。

发布前，文档中的本地图片会被并发上传到 Rin 并替换为线上链接；发布成功后，文档中的图片也会一并被替换为线上链接。若部分图片上传失败，会弹出提示。

发布成功后，插件会将 Rin 文章 ID 和链接写入文档自定义属性：

- `custom-rin-id`：Rin 文章 ID
- `custom-rin-url`：Rin 文章访问链接

后续再次点击发布会自动更新该文章，无需新建。

**取消发布**：在菜单中点击"从 Rin 删除"，确认后将从 Rin 删除该文章，并清除文档中的 `custom-rin-id` / `custom-rin-url` 属性。

**删除检测提醒**：若已发布的文章在 Rin 上被删除，再次发布会弹出提醒，可选择：
- **重新发布**：作为新文章重新发布；
- **取消发布**：清除文档中的本地发布记录（`custom-rin-id` / `custom-rin-url`）。

## 配置项

| 配置 | 说明 |
| ---- | ---- |
| Rin 站点地址 | Rin 部署地址，如 `https://your-blog.example.com` |
| 用户名 | Rin 登录用户名（必须是管理员） |
| 密码 | Rin 登录密码 |
| 自定义发布 | 开启后发布前弹出对话框，可选择公开、草稿、标签、简介与别名 |

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 生产构建（生成 dist/ 与 dist/package/siyuan-rin-publisher-<版本号>.zip）
npm run build
```

### 项目结构

```
├── src/
│   ├── index.ts        # 插件主入口
│   ├── rin.ts          # Rin API 客户端
│   ├── index.scss      # 样式
│   └── i18n/           # 国际化
├── .github/workflows/  # GitHub Actions（构建并发布 Release）
├── plugin.json         # 插件清单
├── webpack.config.js   # 构建配置
└── package.json
```

## 工作原理

1. 通过监听 `switch-protyle` / `click-editorcontent` 事件维护当前激活的文档，确保多标签场景下始终操作正确文档。
2. 通过思源内核 API `getBlockInfo` 获取文档标题（`rootTitle`）。
3. 通过 `getBlockKramdown` 获取当前文档的 Markdown（Kramdown）内容，并自动清理思源块级 IAL 元数据（形如 `{: id="..." updated="..."}` 的属性行），保证发布的是干净的 Markdown。
4. 读取文档自定义属性，解析标签、别名、创建时间。
5. **图片处理**：扫描 Markdown 中的本地图片（`assets/...`），并发读取并上传到 Rin（`POST /api/storage`），将发布内容中的图片替换为线上链接，并记录替换映射。
6. 调用 Rin `/api/auth/login` 登录获取 JWT。
7. 调用 `/api/feed` 创建文章或 `/api/feed/:id` 更新文章。
8. **删除检测**：发布前校验 `custom-rin-id` 对应的文章在 Rin 上是否仍存在；若已删除（404），弹出提醒让用户选择重新发布或取消发布。
9. **文档同步**：发布成功后，通过 `getChildBlocks` 遍历文档图片块，将本地图片替换为上传后的线上链接。
10. 将 Rin 文章 ID / 链接写回文档自定义属性。
11. **取消发布**：通过 `/api/feed/:id`（DELETE）从 Rin 删除文章，并清除文档中的发布相关自定义属性。

## 发布（Release）

本项目配置了 GitHub Actions 工作流（`.github/workflows/release.yml`），推送 `v*` 格式的 tag 会自动构建插件并发布 GitHub Release：

```bash
git tag v0.3.4
git push origin v0.3.4
```

## License

[MIT](LICENSE)
