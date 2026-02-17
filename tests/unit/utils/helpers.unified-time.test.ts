/**
 * Unified Time Entry Helper Tests
 * Tests for generateTimeEntryId and validateUnifiedTimeEntry
 */

import { generateTimeEntryId, validateUnifiedTimeEntry } from '../../../src/utils/helpers';

// Mock obsidian (required by helpers.ts imports)
jest.mock('obsidian');
jest.mock('rrule');
jest.mock('date-fns', () => ({
    format: jest.fn((date: Date, formatStr: string) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }),
}));

describe('Unified Time Entry Helpers', () => {
    describe('generateTimeEntryId', () => {
        it('should generate IDs with te- prefix', () => {
            const id = generateTimeEntryId();
            expect(id).toMatch(/^te-\d+-[a-z0-9]+$/);
        });

        it('should generate unique IDs', () => {
            const ids = new Set(Array.from({ length: 100 }, () => generateTimeEntryId()));
            expect(ids.size).toBe(100);
        });

        it('should generate IDs of reasonable length', () => {
            const id = generateTimeEntryId();
            // te- prefix + timestamp + - + random chars
            expect(id.length).toBeGreaterThan(10);
            expect(id.length).toBeLessThan(40);
        });

        it('should always start with te- prefix', () => {
            for (let i = 0; i < 10; i++) {
                expect(generateTimeEntryId().startsWith('te-')).toBe(true);
            }
        });
    });

    describe('validateUnifiedTimeEntry', () => {
        it('should accept valid entry with all fields', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00+11:00',
                endTime: '2026-02-18T11:00:00+11:00',
                title: 'Test',
                color: '#ff0000',
                description: 'A test entry',
            })).toBe(true);
        });

        it('should accept valid entry with minimal fields', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00',
            })).toBe(true);
        });

        it('should reject entry without id', () => {
            expect(validateUnifiedTimeEntry({
                startTime: '2026-02-18T09:00:00',
            })).toBe(false);
        });

        it('should reject entry with empty id', () => {
            expect(validateUnifiedTimeEntry({
                id: '',
                startTime: '2026-02-18T09:00:00',
            })).toBe(false);
        });

        it('should reject entry without startTime', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
            })).toBe(false);
        });

        it('should reject entry with empty startTime', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '',
            })).toBe(false);
        });

        it('should reject entry with invalid startTime', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: 'not-a-date',
            })).toBe(false);
        });

        it('should accept entry without endTime', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00',
            })).toBe(true);
        });

        it('should reject entry with invalid endTime', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00',
                endTime: 'not-a-date',
            })).toBe(false);
        });

        it('should accept date-only startTime', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18',
            })).toBe(true);
        });

        it('should reject null input', () => {
            expect(validateUnifiedTimeEntry(null)).toBe(false);
        });

        it('should reject undefined input', () => {
            expect(validateUnifiedTimeEntry(undefined)).toBe(false);
        });

        it('should reject non-object input', () => {
            expect(validateUnifiedTimeEntry('string')).toBe(false);
        });

        it('should reject numeric input', () => {
            expect(validateUnifiedTimeEntry(42)).toBe(false);
        });

        it('should reject entry with non-string title', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00',
                title: 123,
            })).toBe(false);
        });

        it('should reject entry with non-string color', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00',
                color: 123,
            })).toBe(false);
        });

        it('should reject entry with non-string description', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-123-abc',
                startTime: '2026-02-18T09:00:00',
                description: { text: 'foo' },
            })).toBe(false);
        });

        it('should reject entry with non-string id', () => {
            expect(validateUnifiedTimeEntry({
                id: 123,
                startTime: '2026-02-18T09:00:00',
            })).toBe(false);
        });

        it('should accept entry with ISO datetime with timezone offset', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-456-def',
                startTime: '2026-03-15T14:30:00+05:30',
                endTime: '2026-03-15T16:30:00+05:30',
            })).toBe(true);
        });

        it('should accept entry with UTC Z suffix', () => {
            expect(validateUnifiedTimeEntry({
                id: 'te-789-ghi',
                startTime: '2026-04-01T00:00:00Z',
            })).toBe(true);
        });
    });
});
