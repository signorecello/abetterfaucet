import '@testing-library/jest-dom/vitest';

// Stub build-time env vars that wallet-config.ts reads at import time
import.meta.env.VITE_ORIGIN_CHAINID = '1';
import.meta.env.VITE_MIN_BALANCE_WEI = '10000000000000000';
import.meta.env.VITE_EPOCH_DURATION = '604800';
import.meta.env.VITE_REOWN_PROJECT_ID = 'test-project-id';
