import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Disc3 } from 'lucide-react';
import type { ILocalMusicMetadata, MetadataValue } from '@appTypes/infra/localMusic';
import formatDuration from '@common/formatDuration';
import formatFileSize from '@common/formatFileSize';
import downloadManager from '@infra/downloadManager/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import localMusic from '@infra/localMusic/renderer';
import musicSheet from '@infra/musicSheet/renderer';
import Modal from '../../../ui/Modal';
import { Button } from '../../../ui/Button';
import './index.scss';

interface MusicInfoModalProps {
    close: () => void;
    musicItem: IMusic.IMusicItem;
    /** 菜单已确定的选中文件或当前实际播放源路径，优先于 raw 和下载记录。 */
    filePath?: string;
    returnFocusTo?: HTMLElement | null;
}

type MetadataState =
    | { status: 'loading' }
    | { status: 'ready'; metadata: ILocalMusicMetadata }
    | { status: 'error'; reason: string | null };

function tagValueToText(value: MetadataValue | undefined): string {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(tagValueToText).join(', ');
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function RawTags({ label, tags }: { label: string; tags: Record<string, MetadataValue> }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);

    return (
        <details
            className="music-info-modal__raw-tags"
            onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
            <summary className="music-info-modal__summary">{label}</summary>
            {expanded && (
                <pre className="music-info-modal__raw-value" tabIndex={0} aria-label={label}>
                    {Object.keys(tags).length === 0
                        ? t('media.no_tags')
                        : JSON.stringify(
                              tags,
                              (_key, value: MetadataValue) => {
                                  if (
                                      value !== null &&
                                      typeof value === 'object' &&
                                      !Array.isArray(value) &&
                                      value.type === 'binary' &&
                                      typeof value.byteLength === 'number'
                                  ) {
                                      return t('media.binary_data', { count: value.byteLength });
                                  }
                                  return value;
                              },
                              2,
                          )}
                </pre>
            )}
        </details>
    );
}

function MetadataDetails({ metadata }: { metadata: ILocalMusicMetadata }) {
    const { t, i18n } = useTranslation();
    const [coverFailed, setCoverFailed] = useState(false);
    const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
    const unknown = t('common.unknown');
    const numberFormat = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 3 });
    const { format } = metadata;
    const tagFields = [
        [
            t('media.date'),
            tagValueToText(metadata.common.date) || tagValueToText(metadata.common.year) || unknown,
        ],
        [t('media.genre'), tagValueToText(metadata.common.genre) || unknown],
        ...(['track', 'disk'] as const).map((key) => {
            const tag = metadata.common[key];
            let value = tagValueToText(tag);
            if (tag && typeof tag === 'object' && !Array.isArray(tag)) {
                const number = tagValueToText(tag.no);
                const total = tagValueToText(tag.of);
                value = total ? `${number || unknown} / ${total}` : number;
            }
            return [
                t(key === 'track' ? 'media.track_number' : 'media.disc_number'),
                value || unknown,
            ];
        }),
    ];
    const audioFields = [
        [t('media.codec'), format.codec || unknown],
        [t('media.container'), format.container || unknown],
        [
            t('media.lossless_encoding'),
            format.lossless == null ? unknown : t(format.lossless ? 'common.yes' : 'common.no'),
        ],
        [
            t('media.bitrate'),
            format.bitrate == null
                ? unknown
                : t('media.bitrate_value', { value: numberFormat.format(format.bitrate / 1000) }),
        ],
        [
            t('media.sample_rate'),
            format.sampleRate == null
                ? unknown
                : t('media.sample_rate_value', {
                      value: numberFormat.format(format.sampleRate / 1000),
                  }),
        ],
        [
            t('media.bit_depth'),
            format.bitsPerSample == null
                ? unknown
                : t('media.bit_depth_value', { value: numberFormat.format(format.bitsPerSample) }),
        ],
        [
            t('media.channels'),
            format.numberOfChannels == null
                ? unknown
                : numberFormat.format(format.numberOfChannels),
        ],
        [
            t('media.duration'),
            format.duration == null
                ? unknown
                : format.duration === 0
                  ? '0:00'
                  : formatDuration(format.duration),
        ],
    ];

    return (
        <div className="music-info-modal">
            <section className="music-info-modal__section">
                <h3 className="music-info-modal__heading">
                    {t('media.song_tags')}
                    <span className="music-info-modal__source">{t('media.tag_source_file')}</span>
                </h3>
                <div className="music-info-modal__overview">
                    {metadata.artwork && !coverFailed ? (
                        <img
                            className="music-info-modal__artwork"
                            src={metadata.artwork}
                            alt={t('media.artwork')}
                            draggable={false}
                            onError={() => setCoverFailed(true)}
                        />
                    ) : (
                        <div className="music-info-modal__artwork-placeholder">
                            <Disc3 size={28} aria-hidden="true" />
                            <span>
                                {t(coverFailed ? 'media.artwork_unavailable' : 'media.no_artwork')}
                            </span>
                        </div>
                    )}
                    <dl className="music-info-modal__tags">
                        {(['title', 'artist', 'album'] as const).map((key) => {
                            const fileValue = tagValueToText(metadata.common[key]);
                            const libraryValue = metadata.libraryTags?.[key];
                            return (
                                <div className="music-info-modal__tag" key={key}>
                                    <dt className="music-info-modal__label">{t(`media.${key}`)}</dt>
                                    <dd className="music-info-modal__value">
                                        {fileValue || unknown}
                                        {libraryValue !== undefined &&
                                            libraryValue !== fileValue && (
                                                <span className="music-info-modal__library-value">
                                                    {t('media.library_tag_value', {
                                                        value: libraryValue || unknown,
                                                    })}
                                                </span>
                                            )}
                                    </dd>
                                </div>
                            );
                        })}
                    </dl>
                </div>
                <dl className="music-info-modal__fields">
                    {tagFields.map(([label, value]) => (
                        <div className="music-info-modal__field" key={label}>
                            <dt className="music-info-modal__label">{label}</dt>
                            <dd className="music-info-modal__value">{value}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section className="music-info-modal__section">
                <h3 className="music-info-modal__heading">{t('media.audio_properties')}</h3>
                <dl className="music-info-modal__fields">
                    {audioFields.map(([label, value]) => (
                        <div className="music-info-modal__field" key={label}>
                            <dt className="music-info-modal__label">{label}</dt>
                            <dd className="music-info-modal__value">{value}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section className="music-info-modal__section">
                <h3 className="music-info-modal__heading">{t('media.file_info')}</h3>
                <dl className="music-info-modal__fields">
                    <div className="music-info-modal__field">
                        <dt className="music-info-modal__label">{t('media.file_size')}</dt>
                        <dd className="music-info-modal__value">
                            {formatFileSize(metadata.fileSize)} (
                            {numberFormat.format(metadata.fileSize)} B)
                        </dd>
                    </div>
                    <div className="music-info-modal__field">
                        <dt className="music-info-modal__label">{t('media.file_modified')}</dt>
                        <dd className="music-info-modal__value">
                            {new Date(metadata.fileMtime).toLocaleString(i18n.language)}
                        </dd>
                    </div>
                    <div className="music-info-modal__field music-info-modal__field--wide">
                        <dt className="music-info-modal__label">{t('media.file_path')}</dt>
                        <dd className="music-info-modal__value">
                            <p className="music-info-modal__path" tabIndex={0}>
                                {metadata.filePath}
                            </p>
                            <div className="music-info-modal__path-actions">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    icon={<Copy size={14} />}
                                    onClick={() => {
                                        navigator.clipboard.writeText(metadata.filePath).then(
                                            () => setCopyStatus('copied'),
                                            () => setCopyStatus('error'),
                                        );
                                    }}
                                >
                                    {t('local_music.copy_file_path')}
                                </Button>
                                <span className="music-info-modal__copy-status" role="status">
                                    {copyStatus === 'copied'
                                        ? t('common.copied')
                                        : copyStatus === 'error'
                                          ? t('local_music.copy_path_failed')
                                          : ''}
                                </span>
                            </div>
                        </dd>
                    </div>
                </dl>
            </section>

            <section className="music-info-modal__section">
                <h3 className="music-info-modal__heading">{t('media.more_tags')}</h3>
                <RawTags label={t('media.common_tags')} tags={metadata.common} />
                <RawTags label={t('media.native_tags')} tags={metadata.native} />
            </section>
        </div>
    );
}

export default function MusicInfoModal({
    close,
    musicItem,
    filePath,
    returnFocusTo,
}: MusicInfoModalProps) {
    const { t } = useTranslation();
    const [state, setState] = useState<MetadataState>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setState({ status: 'loading' });

        const loadMetadata = async () => {
            try {
                let resolvedPath = filePath;
                if (!resolvedPath) {
                    const raw = await musicSheet.getRawMusicItem(musicItem.platform, musicItem.id);
                    if (typeof raw?.localPath === 'string' && raw.localPath) {
                        resolvedPath = raw.localPath;
                    } else if (raw?.url?.startsWith('file:')) {
                        resolvedPath = fsUtil.fileUrlToPath(raw.url);
                    }
                }
                if (cancelled) return;
                resolvedPath ||= downloadManager.isDownloaded(musicItem)?.path;
                if (!resolvedPath) {
                    setState({ status: 'error', reason: null });
                    return;
                }

                const metadata = await localMusic.getMetadata(resolvedPath);
                if (!cancelled) setState({ status: 'ready', metadata });
            } catch (error) {
                if (!cancelled) {
                    setState({
                        status: 'error',
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        };

        void loadMetadata();
        return () => {
            cancelled = true;
        };
    }, [musicItem, filePath, attempt]);

    return (
        <Modal
            open
            onClose={close}
            title={t('media.song_info')}
            subtitle={
                <span className="music-info-modal__subtitle" title={musicItem.title}>
                    {musicItem.title}
                </span>
            }
            size="lg"
            manageFocus
            returnFocusTo={returnFocusTo}
            footer={
                <Button type="button" variant="secondary" onClick={close}>
                    {t('common.close')}
                </Button>
            }
        >
            {state.status === 'loading' && (
                <p className="music-info-modal__status" role="status">
                    {t('local_music.metadata_loading')}
                </p>
            )}
            {state.status === 'error' && (
                <div className="music-info-modal__error">
                    <div role="alert">
                        <p className="music-info-modal__status">
                            {t(
                                state.reason === null
                                    ? 'local_music.metadata_no_file'
                                    : 'local_music.metadata_read_failed',
                            )}
                        </p>
                        {state.reason && (
                            <p className="music-info-modal__error-detail">{state.reason}</p>
                        )}
                    </div>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setAttempt((value) => value + 1)}
                    >
                        {t('common.retry')}
                    </Button>
                </div>
            )}
            {state.status === 'ready' && <MetadataDetails metadata={state.metadata} />}
        </Modal>
    );
}
