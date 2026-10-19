import './lib/polyfills.js';
import { render } from 'preact';
import { App } from './app.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { registerRemoteKeys } from './platform/keys.js';
import './styles.css';

registerRemoteKeys();
render(<ErrorBoundary><App /></ErrorBoundary>, document.getElementById('app'));
