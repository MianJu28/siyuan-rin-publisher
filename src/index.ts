import {
    Plugin,
    showMessage,
    Setting,
    Menu,
    getFrontend,
    fetchPost,
    getAllEditor,
    IProtyle,
    Dialog,
} from "siyuan";
import { RinClient, RinFeedPayload } from "./rin";
import "./index.scss";

const CONFIG_KEY = "rin-config";
const ATTR_RIN_ID = "custom-rin-id";
const ATTR_RIN_URL = "custom-rin-url";

interface RinPluginConfig {
    baseUrl: string;
    username: string;
    password: string;
    /** 是否启用自定义发布（发布时弹出对话框让用户选择选项） */
    customPublish: boolean;
}

function defaultConfig(): RinPluginConfig {
    return {
        baseUrl: "",
        username: "",
        password: "",
        customPublish: true,
    };
}

/** 从自定义属性中读取的发布元信息 */
interface PublishMeta {
    /** 已发布的 Rin 文章 id（若存在） */
    rinId?: number;
    /** 文档标题 */
    title: string;
    /** 文档 Markdown 内容 */
    content: string;
    /** 标签数组 */
    tags: string[];
    /** URL 别名 */
    alias?: string;
    /** 创建时间 ISO 字符串 */
    createdAt?: string;
    /** 简介/摘要 */
    summary?: string;
}

/** 发布对话框收集到的用户输入 */
interface PublishInput {
    /** 是否公开文章（在首页列表展示） */
    listed: boolean;
    /** 是否存为草稿 */
    draft: boolean;
    /** 用户输入的别名（空串表示不使用） */
    alias: string;
    /** 用户输入的标签数组 */
    tags: string[];
    /** 用户输入的简介（空串表示不使用） */
    summary: string;
}

export default class RinPublisherPlugin extends Plugin {
    private isMobile = false;
    private config: RinPluginConfig = defaultConfig();
    /**
     * 当前激活的编辑器。
     * 通过监听 switch-protyle / click-editorcontent 事件维护，
     * 避免 getAllEditor()[0] 在多标签场景下返回非当前文档导致发布/复制错误文档。
     */
    private activeProtyle: IProtyle | null = null;

    /** 最近一次自定义发布对话框中用户输入，用于发布后写回文档属性 */
    private lastPublishInput: PublishInput | null = null;

    /** 事件监听回调（保存引用以便卸载时移除） */
    private readonly onSwitchProtyle = (event: CustomEvent<{ protyle: IProtyle }>) => {
        this.activeProtyle = event.detail.protyle;
    };
    private readonly onClickEditorContent = (event: CustomEvent<{ protyle: IProtyle }>) => {
        this.activeProtyle = event.detail.protyle;
    };

    onload() {
        const frontend = getFrontend();
        this.isMobile = frontend === "mobile" || frontend === "browser-mobile";

        // 监听文档切换 / 编辑点击，维护当前激活文档
        this.eventBus.on("switch-protyle", this.onSwitchProtyle);
        this.eventBus.on("click-editorcontent", this.onClickEditorContent);

        // 加载配置
        this.loadData(CONFIG_KEY).then((data: RinPluginConfig | undefined) => {
            if (data) {
                this.config = { ...defaultConfig(), ...data };
            }
        }).catch((e) => {
            console.warn(`[${this.name}] load config fail:`, e);
        });

        // 构建设置面板
        this.initSettingPanel();

        // 注册命令（用于命令面板与全局快捷键）
        this.addCommand({
            langKey: "publish",
            hotkey: "⇧⌘P",
            callback: () => {
                this.publishCurrentDoc().catch((e) => {
                    console.error("[rin-publisher] publish error:", e);
                });
            },
        });

        this.addCommand({
            langKey: "copyLink",
            hotkey: "",
            globalCallback: () => {
                this.copyCurrentDocLink().catch((e) => {
                    console.error("[rin-publisher] copy link error:", e);
                });
            },
        });
    }

    onLayoutReady() {
        // 添加顶栏按钮（右侧）
        const topBarElement = this.addTopBar({
            icon: "iconOpenWindow",
            title: this.i18n.pluginName,
            position: "right",
            callback: () => {
                if (this.isMobile) {
                    this.showMenu();
                } else {
                    let rect = topBarElement.getBoundingClientRect();
                    if (rect.width === 0) {
                        const more = document.querySelector("#barMore");
                        if (more) {
                            rect = more.getBoundingClientRect();
                        }
                    }
                    if (rect.width === 0) {
                        const plugins = document.querySelector("#barPlugins");
                        if (plugins) {
                            rect = plugins.getBoundingClientRect();
                        }
                    }
                    this.showMenu(rect);
                }
            },
        });
    }

    onunload() {
        // 移除事件监听
        this.eventBus.off("switch-protyle", this.onSwitchProtyle);
        this.eventBus.off("click-editorcontent", this.onClickEditorContent);
    }

    /**
     * 初始化插件设置面板（显示在思源标准插件设置中）
     */
    private initSettingPanel() {
        // 输入控件引用，用于保存时取值
        const baseUrlInput = document.createElement("input");
        baseUrlInput.className = "b3-text-field fn__block";
        baseUrlInput.placeholder = "https://your-blog.example.com";

        const usernameInput = document.createElement("input");
        usernameInput.className = "b3-text-field fn__block";
        usernameInput.autocomplete = "username";

        const passwordInput = document.createElement("input");
        passwordInput.className = "b3-text-field fn__block";
        passwordInput.type = "password";
        passwordInput.autocomplete = "current-password";

        const customPublishInput = document.createElement("input");
        customPublishInput.type = "checkbox";
        customPublishInput.className = "b3-switch fn__flex-center";

        this.setting = new Setting({
            confirmCallback: async () => {
                this.config = {
                    baseUrl: baseUrlInput.value.trim(),
                    username: usernameInput.value.trim(),
                    password: passwordInput.value,
                    customPublish: customPublishInput.checked,
                };
                await this.saveData(CONFIG_KEY, this.config).catch((e) => {
                    showMessage(`[${this.name}] save config fail: ${e}`);
                });
                showMessage(this.i18n.save);
            },
        });

        this.setting.addItem({
            title: this.i18n.settingBaseUrl,
            description: this.i18n.settingBaseUrlDesc,
            direction: "row",
            createActionElement: () => {
                baseUrlInput.value = this.config.baseUrl;
                return baseUrlInput;
            },
        });
        this.setting.addItem({
            title: this.i18n.settingUsername,
            description: this.i18n.settingUsernameDesc,
            direction: "row",
            createActionElement: () => {
                usernameInput.value = this.config.username;
                return usernameInput;
            },
        });
        this.setting.addItem({
            title: this.i18n.settingPassword,
            description: this.i18n.settingPasswordDesc,
            direction: "row",
            createActionElement: () => {
                passwordInput.value = this.config.password;
                return passwordInput;
            },
        });
        this.setting.addItem({
            title: this.i18n.settingCustomPublish,
            description: this.i18n.settingCustomPublishDesc,
            direction: "row",
            createActionElement: () => {
                customPublishInput.checked = this.config.customPublish;
                return customPublishInput;
            },
        });
    }

    /**
     * 在顶栏按钮处显示的菜单
     */
    private showMenu(rect?: DOMRect) {
        const menu = new Menu("rinPublisher", () => {
            /* closed */
        });
        menu.addItem({
            icon: "iconOpenWindow",
            label: this.i18n.publish,
            click: () => {
                this.publishCurrentDoc().catch((e) => console.error(e));
            },
        });
        menu.addItem({
            icon: "iconLink",
            label: this.i18n.copyLink,
            click: () => {
                this.copyCurrentDocLink().catch((e) => console.error(e));
            },
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconCheck",
            label: this.i18n.testConnection,
            click: () => {
                this.testConnection();
            },
        });
        if (this.isMobile) {
            menu.fullscreen();
        } else {
            menu.open({
                x: rect ? rect.right : 0,
                y: rect ? rect.bottom : 0,
                isLeft: true,
            });
        }
    }

    /**
     * 测试与 Rin 的连接（登录）
     */
    private async testConnection() {
        const { baseUrl, username, password } = this.config;
        if (!baseUrl || !username || !password) {
            showMessage(this.i18n.noConfig);
            return;
        }
        const client = new RinClient(baseUrl);
        const ok = await client.testConnection(username, password);
        if (ok) {
            showMessage(this.i18n.testConnectionSuccess);
        } else {
            showMessage(`${this.i18n.testConnectionFailed}：${baseUrl}`);
        }
    }

    /**
     * 获取当前激活的编辑器 Protyle。
     * 优先使用通过事件维护的 activeProtyle（确保多标签时指向用户正在操作的文档），
     * 若尚未捕获到事件，则回退到 getAllEditor()[0]。
     */
    private getEditorProtyle(): IProtyle | null {
        if (this.activeProtyle && this.activeProtyle.block?.rootID) {
            return this.activeProtyle;
        }
        const editors = getAllEditor();
        if (editors.length === 0) {
            return null;
        }
        return editors[0].protyle;
    }

    /**
     * 清理思源 Kramdown 中的块级 / 行内 IAL（Inline Attribute List）元数据。
     *
     * `getBlockKramdown` 返回的内容会包含两类 IAL 属性：
     * 1. 独立成行的块级属性：`{: id="..." updated="..."}`
     * 2. 行内属性：`- {: id="..."}[链接](url)` 或 `{: id="..."}文本`
     *
     * 这些是思源内部元数据，不应出现在发布到 Rin 的 Markdown 中。
     * 此函数会移除代码块之外的所有 `{: ... }` IAL 片段（代码块内的内容原样保留）。
     *
     * @param kramdown 原始 Kramdown 内容
     * @returns 清理后的干净 Markdown
     */
    private cleanKramdown(kramdown: string): string {
        const lines = kramdown.split("\n");
        let inCodeBlock = false;
        const cleanedLines: string[] = [];

        for (const line of lines) {
            // 检测代码围栏，切换代码块状态（` ``` ` 或 ` ~~~ `）
            const fenceMatch = line.match(/^\s*(```+|~~~+)/);
            if (fenceMatch) {
                inCodeBlock = !inCodeBlock;
                cleanedLines.push(line);
                continue;
            }

            // 代码块内的内容原样保留（其中的 {: } 可能是用户代码）
            if (inCodeBlock) {
                cleanedLines.push(line);
                continue;
            }

            // 代码块外：删除行内 IAL 片段
            const cleaned = line.replace(/\{:([^{}]*)\}/g, "");

            // 整行仅由 IAL 组成（删除后为空但原行非空）：
            // 用一个空行占位，避免相邻块内容粘连；若上一行已是空行则不再重复添加
            if (cleaned.trim() === "" && line.trim() !== "") {
                if (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() !== "") {
                    cleanedLines.push("");
                }
                continue;
            }

            // 规范化删除 IAL 后可能产生的多余空白（如 `-  内容` -> `- 内容`）
            cleanedLines.push(cleaned.replace(/^(\s*[-*+]\s{2,})/, (m) => m.replace(/\s+$/, " ")));
        }

        // 合并多余空行，保留单个空行用于分隔
        return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    /**
     * 获取思源本地资源文件（图片）的二进制内容。
     *
     * 按思源官方建议，通过内核 API `/api/file/getFile` 读取 data 目录下的文件，
     * 而非自行调用 fs，避免数据同步时出现块丢失或云端损坏。
     *
     * 使用原生 fetch（相对路径，自动解析到当前思源内核服务）+ 内核 API Token，
     * 直接以 Blob 形式获取二进制文件内容，规避 fetchPost 对二进制接口的限制。
     *
     * 思源 `getBlockKramdown` 中本地图片通常以 `assets/xxx.png` 或 `/assets/xxx.png`
     * 形式引用，而 `/api/file/getFile` 的 path 需以 `data/` 开头。
     *
     * @param path 资源文件路径，如 `assets/xxx.png`
     * @returns 文件 Blob；失败返回 null
     */
    private async fetchAssetFile(path: string): Promise<Blob | null> {
        // 归一化路径：`/assets/xxx.png` / `assets/xxx.png` -> `data/assets/xxx.png`
        const normalized = `data/${path.replace(/^\/+/, "").replace(/^data\//, "")}`;

        // 获取思源内核 API Token 用于认证
        const token = (window as unknown as { siyuan?: { config?: { api?: { token?: string } } } })
            .siyuan?.config?.api?.token;

        try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (token) {
                headers["Authorization"] = `Token ${token}`;
            }
            // 相对路径会自动解析到当前思源内核服务，无需拼接端口
            const resp = await fetch("/api/file/getFile", {
                method: "POST",
                headers,
                body: JSON.stringify({ path: normalized }),
            });
            if (!resp.ok) {
                console.warn(`[rin-publisher] get asset fail: ${path}`, resp.status);
                return null;
            }
            return await resp.blob();
        } catch (e) {
            console.warn("[rin-publisher] fetch asset fail:", e);
            return null;
        }
    }

    /**
     * 处理文档 Markdown 中的图片。
     *
     * 检测所有 Markdown 图片 `![alt](url)`，若 url 指向思源本地资源
     * （非 `http(s)://` 或 `data:` 形式，即未以链接形式引入），
     * 则通过思源读取图片二进制，上传到 Rin，并将原链接替换为上传后的图片 URL。
     *
     * @param content 已清理的 Markdown 内容
     * @param client  已登录的 Rin 客户端
     * @returns 处理结果：处理后的内容、替换映射（原图片路径 -> 新 URL）与失败统计
     */
    private async processImages(
        content: string,
        client: RinClient,
    ): Promise<{
        content: string;
        mapping: Map<string, string>;
        total: number;
        failed: number;
    }> {
        // 匹配 Markdown 图片语法：![alt](url) 或 ![alt](url "title")
        const imageRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
        const matches: Array<{ full: string; alt: string; url: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = imageRegex.exec(content)) !== null) {
            matches.push({ full: m[0], alt: m[1], url: m[2] });
        }

        const mapping = new Map<string, string>();

        // 收集需要上传的本地图片（跳过已是链接的）
        const pending: Array<{ full: string; alt: string; url: string; filename: string }> = [];
        for (const img of matches) {
            const url = img.url.trim();
            if (/^(https?:\/\/|data:|blob:)/i.test(url)) {
                continue;
            }
            pending.push({
                full: img.full,
                alt: img.alt,
                url,
                filename: url.split(/[/\\]/).pop() || "image.png",
            });
        }

        // 并发上传所有图片：读取图片 -> 上传到 Rin -> 得到新 URL
        const results = await Promise.all(
            pending.map(async (img) => {
                try {
                    const blob = await this.fetchAssetFile(img.url);
                    if (!blob) {
                        console.warn(`[rin-publisher] skip image, cannot read: ${img.url}`);
                        return { full: img.full, alt: img.alt, url: img.url, newUrl: undefined };
                    }
                    const result = await client.uploadImage(blob, img.filename);
                    if (result.error || !result.data?.url) {
                        console.warn(`[rin-publisher] upload image fail: ${img.url}`, result.error?.value);
                        return { full: img.full, alt: img.alt, url: img.url, newUrl: undefined };
                    }
                    return { full: img.full, alt: img.alt, url: img.url, newUrl: result.data.url };
                } catch (e) {
                    console.warn(`[rin-publisher] upload image error: ${img.url}`, e);
                    return { full: img.full, alt: img.alt, url: img.url, newUrl: undefined };
                }
            }),
        );

        // 上传完成后统一替换链接，并记录映射
        let failed = 0;
        for (const r of results) {
            if (!r.newUrl) {
                failed++;
                continue;
            }
            content = content.split(r.full).join(`![${r.alt}](${r.newUrl})`);
            mapping.set(r.url.replace(/^\/+/, ""), r.newUrl);
        }

        return { content, mapping, total: matches.length, failed };
    }

    /**
     * 更新文档中的图片块：把本地图片（引用 assets 资源）替换为上传后的线上链接。
     *
     * 遍历文档所有子块，图片块在 getChildBlocks 中 type 可能是 "p"（段落），
     * 但其 markdown 字段为 Markdown 图片语法 `![alt](assets/xxx.png)`。
     * 据此匹配替换映射，用 `/api/block/updateBlock` 将块更新为新的线上 URL。
     *
     * @param rootId  文档根块 ID
     * @param mapping 原图片路径 -> 新 URL 的替换映射
     */
    private async updateDocImages(rootId: string, mapping: Map<string, string>): Promise<void> {
        // 递归收集所有子块，筛选包含 Markdown 图片语法的块
        const imgBlocks: Array<{ id: string; src: string; alt: string }> = [];

        const collect = (parentId: string): Promise<void> =>
            new Promise<void>((resolve) => {
                fetchPost(
                    "/api/block/getChildBlocks",
                    { id: parentId },
                    (resp: { data?: Array<{ id: string; markdown?: string }> }) => {
                        const blocks = resp.data ?? [];
                        const tasks: Promise<void>[] = [];
                        for (const block of blocks) {
                            // 图片块的 markdown 字段形如：![alt](assets/xxx.png)
                            const m = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(block.markdown ?? "");
                            if (m && m[2]) {
                                const src = m[2].replace(/^\/+/, "");
                                // 仅当该路径在替换映射中才记录，避免不必要更新
                                if (mapping.has(src)) {
                                    imgBlocks.push({ id: block.id, src, alt: m[1] ?? "" });
                                }
                            }
                            // 递归子块
                            tasks.push(collect(block.id));
                        }
                        Promise.all(tasks).then(() => resolve());
                    },
                    {},
                    () => resolve(),
                );
            });

        await collect(rootId);

        // 逐个更新匹配的图片块
        for (const img of imgBlocks) {
            const newUrl = mapping.get(img.src);
            if (!newUrl) {
                continue;
            }
            const markdown = `![${img.alt}](${newUrl})`;
            await new Promise<void>((resolve) => {
                fetchPost(
                    "/api/block/updateBlock",
                    { id: img.id, dataType: "markdown", data: markdown },
                    () => resolve(),
                    {},
                    () => resolve(),
                );
            });
        }
    }

    /**
     * 获取当前文档的发布元信息（标题 + Markdown 内容 + 自定义属性）
     */
    private async collectPublishMeta(): Promise<PublishMeta | null> {
        const protyle = this.getEditorProtyle();
        if (!protyle) {
            showMessage(this.i18n.noDoc);
            return null;
        }
        const rootId = protyle.block.rootID;

        // 获取文档标题（getBlockInfo 返回的文档标题字段为 rootTitle）
        const title = await new Promise<string>((resolve) => {
            fetchPost(
                "/api/block/getBlockInfo",
                { id: rootId },
                (resp: { data?: { rootTitle?: string } }) => {
                    resolve(resp.data?.rootTitle ?? "");
                },
            );
        });

        // 获取文档 Markdown（Kramdown）内容，并清理思源 IAL 元数据
        const kramdown = await new Promise<string | null>((resolve) => {
            fetchPost("/api/block/getBlockKramdown", { id: rootId }, (resp: { data?: { kramdown?: string } }) => {
                resolve(resp.data?.kramdown ?? null);
            });
        });
        if (kramdown === null) {
            showMessage(this.i18n.getContentFailed);
            return null;
        }
        const content = this.cleanKramdown(kramdown);

        // 读取自定义属性（用于预填发布对话框中的默认值）
        let attrs: Record<string, string> = {};
        try {
            attrs = await new Promise<Record<string, string>>((resolve) => {
                fetchPost("/api/attr/getBlockAttrs", { id: rootId }, (resp: { data?: Record<string, string> }) => {
                    resolve(resp.data ?? {});
                });
            });
        } catch (e) {
            console.warn("[rin-publisher] get attrs fail:", e);
        }

        // 解析标签（从文档自定义属性 custom-tags 读取，逗号分隔）
        const tags: string[] = [];
        if (attrs["custom-tags"]) {
            tags.push(...attrs["custom-tags"].split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean));
        }
        const uniqueTags = Array.from(new Set(tags));

        // 别名
        const alias = attrs["custom-alias"]?.trim() || undefined;

        // 简介/摘要
        const summary = attrs["custom-summary"]?.trim() || undefined;

        // 创建时间
        let createdAt: string | undefined;
        if (attrs["custom-created"]) {
            const ts = Number(attrs["custom-created"]);
            if (!Number.isNaN(ts) && ts > 0) {
                createdAt = new Date(ts).toISOString();
            }
        }

        // 已发布的 Rin id
        let rinId: number | undefined;
        if (attrs[ATTR_RIN_ID]) {
            const parsed = Number(attrs[ATTR_RIN_ID]);
            if (!Number.isNaN(parsed) && parsed > 0) {
                rinId = parsed;
            }
        }

        return {
            rinId,
            title: title || "Untitled",
            content,
            tags: uniqueTags,
            alias,
            createdAt,
            summary,
        };
    }

    /**
     * 弹出发布选项对话框，收集用户输入的公开/草稿、别名、标签和简介。
     *
     * @param meta     已收集的发布元信息（用于填充默认值）
     * @param isUpdate 是否为更新已发布文章
     * @returns 用户点击发布后返回输入内容；取消则返回 null
     */
    private showPublishDialog(
        meta: PublishMeta,
        isUpdate: boolean,
    ): Promise<PublishInput | null> {
        return new Promise((resolve) => {
            const dialog = new Dialog({
                title: this.i18n.publishDialogTitle,
                content: `
<div class="b3-dialog__content">
    <div class="b3-typography" style="margin-bottom:12px">${this.i18n.publishDialogDesc}</div>
    <div class="rin-publisher__publish">
        <div class="b3-form__item rin-publisher__publish-checkbox">
            <label class="fn__flex b3-form__label">${this.i18n.publishDialogListed}</label>
            <input id="rinPubListed" type="checkbox" class="b3-switch fn__flex-center" />
        </div>
        <div class="b3-form__item rin-publisher__publish-checkbox">
            <label class="fn__flex b3-form__label">${this.i18n.publishDialogDraft}</label>
            <input id="rinPubDraft" type="checkbox" class="b3-switch fn__flex-center" />
        </div>
        <div class="b3-form__item">
            <label class="fn__flex b3-form__label">${this.i18n.publishDialogAlias}</label>
            <input id="rinPubAlias" class="b3-text-field fn__block" placeholder="${this.i18n.publishDialogAliasPh}" />
        </div>
        <div class="b3-form__item">
            <label class="fn__flex b3-form__label">${this.i18n.publishDialogTags}</label>
            <input id="rinPubTags" class="b3-text-field fn__block" placeholder="${this.i18n.publishDialogTagsPh}" />
        </div>
        <div class="b3-form__item">
            <label class="fn__flex b3-form__label">${this.i18n.publishDialogSummary}</label>
            <textarea id="rinPubSummary" class="b3-text-field fn__block" rows="3" placeholder="${this.i18n.publishDialogSummaryPh}"></textarea>
        </div>
    </div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.i18n.cancel}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">${isUpdate ? this.i18n.publishDialogUpdate : this.i18n.publishDialogSubmit}</button>
</div>`,
                width: this.isMobile ? "92vw" : "560px",
            });

            const listedInput = dialog.element.querySelector("#rinPubListed") as HTMLInputElement;
            const draftInput = dialog.element.querySelector("#rinPubDraft") as HTMLInputElement;
            const aliasInput = dialog.element.querySelector("#rinPubAlias") as HTMLInputElement;
            const tagsInput = dialog.element.querySelector("#rinPubTags") as HTMLInputElement;
            const summaryInput = dialog.element.querySelector("#rinPubSummary") as HTMLTextAreaElement;

            // 默认值：公开文章默认是，存为草稿默认否
            listedInput.checked = true;
            draftInput.checked = false;
            aliasInput.value = meta.alias ?? "";
            tagsInput.value = meta.tags.join(" ");
            summaryInput.value = meta.summary ?? "";

            const [cancelBtn, submitBtn] = dialog.element.querySelectorAll(".b3-button");
            cancelBtn.addEventListener("click", () => {
                dialog.destroy();
                resolve(null);
            });
            submitBtn.addEventListener("click", () => {
                const input: PublishInput = {
                    listed: listedInput.checked,
                    draft: draftInput.checked,
                    alias: aliasInput.value.trim(),
                    tags: tagsInput.value.split(/[\s,，]+/).map((t) => t.trim()).filter(Boolean),
                    summary: summaryInput.value.trim(),
                };
                dialog.destroy();
                resolve(input);
            });
        });
    }

    /**
     * 发布（或更新）当前文档到 Rin
     */
    private async publishCurrentDoc() {
        const { baseUrl, username, password } = this.config;
        if (!baseUrl) {
            showMessage(this.i18n.noConfig);
            return;
        }

        const meta = await this.collectPublishMeta();
        if (!meta) {
            return;
        }

        // 登录获取 token
        const client = new RinClient(baseUrl);
        if (username) {
            const login = await client.login(username, password);
            if (!login.data?.token) {
                showMessage(`${this.i18n.loginFailed}：${login.error?.value ?? ""}`);
                return;
            }
        }

        // 发布前处理文档中的本地图片：检测非链接形式的图片，
        // 通过 Rin 上传并替换为图片链接
        let imageMapping: Map<string, string> = new Map();
        try {
            if (/!\[[^\]]*\]\([^)\s]+\)/.test(meta.content)) {
                showMessage(this.i18n.uploadingImages);
            }
            const imgResult = await this.processImages(meta.content, client);
            meta.content = imgResult.content;
            imageMapping = imgResult.mapping;
            if (imgResult.failed > 0) {
                showMessage(this.i18n.imagesUploadFailed.replace("{failed}", String(imgResult.failed)));
            }
        } catch (e) {
            console.warn("[rin-publisher] process images fail:", e);
        }

        const rootId = this.getEditorProtyle()?.block.rootID;
        let resultId: number | undefined;
        let isUpdate = false;

        // 存在 custom-rin-id 时，先校验 Rin 上该文章是否真实存在。
        // 若文章已不存在（例如被删除，或 custom-rin-id 是残留/误判），
        // 则降级为新建，避免误进入更新分支导致"文档已发布"误报。
        if (meta.rinId) {
            const feed = await client.getFeed(meta.rinId);
            if (feed.error && feed.error.status === 404) {
                console.warn(`[rin-publisher] rin feed ${meta.rinId} not found, fallback to create`);
                meta.rinId = undefined;
            } else {
                isUpdate = true;
            }
        }

        // 组装发布载荷的公共字段
        let payload: RinFeedPayload;
        const basePayload = (extra: {
            listed: boolean;
            draft: boolean;
            tags: string[];
            alias?: string;
            summary?: string;
        }) => {
            const p: RinFeedPayload = {
                title: meta.title,
                content: meta.content,
                listed: extra.listed,
                draft: extra.draft,
                tags: extra.tags,
                createdAt: meta.createdAt,
            };
            if (extra.alias) {
                p.alias = extra.alias;
            }
            if (extra.summary) {
                p.summary = extra.summary;
            }
            return p;
        };

        if (this.config.customPublish) {
            // 自定义发布：弹出对话框让用户选择公开/草稿/标签/简介/别名
            const input = await this.showPublishDialog(meta, isUpdate);
            if (!input) {
                return;
            }
            payload = basePayload({
                listed: input.listed,
                draft: input.draft,
                tags: input.tags.length > 0 ? input.tags : meta.tags,
                alias: input.alias || meta.alias,
                summary: input.summary || meta.summary,
            });
            // 记录输入供写回文档属性
            this.lastPublishInput = input;
        } else {
            // 直接发布：公开文章、非草稿，不附加标签/简介/别名
            payload = basePayload({
                listed: true,
                draft: false,
                tags: [],
            });
            this.lastPublishInput = null;
        }

        if (isUpdate && meta.rinId) {
            // 更新已发布的文章
            showMessage(this.i18n.updating);
            const res = await client.updateFeed(meta.rinId, payload);
            if (res.error) {
                showMessage(`${this.i18n.updateFailed}：${res.error.value}`);
                return;
            }
            resultId = meta.rinId;
            showMessage(this.i18n.updateSuccess);
        } else {
            // 新建文章
            showMessage(this.i18n.publishing);
            const res = await client.createFeed(payload);
            if (res.error || res.data?.insertedId === undefined) {
                showMessage(`${this.i18n.publishFailed}：${res.error?.value ?? ""}`);
                return;
            }
            resultId = res.data.insertedId;
            showMessage(this.i18n.publishSuccess);
        }

        // 发布成功后，将文档中的本地图片一并替换为上传后的线上链接
        if (rootId && imageMapping.size > 0) {
            try {
                await this.updateDocImages(rootId, imageMapping);
            } catch (e) {
                console.warn("[rin-publisher] update doc images fail:", e);
            }
        }

        // 将文章 id 写回文档自定义属性，便于后续更新 / 复制链接。
        // 同时把用户在发布对话框中输入的别名/标签/简介写回文档属性，便于下次发布保留。
        if (rootId && resultId && this.lastPublishInput) {
            const attrs: Record<string, string> = {
                [ATTR_RIN_ID]: String(resultId),
                [ATTR_RIN_URL]: `${baseUrl}/feed/${resultId}`,
            };
            if (this.lastPublishInput.alias) {
                attrs["custom-alias"] = this.lastPublishInput.alias;
            }
            if (this.lastPublishInput.tags.length > 0) {
                attrs["custom-tags"] = this.lastPublishInput.tags.join(",");
            }
            if (this.lastPublishInput.summary) {
                attrs["custom-summary"] = this.lastPublishInput.summary;
            }
            try {
                await new Promise<void>((resolve) => {
                    fetchPost("/api/attr/setBlockAttrs", { id: rootId, attrs }, () => resolve());
                });
            } catch (e) {
                console.warn("[rin-publisher] save rin attrs fail:", e);
            }
        }
    }

    /**
     * 复制当前文档在 Rin 的文章链接
     */
    private async copyCurrentDocLink() {
        const rootId = this.getEditorProtyle()?.block.rootID;
        if (!rootId) {
            showMessage(this.i18n.noDoc);
            return;
        }
        const attrs = await new Promise<Record<string, string>>((resolve) => {
            fetchPost("/api/attr/getBlockAttrs", { id: rootId }, (resp: { data?: Record<string, string> }) => {
                resolve(resp.data ?? {});
            });
        });
        const link = attrs[ATTR_RIN_URL];
        if (!link) {
            showMessage(this.i18n.notPublished);
            return;
        }
        try {
            await navigator.clipboard.writeText(link);
            showMessage(this.i18n.linkCopied);
        } catch {
            showMessage(this.i18n.linkCopyFailed);
        }
    }
}
