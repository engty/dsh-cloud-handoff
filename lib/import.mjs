/**
 * lib/import.mjs — 会话导入与工作区路径编码（云端侧使用）
 *
 * 会话日志格式（与官方 dsh-session-persistence-jsonl 逐帧对齐）：
 *   - 文件 = 多个 zstd 帧拼接；每帧独立压缩且开启校验和（ZSTD_c_checksumFlag=1）
 *   - 第 1 帧：恰好一行 session header（JSON 行 + "\n"）
 *   - 后续帧：按批次拆分的 durable events（每帧 JSONL 行组）
 *   - 读取端（scanZstdFrames）逐帧校验；帧 1 必须是单行 header
 *
 * 工作区目录名编码（与官方 projectKey() 逐字节一致）：
 *   分隔符 / \ : → -（连续合并）；安全字符 [A-Za-z0-9._-]（不含 ~）原样；
 *   其余按 UTF-16 码元 → ~XXXX；去掉开头 - 后包成 --…--，截断 251 字符。
 */
import { zstdCompress, zstdDecompress, constants } from "node:zlib";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
/** 每个事件帧最多容纳的事件数（官方按 200ms 窗口自然分批，无严格上限；此处取保守值） */
const EVENTS_PER_FRAME = 500;
/** zstd 帧魔数（little-endian 0xFD2FB528） */
const ZSTD_MAGIC = 4247762216;

/**
 * 扫描 zstd 帧边界（与官方 dsh-session-persistence-jsonl scanZstdFrames 一致的移植）。
 * @param {Buffer} buffer 完整会话日志字节
 * @returns {{ frames: {start:number,end:number}[], tornStart?: number }}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 解压完整会话日志（多帧逐帧解码，等价官方读取路径）。 */
export async function decompressSessionLog(buf) {
  const { frames, tornStart } = scanZstdFrames(buf);
  if (tornStart !== void 0) throw new Error(`会话日志存在不完整的 zstd 帧（tornStart=${tornStart}）`);
  let text = "";
  for (const f of frames) {
    text += (await zstdDecompressAsync(buf.subarray(f.start, f.end))).toString("utf8");
  }
  return text;
}

/** 把绝对路径编码成 DSH 会话目录里工作区文件夹名（与官方一致）。 */
export function encodeWorkspacePath(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 把一个 zstd 帧列表拼接成完整会话日志文件。 */
export async function buildSessionLog(headerLine, eventLines, outPath) {
  const frames = [await zstdCompressAsync(headerLine + "\n", CHECKSUM_OPTIONS)];
  for (let i = 0; i < eventLines.length; i += EVENTS_PER_FRAME) {
    const batch = eventLines.slice(i, i + EVENTS_PER_FRAME).join("\n") + "\n";
    frames.push(await zstdCompressAsync(batch, CHECKSUM_OPTIONS));
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.concat(frames));
  return frames.length;
}

/**
 * 读入一个已有会话日志，重写首事件（session header）的 cwd 字段后，
 * 以官方帧格式写出到新位置。其余事件原样保留（含字节级内容）。
 *
 * @param {string} logPath  源 session.v4.jsonl.zstd
 * @param {string} newCwd   云端工作区绝对路径
 * @param {string} outPath  输出文件
 * @returns {{ events: number, oldCwd: string, frames: number }}
 */
export async function rewriteSessionCwd(logPath, newCwd, outPath) {
  const compressed = await readFile(logPath);
  const text = await decompressSessionLog(compressed);
  const lines = text.split("\n").filter(Boolean);
  if (lines.length < 1) throw new Error("会话日志为空或格式异常");

  const head = JSON.parse(lines[0]);
  if (head.type !== "session") throw new Error(`首事件不是 session header（type=${head.type}）`);
  const oldCwd = head.cwd;
  head.cwd = newCwd;
  const headerLine = JSON.stringify(head);
  const frames = await buildSessionLog(headerLine, lines.slice(1), outPath);
  return { events: lines.length, oldCwd, frames };
}
