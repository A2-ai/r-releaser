import { describe, it, expect } from 'vitest';
import { parseDescription, updateDescription } from './description.js';

const SAMPLE = `Package: dplyr
Title: A Grammar of Data Manipulation
Version: 1.1.3
Authors@R: c(
    person("Hadley", "Wickham", , "hadley@posit.co", role = c("aut", "cre"),
           comment = c(ORCID = "0000-0003-4757-117X")),
    person("Posit Software, PBC", role = c("cph", "fnd"))
  )
Imports:
    cli (>= 3.4.0),
    generics
LinkingTo: Rcpp
Remotes: r-lib/cli
NeedsCompilation: yes
`;

describe('parseDescription', () => {
    it('parses single-line fields', () => {
        const desc = parseDescription(SAMPLE);
        expect(desc['Package']).toBe('dplyr');
        expect(desc['Version']).toBe('1.1.3');
        expect(desc['NeedsCompilation']).toBe('yes');
    });

    it('joins continuation lines with newlines', () => {
        const desc = parseDescription(SAMPLE);
        expect(desc['Imports']).toBe('cli (>= 3.4.0),\n    generics');
        expect(desc['Authors@R']).toContain('person("Hadley", "Wickham"');
    });
});

describe('updateDescription', () => {
    it('replaces an existing field in place', () => {
        const updated = updateDescription(SAMPLE, { set: { Version: '2.0.0' } });
        expect(updated).toContain('Version: 2.0.0');
        const lines = updated.split('\n');
        expect(lines.indexOf('Version: 2.0.0')).toBe(2);
    });

    it('preserves multi-line fields verbatim when updating others', () => {
        const updated = updateDescription(SAMPLE, { set: { Version: '2.0.0' } });
        expect(updated).toContain('Imports:\n    cli (>= 3.4.0),\n    generics');
        expect(updated).toContain('           comment = c(ORCID = "0000-0003-4757-117X")),');
    });

    it('matches field names case-insensitively but keeps original casing', () => {
        const updated = updateDescription(SAMPLE, { set: { version: '9.9.9' } });
        expect(updated).toContain('Version: 9.9.9');
        expect(updated).not.toContain('version: 9.9.9');
    });

    it('appends fields that are not present', () => {
        const updated = updateDescription(SAMPLE, { set: { GitSHA: 'abc123' } });
        expect(updated.trimEnd().split('\n').pop()).toBe('GitSHA: abc123');
    });

    it('removes fields case-insensitively, including continuation lines', () => {
        const updated = updateDescription(SAMPLE, { remove: ['remotes', 'Imports'] });
        expect(updated).not.toContain('Remotes:');
        expect(updated).not.toContain('cli (>= 3.4.0)');
        expect(updated).toContain('LinkingTo: Rcpp');
    });

    it('round-trips unchanged content byte-for-byte', () => {
        expect(updateDescription(SAMPLE, {})).toBe(SAMPLE);
    });
});
