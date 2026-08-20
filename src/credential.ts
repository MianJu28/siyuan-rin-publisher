/**
 * 凭据加密持久化模块（方案一降级实现 + 方案五 JWT）。
 *
 * 思源内核当前未提供面向插件的系统钥匙串 API，因此这里采用：
 * - 敏感凭据（Rin 密码 / JWT）独立存储在 credential.json，与常规配置分离；
 * - 按环境分区存储：安全环境（secure）用 AES-GCM 加密，http 非安全环境（insecure）明文；
 * - 优先持久化 Rin 登录返回的 JWT（方案五），密码仅作回退。
 *
 * WebCrypto（crypto.subtle）仅在安全上下文（https / http://localhost）可用；
 * http 且非 localhost 环境下 crypto.subtle 不存在，凭据降级为明文存储，
 * 但调用方应通过环境标记向用户提示安全风险。
 *
 * 注意：密钥基于 username 派生且不落盘，仅存在于插件运行期内存；
 * 该方案能防止「直接打开 JSON 看到明文」，并非绝对安全（纯客户端无法做到）。
 */

/** 凭据存储版本 */
const STORE_VERSION = 2;
/** PBKDF2 迭代次数（越大越安全，但耗时越高） */
const PBKDF2_ITERATIONS = 100_000;
/** AES-GCM IV 长度（字节） */
const IV_LENGTH = 12;
/** GCM 认证标签长度（字节） */
const TAG_LENGTH = 16;

/** 环境类型：secure = 安全上下文（https/localhost，可加密）；insecure = http 非 localhost（明文） */
export type Environment = "secure" | "insecure";

/** 单个加密后的凭据条目（iv + data + tag） */
interface EncryptedCredential {
    iv: string; // base64 IV
    data: string; // base64 密文（不含 tag）
    tag: string; // base64 GCM 认证标签
    createdAt: number;
}

/** credential.json 的整体结构（双命名空间：按环境分区） */
export interface CredentialStore {
    version: number;
    /** 安全环境凭据：id -> 加密条目 */
    secure: Record<string, EncryptedCredential>;
    /** http 非安全环境凭据：id -> 明文 */
    insecure: Record<string, string>;
}

/** 旧版（v1）单文件混合条目，用于加载时迁移到双命名空间 */
interface LegacyCredentialStore {
    version: number;
    items: Record<
        string,
        | EncryptedCredential
        | { plain: string; createdAt: number }
    >;
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

/**
 * WebCrypto（crypto.subtle）是否可用。
 * 仅在安全上下文（https / http://localhost）中存在；http 非 localhost 下不可用。
 */
export function isCryptoAvailable(): boolean {
    return typeof crypto !== "undefined" && !!crypto.subtle;
}

/** 判定当前环境：crypto.subtle 可用视为安全环境，否则 http 非安全环境 */
export function getEnvironment(): Environment {
    return isCryptoAvailable() ? "secure" : "insecure";
}

/**
 * 从 username 派生 AES-256-GCM 密钥。
 * 密钥不持久化，仅在内存中使用；username 变更会导致旧凭据无法解密。
 */
async function deriveKey(username: string): Promise<CryptoKey> {
    const salt = new TextEncoder().encode("rin-publisher:credential:v2");
    const base = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(username),
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

/** 用派生密钥加密明文，返回加密条目 */
async function encryptPlain(plain: string, key: CryptoKey): Promise<EncryptedCredential> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plain);
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    // AES-GCM 输出 = 密文 + 最后 16 字节 tag
    const tagOffset = cipher.byteLength - TAG_LENGTH;
    return {
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(cipher, 0, tagOffset)),
        tag: toBase64(new Uint8Array(cipher, tagOffset)),
        createdAt: Date.now(),
    };
}

/** 解密加密条目；失败（如密钥不匹配 / 数据损坏）返回 null */
async function decryptEntry(entry: EncryptedCredential, key: CryptoKey): Promise<string | null> {
    try {
        const combined = new Uint8Array(
            fromBase64(entry.data).length + fromBase64(entry.tag).length,
        );
        combined.set(fromBase64(entry.data), 0);
        combined.set(fromBase64(entry.tag), fromBase64(entry.data).length);
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(entry.iv) },
            key,
            combined,
        );
        return new TextDecoder().decode(plain);
    } catch {
        return null;
    }
}

/** 空存储工厂（双命名空间） */
export function emptyCredentialStore(): CredentialStore {
    return { version: STORE_VERSION, secure: {}, insecure: {} };
}

/**
 * 将任意存储对象归一化为双命名空间 CredentialStore。
 * 兼容旧版 v1（items 混合加密/明文条目）与新版 v2（secure/insecure 分区）。
 */
export function normalizeCredentialStore(raw: unknown): CredentialStore {
    const store = emptyCredentialStore();
    if (!raw || typeof raw !== "object") {
        return store;
    }
    const obj = raw as Partial<CredentialStore> & LegacyCredentialStore;
    // 新版：直接拷贝两个分区
    if (obj.secure && typeof obj.secure === "object") {
        for (const [k, v] of Object.entries(obj.secure)) {
            if (v && typeof v === "object" && "data" in v) {
                store.secure[k] = v as EncryptedCredential;
            }
        }
    }
    if (obj.insecure && typeof obj.insecure === "object") {
        for (const [k, v] of Object.entries(obj.insecure)) {
            if (typeof v === "string") {
                store.insecure[k] = v;
            }
        }
    }
    // 旧版：迁移 items 到分区
    if (obj.items && typeof obj.items === "object") {
        for (const [k, v] of Object.entries(obj.items)) {
            if (!v || typeof v !== "object") {
                continue;
            }
            if ("plain" in v) {
                store.insecure[k] = v.plain;
            } else if ("data" in v) {
                store.secure[k] = v as EncryptedCredential;
            }
        }
    }
    return store;
}

/**
 * 把明文凭据写入指定环境的存储。
 * secure：AES-GCM 加密；insecure：明文。
 *
 * @returns `{ id, encrypted }`：encrypted 为 false 表示明文存储
 */
export async function storeCredential(
    store: CredentialStore,
    username: string,
    plain: string,
    env: Environment,
): Promise<{ id: string; encrypted: boolean }> {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    if (env === "secure") {
        const key = await deriveKey(username);
        store.secure[id] = await encryptPlain(plain, key);
        return { id, encrypted: true };
    }
    store.insecure[id] = plain;
    return { id, encrypted: false };
}

/**
 * 从存储读取指定环境的凭据并解密。
 * @returns 明文；不存在 / 解密失败返回 null
 */
export async function readCredential(
    store: CredentialStore,
    username: string,
    id: string | undefined,
    env: Environment,
): Promise<string | null> {
    if (!id) {
        return null;
    }
    if (env === "secure") {
        // 安全环境条目依赖 crypto.subtle 解密；在 http 非安全环境下 crypto 不可用，
        // 无法解密 secure 条目，优雅返回 null，避免调用 crypto.subtle 抛错。
        if (!isCryptoAvailable()) {
            return null;
        }
        const entry = store.secure[id];
        if (!entry) {
            return null;
        }
        const key = await deriveKey(username);
        return decryptEntry(entry, key);
    }
    return store.insecure[id] ?? null;
}

/** 从存储删除指定环境中的凭据 */
export function removeCredential(store: CredentialStore, id: string | undefined, env: Environment): void {
    if (!id) {
        return;
    }
    if (env === "secure") {
        delete store.secure[id];
    } else {
        delete store.insecure[id];
    }
}

/**
 * 清理两个分区中未被引用的孤立凭据条目。
 * 只保留 referencedIds 集合中的凭据，其余视为残留（如跨环境切换后遗留的历史条目）。
 *
 * @returns 是否清理了至少一个条目
 */
export function cleanupOrphanCredentials(store: CredentialStore, referencedIds: Set<string>): boolean {
    let removed = false;
    // secure 分区
    for (const id of Object.keys(store.secure)) {
        if (!referencedIds.has(id)) {
            delete store.secure[id];
            removed = true;
        }
    }
    // insecure 分区
    for (const id of Object.keys(store.insecure)) {
        if (!referencedIds.has(id)) {
            delete store.insecure[id];
            removed = true;
        }
    }
    return removed;
}
