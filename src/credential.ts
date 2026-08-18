/**
 * 凭据加密持久化模块（方案一降级实现 + 方案五 JWT）。
 *
 * 思源内核当前未提供面向插件的系统钥匙串 API，因此这里采用：
 * - 敏感凭据（Rin 密码 / JWT）独立存储在 credential.json，与常规配置分离；
 * - 写入前用 WebCrypto AES-GCM（PBKDF2 从 username 派生密钥）加密，避免明文落盘；
 * - 优先持久化 Rin 登录返回的 JWT（方案五），密码仅作回退。
 *
 * 注意：密钥基于 username 派生且不落盘，仅存在于插件运行期内存；
 * 该方案能防止「直接打开 JSON 看到明文」，并非绝对安全（纯客户端无法做到）。
 */

/** 凭据存储版本 */
const STORE_VERSION = 1;
/** PBKDF2 迭代次数（越大越安全，但耗时越高） */
const PBKDF2_ITERATIONS = 100_000;
/** AES-GCM IV 长度（字节） */
const IV_LENGTH = 12;
/** GCM 认证标签长度（字节） */
const TAG_LENGTH = 16;

/** 单个加密后的凭据条目 */
interface EncryptedCredential {
    iv: string; // base64 IV
    data: string; // base64 密文（不含 tag）
    tag: string; // base64 GCM 认证标签
    createdAt: number;
}

/** credential.json 的整体结构 */
export interface CredentialStore {
    version: number;
    /** id -> 加密凭据条目 */
    items: Record<string, EncryptedCredential>;
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

/** WebCrypto 是否可用（需要安全上下文） */
export function isCryptoAvailable(): boolean {
    return typeof crypto !== "undefined" && !!crypto.subtle && window.isSecureContext;
}

/**
 * 从 username 派生 AES-256-GCM 密钥。
 * 密钥不持久化，仅在内存中使用；username 变更会导致旧凭据无法解密。
 */
async function deriveKey(username: string): Promise<CryptoKey> {
    const salt = new TextEncoder().encode("rin-publisher:credential:v1");
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

/** 空存储工厂 */
export function emptyCredentialStore(): CredentialStore {
    return { version: STORE_VERSION, items: {} };
}

/**
 * 把明文凭据加密后写入存储。
 * @returns 生成的凭据 id
 */
export async function storeCredential(
    store: CredentialStore,
    username: string,
    plain: string,
): Promise<string> {
    const key = await deriveKey(username);
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    store.items[id] = await encryptPlain(plain, key);
    return id;
}

/**
 * 从存储读取并解密凭据。
 * @returns 明文；解密失败返回 null
 */
export async function readCredential(
    store: CredentialStore,
    username: string,
    id: string | undefined,
): Promise<string | null> {
    if (!id) {
        return null;
    }
    const entry = store.items[id];
    if (!entry) {
        return null;
    }
    const key = await deriveKey(username);
    return decryptEntry(entry, key);
}

/** 从存储删除指定凭据 */
export function removeCredential(store: CredentialStore, id: string | undefined): void {
    if (id) {
        delete store.items[id];
    }
}
