import { LOCAL_PLUGIN_NAME, SUPPORTED_AUDIO_EXTS } from '@common/constant';
import fsp from 'fs/promises';
import path from 'path';
import { parseAudioMeta } from '@infra/localMusic/common/parseAudioMeta';
import { addFileScheme, toLocalMusicItem } from '@infra/localMusic/main/localMusicItem';

/**
 * 解析单个本地音乐文件的元数据
 */
async function parseLocalMusicItem(filePath: string): Promise<IMusic.IMusicItem> {
    const meta = await parseAudioMeta(filePath, { duration: true });
    return toLocalMusicItem(filePath, meta);
}

/**
 * 解析文件夹中所有支持格式的本地音乐文件（并发限制为 10）
 */
async function parseLocalMusicItemFolder(folderPath: string): Promise<IMusic.IMusicItem[]> {
    const stat = await fsp.stat(folderPath);
    if (!stat.isDirectory()) throw new Error(`不是文件夹: ${folderPath}`);

    const files = await fsp.readdir(folderPath);
    const musicFiles = files.filter((f) => SUPPORTED_AUDIO_EXTS.has(path.extname(f).toLowerCase()));

    const { default: PQueue } = await import('p-queue');
    const queue = new PQueue({ concurrency: 10 });
    return queue.addAll(
        musicFiles.map((f) => () => parseLocalMusicItem(path.resolve(folderPath, f))),
    );
}

const localPluginDefine: IPlugin.IPluginInstance = {
    platform: LOCAL_PLUGIN_NAME,
    _path: '', // 内建插件不从磁盘加载，无需路径
    async getMediaSource(musicItem) {
        return {
            url: addFileScheme(musicItem.url),
        };
    },
    async getLyric(musicItem) {
        if (musicItem.rawLrc) {
            return {
                rawLrc: musicItem.rawLrc,
            };
        } else {
            // 封面和歌词使用同一读取能力，共享解析及 inflight 结果。
            const meta = await parseAudioMeta(musicItem.localPath!);
            if (meta.rawLrc) {
                return {
                    rawLrc: meta.rawLrc,
                };
            }
        }
    },
    async importMusicItem(filePath) {
        return parseLocalMusicItem(filePath);
    },
    async importMusicSheet(folderPath) {
        return parseLocalMusicItemFolder(folderPath);
    },
    async getMusicInfo(musicItem) {
        if (!musicItem.artwork) {
            const meta = await parseAudioMeta(musicItem.localPath!);
            if (meta.artwork) {
                return {
                    artwork: meta.artwork,
                };
            }
        }
        return null;
    },
};

export default localPluginDefine;
