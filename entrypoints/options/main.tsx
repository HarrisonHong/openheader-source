import { render } from 'preact';
import '../../ui/base.css';
import { OptionsApp } from './App';

const root = document.getElementById('root');
if (root) {
  render(<OptionsApp />, root);
}
