import fsp from 'fs/promises';
import path from 'path';
import { SUPPORTED_AUDIO_EXTS } from '@common/constant';
import type {
    IFileInfo,
    ILocalMusicDirectoriesResult,
    ILocalMusicImportResult,
    IScanFailure,
} from '@appTypes/infra/localMusic';
import { parseAudioMeta } from '../common/parseAudioMeta';
import { discoverAudioFilesForImport } from './scanner';
import { toLocalMusicItem } from './localMusicItem';

function pathKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

/** IPC 输入只在这里校验、规范化和去重。 */
function readPaths(input: unknown): { paths: string[]; failures: IScanFailure[] } {
    if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
        throw new Error('路径参数必须是字符串数组');
    }
    const paths = new Map<string, string>();
    const failures: IScanFailure[] = [];
    for (const value of new Set<string>(input)) {
        if (value.includes('\0') || !path.isAbsolute(value)) {
            failures.push({ filePath: value, reason: '文件路径必须是有效的绝对路径' });
            continue;
        }
        const normalized = path.resolve(value);
        const key = pathKey(normalized);
        if (!paths.has(key)) paths.set(key, normalized);
    }
    return { paths: [...paths.values()], failures };
}

/** 只读取目录信息，调用方自行决定是否更新扫描配置。 */
export async function getDirectories(input: unknown): Promise<ILocalMusicDirectoriesResult> {
    const { paths, failures } = readPaths(input);
    const directories: string[] = [];
    for (const filePath of paths) {
        try {
            const stat = await fsp.stat(filePath);
            if (!stat.isDirectory()) throw new Error('该路径不是文件夹');
            directories.push(filePath);
        } catch (error) {
            failures.push({
                filePath,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { directories, failures };
}

/** 混合路径导入：递归发现、逐曲解析，无数据库或用户歌单副作用。 */
export async function importPaths(input: unknown): Promise<ILocalMusicImportResult> {
    const { paths, failures } = readPaths(input);
    const files = new Map<string, IFileInfo>();
    for (const filePath of paths) {
        try {
            const stat = await fsp.stat(filePath);
            if (stat.isDirectory()) {
                const discovered = await discoverAudioFilesForImport(filePath);
                failures.push(...discovered.failures);
                for (const file of discovered.files) {
                    const key = pathKey(file.filePath);
                    if (!files.has(key)) files.set(key, file);
                }
            } else {
                if (!stat.isFile()) throw new Error('该路径不是普通文件或文件夹');
                if (!SUPPORTED_AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) {
                    throw new Error(`不支持的音频格式: ${path.extname(filePath) || '无扩展名'}`);
                }
                const key = pathKey(filePath);
                if (!files.has(key))
                    files.set(key, { filePath, size: stat.size, mtime: stat.mtimeMs });
            }
        } catch (error) {
            failures.push({
                filePath,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const musicItems: IMusic.IMusicItem[] = [];
    for (const file of files.values()) {
        try {
            const meta = await parseAudioMeta(file.filePath, {
                skipCovers: true,
                skipLyrics: true,
                duration: true,
                fileInfo: { size: file.size, mtime: file.mtime },
            });
            // 即使命中了带封面的更完整缓存，也不把大字段放入导入 IPC。
            musicItems.push(toLocalMusicItem(file.filePath, meta, false));
        } catch (error) {
            failures.push({
                filePath: file.filePath,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { musicItems, failures };
}
