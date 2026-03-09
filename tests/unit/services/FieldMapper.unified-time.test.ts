/**
 * FieldMapper unified time entry tests
 * Tests for computing scheduled from future planned time entries and round-trip mapping
 */

import { FieldMapper } from '../../../src/services/FieldMapper';
import { DEFAULT_FIELD_MAPPING } from '../../../src/settings/defaults';
import { TaskInfo } from '../../../src/types';

describe('FieldMapper - Unified Time Entries', () => {
    let mapper: FieldMapper;

    beforeEach(() => {
        mapper = new FieldMapper({ ...DEFAULT_FIELD_MAPPING });
    });

    describe('mapFromFrontmatter - computed scheduled', () => {
        it('should compute scheduled from earliest future planned time entry', () => {
            // Create entries with dates definitely in the future
            const futureDate1 = new Date(Date.now() + 86400000 * 2); // +2 days
            const futureDate2 = new Date(Date.now() + 86400000 * 5); // +5 days

            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                timeEntries: [
                    { id: 'te-1', type: 'planned', startTime: futureDate2.toISOString(), endTime: undefined },
                    { id: 'te-2', type: 'planned', startTime: futureDate1.toISOString(), endTime: undefined },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            // Should be the earlier future entry's full startTime
            expect(result.next_scheduled).toBe(futureDate1.toISOString());
        });

        it('should return undefined when only past planned entries exist (no past fallback)', () => {
            const pastDate = new Date(Date.now() - 86400000); // yesterday

            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                next_scheduled: '2025-01-15',
                timeEntries: [
                    // Past entry with type "planned" — planned but in the past
                    { id: 'te-1', type: 'planned', startTime: pastDate.toISOString(), endTime: pastDate.toISOString() },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            // No future planned entries — next_scheduled is undefined (no past fallback)
            expect(result.next_scheduled).toBeUndefined();
        });

        it('should clear scheduled when entries have no type: "planned"', () => {
            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                next_scheduled: '2025-01-15',
                timeEntries: [
                    // Entries without type: "planned" are filtered out
                    { id: 'te-1', startTime: '2099-06-15' },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            // No planned entries — stale scheduled value is cleared
            expect(result.next_scheduled).toBeUndefined();
        });

        it('should handle date-only startTime', () => {
            // Date far enough in the future it won't expire during test
            const futureDate = '2099-06-15';

            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                timeEntries: [
                    { id: 'te-1', type: 'planned', startTime: futureDate },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            expect(result.next_scheduled).toBe('2099-06-15');
        });

        it('should not override scheduled when timeEntries is empty', () => {
            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                next_scheduled: '2025-03-01',
                timeEntries: [],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            expect(result.next_scheduled).toBe('2025-03-01');
        });

        it('should pick earliest future planned entry when multiple future entries exist', () => {
            const futureDate1 = new Date(Date.now() + 86400000 * 10); // +10 days
            const futureDate2 = new Date(Date.now() + 86400000 * 3);  // +3 days
            const futureDate3 = new Date(Date.now() + 86400000 * 7);  // +7 days

            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                timeEntries: [
                    { id: 'te-1', type: 'planned', startTime: futureDate1.toISOString() },
                    { id: 'te-2', type: 'planned', startTime: futureDate2.toISOString() },
                    { id: 'te-3', type: 'planned', startTime: futureDate3.toISOString() },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            expect(result.next_scheduled).toBe(futureDate2.toISOString());
        });

        it('should ignore entries without type: "planned"', () => {
            const futureDate = new Date(Date.now() + 86400000 * 5);

            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                next_scheduled: '2025-01-01',
                timeEntries: [
                    // Entries without type: "planned" are filtered out
                    { id: 'te-1', startTime: futureDate.toISOString(), endTime: undefined },
                    { id: 'te-2', type: 'logged', startTime: futureDate.toISOString() },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            // No planned entries — stale scheduled value is cleared
            expect(result.next_scheduled).toBeUndefined();
        });

        it('should handle mix of past and future planned entries', () => {
            const pastDate = new Date(Date.now() - 86400000 * 3);
            const futureDate = new Date(Date.now() + 86400000 * 5);

            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                next_scheduled: '2025-01-01',
                timeEntries: [
                    { id: 'te-1', type: 'planned', startTime: pastDate.toISOString(), endTime: pastDate.toISOString() },
                    { id: 'te-2', type: 'planned', startTime: futureDate.toISOString() },
                ],
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            // Future planned entry should be used (overrides frontmatter scheduled)
            expect(result.next_scheduled).toBe(futureDate.toISOString());
        });

        it('should handle non-array timeEntries gracefully', () => {
            const frontmatter = {
                title: 'Test Task',
                status: 'open',
                priority: 'normal',
                next_scheduled: '2025-06-01',
                timeEntries: 'not-an-array',
            };

            const result = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            // Non-array should be converted to empty array, so scheduled stays from frontmatter
            expect(result.next_scheduled).toBe('2025-06-01');
        });
    });

    describe('mapToFrontmatter - scheduled not written', () => {
        it('should NOT write scheduled to frontmatter (computed from time entries)', () => {
            const futureDate = new Date(Date.now() + 86400000 * 3);

            const taskData: Partial<TaskInfo> = {
                title: 'Test Task',
                next_scheduled: futureDate.toISOString(),
                timeEntries: [
                    { id: 'te-1', type: 'planned', startTime: futureDate.toISOString() },
                ],
            };

            const result = mapper.mapToFrontmatter(taskData);
            // scheduled should NOT be in frontmatter — it's computed from time entries
            expect(result[DEFAULT_FIELD_MAPPING.nextScheduled]).toBeUndefined();
            expect(result.timeEntries).toEqual(taskData.timeEntries);
        });

        it('should write timeEntries even without scheduled', () => {
            const futureDate = new Date(Date.now() + 86400000 * 3);

            const taskData: Partial<TaskInfo> = {
                title: 'Test Task',
                timeEntries: [
                    { id: 'te-1', type: 'planned', startTime: futureDate.toISOString() },
                ],
            };

            const result = mapper.mapToFrontmatter(taskData);
            expect(result.timeEntries).toEqual(taskData.timeEntries);
            expect(result[DEFAULT_FIELD_MAPPING.nextScheduled]).toBeUndefined();
        });

        it('should handle empty timeEntries array without error', () => {
            const taskData: Partial<TaskInfo> = {
                title: 'Test Task',
                timeEntries: [],
            };

            const result = mapper.mapToFrontmatter(taskData);
            expect(result.timeEntries).toEqual([]);
            expect(result[DEFAULT_FIELD_MAPPING.nextScheduled]).toBeUndefined();
        });
    });

    describe('round-trip: mapFromFrontmatter → mapToFrontmatter', () => {
        it('should compute scheduled on read and not write it back', () => {
            const futureDate = new Date(Date.now() + 86400000 * 4);
            const iso = futureDate.toISOString();

            const frontmatter = {
                title: 'Round Trip Task',
                status: 'open',
                priority: 'normal',
                timeEntries: [
                    { id: 'te-rt-1', type: 'planned', startTime: iso },
                ],
            };

            // Read from frontmatter — scheduled is computed
            const taskData = mapper.mapFromFrontmatter(frontmatter, 'test.md');
            expect(taskData.next_scheduled).toBe(iso);

            // Write back to frontmatter — scheduled is NOT written
            const result = mapper.mapToFrontmatter(taskData);
            expect(result[DEFAULT_FIELD_MAPPING.nextScheduled]).toBeUndefined();
            expect(result.timeEntries).toEqual(frontmatter.timeEntries);
        });
    });
});
