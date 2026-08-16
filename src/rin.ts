/**
 * Rin API 客户端
 *
 * 参考 openRin/Rin 项目（https://github.com/openRin/Rin）的 REST API。
 * 认证方式：POST /api/auth/login 获取 JWT，后续请求携带 Authorization: Bearer <token>。
 * 文章（Feed）创建/更新：POST /api/feed 与 POST /api/feed/:id。
 */

export interface RinConfig {
    /** Rin 站点地址，例如 https://your-blog.example.com */
    baseUrl: string;
    username: string;
    password: string;
    /** 是否启用自定义发布（发布时弹出对话框让用户选择选项） */
    customPublish: boolean;
}

export interface RinFeedPayload {
    title: string;
    content: string;
    listed: boolean;
    draft: boolean;
    tags: string[];
    summary?: string;
    alias?: string;
    createdAt?: string;
}

export interface RinLoginResult {
    success: boolean;
    token?: string;
    user?: {
        id: number;
        username: string;
        avatar: string | null;
        permission: boolean;
    };
}

export interface RinFeed {
    id: number;
    title: string | null;
    content: string;
}

export interface RinApiError {
    status: number;
    value: string;
}

/** 统一的 API 调用结果 */
export interface RinResult<T> {
    data?: T;
    error?: RinApiError;
}

function normalizeBaseUrl(url: string): string {
    let base = url.trim().replace(/\/+$/, "");
    if (base.length > 0 && !/^https?:\/\//i.test(base)) {
        base = `https://${base}`;
    }
    return base;
}

/**
 * 发起一次到 Rin 的请求。
 * 处理 JSON / 文本响应与错误信息提取。
 */
async function request<T>(
    method: string,
    baseUrl: string,
    path: string,
    token?: string,
    body?: unknown,
): Promise<RinResult<T>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
        response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        return {
            error: {
                status: 0,
                value: e instanceof Error ? e.message : "Network error",
            },
        };
    }

    if (!response.ok) {
        let value: unknown = response.statusText;
        try {
            const text = await response.text();
            try {
                value = JSON.parse(text);
            } catch {
                value = text;
            }
        } catch {
            /* ignore */
        }
        let message: string;
        if (typeof value === "string") {
            message = value;
        } else {
            const obj = value as Record<string, unknown>;
            message =
                String(obj?.message ?? obj?.error ?? JSON.stringify(value));
        }
        return { error: { status: response.status, value: message } };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
        const data = (await response.json()) as T;
        return { data };
    }
    const text = await response.text();
    return { data: text as unknown as T };
}

export class RinClient {
    private baseUrl: string;
    private token: string | null = null;

    constructor(baseUrl: string) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    getUrl(): string {
        return this.baseUrl;
    }

    isConfigured(): boolean {
        return this.baseUrl.length > 0;
    }

    /**
     * 登录并获取 JWT。
     * @returns 是否成功
     */
    async login(username: string, password: string): Promise<RinResult<RinLoginResult>> {
        const result = await request<RinLoginResult>(
            "POST",
            this.baseUrl,
            "/api/auth/login",
            undefined,
            { username, password },
        );
        if (result.data?.token) {
            this.token = result.data.token;
        }
        return result;
    }

    /** 测试连接：尝试登录并校验 token 是否有效 */
    async testConnection(username: string, password: string): Promise<boolean> {
        const login = await this.login(username, password);
        if (!login.data?.token) {
            return false;
        }
        // 通过获取用户资料验证 token 有效性
        const profile = await this.getProfile();
        return !profile.error;
    }

    /** 获取当前登录用户资料，用于校验 token */
    async getProfile(): Promise<RinResult<{ id: number; username: string }>> {
        return request<{ id: number; username: string }>(
            "GET",
            this.baseUrl,
            "/api/user/profile",
            this.token ?? undefined,
        );
    }

    /**
     * 创建文章。
     * @returns 返回新增文章 id（若成功）
     */
    async createFeed(payload: RinFeedPayload): Promise<RinResult<{ insertedId: number }>> {
        return request<{ insertedId: number }>(
            "POST",
            this.baseUrl,
            "/api/feed",
            this.token ?? undefined,
            payload,
        );
    }

    /**
     * 更新文章。
     * @param id 文章 id
     */
    async updateFeed(id: number, payload: Partial<RinFeedPayload>): Promise<RinResult<void>> {
        return request<void>(
            "POST",
            this.baseUrl,
            `/api/feed/${id}`,
            this.token ?? undefined,
            payload,
        );
    }

    /** 删除文章 */
    async deleteFeed(id: number): Promise<RinResult<void>> {
        return request<void>(
            "DELETE",
            this.baseUrl,
            `/api/feed/${id}`,
            this.token ?? undefined,
        );
    }

    /** 根据 id 获取文章（用于读取已发布文章的地址信息） */
    async getFeed(id: number): Promise<RinResult<RinFeed>> {
        return request<RinFeed>(
            "GET",
            this.baseUrl,
            `/api/feed/${id}`,
            this.token ?? undefined,
        );
    }

    /** 清除缓存的 token */
    clearToken(): void {
        this.token = null;
    }
}
