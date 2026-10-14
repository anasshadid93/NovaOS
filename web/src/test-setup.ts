import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount rendered trees between tests (vitest runs without globals).
afterEach(() => cleanup());
