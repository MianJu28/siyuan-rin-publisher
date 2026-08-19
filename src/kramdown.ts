/**
 * Kramdown 处理工具（纯函数，无状态）。
 *
 * 思源 `getBlockKramdown` 返回的 Markdown 中混有思源私有 IAL 元数据
 * （形如 `{: type="doc" id="..." updated="..."}`），发布到 Rin 前需清理。
 */

/** 行内 IAL 片段（`{: ... }`）正则 */
const IAL_PATTERN = /\{:([^{}]*)\}/g;

/**
 * 清理思源 Kramdown：删除代码块外的 IAL 元数据，保留代码块内内容。
 *
 * 处理要点：
 * - 代码围栏必须正确配对（按围栏类型），且未进入代码块时围栏须顶格（无前导空白），
 *   避免把缩进的代码内容误判为围栏；
 * - 代码块内的 `{: }` 视为用户代码，原样保留；
 * - 整行仅为 IAL 时用空行占位，避免相邻块粘连；
 * - 规范化删除 IAL 后产生的多余空白，并合并多余空行。
 */
export function cleanKramdown(kramdown: string): string {
    const lines = kramdown.split("\n");
    let inCodeBlock = false;
    let fenceMarker = "";
    const cleanedLines: string[] = [];

    for (const line of lines) {
        // 检测代码围栏并正确配对（按围栏类型，缩进的围栏视为代码内容而非围栏）。
        // 未进入代码块时，围栏行必须顶格（无前导空白）才算开启，避免把缩进的代码内容误判为围栏。
        const openingFence = !inCodeBlock ? /^(```+|~~~+)/.exec(line) : null;
        if (openingFence) {
            fenceMarker = openingFence[1];
            inCodeBlock = true;
            cleanedLines.push(line);
            continue;
        }

        // 代码块内：用与开启围栏同类型的围栏（可带尾随空白）闭合
        if (inCodeBlock) {
            const closingFence = new RegExp(`^${fenceMarker[0]}+\\s*$`).exec(line);
            if (closingFence) {
                inCodeBlock = false;
                fenceMarker = "";
                cleanedLines.push(line);
                continue;
            }
            // 代码块内的其他内容原样保留（其中的 {: } 可能是用户代码）
            cleanedLines.push(line);
            continue;
        }

        // 代码块外：删除行内 IAL 片段
        const cleaned = line.replace(IAL_PATTERN, "");

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
