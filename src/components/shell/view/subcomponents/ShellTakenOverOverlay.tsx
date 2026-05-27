import { useTranslation } from 'react-i18next';

type ShellTakenOverOverlayProps = {
  onReattach: () => void;
};

export default function ShellTakenOverOverlay({ onReattach }: ShellTakenOverOverlayProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-80 p-4">
      <div className="w-full max-w-sm text-center">
        <p className="mb-4 text-sm text-gray-300">
          {t('shell.takenOver.message')}
        </p>
        <button
          type="button"
          onClick={onReattach}
          className="inline-flex w-full items-center justify-center space-x-2 rounded-lg bg-amber-600 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-amber-700 sm:w-auto"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span>{t('shell.takenOver.reattach')}</span>
        </button>
        <p className="mt-3 px-2 text-xs text-gray-500">
          {t('shell.takenOver.note')}
        </p>
      </div>
    </div>
  );
}
