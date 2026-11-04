/**
 * PlayQueue — 播放队列管理
 *
 * 内存中维护 slim 列表供 UI 渲染，
 * 通过 MutationQueue + musicSheet preload IPC 持久化到 SQLite 虚拟歌单。
 * 乐观更新：先改内存 → 再异步落库。
 */
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { compositeKey, isSameMedia } from '@common/mediaKey';
import { createIndexMap, type IIndexMap } from '@common/indexMap';
import musicItemToSlim from '@common/musicItemToSlim';
import MutationQueue from '@common/mutationQueue';
import { syncKV } from '@renderer/common/kvStore';
import { playQueueBridge } from '@infra/musicSheet/renderer';
import { store, musicQueueAtom } from './store';
import type { IShuffleSnapshot } from './types';

const SHUFFLE_STORAGE_KEY = 'player.shuffleOrder';
const RANDOM_HISTORY_LIMIT = 200;

// ─── PlayQueue ───

class PlayQueue {
    /** 数据库原始队列顺序；Shuffle 只重排展示和导航，不重排此列表。 */
    private slimList: IMusicItemSlim[] = [];
    private indexMap: IIndexMap = createIndexMap([]);
    private displayList: IMusicItemSlim[] = [];
    private displayIndexMap: IIndexMap = createIndexMap([]);
    private currentIndex = -1;
    private mutationQueue = new MutationQueue();

    // ─── Shuffle：持久化无放回排列及游标 ───
    private shuffleKeys: string[] = [];
    private shufflePosition = -1;
    private _isShuffleActive = false;
    private keyToIndex = new Map<string, number>();

    // ─── Random：允许重复的实际播放历史（最多 200 项） ───
    private _isRandomActive = false;
    private randomHistory: string[] = [];
    private randomPosition = -1;
    private priorityKeys: string[] = [];
    private randomNavigation: { key: string; cursor: number | null } | null = null;

    constructor(private readonly random: () => number = Math.random) {
        this.mutationQueue.onError(() => {
            // 持久化失败时从主进程重新加载
            this.reloadFromDB();
        });
    }

    // ─── 读取 ───

    get queue(): IMusicItemSlim[] {
        return this.displayList;
    }

    get isEmpty(): boolean {
        return this.slimList.length === 0;
    }

    getCurrentIndex(): number {
        const current = this.getCurrentMusic();
        return current ? this.displayIndexMap.indexOf(current) : -1;
    }

    getCurrentMusic(): IMusicItemSlim | null {
        return this.currentIndex >= 0 ? (this.slimList[this.currentIndex] ?? null) : null;
    }

    get isShuffleActive(): boolean {
        return this._isShuffleActive;
    }

    get isRandomActive(): boolean {
        return this._isRandomActive;
    }

    // ─── 初始化（启动恢复） ───

    async setup(): Promise<void> {
        this.slimList = await playQueueBridge.getAll();
        this.rebuildIndexMap();

        const savedMusic = syncKV.get('player.currentMusic');
        if (savedMusic) {
            this.currentIndex = this.indexMap.indexOf(savedMusic);
        }
        this.syncAtom();
    }

    // ─── 队列操作（乐观更新 + MutationQueue） ───

    /**
     * 替换整个队列。
     * @param items   歌曲列表（IMusicItem 或 IMusicItemSlim 均可）
     * @param options.playIndex    起始播放位置
     * @param options.fromSheetId  可选性能优化提示：若来自某本地歌单，主进程用 INSERT...SELECT
     */
    setQueue(
        items: (IMusic.IMusicItem | IMusicItemSlim)[],
        options?: { playIndex?: number; fromSheetId?: string },
    ): void {
        const uniqueItems = [...new Map(items.map((item) => [this.keyOf(item), item])).values()];
        const slims = uniqueItems.map(musicItemToSlim);
        this.slimList = slims;
        this.rebuildIndexMap();
        const startItem = items[options?.playIndex ?? -1];
        this.currentIndex = startItem ? this.indexMap.indexOf(startItem) : -1;
        this.resetRandomHistory();
        if (this._isShuffleActive) this.regenerateShuffleOrder();
        this.syncAtom();

        this.mutationQueue.enqueue(() =>
            playQueueBridge.set(uniqueItems as IMusic.IMusicItem[], options?.fromSheetId),
        );
    }

    /**
     * 下一首播放。
     * 将指定歌曲移到当前歌曲之后（已存在则先移除再插入）。
     * Shuffle 模式下同时更新 shuffle 导航，确保新歌曲在随机序列的下一位。
     */
    addNext(items: (IMusic.IMusicItem | IMusicItemSlim)[]): void {
        const slims = items.map(musicItemToSlim);
        const currentMusic = this.getCurrentMusic();
        const currentKey = currentMusic ? this.keyOf(currentMusic) : null;

        // 单次遍历：过滤当前播放歌曲，同时保留对应 items 索引
        const filteredSlims: IMusicItemSlim[] = [];
        const filteredItems: IMusic.IMusicItem[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < slims.length; i++) {
            const key = this.keyOf(slims[i]);
            if ((!this._isRandomActive && key === currentKey) || seen.has(key)) continue;
            seen.add(key);
            filteredSlims.push(slims[i]);
            filteredItems.push(items[i] as IMusic.IMusicItem);
        }

        if (filteredSlims.length === 0) return;

        // 去重：从队列中移除即将插入的歌曲
        const removeSet = new Set(filteredSlims.map((s) => this.keyOf(s)));
        const cleaned = this.slimList.filter((s) => !removeSet.has(this.keyOf(s)));

        // 计算插入点：当前歌曲之后
        const cleanedCurrentIdx = currentMusic
            ? cleaned.findIndex((s) => isSameMedia(s, currentMusic))
            : -1;
        const insertPos = cleanedCurrentIdx + 1;
        cleaned.splice(insertPos, 0, ...filteredSlims);
        this.slimList = cleaned;
        this.rebuildIndexMap();
        this.fixCurrentIndex(currentMusic);

        // 更新 shuffle 导航
        if (this._isShuffleActive) {
            this.shuffleKeys = this.shuffleKeys.filter((k) => !removeSet.has(k));
            if (currentKey) {
                const pos = this.shuffleKeys.indexOf(currentKey);
                if (pos !== -1) this.shufflePosition = pos;
            }
            const newKeys = filteredSlims.map((s) => this.keyOf(s));
            this.shuffleKeys.splice(this.shufflePosition + 1, 0, ...newKeys);
        }

        if (this._isRandomActive) {
            this.priorityKeys = [
                ...filteredSlims.map((item) => this.keyOf(item)),
                ...this.priorityKeys.filter((key) => !removeSet.has(key)),
            ];
        }

        this.syncAtom();
        this.mutationQueue.enqueue(() => playQueueBridge.add(filteredItems, insertPos));
    }

    /** 追加到队尾 */
    append(items: (IMusic.IMusicItem | IMusicItemSlim)[]): void {
        const seen = new Set(this.slimList.map((item) => this.keyOf(item)));
        const added = items.filter((item) => {
            const key = this.keyOf(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (added.length === 0) return;
        const slims = added.map(musicItemToSlim);
        const insertPos = this.slimList.length;
        this.slimList = [...this.slimList, ...slims];
        this.rebuildIndexMap();
        if (this._isShuffleActive) {
            this.shuffleKeys.push(...slims.map((s) => this.keyOf(s)));
        }
        this.syncAtom();

        // afterIndex 超出范围时主进程自动 append
        this.mutationQueue.enqueue(() =>
            playQueueBridge.add(added as IMusic.IMusicItem[], insertPos),
        );
    }

    /** 移除指定歌曲 */
    remove(targets: IMedia.IMediaBase | IMedia.IMediaBase[]): void {
        const bases = Array.isArray(targets) ? targets : [targets];
        const removeSet = new Set(bases.map((b) => this.keyOf(b)));

        const currentMusic = this.getCurrentMusic();
        this.slimList = this.slimList.filter((s) => !removeSet.has(this.keyOf(s)));
        this.rebuildIndexMap();

        if (currentMusic && removeSet.has(this.keyOf(currentMusic))) {
            this.currentIndex = -1;
        } else {
            this.fixCurrentIndex(currentMusic);
        }

        if (this._isShuffleActive) {
            const precedingKeys = this.shuffleKeys.slice(
                0,
                this.shufflePosition + (currentMusic ? 0 : 1),
            );
            this.shuffleKeys = this.shuffleKeys.filter((k) => !removeSet.has(k));
            if (this.currentIndex >= 0) {
                const key = this.keyOf(this.slimList[this.currentIndex]);
                this.shufflePosition = this.shuffleKeys.indexOf(key);
            } else {
                this.shufflePosition =
                    precedingKeys.filter((key) => !removeSet.has(key)).length - 1;
            }
        }
        this.pruneRandomHistory();
        this.syncAtom();

        this.mutationQueue.enqueue(() => playQueueBridge.remove(bases));
    }

    /** 清空 */
    clear(): void {
        this.slimList = [];
        this.currentIndex = -1;
        this.shuffleKeys = [];
        this.shufflePosition = -1;
        this.resetRandomHistory();
        this.rebuildIndexMap();
        this.syncAtom();

        this.mutationQueue.enqueue(() => playQueueBridge.clear());
    }

    // ─── 导航 ───

    /** 所有公开 index 都对应 queue / musicQueueAtom 的展示顺序。 */
    setCurrentIndex(index: number): void {
        const item = this.displayList[index];
        this.currentIndex = item ? this.indexMap.indexOf(item) : -1;
        if (!item) return;
        const key = this.keyOf(item);
        if (this._isShuffleActive) {
            const pos = this.shuffleKeys.indexOf(key);
            if (pos !== -1) this.shufflePosition = pos;
            this.saveShuffleOrder();
        }
        if (this._isRandomActive) {
            const navigation = this.randomNavigation;
            if (navigation?.key === key && navigation.cursor !== null) {
                this.randomPosition = navigation.cursor;
            } else if (navigation?.key === key || this.randomHistory[this.randomPosition] !== key) {
                this.randomHistory = this.randomHistory.slice(0, this.randomPosition + 1);
                this.randomHistory.push(key);
                this.randomHistory = this.randomHistory.slice(-RANDOM_HISTORY_LIMIT);
                this.randomPosition = this.randomHistory.length - 1;
            }
            this.priorityKeys = this.priorityKeys.filter((priorityKey) => priorityKey !== key);
            this.randomNavigation = null;
        }
    }

    /** exclude 仅用于失败跳过；正常 Random 不排除当前曲目。 */
    getNextIndex(exclude?: IMedia.IMediaBase): number {
        if (this.isEmpty) return -1;
        if (this._isRandomActive) {
            const excludedKey = exclude ? this.keyOf(exclude) : null;
            const priority = this.priorityKeys.find((key) => key !== excludedKey);
            if (priority) {
                this.randomNavigation = { key: priority, cursor: null };
                return this.indexOfKey(priority);
            }
            for (
                let cursor = this.randomPosition + 1;
                cursor < this.randomHistory.length;
                cursor++
            ) {
                const key = this.randomHistory[cursor];
                if (key === excludedKey) continue;
                this.randomNavigation = { key, cursor };
                return this.indexOfKey(key);
            }
            const candidates = excludedKey
                ? this.slimList.filter((item) => this.keyOf(item) !== excludedKey)
                : this.slimList;
            if (candidates.length === 0) return -1;
            const key = this.keyOf(candidates[Math.floor(this.random() * candidates.length)]);
            this.randomNavigation = { key, cursor: null };
            return this.indexOfKey(key);
        }
        if (this._isShuffleActive && this.shuffleKeys.length > 0) {
            return (this.shufflePosition + 1) % this.shuffleKeys.length;
        }
        return (this.currentIndex + 1) % this.slimList.length;
    }

    getPrevIndex(): number {
        if (this.isEmpty) return -1;
        if (this._isRandomActive) {
            const cursor = this.randomPosition - 1;
            if (cursor < 0) return -1;
            const key = this.randomHistory[cursor];
            this.randomNavigation = { key, cursor };
            return this.indexOfKey(key);
        }
        if (this._isShuffleActive && this.shuffleKeys.length > 0) {
            if (this.shufflePosition < 0) return this.shuffleKeys.length - 1;
            const prevPos =
                (this.shufflePosition - 1 + this.shuffleKeys.length) % this.shuffleKeys.length;
            return prevPos;
        }
        return this.currentIndex < 0
            ? this.slimList.length - 1
            : (this.currentIndex - 1 + this.slimList.length) % this.slimList.length;
    }

    findIndex(item: IMedia.IMediaBase): number {
        return this.displayIndexMap.indexOf(item);
    }

    // ─── Shuffle（虚拟导航） ───

    /** 进入 Shuffle 模式：生成随机导航序列，当前歌曲置首 */
    enterShuffle(restore = false): void {
        this.exitRandom();
        this._isShuffleActive = true;
        if (!restore || !this.restoreShuffleOrder()) this.regenerateShuffleOrder();
        this.syncAtom();
    }

    /** 退出 Shuffle 模式：清空导航序列 */
    exitShuffle(): void {
        this.shuffleKeys = [];
        this.shufflePosition = -1;
        this._isShuffleActive = false;
        localStorage.removeItem(SHUFFLE_STORAGE_KEY);
        this.syncAtom();
    }

    enterRandom(): void {
        if (this._isShuffleActive) this.exitShuffle();
        this._isRandomActive = true;
        this.resetRandomHistory();
    }

    exitRandom(): void {
        this._isRandomActive = false;
        this.resetRandomHistory();
    }

    // ─── 内部方法 ───

    private rebuildIndexMap(): void {
        this.indexMap = createIndexMap(this.slimList);
        this.keyToIndex.clear();
        for (let i = 0; i < this.slimList.length; i++) {
            this.keyToIndex.set(this.keyOf(this.slimList[i]), i);
        }
    }

    private keyOf(item: IMusicItemSlim | IMedia.IMediaBase): string {
        return compositeKey(item.platform, item.id);
    }

    private indexOfKey(key: string): number {
        return this.keyToIndex.get(key) ?? -1;
    }

    /** 生成随机导航序列，当前歌曲置首 */
    private regenerateShuffleOrder(): void {
        const n = this.slimList.length;
        if (n === 0) {
            this.shuffleKeys = [];
            this.shufflePosition = -1;
            return;
        }

        const currentKey =
            this.currentIndex >= 0 ? this.keyOf(this.slimList[this.currentIndex]) : null;
        const allKeys = this.slimList.map((s) => this.keyOf(s));
        const rest = currentKey ? allKeys.filter((k) => k !== currentKey) : [...allKeys];

        // Fisher-Yates in-place shuffle
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }

        this.shuffleKeys = currentKey ? [currentKey, ...rest] : rest;
        this.shufflePosition = currentKey ? 0 : -1;
    }

    /**
     * 重定位 currentIndex。
     * @param currentMusic 已捕获的当前歌曲引用（避免读 localStorage）
     *   仅在 reloadFromDB 等无法提前捕获的场景传 undefined，此时回退到 localStorage。
     */
    private fixCurrentIndex(currentMusic?: IMusicItemSlim | null): void {
        const target =
            currentMusic === undefined ? syncKV.get('player.currentMusic') : currentMusic;
        this.currentIndex = target ? this.indexMap.indexOf(target) : -1;
    }

    private syncAtom(): void {
        this.displayList = this._isShuffleActive
            ? this.shuffleKeys.map((key) => this.slimList[this.indexOfKey(key)])
            : this.slimList;
        this.displayIndexMap = createIndexMap(this.displayList);
        store.set(musicQueueAtom, this.displayList);
        if (this._isShuffleActive) this.saveShuffleOrder();
    }

    private resetRandomHistory(): void {
        const current = this.getCurrentMusic();
        this.randomHistory = this._isRandomActive && current ? [this.keyOf(current)] : [];
        this.randomPosition = this.randomHistory.length - 1;
        this.priorityKeys = [];
        this.randomNavigation = null;
    }

    private pruneRandomHistory(): void {
        const preceding = this.randomHistory.slice(0, this.randomPosition + 1);
        this.randomHistory = this.randomHistory.filter((key) => this.keyToIndex.has(key));
        this.randomPosition = preceding.filter((key) => this.keyToIndex.has(key)).length - 1;
        this.priorityKeys = this.priorityKeys.filter((key) => this.keyToIndex.has(key));
        this.randomNavigation = null;
    }

    private saveShuffleOrder(): void {
        if (this.isEmpty) {
            localStorage.removeItem(SHUFFLE_STORAGE_KEY);
            return;
        }
        const snapshot: IShuffleSnapshot = {
            version: 1,
            keys: this.shuffleKeys,
            cursor: this.shufflePosition,
        };
        localStorage.setItem(SHUFFLE_STORAGE_KEY, JSON.stringify(snapshot));
    }

    /** 持久化数据只在入口校验一次，再按当前数据库媒体 key 对齐。 */
    private restoreShuffleOrder(): boolean {
        const raw = localStorage.getItem(SHUFFLE_STORAGE_KEY);
        if (!raw) return false;
        let saved: IShuffleSnapshot;
        try {
            saved = JSON.parse(raw);
        } catch {
            return false;
        }
        if (
            !saved ||
            saved.version !== 1 ||
            !Array.isArray(saved.keys) ||
            !saved.keys.every((key) => typeof key === 'string') ||
            !Number.isInteger(saved.cursor) ||
            saved.cursor < -1 ||
            saved.cursor >= saved.keys.length
        )
            return false;

        const keys = new Set(saved.keys.filter((key) => this.keyToIndex.has(key)));
        for (const item of this.slimList) keys.add(this.keyOf(item));
        this.shuffleKeys = [...keys];
        const current = this.getCurrentMusic();
        // 当前歌曲为准；数据库重排/删歌后不能把旧 cursor 当成新的歌曲位置。
        this.shufflePosition = current ? this.shuffleKeys.indexOf(this.keyOf(current)) : -1;
        return true;
    }

    private async reloadFromDB(): Promise<void> {
        try {
            this.slimList = await playQueueBridge.getAll();
            this.rebuildIndexMap();
            this.fixCurrentIndex();
            if (this._isShuffleActive) {
                if (!this.restoreShuffleOrder()) this.regenerateShuffleOrder();
            }
            this.pruneRandomHistory();
            this.syncAtom();
        } catch (error) {
            console.error('[PlayQueue] Failed to reload queue after persistence error:', error);
        }
    }
}

export default PlayQueue;
