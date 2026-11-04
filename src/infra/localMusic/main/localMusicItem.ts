import { createHash } from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import { LOCAL_PLUGIN_NAME } from '@common/constant';
import i18n from '@infra/i18n/main';
import type { ParsedAudioMeta } from '../common/parseAudioMeta';

export function addFileScheme(filePath: string): string {
    return filePath.startsWith('file:') ? filePath : pathToFileURL(filePath).toString();
}

/** 本地插件与路径导入使用相同身份和展示字段。 */
export function toLocalMusicItem(
    filePath: string,
    meta: ParsedAudioMeta,
    includeMedia = true,
): IMusic.IMusicItem {
    return {
        id: createHash('md5').update(filePath).digest('hex'),
        platform: LOCAL_PLUGIN_NAME,
        title: meta.title ?? (path.parse(filePath).name || filePath),
        artist: meta.artist ?? i18n.t('media.unknown_artist'),
        album: meta.album ?? i18n.t('media.unknown_album'),
        duration: meta.duration ?? null,
        url: addFileScheme(filePath),
        localPath: filePath,
        ...(includeMedia ? { artwork: meta.artwork, rawLrc: meta.rawLrc } : {}),
    };
}
