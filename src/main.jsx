import './lib/polyfills.js';
import { render } from 'preact';
import { App } from './app.jsx';
import { registerRemoteKeys } from './platform/keys.js';
import './styles.css';

registerRemoteKeys();
render(<App />, document.getElementById('app'));
