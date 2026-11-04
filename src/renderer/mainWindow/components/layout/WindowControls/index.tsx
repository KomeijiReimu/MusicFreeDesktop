import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Minus, Square, X } from 'lucide-react';
import appConfig from '@infra/appConfig/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import './index.scss';

const WindowControls = memo(function WindowControls() {
    const { t } = useTranslation();
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        let ignoreInitialState = false;
        const unsubscribe = systemUtil.onMaximizedChange((maximized) => {
            ignoreInitialState = true;
            setIsMaximized(maximized);
        });

        void systemUtil.isMaximized().then((maximized) => {
            // 已收到窗口事件或已经卸载时，不再应用初始查询结果。
            if (!ignoreInitialState) setIsMaximized(maximized);
        });

        return () => {
            ignoreInitialState = true;
            unsubscribe();
        };
    }, []);

    const maximizeLabel = t(isMaximized ? 'app.restore' : 'app.maximize');

    return (
        <div className="l-window-controls">
            <button
                className="l-window-controls__button"
                type="button"
                title={t('app.minimize')}
                aria-label={t('app.minimize')}
                onClick={() => systemUtil.minimizeWindow()}
            >
                <Minus size={14} strokeWidth={1.5} />
            </button>
            <button
                className="l-window-controls__button"
                type="button"
                title={maximizeLabel}
                aria-label={maximizeLabel}
                onClick={() => systemUtil.toggleMaximize()}
            >
                {isMaximized ? (
                    <Copy size={12} strokeWidth={1.5} />
                ) : (
                    <Square size={10} strokeWidth={1.5} />
                )}
            </button>
            <button
                className="l-window-controls__button l-window-controls__button--close"
                type="button"
                title={t('common.close')}
                aria-label={t('common.close')}
                onClick={() => {
                    if (appConfig.getConfigByKey('normal.closeBehavior') === 'exit_app') {
                        systemUtil.exitApp();
                    } else {
                        systemUtil.minimizeWindow(true);
                    }
                }}
            >
                <X size={14} strokeWidth={1.5} />
            </button>
        </div>
    );
});

export default WindowControls;
