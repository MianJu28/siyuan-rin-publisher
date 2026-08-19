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
import { cleanKramdown } from "./kramdown";
import {
    CredentialStore,
    Environment,
    emptyCredentialStore,
    getEnvironment,
    normalizeCredentialStore,
    readCredential,
    removeCredential,
    storeCredential,
} from "./credential";
import "./index.scss";

const CONFIG_KEY = "rin-config";
const CREDENTIAL_KEY = "rin-credential";
const ATTR_RIN_ID = "custom-rin-id";
const ATTR_RIN_URL = "custom-rin-url";
/** 持久化本地图片路径 -> 线上 URL 的映射，避免「发布成功但文档块更新失败」时下次重复上传 */
const ATTR_RIN_IMAGE_MAP = "custom-rin-image-map";

/** 图片并发上传的最大并发数，避免触发 Rin 限流或浏览器连接数上限 */
const IMAGE_UPLOAD_CONCURRENCY = 4;

/**
 * 获取思源内核 API Token。
 * 思源未公开该结构，这里集中管理类型断言，便于版本升级时统一修改。
 */
function getSiyuanToken(): string | undefined {
    return (window as unknown as { siyuan?: { config?: { api?: { token?: string } } } })
        .siyuan?.config?.api?.token;
}

/**
 * 对插入 HTML 模板字符串的文本进行转义，防止 XSS。
 * 对话框 / 弹窗中若需拼接文档标题、链接等用户输入，必须经此函数转义后再插入。
 */
function escapeHtml(value: string | undefined | null): string {
    return (value ?? "").replace(/[&<>"']/g, (c) => {
        switch (c) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            case "'":
                return "&#39;";
            default:
                return c;
        }
    });
}

/**
 * 以固定并发数映射异步操作，避免 Promise.all 一次性发起全部请求。
 */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return results;
}

interface RinPluginConfig {
    baseUrl: string;
    username: string;
    /** 是否启用自定义发布（发布时弹出对话框让用户选择选项） */
    customPublish: boolean;
    /** 指向 credential.json 中已持久化的 Rin JWT 的 id（方案五：优先使用） */
    tokenRef?: string;
    /** 指向 credential.json 中已持久化的密码密文的 id（JWT 失效时回退） */
    passwordRef?: string;
    /** 是否已确认接受「非安全环境明文存储凭据」的风险（为 true 则发布时不再提示） */
    dismissInsecureWarning?: boolean;
}

function defaultConfig(): RinPluginConfig {
    return {
        baseUrl: "",
        username: "",
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

    /** 缓存已登录的 Rin 客户端，避免每次发布/取消发布都重新登录 */
    private rinClient: RinClient | null = null;

    /** 加密凭据存储（credential.json），与常规配置分离 */
    private credentialStore: CredentialStore = emptyCredentialStore();

    /** 当前环境（决定读写 secure/insecure 分区） */
    private credentialEnv: Environment = getEnvironment();

    /**
     * 获取（或创建）Rin 客户端，并在 baseUrl 变化时重建。
     * 客户端内部会缓存登录 token，减少重复登录的网络往返。
     */
    private getRinClient(baseUrl: string): RinClient {
        if (!this.rinClient || this.rinClient.getUrl() !== baseUrl) {
            this.rinClient = new RinClient(baseUrl);
        }
        return this.rinClient;
    }

    /**
     * 读取持久化的凭据（JWT 或密码），按当前环境分区读写。
     *
     * 跨环境回退/迁移：若当前环境分区中不存在该 id，则尝试从另一环境分区读取
     * （例如 https 下读取 http 环境保存的明文凭据），并自动迁移到当前环境分区。
     * 返回 `{ value, migrated }`，migrated 为 true 表示发生了跨环境读取。
     */
    private async readStoredCredential(
        id: string | undefined,
    ): Promise<{ value: string | null; migrated: boolean }> {
        if (!id) {
            return { value: null, migrated: false };
        }
        const env = this.credentialEnv;
        const other: Environment = env === "secure" ? "insecure" : "secure";

        let value = await readCredential(this.credentialStore, this.config.username, id, env);
        if (value !== null) {
            return { value, migrated: false };
        }
        // 当前环境无此凭据：尝试从另一环境读取（迁移场景）
        value = await readCredential(this.credentialStore, this.config.username, id, other);
        if (value !== null) {
            return { value, migrated: true };
        }
        return { value: null, migrated: false };
    }

    /**
     * 把凭据持久化到当前环境分区，并返回其 id。
     * secure 分区 AES-GCM 加密；insecure 分区明文，返回 encrypted:false。
     */
    private async persistCredential(plain: string): Promise<{ id: string; encrypted: boolean } | undefined> {
        const result = await storeCredential(this.credentialStore, this.config.username, plain, this.credentialEnv);
        await this.saveData(CREDENTIAL_KEY, this.credentialStore).catch((e) => {
            console.warn("[rin-publisher] save credential fail:", e);
        });
        return result;
    }

    /**
     * 移除当前环境分区中的某个凭据并落盘。
     */
    private async removeStoredCredential(id: string | undefined): Promise<void> {
        removeCredential(this.credentialStore, id, this.credentialEnv);
        await this.saveData(CREDENTIAL_KEY, this.credentialStore).catch((e) => {
            console.warn("[rin-publisher] save credential fail:", e);
        });
    }

    /**
     * 处理跨环境迁移：把读取到的另一环境凭据写入当前环境分区，
     * 并从原环境分区删除（可选）。调用方在读取返回 migrated 时调用。
     */
    private async migrateCredential(id: string | undefined, plain: string): Promise<string | undefined> {
        if (!id) {
            return undefined;
        }
        const env = this.credentialEnv;
        const other: Environment = env === "secure" ? "insecure" : "secure";
        // 写入当前环境分区
        const result = await storeCredential(this.credentialStore, this.config.username, plain, env);
        // 从原环境分区删除（迁移完成后清理）
        removeCredential(this.credentialStore, id, other);
        await this.saveData(CREDENTIAL_KEY, this.credentialStore).catch((e) => {
            console.warn("[rin-publisher] save credential fail:", e);
        });
        return result.id;
    }

    /**
     * 清除所有明文凭据（insecure 分区）及配置中对它们的引用。
     * 用于「使用 HTTPS 并清除明文配置」选项，避免明文继续残留。
     */
    private async clearInsecureCredentials(): Promise<void> {
        // 清空 insecure 分区
        this.credentialStore.insecure = {};
        // 若配置引用指向 insecure 分区（当前环境即 insecure），一并清除引用
        if (this.credentialEnv === "insecure") {
            delete this.config.tokenRef;
            delete this.config.passwordRef;
        }
        await this.saveData(CREDENTIAL_KEY, this.credentialStore).catch((e) => {
            console.warn("[rin-publisher] save credential fail:", e);
        });
    }

    /**
     * 获取一个已认证的 Rin 客户端（JWT 优先，密码回退）。
     *
     * 流程：
     * 1. 若有持久化 JWT（tokenRef）→ 解密并设置，再通过 getProfile 校验：
     *    - 有效：直接复用，无需密码；
     *    - 失效：清除 tokenRef，走密码回退。
     * 2. 若有持久化密码（passwordRef）→ 解密并 login：
     *    - 成功：把返回的新 JWT 加密持久化为 tokenRef（JWT 轮换）；
     *    - 失败：返回 null。
     *
     * @returns 已认证的客户端；无法认证时返回 null
     */
    private async ensureAuthedClient(baseUrl: string): Promise<RinClient | null> {
        const client = this.getRinClient(baseUrl);

        // 优先：复用持久化 JWT
        if (this.config.tokenRef) {
            const { value: jwt, migrated } = await this.readStoredCredential(this.config.tokenRef);
            if (jwt) {
                if (migrated) {
                    // 跨环境读取成功：迁移到当前环境分区
                    const migratedId = await this.migrateCredential(this.config.tokenRef, jwt);
                    if (migratedId) {
                        this.config.tokenRef = migratedId;
                        await this.saveData(CONFIG_KEY, this.config).catch(() => {});
                    }
                }
                client.setToken(jwt);
                const profile = await client.getProfile();
                if (!profile.error) {
                    return client;
                }
                // JWT 失效：清除并回退密码
                console.warn("[rin-publisher] stored JWT invalid, fall back to password");
                await this.removeStoredCredential(this.config.tokenRef);
                delete this.config.tokenRef;
                client.clearToken();
            } else {
                // tokenRef 存在但无法解密（密钥变更等），移除
                await this.removeStoredCredential(this.config.tokenRef);
                delete this.config.tokenRef;
            }
        }

        // 回退：使用持久化密码登录
        if (this.config.passwordRef) {
            const { value: password, migrated } = await this.readStoredCredential(this.config.passwordRef);
            if (!password) {
                console.warn("[rin-publisher] stored password not decryptable");
                return null;
            }
            if (migrated) {
                const migratedId = await this.migrateCredential(this.config.passwordRef, password);
                if (migratedId) {
                    this.config.passwordRef = migratedId;
                    await this.saveData(CONFIG_KEY, this.config).catch(() => {});
                }
            }
            const login = await client.login(this.config.username, password);
            if (!login.data?.token) {
                console.warn("[rin-publisher] login failed:", login.error?.value);
                return null;
            }
            // 登录成功：把新 JWT 持久化为 tokenRef，下次优先复用
            const jwtResult = await this.persistCredential(login.data.token);
            if (jwtResult) {
                this.config.tokenRef = jwtResult.id;
                if (!jwtResult.encrypted) {
                    // http 非 localhost：JWT 明文兜底，提示用户建议使用 https
                    showMessage(this.i18n.httpsRecommended);
                }
                await this.saveData(CONFIG_KEY, this.config).catch(() => {});
            }
            return client;
        }

        return null;
    }

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

        // 加载加密凭据存储（与常规配置分离）。
        // 旧版（v1）为单一 items 混合结构，加载时自动归一化为 secure/insecure 双分区。
        this.loadData(CREDENTIAL_KEY).then((store: unknown) => {
            this.credentialStore = normalizeCredentialStore(store);
        }).catch((e) => {
            console.warn(`[${this.name}] load credential fail:`, e);
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
        passwordInput.placeholder = this.config.passwordRef ? "••••••••" : "";

        const customPublishInput = document.createElement("input");
        customPublishInput.type = "checkbox";
        customPublishInput.className = "b3-switch fn__flex-center";

        this.setting = new Setting({
            confirmCallback: async () => {
                const newBaseUrl = baseUrlInput.value.trim();
                const newUsername = usernameInput.value.trim();
                // 1) 保存非敏感配置（不再持久化明文密码），保留既有凭据引用与提示确认状态
                this.config = {
                    baseUrl: newBaseUrl,
                    username: newUsername,
                    customPublish: customPublishInput.checked,
                    tokenRef: this.config.tokenRef,
                    passwordRef: this.config.passwordRef,
                    dismissInsecureWarning: this.config.dismissInsecureWarning,
                };
                // 2) 若用户填写了新密码，则持久化（覆盖旧密码凭据）
                const newPassword = passwordInput.value.trim();
                if (newPassword) {
                    // 非安全环境（http 非 localhost）且用户未确认过风险：保存密码前直接弹出安全提示
                    if (this.credentialEnv === "insecure" && !this.config.dismissInsecureWarning) {
                        const choice = await this.showInsecureWarningDialog();
                        if (choice === "https") {
                            // 清除明文配置，提示手动切换到 https；本次不保存明文密码
                            await this.clearInsecureCredentials();
                            showMessage(this.i18n.insecureClearedManual);
                            passwordInput.value = "";
                            return;
                        }
                        if (choice === null) {
                            // 用户取消：不保存密码
                            passwordInput.value = "";
                            return;
                        }
                        // choice === "dismiss"：用户确认已了解，不再提示
                        this.config.dismissInsecureWarning = true;
                    }

                    // 密码更新后旧 JWT 可能失效，先清除，由下次发布校验决定是否重登
                    await this.removeStoredCredential(this.config.tokenRef);
                    delete this.config.tokenRef;
                    await this.removeStoredCredential(this.config.passwordRef);
                    const result = await this.persistCredential(newPassword);
                    if (result) {
                        this.config.passwordRef = result.id;
                        if (!result.encrypted) {
                            // http 非 localhost 环境：明文兜底，提示用户建议使用 https
                            showMessage(this.i18n.httpsRecommended);
                        }
                        passwordInput.value = "";
                        passwordInput.placeholder = "••••••••";
                    }
                }
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
                // 密码不再明文回填；仅在已保存密码时用占位符提示
                passwordInput.value = "";
                passwordInput.placeholder = this.config.passwordRef ? "••••••••" : "";
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
        menu.addItem({
            icon: "iconTrashcan",
            label: this.i18n.unpublishFromRin,
            click: () => {
                this.unpublishCurrentDoc().catch((e) => console.error(e));
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
     * 测试与 Rin 的连接（JWT 优先，密码回退）
     */
    private async testConnection() {
        const { baseUrl, username } = this.config;
        if (!baseUrl || !username) {
            showMessage(this.i18n.noConfig);
            return;
        }
        const client = await this.ensureAuthedClient(baseUrl);
        if (!client) {
            showMessage(this.i18n.noCredential);
            return;
        }
        // ensureAuthedClient 已通过 getProfile 校验 token，客户端已认证
        const profile = await client.getProfile();
        if (!profile.error) {
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
     * 以 Promise 方式调用思源内核 API（fetchPost 的回调式封装）。
     * 统一处理成功 / 失败回调，避免失败时 Promise 永久挂起。
     * 思源回调参数类型为 IWebSocketData，此处按调用方约定的响应结构做强转。
     */
    private apiPost<T>(url: string, data: object): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            fetchPost(url, data, (r) => resolve(r as unknown as T), {}, () =>
                reject(new Error(`siyuan api error: ${url}`)),
            );
        });
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
        const token = getSiyuanToken();
        if (!token) {
            console.warn(
                "[rin-publisher] 未获取到思源内核 API Token，本地图片可能无法读取。请检查思源版本兼容性。",
            );
        }

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
    /**
     * 处理文档中的本地图片：上传到 Rin 并替换为线上 URL。
     *
     * @param content  文档 Markdown
     * @param client   已认证的 Rin 客户端
     * @param seedMap  上一次发布会话持久化的「本地路径 -> 线上 URL」映射，
     *                 命中则跳过重复上传，直接复用既有线上 URL（解决 1.5 重复上传）
     */
    private async processImages(
        content: string,
        client: RinClient,
        seedMap: ReadonlyMap<string, string> = new Map(),
    ): Promise<{
        content: string;
        mapping: Map<string, string>;
        total: number;
        failed: number;
    }> {
        // 匹配 Markdown 图片语法：![alt](url) 或 ![alt](url "title")
        const imageRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
        const matches: Array<{ alt: string; url: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = imageRegex.exec(content)) !== null) {
            matches.push({ alt: m[1], url: m[2].trim() });
        }

        const mapping = new Map<string, string>(seedMap);

        // 收集需要上传的本地图片（跳过已是链接的；命中 seedMap 的也跳过，直接复用）
        const pending: Array<{ alt: string; url: string; filename: string }> = [];
        for (const img of matches) {
            if (/^(https?:\/\/|data:|blob:)/i.test(img.url)) {
                continue;
            }
            const seeded = seedMap.get(img.url);
            if (seeded) {
                mapping.set(img.url, seeded);
                continue;
            }
            pending.push({
                alt: img.alt,
                url: img.url,
                filename: img.url.split(/[/\\]/).pop() || "image.png",
            });
        }

        // 限并发上传所有图片：读取图片 -> 上传到 Rin -> 得到新 URL
        const results = await mapWithConcurrency(pending, IMAGE_UPLOAD_CONCURRENCY, async (img) => {
            try {
                const blob = await this.fetchAssetFile(img.url);
                if (!blob) {
                    console.warn(`[rin-publisher] skip image, cannot read: ${img.url}`);
                    return { url: img.url, newUrl: undefined };
                }
                const result = await client.uploadImage(blob, img.filename);
                if (result.error || !result.data?.url) {
                    console.warn(`[rin-publisher] upload image fail: ${img.url}`, result.error?.value);
                    return { url: img.url, newUrl: undefined };
                }
                return { url: img.url, newUrl: result.data.url };
            } catch (e) {
                console.warn(`[rin-publisher] upload image error: ${img.url}`, e);
                return { url: img.url, newUrl: undefined };
            }
        });

        // 上传完成后按匹配位置逐一替换链接，并记录映射。
        // 用带 lastIndex 的正则原位替换：避免 split/join 在相同 url 多引用时语义不精确，
        // 也避免带 title 的图片（![alt](url "title")）漏替换。
        let failed = 0;
        for (const r of results) {
            if (!r.newUrl) {
                failed++;
                continue;
            }
            mapping.set(r.url.replace(/^\/+/, ""), r.newUrl);
        }

        // 统一替换：对每个本地图片，若 mapping 中已有线上 URL（含本次上传或 seedMap 复用），
        // 用带 lastIndex 的正则原位替换，保留 title。
        const pattern = /!\[([^\]]*)\]\(([^)\s]+)((?:\s+["'][^"']*["'])?)\)/g;
        content = content.replace(pattern, (orig, alt, url, title) => {
            const newUrl = mapping.get(url.trim());
            if (newUrl) {
                return `![${alt}](${newUrl}${title})`;
            }
            return orig;
        });

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

        const collect = async (parentId: string): Promise<void> => {
            let blocks: Array<{ id: string; markdown?: string }> = [];
            try {
                const resp = await this.apiPost<{ data?: Array<{ id: string; markdown?: string }> }>(
                    "/api/block/getChildBlocks",
                    { id: parentId },
                );
                blocks = resp.data ?? [];
            } catch (e) {
                // 获取子块失败：跳过该节点子树，但明确告警，避免用户无感知
                console.warn(`[rin-publisher] get child blocks fail for ${parentId}, skipping subtree:`, e);
                return;
            }
            await Promise.all(
                blocks.map(async (block) => {
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
                    await collect(block.id);
                }),
            );
        };

        await collect(rootId);

        // 并发更新匹配的图片块
        await Promise.all(
            imgBlocks.map(async (img) => {
                const newUrl = mapping.get(img.src);
                if (!newUrl) {
                    return;
                }
                const markdown = `![${img.alt}](${newUrl})`;
                await this.apiPost<void>("/api/block/updateBlock", {
                    id: img.id,
                    dataType: "markdown",
                    data: markdown,
                }).catch((e) => console.warn(`[rin-publisher] update block fail: ${img.id}`, e));
            }),
        );
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

        // 并行获取文档标题、Kramdown 内容与自定义属性（三者互不依赖）
        const [titleResp, kramdownResp, attrsResp] = await Promise.all([
            this.apiPost<{ data?: { rootTitle?: string } }>("/api/block/getBlockInfo", { id: rootId }),
            this.apiPost<{ data?: { kramdown?: string } }>("/api/block/getBlockKramdown", { id: rootId }),
            this.apiPost<{ data?: Record<string, string> }>("/api/attr/getBlockAttrs", { id: rootId }).catch(() => ({
                data: undefined,
            })),
        ]);

        const title = titleResp.data?.rootTitle ?? "";

        // 获取文档 Markdown（Kramdown）内容，并清理思源 IAL 元数据
        const kramdown = kramdownResp.data?.kramdown ?? null;
        if (kramdown === null) {
            showMessage(this.i18n.getContentFailed);
            return null;
        }
        const content = cleanKramdown(kramdown);

        // 读取自定义属性（用于预填发布对话框中的默认值）
        const attrs = attrsResp.data ?? {};

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
    <div class="b3-typography" style="margin-bottom:12px">${escapeHtml(this.i18n.publishDialogDesc)}</div>
    <div class="rin-publisher__publish">
        <div class="b3-form__item rin-publisher__publish-checkbox">
            <label class="fn__flex b3-form__label">${escapeHtml(this.i18n.publishDialogListed)}</label>
            <input id="rinPubListed" type="checkbox" class="b3-switch fn__flex-center" />
        </div>
        <div class="b3-form__item rin-publisher__publish-checkbox">
            <label class="fn__flex b3-form__label">${escapeHtml(this.i18n.publishDialogDraft)}</label>
            <input id="rinPubDraft" type="checkbox" class="b3-switch fn__flex-center" />
        </div>
        <div class="b3-form__item">
            <label class="fn__flex b3-form__label">${escapeHtml(this.i18n.publishDialogAlias)}</label>
            <input id="rinPubAlias" class="b3-text-field fn__block" placeholder="${escapeHtml(this.i18n.publishDialogAliasPh)}" />
        </div>
        <div class="b3-form__item">
            <label class="fn__flex b3-form__label">${escapeHtml(this.i18n.publishDialogTags)}</label>
            <input id="rinPubTags" class="b3-text-field fn__block" placeholder="${escapeHtml(this.i18n.publishDialogTagsPh)}" />
        </div>
        <div class="b3-form__item">
            <label class="fn__flex b3-form__label">${escapeHtml(this.i18n.publishDialogSummary)}</label>
            <textarea id="rinPubSummary" class="b3-text-field fn__block" rows="3" placeholder="${escapeHtml(this.i18n.publishDialogSummaryPh)}"></textarea>
        </div>
    </div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${escapeHtml(this.i18n.cancel)}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">${escapeHtml(isUpdate ? this.i18n.publishDialogUpdate : this.i18n.publishDialogSubmit)}</button>
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
     * 弹出「Rin 上文章已被删除」的确认对话框，让用户选择重新发布还是取消发布。
     *
     * @returns "republish" 表示重新发布（新建文章）；"unpublish" 表示取消发布（清除本地发布记录）；null 表示用户关闭对话框
     */
    private showDeletedConfirmDialog(): Promise<"republish" | "unpublish" | null> {
        return new Promise((resolve) => {
            const dialog = new Dialog({
                title: this.i18n.deletedConfirmTitle,
                content: `
<div class="b3-dialog__content">
    <div class="b3-typography">${escapeHtml(this.i18n.deletedConfirmDesc)}</div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel" id="rinDelUnpublish">${escapeHtml(this.i18n.unpublish)}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="rinDelRepublish">${escapeHtml(this.i18n.republish)}</button>
</div>`,
                width: this.isMobile ? "92vw" : "520px",
            });

            const unpublishBtn = dialog.element.querySelector("#rinDelUnpublish") as HTMLButtonElement;
            const republishBtn = dialog.element.querySelector("#rinDelRepublish") as HTMLButtonElement;

            unpublishBtn.addEventListener("click", () => {
                dialog.destroy();
                resolve("unpublish");
            });
            republishBtn.addEventListener("click", () => {
                dialog.destroy();
                resolve("republish");
            });
            // 点击遮罩关闭时视为取消（不执行任何操作）
            dialog.element.addEventListener("click", (e) => {
                if (e.target === dialog.element) {
                    dialog.destroy();
                    resolve(null);
                }
            });
        });
    }

    /**
     * 清除文档中与 Rin 发布相关的自定义属性（custom-rin-id / custom-rin-url）。
     *
     * @param rootId 文档根块 ID
     */
    private async clearPublishAttrs(rootId: string): Promise<void> {
        const attrs: Record<string, string> = {
            [ATTR_RIN_ID]: "",
            [ATTR_RIN_URL]: "",
            [ATTR_RIN_IMAGE_MAP]: "",
        };
        try {
            await this.apiPost<void>("/api/attr/setBlockAttrs", { id: rootId, attrs });
        } catch (e) {
            console.warn("[rin-publisher] clear rin attrs fail:", e);
        }
    }

    /**
     * 弹出「取消发布」确认对话框，确认是否从 Rin 删除该文章。
     *
     * @returns true 表示确认删除；false 表示取消操作
     */
    private showUnpublishConfirmDialog(): Promise<boolean> {
        return new Promise((resolve) => {
            const dialog = new Dialog({
                title: this.i18n.unpublishConfirmTitle,
                content: `
<div class="b3-dialog__content">
    <div class="b3-typography">${escapeHtml(this.i18n.unpublishConfirmDesc)}</div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel" id="rinUnpubCancel">${escapeHtml(this.i18n.cancel)}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="rinUnpubConfirm">${escapeHtml(this.i18n.unpublishConfirmAction)}</button>
</div>`,
                width: this.isMobile ? "92vw" : "520px",
            });

            const cancelBtn = dialog.element.querySelector("#rinUnpubCancel") as HTMLButtonElement;
            const confirmBtn = dialog.element.querySelector("#rinUnpubConfirm") as HTMLButtonElement;

            const close = (result: boolean) => {
                dialog.destroy();
                resolve(result);
            };

            cancelBtn.addEventListener("click", () => close(false));
            confirmBtn.addEventListener("click", () => close(true));
            // 点击遮罩关闭时视为取消
            dialog.element.addEventListener("click", (e) => {
                if (e.target === dialog.element) {
                    close(false);
                }
            });
        });
    }

    /**
     * 非安全环境（http 非 localhost）发布前的安全提示对话框。
     *
     * @returns "dismiss" 表示用户确认已了解、不再提示；"https" 表示使用 HTTPS 并清除明文配置；
     *          null 表示用户关闭了对话框（不执行操作）
     */
    private showInsecureWarningDialog(): Promise<"dismiss" | "https" | null> {
        return new Promise((resolve) => {
            const dialog = new Dialog({
                title: this.i18n.insecureWarningTitle,
                content: `
<div class="b3-dialog__content">
    <div class="b3-typography">${escapeHtml(this.i18n.insecureWarningDesc)}</div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--text" id="rinInsecureDismiss">${escapeHtml(this.i18n.insecureWarningDismiss)}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text" id="rinInsecureHttps">${escapeHtml(this.i18n.insecureWarningUseHttps)}</button>
</div>`,
                width: this.isMobile ? "92vw" : "520px",
            });

            const dismissBtn = dialog.element.querySelector("#rinInsecureDismiss") as HTMLButtonElement;
            const httpsBtn = dialog.element.querySelector("#rinInsecureHttps") as HTMLButtonElement;

            const close = (result: "dismiss" | "https" | null) => {
                dialog.destroy();
                resolve(result);
            };

            dismissBtn.addEventListener("click", () => close("dismiss"));
            httpsBtn.addEventListener("click", () => close("https"));
            // 点击遮罩关闭时视为取消
            dialog.element.addEventListener("click", (e) => {
                if (e.target === dialog.element) {
                    close(null);
                }
            });
        });
    }

    /**
     * 取消发布：从 Rin 删除当前文档对应的文章，并清除文档中的发布相关自定义属性。
     */
    private async unpublishCurrentDoc() {
        const { baseUrl } = this.config;
        const rootId = this.getEditorProtyle()?.block.rootID;
        if (!rootId) {
            showMessage(this.i18n.noDoc);
            return;
        }
        if (!baseUrl) {
            showMessage(this.i18n.noConfig);
            return;
        }

        // 读取文档自定义属性，获取已发布的 Rin id
        const attrs = await this.apiPost<{ data?: Record<string, string> }>("/api/attr/getBlockAttrs", {
            id: rootId,
        }).catch(() => ({ data: undefined }));
        const rinId = Number(attrs.data?.[ATTR_RIN_ID]);
        const hasRinId = !Number.isNaN(rinId) && rinId > 0;
        if (hasRinId) {
            // 存在已发布的文章 id，先确认删除
            const confirmed = await this.showUnpublishConfirmDialog();
            if (!confirmed) {
                return;
            }
        }

        // 仅当确定要删除远端文章时才认证（无 rinId 时无需网络请求）
        if (hasRinId) {
            const client = await this.ensureAuthedClient(baseUrl);
            if (!client) {
                showMessage(this.i18n.noCredential);
                return;
            }
            showMessage(this.i18n.unpublishDeleting);
            const res = await client.deleteFeed(rinId);
            if (res.error) {
                showMessage(`${this.i18n.unpublishDeleteFailed}：${res.error.value}`);
                return;
            }
        }

        // 清除文档中的发布相关自定义属性
        await this.clearPublishAttrs(rootId);
        showMessage(this.i18n.unpublishDeleteSuccess);
    }

    /**
     * 发布（或更新）当前文档到 Rin
     */
    private async publishCurrentDoc() {
        const { baseUrl } = this.config;
        const rootId = this.getEditorProtyle()?.block.rootID;
        if (!baseUrl) {
            showMessage(this.i18n.noConfig);
            return;
        }

        const meta = await this.collectPublishMeta();
        if (!meta) {
            return;
        }

        // 获取已认证客户端（JWT 优先，密码回退；复用缓存避免重复登录）
        const client = await this.ensureAuthedClient(baseUrl);
        if (!client) {
            showMessage(this.i18n.noCredential);
            return;
        }

        // 非安全环境（http 非 localhost）且用户未确认过风险时，弹窗提示
        if (this.credentialEnv === "insecure" && !this.config.dismissInsecureWarning) {
            const choice = await this.showInsecureWarningDialog();
            if (choice === "https") {
                // 使用 HTTPS 并清除明文配置：清除明文凭据 + 提示用户手动切换 https + 终止本次发布
                await this.clearInsecureCredentials();
                showMessage(this.i18n.insecureClearedManual);
                return;
            }
            if (choice === "dismiss") {
                // 用户确认已了解，不再提示
                this.config.dismissInsecureWarning = true;
                await this.saveData(CONFIG_KEY, this.config).catch((e) => {
                    console.warn("[rin-publisher] save config fail:", e);
                });
            } else {
                // 用户关闭对话框：终止本次发布
                return;
            }
        }

        // 发布前处理文档中的本地图片：检测非链接形式的图片，
        // 通过 Rin 上传并替换为图片链接。
        // 先读取上一发布会话持久化的「本地路径 -> 线上 URL」映射作为种子，
        // 避免「发布成功但文档块更新失败」时下次重复上传（1.5）。
        let imageMapping: Map<string, string> = new Map();
        try {
            let seedMap: Map<string, string> = new Map();
            if (rootId) {
                const seedAttrs = await this.apiPost<{ data?: Record<string, string> }>(
                    "/api/attr/getBlockAttrs",
                    { id: rootId },
                ).catch(() => ({ data: undefined }));
                const raw = seedAttrs.data?.[ATTR_RIN_IMAGE_MAP];
                if (raw) {
                    try {
                        seedMap = new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
                    } catch (e) {
                        console.warn("[rin-publisher] parse image map fail:", e);
                    }
                }
            }
            if (/!\[[^\]]*\]\([^)\s]+\)/.test(meta.content)) {
                showMessage(this.i18n.uploadingImages);
            }
            const imgResult = await this.processImages(meta.content, client, seedMap);
            meta.content = imgResult.content;
            imageMapping = imgResult.mapping;
            if (imgResult.failed > 0) {
                showMessage(this.i18n.imagesUploadFailed.replace("{failed}", String(imgResult.failed)));
            }
        } catch (e) {
            console.warn("[rin-publisher] process images fail:", e);
        }

        let resultId: number | undefined;
        let isUpdate = false;

        // 存在 custom-rin-id 时，先校验 Rin 上该文章是否真实存在。
        // 若文章已不存在（例如在 Rin 上被删除，或 custom-rin-id 是残留/误判），
        // 则弹出提醒，让用户选择"重新发布"（新建文章）还是"取消发布"（清除本地发布记录）。
        if (meta.rinId) {
            const feed = await client.getFeed(meta.rinId);
            if (feed.error && feed.error.status === 404) {
                console.warn(`[rin-publisher] rin feed ${meta.rinId} not found`);
                const choice = await this.showDeletedConfirmDialog();
                if (choice === "unpublish" && rootId) {
                    // 取消发布：清除文档中的发布相关自定义属性
                    await this.clearPublishAttrs(rootId);
                    showMessage(this.i18n.unpublishedSuccess);
                    return;
                }
                if (choice === "republish") {
                    // 重新发布：降级为新建文章
                    meta.rinId = undefined;
                } else {
                    // 用户关闭了对话框，放弃本次发布
                    return;
                }
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
            };
            if (meta.createdAt) {
                p.createdAt = meta.createdAt;
            }
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
                await this.apiPost<void>("/api/attr/setBlockAttrs", { id: rootId, attrs });
            } catch (e) {
                console.warn("[rin-publisher] save rin attrs fail:", e);
            }
        }

        // 持久化「本地图片路径 -> 线上 URL」映射到文档属性，
        // 使「发布成功但文档块更新失败」的场景在下次发布时不重复上传（1.5）。
        if (rootId && imageMapping.size > 0) {
            const imageMapObj: Record<string, string> = {};
            for (const [k, v] of imageMapping) {
                imageMapObj[k] = v;
            }
            const imageMapAttrs: Record<string, string> = {
                [ATTR_RIN_IMAGE_MAP]: JSON.stringify(imageMapObj),
            };
            try {
                await this.apiPost<void>("/api/attr/setBlockAttrs", { id: rootId, attrs: imageMapAttrs });
            } catch (e) {
                console.warn("[rin-publisher] save rin image map fail:", e);
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
        const attrs = await this.apiPost<{ data?: Record<string, string> }>("/api/attr/getBlockAttrs", {
            id: rootId,
        }).catch(() => ({ data: undefined }));
        const link = attrs.data?.[ATTR_RIN_URL];
        if (!link) {
            showMessage(this.i18n.notPublished);
            return;
        }
        const copied = await this.copyTextToClipboard(link);
        if (copied) {
            showMessage(this.i18n.linkCopied);
        } else {
            showMessage(this.i18n.linkCopyFailed);
        }
    }

    /**
     * 复制文本到剪贴板。
     *
     * 优先使用 `navigator.clipboard.writeText`（需要安全上下文 + 用户激活），
     * 在思源桌面端 Electron 环境中该 API 常因权限/激活状态失败，因此
     * 失败时回退到「临时 textarea + document.execCommand('copy')」方案，
     * 该方案在思源渲染进程中稳定可用，不受剪贴板权限限制。
     */
    private async copyTextToClipboard(text: string): Promise<boolean> {
        // 方案一：现代 Clipboard API
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {
            /* 回退到方案二 */
        }

        // 方案二：临时 textarea + execCommand（兼容思源桌面端）
        try {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            // 隐藏且不触发滚动/焦点，避免页面跳动
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            textarea.style.pointerEvents = "none";
            textarea.setAttribute("readonly", "");
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, text.length);
            const ok = document.execCommand("copy");
            document.body.removeChild(textarea);
            return ok;
        } catch (e) {
            console.warn("[rin-publisher] copy text fail:", e);
            return false;
        }
    }
}
