/**
 * ScanFolderModal — 扫描本地文件夹弹窗（业务组件）
 *
 * 功能：
 *   - 展示待扫描的文件夹列表（纯本地状态）
 *   - 点击或拖入文件夹，仅修改待扫描列表
 *   - 移除已有文件夹（仅修改本地状态）
 *   - 点击"开始扫描"后提交文件夹列表，展示进度、结果与失败明细
 *   - 主进程负责计算 diff（增删）并触发扫描
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Folder } from 'lucide-react';
import type { IScanFailure, IScanProgress, IScanResult } from '@appTypes/infra/localMusic';
import { cn } from '@common/cn';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { ScrollArea } from '@renderer/mainWindow/components/ui/ScrollArea';
import { CheckboxGroup } from '@renderer/mainWindow/components/ui/CheckboxGroup';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import localMusic from '@infra/localMusic/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import appConfig from '@infra/appConfig/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import './index.scss';

export interface ScanFolderModalProps {
    close: () => void;
}

function FailureList({ title, failures }: { title: string; failures: IScanFailure[] }) {
    const { t } = useTranslation();
    return (
        <section className="scan-folder-modal__failures">
            <p className="scan-folder-modal__failure-title">{title}</p>
            {failures.length > 0 && (
                <ul className="scan-folder-modal__failure-list">
                    {failures.map((failure, index) => (
                        <li
                            className="scan-folder-modal__failure"
                            key={`${failure.filePath}-${index}`}
                        >
                            {t('local_music.import_failure_details', {
                                path: failure.filePath,
                                reason: failure.reason,
                            })}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/**
 * 规范化路径用于比较：统一正反斜杠为 '\'，去除末尾分隔符，转小写。
 * Windows 文件系统不区分大小写。
 */
function normalizeForCompare(folderPath: string): string {
    return fsUtil.normalizePath(folderPath).toLowerCase();
}

/**
 * 检查路径列表中是否存在父子路径重叠。
 * 返回冲突描述文本，无冲突返回 null。
 */
function checkPathOverlap(
    newPath: string,
    existingPaths: string[],
    t: (key: string, opts?: Record<string, string>) => string,
): string | null {
    const sep = fsUtil.pathSep;
    const newNorm = normalizeForCompare(newPath);
    for (const ep of existingPaths) {
        const existingNorm = normalizeForCompare(ep);
        if (newNorm === existingNorm) {
            return t('local_music.scan_folder_duplicate');
        }
        if (newNorm.startsWith(existingNorm + sep)) {
            return t('local_music.scan_folder_child_overlap', { parent: ep });
        }
        if (existingNorm.startsWith(newNorm + sep)) {
            return t('local_music.scan_folder_parent_overlap', { child: ep });
        }
    }
    return null;
}

export default function ScanFolderModal({ close }: ScanFolderModalProps) {
    const { t } = useTranslation();

    // ── 纯本地文件夹列表状态 ──
    const [folderPaths, setFolderPaths] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [folderFailures, setFolderFailures] = useState<IScanFailure[]>([]);
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState<IScanProgress | null>(null);
    const [result, setResult] = useState<IScanResult | null>(null);
    const [scanError, setScanError] = useState<string | null>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const [filterShort, setFilterShort] = useState(() => {
        return (appConfig.getConfigByKey('localMusic.minDurationSec') ?? 0) === 60;
    });

    // 操作按钮将禁用或移除时，先将焦点留在弹窗内。
    const focusPanel = useCallback(() => {
        addButtonRef.current
            ?.closest<HTMLElement>('[role="dialog"]')
            ?.focus({ preventScroll: true });
    }, []);

    // ── 初始化：从主进程加载已持久化的文件夹列表 → 拷贝到本地状态 ──
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        (async () => {
            try {
                const result = await localMusic.getScanFolders();
                if (!cancelled) {
                    setFolderPaths(result.map((f) => f.folderPath));
                }
            } catch (error) {
                if (!cancelled)
                    setLoadError(error instanceof Error ? error.message : String(error));
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadAttempt]);

    useEffect(() => {
        if (!scanning) return;
        return localMusic.onScanProgress((next) => {
            setProgress((previous) => ({
                ...next,
                failed: next.failed ?? previous?.failed,
                failures: next.failures ?? previous?.failures,
            }));
        });
    }, [scanning]);

    // ── 点击与拖放共用同一添加路径，只更新待扫描列表 ──
    const addPaths = useCallback(
        async (paths: string[], pathFailures: IScanFailure[] = []) => {
            focusPanel();
            setAdding(true);
            setFolderFailures(pathFailures);
            try {
                const checked = paths.length
                    ? await localMusic.getDirectories(paths)
                    : { directories: [], failures: [] };
                const next = [...folderPaths];
                const failures = [...pathFailures, ...checked.failures];
                for (const folderPath of checked.directories) {
                    const overlap = checkPathOverlap(folderPath, next, t);
                    if (overlap) failures.push({ filePath: folderPath, reason: overlap });
                    else next.push(folderPath);
                }
                setFolderPaths(next);
                setFolderFailures(failures);
                setResult(null);
                setProgress(null);
                setScanError(null);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                setFolderFailures([
                    ...pathFailures,
                    ...paths.map((filePath) => ({ filePath, reason })),
                ]);
            } finally {
                setAdding(false);
            }
        },
        [folderPaths, t, focusPanel],
    );

    const handleAddFolder = useCallback(async () => {
        try {
            const selection = await systemUtil.showOpenDialog({
                properties: ['openDirectory', 'multiSelections'],
            });
            if (!selection.canceled && selection.filePaths.length > 0) {
                await addPaths(selection.filePaths);
            }
        } catch (error) {
            showToast(t('local_music.folder_select_failed'), {
                type: 'warn',
                description: error instanceof Error ? error.message : String(error),
            });
        }
    }, [addPaths, t]);

    // ── 移除文件夹（仅修改本地状态） ──
    const handleRemoveFolder = useCallback(
        (folderPath: string) => {
            focusPanel();
            setFolderPaths((prev) => prev.filter((fp) => fp !== folderPath));
            setResult(null);
            setProgress(null);
            setScanError(null);
        },
        [focusPanel],
    );

    const handleStartScan = useCallback(async () => {
        focusPanel();
        setScanning(true);
        setProgress(null);
        setResult(null);
        setScanError(null);
        try {
            appConfig.setConfig({ 'localMusic.minDurationSec': filterShort ? 60 : 0 });
            setResult(await localMusic.syncScanFolders(folderPaths));
        } catch (error) {
            setScanError(error instanceof Error ? error.message : String(error));
        } finally {
            setScanning(false);
        }
    }, [folderPaths, filterShort, focusPanel]);

    const busy = loading || adding || scanning || loadError !== null;
    const scanFailures = result?.failures ?? progress?.failures ?? [];
    const failedCount = result?.failed ?? progress?.failed ?? scanFailures.length;

    return (
        <Modal
            open
            onClose={close}
            title={t('local_music.scan_title')}
            size="md"
            manageFocus
            onDragOverCapture={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                event.stopPropagation();
                const canDrop = !busy && !!addButtonRef.current?.contains(event.target as Node);
                event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
                setDragging(canDrop);
            }}
            onDragLeaveCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
            }}
            onDropCapture={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                event.stopPropagation();
                setDragging(false);
                if (busy || !addButtonRef.current?.contains(event.target as Node)) return;
                const files = Array.from(event.dataTransfer.files);
                const paths: string[] = [];
                const failures: IScanFailure[] = [];
                for (const file of files) {
                    try {
                        const filePath = fsUtil.getPathForFile(file);
                        if (filePath) paths.push(filePath);
                        else
                            failures.push({
                                filePath: file.name,
                                reason: t('local_music.import_path_unavailable'),
                            });
                    } catch (error) {
                        failures.push({
                            filePath: file.name,
                            reason: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                void addPaths(paths, failures);
            }}
            footer={
                <>
                    <Button variant="secondary" onClick={close}>
                        {t(scanning || result ? 'common.close' : 'common.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleStartScan}
                        disabled={busy}
                        loading={scanning}
                    >
                        {t(scanError ? 'common.retry' : 'local_music.start_scan')}
                    </Button>
                </>
            }
        >
            <div className="scan-folder-modal">
                {loading && <p role="status">{t('common.loading')}</p>}
                {loadError !== null && (
                    <div className="scan-folder-modal__error">
                        <div role="alert">
                            <p>{t('local_music.scan_folders_load_failed')}</p>
                            <p className="scan-folder-modal__failure">{loadError}</p>
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                focusPanel();
                                setLoadAttempt((value) => value + 1);
                            }}
                        >
                            {t('common.retry')}
                        </Button>
                    </div>
                )}
                {/* ── 已添加的文件夹列表 ── */}
                <div className="scan-folder-modal__section-label">
                    {t('local_music.selected_folders')}
                </div>

                {folderPaths.length > 0 ? (
                    <ScrollArea className="scan-folder-modal__folder-list">
                        {folderPaths.map((folderPath) => (
                            <div key={folderPath} className="scan-folder-modal__folder-item">
                                <Folder size={16} className="scan-folder-modal__folder-icon" />
                                <span className="scan-folder-modal__folder-path" title={folderPath}>
                                    {folderPath}
                                </span>
                                <button
                                    type="button"
                                    className="scan-folder-modal__remove-btn"
                                    onClick={() => handleRemoveFolder(folderPath)}
                                    disabled={busy}
                                >
                                    {t('local_music.remove_folder')}
                                </button>
                            </div>
                        ))}
                    </ScrollArea>
                ) : (
                    !loading &&
                    loadError === null && (
                        <div className="scan-folder-modal__empty">
                            {t('local_music.scan_empty_desc')}
                        </div>
                    )
                )}

                {/* ── 添加文件夹按钮 ── */}
                <button
                    type="button"
                    ref={addButtonRef}
                    className={cn('scan-folder-modal__add-btn', dragging && 'is-dragging')}
                    onClick={handleAddFolder}
                    disabled={busy}
                >
                    <Plus size={16} />
                    {t(
                        adding
                            ? 'local_music.checking_folders'
                            : 'local_music.add_folder_drop_hint',
                    )}
                </button>

                {folderFailures.length > 0 && (
                    <FailureList
                        title={t('local_music.folder_add_failures', {
                            count: folderFailures.length,
                        })}
                        failures={folderFailures}
                    />
                )}

                {/* ── 扫描选项 ── */}
                <CheckboxGroup
                    value={filterShort ? ['filterShort'] : []}
                    disabled={busy}
                    options={[
                        {
                            value: 'filterShort',
                            label: t('local_music.filter_short_audio'),
                        },
                    ]}
                    onChange={(v) => {
                        setFilterShort(v.includes('filterShort'));
                        setResult(null);
                        setProgress(null);
                        setScanError(null);
                    }}
                />

                {scanning && (
                    <p className="scan-folder-modal__status" role="status">
                        {progress && progress.total > 0
                            ? t('local_music.scan_progress', {
                                  scanned: progress.scanned,
                                  total: progress.total,
                              })
                            : t('local_music.scanning')}
                    </p>
                )}
                {result && (
                    <div className="scan-folder-modal__status" role="status">
                        <p>
                            {t(
                                result.failed > 0
                                    ? 'local_music.scan_partial'
                                    : 'local_music.scan_complete',
                            )}
                        </p>
                        <p>
                            {t('local_music.scan_result', {
                                added: result.added,
                                updated: result.updated,
                                removed: result.removed,
                                unchanged: result.unchanged,
                            })}
                        </p>
                    </div>
                )}
                {failedCount > 0 && (
                    <FailureList
                        title={t('local_music.scan_failures', { count: failedCount })}
                        failures={scanFailures}
                    />
                )}
                {scanError !== null && (
                    <div className="scan-folder-modal__error" role="alert">
                        <p>{t('local_music.scan_failed')}</p>
                        <p className="scan-folder-modal__failure">{scanError}</p>
                    </div>
                )}

                {/* ── 提示文本 ── */}
                <div className="scan-folder-modal__hint">{t('local_music.scan_hint')}</div>
            </div>
        </Modal>
    );
}
