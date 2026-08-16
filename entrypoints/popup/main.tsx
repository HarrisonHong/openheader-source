import { render } from 'preact';
import '../../ui/base.css';
import './popup.css';
import { PopupApp } from './App';

const root = document.getElementById('root');
if (root) {
  render(<PopupApp />, root);
}
