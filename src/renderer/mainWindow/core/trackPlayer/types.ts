/**
 * TrackPlayer 模块内部类型
 */
import type LyricParser from '@common/lyricParser';
import type { IParsedLrcItem } from '@common/lyricParser';

export interface ICurrentLyric {
    parser?: LyricParser;
    currentLrc?: IParsedLrcItem;
}

export interface IPlayOptions {
    restartOnSameMedia?: boolean;
}

/** 仅保存媒体 key，不持久化数据库位置或修改用户歌单顺序。 */
export interface IShuffleSnapshot {
    version: 1;
    keys: string[];
    cursor: number;
}

/** resolveSource 的可选行为 */
export interface IResolveSourceOptions {
    /** 为 true 时，仅在本地已下载文件的音质与目标音质一致时才使用本地文件（切换音质场景） */
    requireQualityMatch?: boolean;
}
