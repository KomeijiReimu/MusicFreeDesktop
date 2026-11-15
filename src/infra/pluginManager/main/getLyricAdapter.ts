/**
 * pluginManager — getLyric 适配器（主进程）
 *
 * 在主进程中实现多步歌词获取逻辑：
 * 0. 检查 mediaMeta.associatedLyric——用户关联歌词优先
 * 1. 检查 musicItem.rawLrc——已有文本直接返回
 * 2. 读取本地同名 .lrc 文件（含翻译文件 -tr）
 * 3. 调用插件的 getLyric 方法
 * 4. 如果插件无结果但有 lrcUrl，通过 HTTP 获取
 *
 * 此适配器在主进程运行（需要 fs 访问），通过 IPC 向渲染进程暴露。
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { isSameMedia } from '@common/mediaKey';
import type { ILocalLyricSource, IMediaMetaProvider } from '@appTypes/infra/mediaMeta';
import type { IMusicItemProvider } from '@appTypes/infra/musicSheet';
import { parseAudioMeta } from '@infra/localMusic/common/parseAudioMeta';

/** getLyric 适配器所需的参数 */
export interface IGetLyricParams {
    musicItem: IMusic.IMusicItem;
    source?: ILocalLyricSource;
}

/** 调用插件方法的函数类型 */
type CallPluginMethodFn = (params: {
    hash?: string;
    platform?: string;
    method: string;
    args: any[];
}) => Promise<any>;

/**
 * 安全地检查路径是否存在且是文件。
 */
function isFile(filePath: string, strict: boolean): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (strict && code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        return false;
    }
}

/**
 * 获取歌曲的本地文件路径。
 *
 * 依次尝试：
 * 1. mediaMeta 中的 downloadData.path（已下载歌曲）
 * 2. musicItem.localPath（本地扫描歌曲，完整对象时可用）
 * 3. 从 musicSheet DB 查 raw JSON 取 localPath（slim fallback）
 */
function getLocalPath(
    musicItem: IMusic.IMusicItem,
    mediaMeta: IMediaMetaProvider,
    musicItemProvider: IMusicItemProvider,
): string | null {
    // 1. 已下载歌曲：从 mediaMeta 查
    const downloadData = mediaMeta.getDownloadData(musicItem.platform, String(musicItem.id));
    if (downloadData?.path) return downloadData.path;

    // 2. 本地音乐：直接读 localPath（完整对象时存在）
    if (musicItem.localPath) return musicItem.localPath;

    // 3. slim fallback：从 musicSheet DB 查 raw JSON
    const rawItem = musicItemProvider.getRawMusicItem(musicItem.platform, String(musicItem.id));
    if (rawItem?.localPath) return rawItem.localPath;

    return null;
}

/** 显式来源与自动模式共用同名文件及翻译的扩展名顺序。 */
function readSiblingLyric(localPath: string, lrcUrl?: string, strict = false): ILyric.ILyricSource {
    const fileName = path.parse(localPath).name;
    const lrcPathWithoutExt = path.resolve(localPath, `../${fileName}`);
    const lrcTranslationPathWithoutExt = path.resolve(localPath, `../${fileName}-tr`);
    let translation: string | undefined;

    for (const ext of ['.lrc', '.LRC', '.txt']) {
        const lrcFilePath = lrcPathWithoutExt + ext;
        if (isFile(lrcFilePath, strict)) {
            const rawLrc = fs.readFileSync(lrcFilePath, 'utf-8');
            const trFilePath = lrcTranslationPathWithoutExt + ext;
            if (isFile(trFilePath, strict)) {
                translation = fs.readFileSync(trFilePath, 'utf-8');
            }
            if (rawLrc) return { rawLrc, translation, lrc: lrcUrl };
        }
    }
    return { translation };
}

/**
 * getLyric 适配器。
 * 按旧版 plugin-methods.ts 的 getLyric 逻辑，依次尝试多种获取方式。
 *
 * @param params 请求参数
 * @param callPluginMethod 调用插件方法的函数
 * @param mediaMeta mediaMeta DI 接口
 * @param musicItemProvider musicSheet DI 接口
 * @returns 歌词源结果，或 null
 */
export async function getLyricAdapter(
    params: IGetLyricParams,
    callPluginMethod: CallPluginMethodFn,
    mediaMeta: IMediaMetaProvider,
    musicItemProvider: IMusicItemProvider,
): Promise<ILyric.ILyricSource | null> {
    const { musicItem, source = 'auto' } = params;

    // 显式来源只读取实际本地文件，不使用关联、rawLrc、插件或远程歌词兜底。
    if (source !== 'auto') {
        const localPath = getLocalPath(musicItem, mediaMeta, musicItemProvider);
        if (!localPath) return null;
        try {
            if (source === 'file') {
                const fileSource = readSiblingLyric(localPath, undefined, true);
                return fileSource.rawLrc ? fileSource : null;
            }
            const meta = await parseAudioMeta(localPath);
            return meta.rawLrc ? { rawLrc: meta.rawLrc } : null;
        } catch (error) {
            console.error('[PluginManager] Failed to read local lyrics:', source, localPath, error);
            throw error;
        }
    }

    let rawLrc = musicItem.rawLrc;
    let lrcUrl = musicItem.lrc;
    let translation: string | undefined;

    // ─── Step 0: 用户关联歌词优先 ───
    const associated = mediaMeta.getAssociatedLyric(musicItem.platform, String(musicItem.id));
    if (associated) {
        // 0a: 有缓存的歌词文本，直接返回
        if (associated.rawLrc) {
            return {
                rawLrc: associated.rawLrc,
                translation: associated.translation,
            };
        }

        // 0b: 有关联的 musicItem 但无缓存文本，调用其所属插件的 getLyric
        //     自引用保护：关联歌曲不能是自己（避免死循环）
        if (associated.musicItem && !isSameMedia(associated.musicItem, musicItem)) {
            try {
                const linkedSource = await callPluginMethod({
                    platform: associated.musicItem.platform,
                    method: 'getLyric',
                    args: [associated.musicItem],
                });

                if (linkedSource?.rawLrc || linkedSource?.translation) {
                    const linkedRawLrc = linkedSource.rawLrc ?? linkedSource.translation;
                    const linkedTranslation = linkedSource.rawLrc
                        ? linkedSource.translation
                        : undefined;

                    // 回写缓存到 mediaMeta，下次无需再调插件
                    mediaMeta.setMeta(musicItem.platform, String(musicItem.id), {
                        associatedLyric: {
                            musicItem: associated.musicItem,
                            rawLrc: linkedRawLrc,
                            translation: linkedTranslation,
                        },
                    });

                    return {
                        rawLrc: linkedRawLrc,
                        translation: linkedTranslation,
                    };
                }
            } catch {
                // 关联歌词插件调用失败，继续后续步骤
            }
        }
    }

    // ─── Step 1: musicItem 自身已有 rawLrc，直接返回 ───
    if (rawLrc) {
        return {
            rawLrc,
            lrc: lrcUrl,
        };
    }

    // ─── Step 2: 读取本地同名 .lrc 文件 ───
    const localPath = getLocalPath(musicItem, mediaMeta, musicItemProvider);
    if (localPath) {
        const fileSource = readSiblingLyric(localPath, lrcUrl);
        if (fileSource.rawLrc) return fileSource;
        translation = fileSource.translation;
    }

    // ─── Step 3: 调用插件 getLyric ───
    try {
        const lrcSource = await callPluginMethod({
            platform: musicItem.platform,
            method: 'getLyric',
            args: [musicItem],
        });

        rawLrc = lrcSource?.rawLrc;
        lrcUrl = lrcSource?.lrc || lrcUrl;
        translation = lrcSource?.translation;

        if (rawLrc || translation) {
            // 仅有翻译无原文时，将翻译提升为原文
            if (!rawLrc) {
                rawLrc = translation;
                translation = undefined;
            }

            return {
                rawLrc,
                translation,
            };
        }
    } catch {
        // 插件获取歌词失败，继续下一步
    }

    // ─── Step 4: 通过 lrcUrl 远程获取 ───
    if (lrcUrl) {
        try {
            const resp = await axios.get(lrcUrl, { timeout: 5000 });
            rawLrc = resp.data;

            return {
                rawLrc,
                lrc: lrcUrl,
                translation,
            };
        } catch {
            // 远程获取失败
        }
    }

    return null;
}
