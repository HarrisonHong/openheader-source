import { render } from 'preact';
import '../../ui/base.css';
import { WelcomeApp } from './App';

const root = document.getElementById('root');
if (root) {
  render(<WelcomeApp />, root);
}
