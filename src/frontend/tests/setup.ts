import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle, configurable: true })
