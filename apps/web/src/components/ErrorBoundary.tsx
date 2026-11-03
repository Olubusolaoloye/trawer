import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { reportError } from '../lib/monitor';
import { t } from '../i18n';

/** Last line of defence: a friendly page instead of a blank screen, and the error goes to monitoring. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { reportError(error, { component: info.componentStack?.split('\n').filter(Boolean)[0]?.trim() }); }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="font-display text-3xl font-extrabold">{t('crash.title')}</h1>
        <p className="text-body">{t('crash.body')}</p>
        <button type="button" onClick={() => location.reload()} className="press inline-flex min-h-13 items-center gap-2 rounded-xl bg-green px-6 font-bold text-white">
          <RotateCcw className="size-5" aria-hidden />{t('crash.reload')}
        </button>
      </main>
    );
  }
}
