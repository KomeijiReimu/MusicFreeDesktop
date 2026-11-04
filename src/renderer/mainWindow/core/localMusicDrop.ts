import type { IScanFailure } from '@appTypes/infra/localMusic';
import fsUtil from '@infra/fsUtil/renderer';
import i18n from '@infra/i18n/renderer';
import localMusic from '@infra/localMusic/renderer';
import { showToast } from '../components/ui/Toast';
import trackPlayer from './trackPlayer';

/** App 在 bootstrap 完成后挂载；返回 document 事件的清理函数。 */
export function setupLocalMusicDrop(): () => void {
    let mounted = true;

    const importFiles = async (files: File[]): Promise<void> => {
        const paths: string[] = [];
        const failures: IScanFailure[] = [];
        for (const file of files) {
            try {
                const filePath = fsUtil.getPathForFile(file);
                if (filePath) paths.push(filePath);
                else
                    failures.push({
                        filePath: file.name,
                        reason: i18n.t('local_music.import_path_unavailable'),
                    });
            } catch (error) {
                failures.push({
                    filePath: file.name,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }

        let musicItems: IMusic.IMusicItem[] = [];
        let added = 0;
        let playbackPath: string | undefined;
        try {
            if (paths.length > 0) {
                if (mounted) showToast(i18n.t('local_music.importing'));
                const result = await localMusic.importPaths(paths);
                musicItems = result.musicItems;
                failures.push(...result.failures);

                const queue = trackPlayer.getPlayQueue();
                const previousLength = queue.queue.length;
                // append 同步去重并更新队列；并发 drop 各自追加，不替换已有内容。
                queue.append(musicItems);
                added = queue.queue.length - previousLength;
                if (previousLength === 0 && added > 0) {
                    playbackPath = musicItems[0].localPath;
                    await trackPlayer.playMusic(musicItems[0]);
                }
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error('[localMusicDrop] Import or initial playback failed', paths, error);
            const affectedPaths = playbackPath ? [playbackPath] : paths;
            failures.push(...affectedPaths.map((filePath) => ({ filePath, reason })));
        }

        if (failures.length > 0) console.warn('[localMusicDrop] Import failures', failures);
        // 已接受的导入继续加入队列，但卸载后不再向 UI 发通知。
        if (!mounted) return;
        if (failures.length > 0) {
            showToast(
                added > 0
                    ? i18n.t('local_music.import_partial', {
                          count: added,
                          failed: failures.length,
                      })
                    : i18n.t('local_music.import_failed', { reason: failures[0].reason }),
                {
                    type: 'warn',
                    duration: 10000,
                    description: failures
                        .slice(0, 3)
                        .map((failure) =>
                            i18n.t('local_music.import_failure_details', {
                                path: failure.filePath,
                                reason: failure.reason,
                            }),
                        )
                        .join('\n'),
                },
            );
        } else if (added > 0) {
            showToast(i18n.t('local_music.import_added', { count: added }));
        } else {
            showToast(
                i18n.t(
                    musicItems.length > 0
                        ? 'local_music.import_unchanged'
                        : 'local_music.import_empty',
                ),
            );
        }
    };

    const onDragOver = (event: DragEvent): void => {
        if (!event.dataTransfer?.types.includes('Files') || event.defaultPrevented) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = document.querySelector('[aria-modal="true"]')
            ? 'none'
            : 'copy';
    };

    const onDrop = (event: DragEvent): void => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        const consumed = event.defaultPrevented;
        event.preventDefault();
        if (consumed || document.querySelector('[aria-modal="true"]')) return;
        // DataTransfer 只在当前事件期间可读，先复制 File 列表再异步导入。
        void importFiles(Array.from(event.dataTransfer.files));
    };

    // 使用冒泡阶段：React 局部 drop 处理器（含 portal 弹窗）先执行。
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
        mounted = false;
        document.removeEventListener('dragover', onDragOver);
        document.removeEventListener('drop', onDrop);
    };
}
