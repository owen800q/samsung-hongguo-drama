import { Component } from 'preact';
import { actionOf } from '../platform/keys.js';
import { exitApp } from '../platform/tv.js';

/**
 * A rendering error would otherwise leave a blank screen that the remote cannot leave.
 * Shows a recovery prompt instead: OK reloads the app, Back exits it. The app's own key
 * handling is gone with the crashed tree, so this listens for the keys itself.
 */
export class ErrorBoundary extends Component {
  constructor() {
    super();
    this.state = { failed: false };
    this.onKey = e => {
      const action = actionOf(e);
      if (action === 'enter') { e.preventDefault(); window.location.reload(); }
      else if (action === 'back') { e.preventDefault(); exitApp(); }
    };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try { console.error('[app] render failed', error); } catch (_) {}
  }

  componentDidUpdate() {
    if (!this.state.failed || this.listening) return;
    this.listening = true;
    document.addEventListener('keydown', this.onKey);
    if (this.button) this.button.focus();
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.onKey);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div class="app error-boundary" role="alert">
        <div class="status">
          <div class="status-title">界面出现异常</div>
          <div class="status-text">按 OK 键重新加载；若仍出现此提示，请按返回键退出后重新打开应用。观看记录不会丢失。</div>
          <button type="button" tabIndex={-1} class="btn btn-primary btn-lg focusable" ref={el => { this.button = el; }}
            onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}
